import { Router } from 'express';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  careUnits,
  equipmentEvents,
  equipmentItems,
  facilities,
  safetyIncidents,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  addDays,
  CATEGORIES,
  CRITICAL_CATEGORIES,
  CRITICALITIES,
  CSV_COLUMNS,
  DUE_SOON_DAYS,
  EVENT_KINDS,
  maintenanceState,
  NATIONAL_CATEGORIES,
  nextDueFrom,
  STATUSES,
  statusAfterEvent,
  todayIso,
  unitOfFacility,
  unitsOf,
  validateCsv,
  type EquipmentStatus,
} from './equipment.service.js';

/**
 * Medical equipment: the facility register, maintenance schedule, faults and availability.
 * - DIRECTOR (own facility): manages the register, records services, repairs and status changes,
 *   imports CSV files.
 * - DOCTOR, NURSE, PHARMACIST (own facility): see the equipment and report faults.
 * - MINISTRY: national aggregates only (no item lists).
 */
export const equipmentRouter = Router();
equipmentRouter.use(authenticate);

const STAFF = ['DOCTOR', 'NURSE', 'PHARMACIST', 'DIRECTOR'] as const;

const IdParam = z.object({ id: z.string().uuid() });
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');

function facilityOf(ctx: AuthContext): string {
  if (!ctx.facilityId) throw forbidden();
  return ctx.facilityId;
}

async function loadItem(ctx: AuthContext, id: string) {
  const [item] = await db.select().from(equipmentItems).where(eq(equipmentItems.id, id));
  // Other facilities' equipment is simply not found.
  if (!item || item.facilityId !== ctx.facilityId) throw notFound('Equipment not found');
  return item;
}

function present(
  item: typeof equipmentItems.$inferSelect,
  unitName: string | null,
  today = todayIso(),
) {
  return {
    id: item.id,
    assetTag: item.assetTag,
    category: item.category,
    name: item.name,
    manufacturer: item.manufacturer,
    model: item.model,
    serialNumber: item.serialNumber,
    criticality: item.criticality,
    status: item.status,
    unitId: item.unitId,
    unitName,
    serviceIntervalDays: item.serviceIntervalDays,
    lastServiceAt: item.lastServiceAt,
    nextServiceDue: item.nextServiceDue,
    commissionedOn: item.commissionedOn,
    maintenance: maintenanceState(item, today),
    updatedAt: item.updatedAt,
  };
}

/* ------------------------------------------------------------------------------- meta ----- */

equipmentRouter.get('/meta', requireRole(...STAFF, 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  res.json({
    categories: CATEGORIES,
    criticalities: CRITICALITIES,
    statuses: STATUSES,
    eventKinds: EVENT_KINDS,
    criticalCategories: CRITICAL_CATEGORIES,
    csvColumns: CSV_COLUMNS,
    dueSoonDays: DUE_SOON_DAYS,
    units: ctx.facilityId && ctx.role !== 'MINISTRY' ? await unitsOf(ctx.facilityId) : [],
    canManage: ctx.role === 'DIRECTOR',
    canReportFault: (STAFF as readonly string[]).includes(ctx.role),
    isMinistry: ctx.role === 'MINISTRY',
  });
});

/* ------------------------------------------------------------------------------ items ----- */

const ListQuery = PaginationSchema.extend({
  unitId: z.string().uuid().optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(STATUSES).optional(),
  maintenance: z.enum(['OVERDUE', 'DUE_SOON']).optional(),
  q: z.string().trim().max(100).optional(),
  /** Exact asset tag (e.g. from a scanned label). */
  tag: z.string().trim().max(40).optional(),
  includeRetired: z.coerce.boolean().default(false),
});

equipmentRouter.get('/items', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const query = parse(ListQuery, req.query);
  const today = todayIso();
  const where: (SQL | undefined)[] = [eq(equipmentItems.facilityId, facilityId)];
  if (query.unitId) where.push(eq(equipmentItems.unitId, query.unitId));
  if (query.category) where.push(eq(equipmentItems.category, query.category));
  if (query.status) where.push(eq(equipmentItems.status, query.status));
  else if (!query.includeRetired) where.push(ne(equipmentItems.status, 'RETIRED'));
  if (query.maintenance === 'OVERDUE') where.push(lt(equipmentItems.nextServiceDue, today));
  if (query.maintenance === 'DUE_SOON') {
    where.push(gte(equipmentItems.nextServiceDue, today));
    where.push(sql`${equipmentItems.nextServiceDue} <= ${addDays(today, DUE_SOON_DAYS)}`);
  }
  if (query.tag) where.push(eq(equipmentItems.assetTag, query.tag.toUpperCase()));
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
    where.push(
      or(
        ilike(equipmentItems.assetTag, like),
        ilike(equipmentItems.name, like),
        ilike(equipmentItems.serialNumber, like),
        ilike(equipmentItems.model, like),
      ),
    );
  }
  const condition = and(...where);
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(equipmentItems)
    .where(condition);
  const rows = await db
    .select({ item: equipmentItems, unitName: careUnits.name })
    .from(equipmentItems)
    .leftJoin(careUnits, eq(careUnits.id, equipmentItems.unitId))
    .where(condition)
    .orderBy(asc(careUnits.name), asc(equipmentItems.category), asc(equipmentItems.assetTag))
    .limit(toOffset(query).limit)
    .offset(toOffset(query).offset);
  res.json(
    paginated(
      rows.map((r) => present(r.item, r.unitName, today)),
      Number(total),
      query,
    ),
  );
});

equipmentRouter.get('/items/:id', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const item = await loadItem(ctx, id);
  const [unit] = item.unitId
    ? await db.select({ name: careUnits.name }).from(careUnits).where(eq(careUnits.id, item.unitId))
    : [];
  const events = await db
    .select({
      id: equipmentEvents.id,
      kind: equipmentEvents.kind,
      occurredAt: equipmentEvents.occurredAt,
      description: equipmentEvents.description,
      status: equipmentEvents.status,
      recordedBy: users.fullName,
      incidentId: equipmentEvents.incidentId,
      incidentReference: safetyIncidents.reference,
      createdAt: equipmentEvents.createdAt,
    })
    .from(equipmentEvents)
    .innerJoin(users, eq(users.id, equipmentEvents.recordedById))
    .leftJoin(safetyIncidents, eq(safetyIncidents.id, equipmentEvents.incidentId))
    .where(eq(equipmentEvents.itemId, id))
    .orderBy(desc(equipmentEvents.occurredAt), desc(equipmentEvents.createdAt));
  res.json({ ...present(item, unit?.name ?? null), events });
});

const ItemFields = z.object({
  assetTag: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,39}$/, 'Use letters, digits and dashes (2–40 characters)'),
  category: z.enum(CATEGORIES),
  name: z.string().trim().min(2).max(200),
  manufacturer: z.string().trim().max(120).optional().nullable(),
  model: z.string().trim().max(120).optional().nullable(),
  serialNumber: z.string().trim().max(120).optional().nullable(),
  unitId: z.string().uuid().optional().nullable(),
  criticality: z.enum(CRITICALITIES),
  serviceIntervalDays: z.coerce.number().int().min(1).max(3650).optional().nullable(),
  commissionedOn: isoDate.optional().nullable(),
  lastServiceAt: isoDate.optional().nullable(),
});

async function assertUnit(facilityId: string, unitId: string | null | undefined) {
  if ((await unitOfFacility(facilityId, unitId)) === undefined) {
    throw badRequest('The ward or unit does not belong to your facility');
  }
}

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' &&
  err !== null &&
  ((err as { code?: string }).code === '23505' ||
    (err as { cause?: { code?: string } }).cause?.code === '23505');

equipmentRouter.post('/items', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const input = parse(ItemFields, req.body);
  await assertUnit(facilityId, input.unitId);
  const today = todayIso();
  if (input.lastServiceAt && input.lastServiceAt > today) {
    throw badRequest('The last service date cannot be in the future');
  }
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(equipmentItems)
        .values({
          facilityId,
          ...input,
          unitId: input.unitId ?? null,
          nextServiceDue: nextDueFrom(
            input.lastServiceAt ?? input.commissionedOn,
            input.serviceIntervalDays,
          ),
        })
        .returning();
      await audit(
        {
          action: AuditAction.EQUIPMENT_CHANGED,
          actor: ctx,
          resourceType: 'equipment_item',
          resourceId: row!.id,
          meta: requestMeta(req),
          metadata: { change: 'created', assetTag: row!.assetTag },
        },
        tx,
      );
      return row!;
    });
    res.status(201).json(present(created, null));
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('This asset tag is already used at your facility');
    throw err;
  }
});

equipmentRouter.patch('/items/:id', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const item = await loadItem(ctx, id);
  if (item.status === 'RETIRED') throw conflict('Retired equipment cannot be changed');
  const input = parse(ItemFields.partial().strict(), req.body);
  if (!Object.keys(input).length) throw badRequest('Nothing to change');
  if ('unitId' in input) await assertUnit(item.facilityId, input.unitId);
  if (input.lastServiceAt && input.lastServiceAt > todayIso()) {
    throw badRequest('The last service date cannot be in the future');
  }
  const interval =
    'serviceIntervalDays' in input ? input.serviceIntervalDays : item.serviceIntervalDays;
  const last = input.lastServiceAt ?? item.lastServiceAt;
  const commissioned = 'commissionedOn' in input ? input.commissionedOn : item.commissionedOn;
  try {
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(equipmentItems)
        .set({ ...input, nextServiceDue: nextDueFrom(last ?? commissioned, interval) })
        .where(eq(equipmentItems.id, id))
        .returning();
      await audit(
        {
          action: AuditAction.EQUIPMENT_CHANGED,
          actor: ctx,
          resourceType: 'equipment_item',
          resourceId: id,
          meta: requestMeta(req),
          metadata: { change: 'edited', fields: Object.keys(input) },
        },
        tx,
      );
      return row!;
    });
    res.json(present(updated, null));
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('This asset tag is already used at your facility');
    throw err;
  }
});

const ReasonInput = z.object({ reason: z.string().trim().min(5).max(500) });

equipmentRouter.post('/items/:id/retire', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonInput, req.body);
  const item = await loadItem(ctx, id);
  if (item.status === 'RETIRED') throw conflict('This equipment is already retired');
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(equipmentItems)
      .set({ status: 'RETIRED', nextServiceDue: null })
      .where(eq(equipmentItems.id, id))
      .returning();
    await tx.insert(equipmentEvents).values({
      itemId: id,
      kind: 'STATUS',
      occurredAt: new Date(),
      description: reason,
      status: 'RETIRED',
      recordedById: ctx.userId,
    });
    await audit(
      {
        action: AuditAction.EQUIPMENT_CHANGED,
        actor: ctx,
        resourceType: 'equipment_item',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { change: 'retired' },
      },
      tx,
    );
    return row!;
  });
  res.json(present(updated, null));
});

/* ----------------------------------------------------------------------------- events ----- */

const EventInput = z
  .object({
    kind: z.enum(EVENT_KINDS),
    description: z.string().trim().min(5).max(500),
    /** Defaults to now; services and repairs may be recorded afterwards (up to 90 days back). */
    occurredAt: z.coerce.date().optional(),
    /** Status after the event (REPAIR, STATUS; FAULT for non-critical items). */
    status: z.enum(['IN_SERVICE', 'OUT_OF_SERVICE', 'IN_MAINTENANCE']).optional(),
    /** Link a fault to a safety incident reported at this facility (e.g. "INC-2026-00042"). */
    incidentReference: z.string().trim().max(30).optional(),
  })
  .refine((e) => e.kind !== 'STATUS' || e.status, {
    message: 'Choose the new status',
    path: ['status'],
  })
  .refine((e) => e.kind === 'FAULT' || !e.incidentReference, {
    message: 'Only a fault can be linked to a safety incident',
    path: ['incidentReference'],
  });

equipmentRouter.post('/items/:id/events', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(EventInput, req.body);
  const item = await loadItem(ctx, id);
  if (item.status === 'RETIRED') throw conflict('Retired equipment cannot have new events');
  // Ward staff report faults; services, repairs and status changes are the director's.
  if (input.kind !== 'FAULT' && ctx.role !== 'DIRECTOR') {
    throw forbidden('Only the facility director records services, repairs and status changes');
  }
  const now = new Date();
  const occurredAt = input.occurredAt ?? now;
  if (occurredAt.getTime() > now.getTime() + 5 * 60_000) {
    throw badRequest('The date cannot be in the future');
  }
  if (occurredAt.getTime() < now.getTime() - 90 * 86_400_000) {
    throw badRequest('Events older than 90 days cannot be recorded');
  }

  let incidentId: string | null = null;
  if (input.incidentReference) {
    const [incident] = await db
      .select({ id: safetyIncidents.id })
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.reference, input.incidentReference.toUpperCase()),
          eq(safetyIncidents.facilityId, item.facilityId),
        ),
      );
    if (!incident) throw badRequest('No safety incident with this reference at your facility');
    incidentId = incident.id;
  }

  const newStatus: EquipmentStatus | null = statusAfterEvent(input.kind, item, input.status);
  const serviceDate = todayIso(occurredAt);
  const result = await db.transaction(async (tx) => {
    const [event] = await tx
      .insert(equipmentEvents)
      .values({
        itemId: id,
        kind: input.kind,
        occurredAt,
        description: input.description,
        status: newStatus,
        incidentId,
        recordedById: ctx.userId,
      })
      .returning();
    const changes: Partial<typeof equipmentItems.$inferInsert> = {};
    if (newStatus && newStatus !== item.status) changes.status = newStatus;
    if (input.kind === 'SERVICE') {
      // A service recorded late never moves the schedule backwards.
      if (!item.lastServiceAt || serviceDate >= item.lastServiceAt) {
        changes.lastServiceAt = serviceDate;
        changes.nextServiceDue = nextDueFrom(serviceDate, item.serviceIntervalDays);
      }
    }
    const [updated] = Object.keys(changes).length
      ? await tx.update(equipmentItems).set(changes).where(eq(equipmentItems.id, id)).returning()
      : [item];
    await audit(
      {
        action: AuditAction.EQUIPMENT_EVENT,
        actor: ctx,
        resourceType: 'equipment_item',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { kind: input.kind, status: newStatus, incidentId },
      },
      tx,
    );
    return { event: event!, item: updated! };
  });
  res.status(201).json({ event: result.event, item: present(result.item, null) });
});

/* ------------------------------------------------------------------------- CSV import ----- */

const ImportInput = z.object({
  csv: z.string().min(1).max(190_000),
  dryRun: z.boolean().default(true),
});

equipmentRouter.post('/import', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const { csv, dryRun } = parse(ImportInput, req.body);
  const { rows, errors } = validateCsv(csv);
  const units = new Map((await unitsOf(facilityId)).map((u) => [u.code.toUpperCase(), u.id]));
  for (const r of rows) {
    if (r.unitCode && !units.has(r.unitCode.toUpperCase())) {
      errors.push({ line: r.line, message: `unknown unit code ${r.unitCode}` });
    }
  }
  const valid = rows.filter((r) => !errors.some((e) => e.line === r.line));
  const existing = new Map(
    (
      await db
        .select({ id: equipmentItems.id, assetTag: equipmentItems.assetTag })
        .from(equipmentItems)
        .where(
          and(
            eq(equipmentItems.facilityId, facilityId),
            inArray(equipmentItems.assetTag, valid.length ? valid.map((r) => r.assetTag) : ['']),
          ),
        )
    ).map((e) => [e.assetTag, e.id]),
  );
  const summary = {
    dryRun,
    total: new Set([
      ...rows.map((r) => r.line),
      ...errors.filter((e) => e.line > 1).map((e) => e.line),
    ]).size,
    valid: valid.length,
    toCreate: valid.filter((r) => !existing.has(r.assetTag)).length,
    toUpdate: valid.filter((r) => existing.has(r.assetTag)).length,
    errors: errors.sort((a, b) => a.line - b.line),
  };
  if (dryRun || errors.length) {
    res.json({ ...summary, applied: false });
    return;
  }
  await db.transaction(async (tx) => {
    for (const r of valid) {
      const values = {
        category: r.category,
        name: r.name,
        manufacturer: r.manufacturer,
        model: r.model,
        serialNumber: r.serialNumber,
        unitId: r.unitCode ? units.get(r.unitCode.toUpperCase())! : null,
        criticality: r.criticality,
        serviceIntervalDays: r.serviceIntervalDays,
        commissionedOn: r.commissionedOn,
        lastServiceAt: r.lastServiceAt,
        nextServiceDue: nextDueFrom(r.lastServiceAt ?? r.commissionedOn, r.serviceIntervalDays),
      };
      const id = existing.get(r.assetTag);
      // Imports never change the status (faults and repairs come from the event history).
      if (id) await tx.update(equipmentItems).set(values).where(eq(equipmentItems.id, id));
      else await tx.insert(equipmentItems).values({ facilityId, assetTag: r.assetTag, ...values });
    }
    await audit(
      {
        action: AuditAction.EQUIPMENT_CHANGED,
        actor: ctx,
        resourceType: 'equipment_import',
        meta: requestMeta(req),
        metadata: { created: summary.toCreate, updated: summary.toUpdate },
      },
      tx,
    );
  });
  res.json({ ...summary, applied: true });
});

/* ---------------------------------------------------------------------- maintenance ----- */

equipmentRouter.get('/maintenance', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const { unitId } = parse(z.object({ unitId: z.string().uuid().optional() }), req.query);
  const today = todayIso();
  const rows = await db
    .select({ item: equipmentItems, unitName: careUnits.name })
    .from(equipmentItems)
    .leftJoin(careUnits, eq(careUnits.id, equipmentItems.unitId))
    .where(
      and(
        eq(equipmentItems.facilityId, facilityId),
        ne(equipmentItems.status, 'RETIRED'),
        unitId ? eq(equipmentItems.unitId, unitId) : undefined,
        or(
          sql`${equipmentItems.nextServiceDue} <= ${addDays(today, DUE_SOON_DAYS)}`,
          inArray(equipmentItems.status, ['OUT_OF_SERVICE', 'IN_MAINTENANCE']),
        ),
      ),
    )
    .orderBy(asc(equipmentItems.nextServiceDue), asc(equipmentItems.assetTag));
  const items = rows.map((r) => present(r.item, r.unitName, today));
  res.json({
    today,
    dueSoonDays: DUE_SOON_DAYS,
    overdue: items.filter((i) => i.maintenance === 'OVERDUE'),
    dueSoon: items.filter((i) => i.maintenance === 'DUE_SOON'),
    outOfService: items.filter(
      (i) => i.status === 'OUT_OF_SERVICE' || i.status === 'IN_MAINTENANCE',
    ),
  });
});

/* ---------------------------------------------------------------------- availability ----- */

/** Per unit: critical equipment in service out of the total, plus the facility's totals. */
equipmentRouter.get('/availability', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const today = todayIso();
  const rows = await db
    .select({
      unitId: equipmentItems.unitId,
      unitName: careUnits.name,
      category: equipmentItems.category,
      total: count(),
      inService: sql<number>`count(*) FILTER (WHERE ${equipmentItems.status} = 'IN_SERVICE')::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${equipmentItems.nextServiceDue} < ${today})::int`,
    })
    .from(equipmentItems)
    .leftJoin(careUnits, eq(careUnits.id, equipmentItems.unitId))
    .where(
      and(
        eq(equipmentItems.facilityId, facilityId),
        ne(equipmentItems.status, 'RETIRED'),
        inArray(equipmentItems.category, CRITICAL_CATEGORIES),
      ),
    )
    .groupBy(equipmentItems.unitId, careUnits.name, equipmentItems.category);
  const units = new Map<
    string,
    { unitId: string | null; unitName: string | null; categories: Record<string, unknown> }
  >();
  for (const r of rows) {
    const key = r.unitId ?? 'none';
    const u = units.get(key) ?? { unitId: r.unitId, unitName: r.unitName, categories: {} };
    u.categories[r.category] = {
      total: Number(r.total),
      inService: Number(r.inService),
      overdue: Number(r.overdue),
    };
    units.set(key, u);
  }
  const [totals] = await db
    .select({
      total: count(),
      inService: sql<number>`count(*) FILTER (WHERE ${equipmentItems.status} = 'IN_SERVICE')::int`,
      outOfService: sql<number>`count(*) FILTER (WHERE ${equipmentItems.status} IN ('OUT_OF_SERVICE', 'IN_MAINTENANCE'))::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${equipmentItems.nextServiceDue} < ${today})::int`,
      dueSoon: sql<number>`count(*) FILTER (WHERE ${equipmentItems.nextServiceDue} >= ${today} AND ${equipmentItems.nextServiceDue} <= ${addDays(today, DUE_SOON_DAYS)})::int`,
    })
    .from(equipmentItems)
    .where(and(eq(equipmentItems.facilityId, facilityId), ne(equipmentItems.status, 'RETIRED')));
  res.json({
    criticalCategories: CRITICAL_CATEGORIES,
    units: [...units.values()].sort((a, b) => (a.unitName ?? '~').localeCompare(b.unitName ?? '~')),
    totals: {
      total: Number(totals?.total ?? 0),
      inService: Number(totals?.inService ?? 0),
      outOfService: Number(totals?.outOfService ?? 0),
      overdue: Number(totals?.overdue ?? 0),
      dueSoon: Number(totals?.dueSoon ?? 0),
    },
  });
});

/* -------------------------------------------------------------------------- national ----- */

/**
 * Ministry: ventilators, defibrillators and dialysis machines in service by facility and
 * municipality, overdue maintenance and faults per month. Aggregates only – no item lists.
 */
equipmentRouter.get('/national', requireRole('MINISTRY'), async (_req, res) => {
  const today = todayIso();
  const byFacility = await db
    .select({
      facilityId: facilities.id,
      facility: facilities.name,
      code: facilities.code,
      municipality: facilities.municipality,
      category: equipmentItems.category,
      total: count(),
      inService: sql<number>`count(*) FILTER (WHERE ${equipmentItems.status} = 'IN_SERVICE')::int`,
    })
    .from(equipmentItems)
    .innerJoin(facilities, eq(facilities.id, equipmentItems.facilityId))
    .where(
      and(
        ne(equipmentItems.status, 'RETIRED'),
        inArray(equipmentItems.category, NATIONAL_CATEGORIES),
      ),
    )
    .groupBy(
      facilities.id,
      facilities.name,
      facilities.code,
      facilities.municipality,
      equipmentItems.category,
    )
    .orderBy(facilities.name);
  const maintenance = await db
    .select({
      facilityId: facilities.id,
      facility: facilities.name,
      municipality: facilities.municipality,
      total: count(),
      scheduled: sql<number>`count(${equipmentItems.nextServiceDue})::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${equipmentItems.nextServiceDue} < ${today})::int`,
      outOfService: sql<number>`count(*) FILTER (WHERE ${equipmentItems.status} IN ('OUT_OF_SERVICE', 'IN_MAINTENANCE'))::int`,
    })
    .from(equipmentItems)
    .innerJoin(facilities, eq(facilities.id, equipmentItems.facilityId))
    .where(ne(equipmentItems.status, 'RETIRED'))
    .groupBy(facilities.id, facilities.name, facilities.municipality)
    .orderBy(facilities.name);
  const since = new Date(`${addDays(today, -365).slice(0, 7)}-01T00:00:00Z`);
  const faults = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${equipmentEvents.occurredAt} AT TIME ZONE 'Europe/Belgrade'), 'YYYY-MM')`,
      count: count(),
    })
    .from(equipmentEvents)
    .where(and(eq(equipmentEvents.kind, 'FAULT'), gte(equipmentEvents.occurredAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  type Cell = { total: number; inService: number };
  const facilityRows = new Map<
    string,
    {
      facilityId: string;
      facility: string;
      code: string;
      municipality: string;
      categories: Record<string, Cell>;
    }
  >();
  const municipalities = new Map<string, Record<string, Cell>>();
  for (const r of byFacility) {
    const f = facilityRows.get(r.facilityId) ?? {
      facilityId: r.facilityId,
      facility: r.facility,
      code: r.code,
      municipality: r.municipality,
      categories: {},
    };
    f.categories[r.category] = { total: Number(r.total), inService: Number(r.inService) };
    facilityRows.set(r.facilityId, f);
    const m = municipalities.get(r.municipality) ?? {};
    const cell = m[r.category] ?? { total: 0, inService: 0 };
    cell.total += Number(r.total);
    cell.inService += Number(r.inService);
    m[r.category] = cell;
    municipalities.set(r.municipality, m);
  }
  const totalScheduled = maintenance.reduce((a, m) => a + Number(m.scheduled), 0);
  const totalOverdue = maintenance.reduce((a, m) => a + Number(m.overdue), 0);
  res.json({
    categories: NATIONAL_CATEGORIES,
    byFacility: [...facilityRows.values()],
    byMunicipality: [...municipalities.entries()]
      .map(([municipality, categories]) => ({ municipality, categories }))
      .sort((a, b) => a.municipality.localeCompare(b.municipality)),
    maintenance: maintenance.map((m) => ({
      facilityId: m.facilityId,
      facility: m.facility,
      municipality: m.municipality,
      total: Number(m.total),
      overdue: Number(m.overdue),
      outOfService: Number(m.outOfService),
      overduePct: Number(m.scheduled)
        ? Math.round((1000 * Number(m.overdue)) / Number(m.scheduled)) / 10
        : null,
    })),
    overduePct: totalScheduled ? Math.round((1000 * totalOverdue) / totalScheduled) / 10 : null,
    faultsByMonth: faults.map((f) => ({ month: f.month, count: Number(f.count) })),
  });
});
