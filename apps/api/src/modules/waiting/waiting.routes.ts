import { Router, type Request } from 'express';
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  appointments,
  facilities,
  patients,
  referrals,
  surgicalCases,
  users,
  waitingListEntries,
  waitingListEvents,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertDemographicsAccess,
  auditRecordView,
  resolveClinicalReadAccess,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  ACTIVE_STATUSES,
  BREACHED_SQL,
  CLINICAL_REMOVAL_REASONS,
  isBreached,
  kosovoDate,
  MAX_DAYS,
  MAX_WAIT_DAYS,
  openSuspensionDays,
  PRIORITIES,
  PRIORITY_ORDER_SQL,
  recordEvent,
  REMOVAL_REASONS,
  SPECIALTIES,
  SPECIALTY_LABELS,
  STATUSES,
  suppress,
  targetDateFor,
  WAIT_DAYS_SQL,
  waitingDays,
  type Priority,
  type WaitStats,
} from './waiting.service.js';

/**
 * Elective waiting lists (see waiting.service.ts). Facility staff manage their own facility's
 * lists: doctors add patients and make the clinical decisions (priority, removal as no longer
 * needed), reception schedules and records postponements, directors follow the dashboard. The
 * Ministry sees national aggregates only; anyone can read the published waiting times.
 */
export const waitingListRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const STAFF = ['DOCTOR', 'RECEPTION', 'DIRECTOR'] as const;

type Entry = typeof waitingListEntries.$inferSelect;

/** Public (no personal data) and staff-facing shape of an entry. */
function present(
  e: Entry,
  extra: {
    facilityName?: string | null;
    addedByName?: string | null;
    patient?: { id: string; name: string; nationalId: string; dateOfBirth: string } | null;
    includeClinicalReason?: boolean;
  } = {},
) {
  const now = new Date();
  return {
    id: e.id,
    patientId: e.patientId,
    patient: extra.patient ?? undefined,
    facilityId: e.facilityId,
    facilityName: extra.facilityName ?? undefined,
    specialty: e.specialty,
    kind: e.kind,
    procedureCode: e.procedureCode,
    procedureName: e.procedureName,
    priority: e.priority,
    clinicalReason: extra.includeClinicalReason ? e.clinicalReason : undefined,
    referralId: e.referralId,
    addedById: e.addedById,
    addedByName: extra.addedByName ?? undefined,
    addedAt: e.addedAt,
    targetDate: e.targetDate,
    status: e.status,
    scheduledFor: e.scheduledFor,
    surgicalCaseId: e.surgicalCaseId,
    appointmentId: e.appointmentId,
    suspendedDays:
      e.suspendedDays + (e.status === 'SUSPENDED' ? openSuspensionDays(e.suspendedSince, now) : 0),
    suspendedSince: e.suspendedSince,
    removedReason: e.removedReason,
    completedAt: e.completedAt,
    waitingDays: waitingDays(e, now),
    maxDays: MAX_WAIT_DAYS[e.priority as Priority] ?? MAX_WAIT_DAYS.ROUTINE,
    breached: ['WAITING', 'SCHEDULED', 'SUSPENDED'].includes(e.status) && isBreached(e, now),
    scheduledAfterTarget:
      e.status === 'SCHEDULED' &&
      e.scheduledFor !== null &&
      kosovoDate(e.scheduledFor) > e.targetDate,
  };
}

/* ------------------------------------------------------------------------ public times -- */

/**
 * Published waiting times (no sign-in): median and 90th percentile days waited for entries
 * completed in the last 12 months, per facility and specialty. Groups below the small-cell
 * threshold are suppressed. No personal data.
 */
waitingListRouter.get('/public/times', async (_req, res) => {
  const since = new Date(Date.now() - 365 * 86_400_000);
  const rows = await db
    .select({
      facilityId: waitingListEntries.facilityId,
      facilityName: facilities.name,
      municipality: facilities.municipality,
      specialty: waitingListEntries.specialty,
      kind: waitingListEntries.kind,
      count: sql<number>`count(*)::int`,
      medianDays: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${WAIT_DAYS_SQL})`,
      p90Days: sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${WAIT_DAYS_SQL})`,
    })
    .from(waitingListEntries)
    .innerJoin(facilities, eq(facilities.id, waitingListEntries.facilityId))
    .where(
      and(eq(waitingListEntries.status, 'COMPLETED'), gte(waitingListEntries.completedAt, since)),
    )
    .groupBy(
      waitingListEntries.facilityId,
      facilities.name,
      facilities.municipality,
      waitingListEntries.specialty,
      waitingListEntries.kind,
    )
    .orderBy(facilities.name, waitingListEntries.specialty);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    period: { from: since.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    items: rows.map((r) => {
      const suppressed = r.count < SMALL_CELL_THRESHOLD;
      return {
        facilityName: r.facilityName,
        municipality: r.municipality,
        specialty: r.specialty,
        kind: r.kind,
        completed: suppressed ? null : r.count,
        medianDays: suppressed ? null : Math.round(Number(r.medianDays)),
        p90Days: suppressed ? null : Math.round(Number(r.p90Days)),
        suppressed,
      };
    }),
  });
});

waitingListRouter.use(authenticate);

/* ---------------------------------------------------------------------- reference data -- */

waitingListRouter.get('/specialties', (_req, res) => {
  res.json({
    specialties: SPECIALTIES.map((code) => ({ code, label: SPECIALTY_LABELS[code] })),
    priorities: PRIORITIES.map((code) => ({ code, maxDays: MAX_WAIT_DAYS[code] })),
    removalReasons: REMOVAL_REASONS.map((code) => ({
      code,
      clinical: CLINICAL_REMOVAL_REASONS.has(code),
    })),
  });
});

/* ------------------------------------------------------------------------------- helpers -- */

function assertFacilityStaff(ctx: AuthContext, roles: readonly string[] = STAFF): string {
  if (!roles.includes(ctx.role) || !ctx.facilityId) throw forbidden();
  return ctx.facilityId;
}

/** Loads an entry of the caller's facility (404 otherwise – other facilities' lists are not visible). */
async function loadEntry(ctx: AuthContext, id: string, executor: Executor = db, lock = false) {
  const facilityId = assertFacilityStaff(ctx);
  const q = executor
    .select()
    .from(waitingListEntries)
    .where(and(eq(waitingListEntries.id, id), eq(waitingListEntries.facilityId, facilityId)));
  const [entry] = lock ? await q.for('update') : await q;
  if (!entry) throw notFound('Waiting list entry not found');
  return entry;
}

async function auditChange(
  req: Request,
  ctx: AuthContext,
  entry: Entry,
  event: string,
  executor: Executor,
  metadata: Record<string, unknown> = {},
) {
  await audit(
    {
      action: event === 'ADDED' ? AuditAction.WAITING_LIST_ADDED : AuditAction.WAITING_LIST_CHANGED,
      actor: ctx,
      resourceType: 'waiting_list_entry',
      resourceId: entry.id,
      patientId: entry.patientId,
      meta: requestMeta(req),
      metadata: { event, specialty: entry.specialty, ...metadata },
    },
    executor,
  );
}

function assertStatus(entry: Entry, allowed: readonly string[], message: string) {
  if (!allowed.includes(entry.status)) throw conflict(message);
}

/** Days of the open suspension are added to suspendedDays when the suspension ends. */
function closeSuspension(entry: Entry, now: Date) {
  if (entry.status !== 'SUSPENDED') return { suspendedDays: entry.suspendedDays };
  return {
    suspendedDays: entry.suspendedDays + openSuspensionDays(entry.suspendedSince, now),
    suspendedSince: null,
  };
}

/* -------------------------------------------------------------------------------- list -- */

const ListQuery = PaginationSchema.extend({
  specialty: z.enum(SPECIALTIES).optional(),
  status: z.enum([...STATUSES, 'ACTIVE']).default('ACTIVE'),
  priority: z.enum(PRIORITIES).optional(),
  breached: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().trim().max(100).optional(),
});

waitingListRouter.get('/', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx);
  const query = parse(ListQuery, req.query);
  const conditions: SQL[] = [eq(waitingListEntries.facilityId, facilityId)];
  if (query.status === 'ACTIVE') {
    conditions.push(inArray(waitingListEntries.status, [...ACTIVE_STATUSES]));
  } else conditions.push(eq(waitingListEntries.status, query.status));
  if (query.specialty) conditions.push(eq(waitingListEntries.specialty, query.specialty));
  if (query.priority) conditions.push(eq(waitingListEntries.priority, query.priority));
  if (query.breached !== undefined) {
    conditions.push(query.breached ? BREACHED_SQL : sql`NOT ${BREACHED_SQL}`);
  }
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      or(
        ilike(patients.lastName, like),
        ilike(patients.firstName, like),
        ilike(patients.nationalId, like),
        ilike(waitingListEntries.procedureName, like),
      )!,
    );
  }
  const where = and(...conditions);
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(waitingListEntries)
    .innerJoin(patients, eq(patients.id, waitingListEntries.patientId))
    .where(where);
  const rows = await db
    .select({
      entry: waitingListEntries,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      addedByName: users.fullName,
    })
    .from(waitingListEntries)
    .innerJoin(patients, eq(patients.id, waitingListEntries.patientId))
    .leftJoin(users, eq(users.id, waitingListEntries.addedById))
    .where(where)
    .orderBy(
      PRIORITY_ORDER_SQL,
      asc(waitingListEntries.targetDate),
      asc(waitingListEntries.addedAt),
    )
    .limit(query.pageSize)
    .offset(toOffset(query).offset);
  res.json(
    paginated(
      rows.map((r) =>
        present(r.entry, {
          addedByName: r.addedByName,
          patient: {
            id: r.entry.patientId,
            name: `${r.firstName} ${r.lastName}`,
            nationalId: r.nationalId,
            dateOfBirth: r.dateOfBirth,
          },
        }),
      ),
      Number(total),
      query,
    ),
  );
});

/* --------------------------------------------------------------------------------- add -- */

const AddInput = z.object({
  patientId: z.string().uuid(),
  specialty: z.enum(SPECIALTIES),
  kind: z.enum(['PROCEDURE', 'OUTPATIENT']).default('PROCEDURE'),
  procedureCode: z.string().trim().max(20).optional().nullable(),
  procedureName: z.string().trim().min(3).max(200),
  priority: z.enum(PRIORITIES),
  clinicalReason: z.string().trim().max(2000).optional().nullable(),
  referralId: z.string().uuid().optional().nullable(),
});

waitingListRouter.post('/', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx, ['DOCTOR']);
  const input = parse(AddInput, req.body);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, input.patientId, meta, ['DOCTOR']);
  const [patient] = await db
    .select({ deceasedAt: patients.deceasedAt })
    .from(patients)
    .where(eq(patients.id, input.patientId));
  if (patient?.deceasedAt)
    throw conflict('This patient has died – they cannot be added to a waiting list');
  if (input.referralId) {
    const [ref] = await db
      .select({ patientId: referrals.patientId })
      .from(referrals)
      .where(eq(referrals.id, input.referralId));
    if (!ref || ref.patientId !== input.patientId) {
      throw badRequest('The referral does not belong to this patient');
    }
  }
  const now = new Date();
  const created = await db.transaction(async (tx) => {
    // One active entry per patient, facility, specialty and procedure.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`waiting:${input.patientId}`}))`);
    const same = input.procedureCode
      ? or(
          eq(waitingListEntries.procedureCode, input.procedureCode),
          sql`lower(${waitingListEntries.procedureName}) = lower(${input.procedureName})`,
        )
      : sql`lower(${waitingListEntries.procedureName}) = lower(${input.procedureName})`;
    const [dup] = await tx
      .select({ id: waitingListEntries.id })
      .from(waitingListEntries)
      .where(
        and(
          eq(waitingListEntries.patientId, input.patientId),
          eq(waitingListEntries.facilityId, facilityId),
          eq(waitingListEntries.specialty, input.specialty),
          inArray(waitingListEntries.status, [...ACTIVE_STATUSES]),
          same,
        ),
      )
      .limit(1);
    if (dup) throw conflict('The patient is already on this waiting list');
    const [row] = await tx
      .insert(waitingListEntries)
      .values({
        patientId: input.patientId,
        facilityId,
        specialty: input.specialty,
        kind: input.kind,
        procedureCode: input.procedureCode || null,
        procedureName: input.procedureName,
        priority: input.priority,
        clinicalReason: input.clinicalReason || null,
        referralId: input.referralId ?? null,
        addedById: ctx.userId,
        addedAt: now,
        targetDate: targetDateFor(now, input.priority, 0),
      })
      .returning();
    await recordEvent(tx, row!, ctx.userId, 'ADDED', {
      priority: input.priority,
      targetDate: row!.targetDate,
    });
    await auditChange(req, ctx, row!, 'ADDED', tx, { priority: input.priority });
    return row!;
  });
  res.status(201).json(present(created, { includeClinicalReason: true }));
});

/* ------------------------------------------------------------------ dashboards (aggregate) -- */

const statsSelect = {
  count: sql<number>`count(*)::int`,
  medianDays: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${WAIT_DAYS_SQL})`,
  p90Days: sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${WAIT_DAYS_SQL})`,
  breaches: sql<number>`count(*) FILTER (WHERE ${BREACHED_SQL})::int`,
  longestDays: sql<number>`max(${WAIT_DAYS_SQL})`,
};
const toStats = (r: {
  count: number;
  medianDays: number | null;
  p90Days: number | null;
  breaches: number;
}): WaitStats => ({
  count: Number(r.count),
  medianDays: r.medianDays === null ? null : Math.round(Number(r.medianDays)),
  p90Days: r.p90Days === null ? null : Math.round(Number(r.p90Days)),
  breaches: Number(r.breaches),
  suppressed: false,
});

waitingListRouter.get('/dashboard', requireRole('DIRECTOR', 'DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx, ['DIRECTOR', 'DOCTOR']);
  const active = and(
    eq(waitingListEntries.facilityId, facilityId),
    inArray(waitingListEntries.status, [...ACTIVE_STATUSES]),
  );
  const bySpecialty = await db
    .select({
      specialty: waitingListEntries.specialty,
      ...statsSelect,
      urgent: sql<number>`count(*) FILTER (WHERE ${waitingListEntries.priority} = 'URGENT')::int`,
      scheduled: sql<number>`count(*) FILTER (WHERE ${waitingListEntries.status} = 'SCHEDULED')::int`,
      suspended: sql<number>`count(*) FILTER (WHERE ${waitingListEntries.status} = 'SUSPENDED')::int`,
    })
    .from(waitingListEntries)
    .where(active)
    .groupBy(waitingListEntries.specialty)
    .orderBy(waitingListEntries.specialty);
  const [totals] = await db.select(statsSelect).from(waitingListEntries).where(active);
  const longest = await db
    .select({
      entry: waitingListEntries,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(waitingListEntries)
    .innerJoin(patients, eq(patients.id, waitingListEntries.patientId))
    .where(active)
    .orderBy(desc(sql`${WAIT_DAYS_SQL}::float / ${MAX_DAYS}`))
    .limit(10);
  const since = new Date(Date.now() - 365 * 86_400_000);
  const [completed] = await db
    .select({
      count: sql<number>`count(*)::int`,
      medianDays: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${WAIT_DAYS_SQL})`,
      withinTarget: sql<number>`count(*) FILTER (WHERE NOT ${BREACHED_SQL})::int`,
    })
    .from(waitingListEntries)
    .where(
      and(
        eq(waitingListEntries.facilityId, facilityId),
        eq(waitingListEntries.status, 'COMPLETED'),
        gte(waitingListEntries.completedAt, since),
      ),
    );
  res.json({
    totals: totals ? { ...toStats(totals), longestDays: totals.longestDays ?? null } : null,
    bySpecialty: bySpecialty.map((r) => ({
      specialty: r.specialty,
      ...toStats(r),
      longestDays: r.longestDays,
      urgent: r.urgent,
      scheduled: r.scheduled,
      suspended: r.suspended,
    })),
    longestWaits: longest.map((r) =>
      present(r.entry, {
        patient:
          ctx.role === 'DIRECTOR' || ctx.role === 'DOCTOR'
            ? {
                id: r.entry.patientId,
                name: `${r.firstName} ${r.lastName}`,
                nationalId: r.nationalId,
                dateOfBirth: r.dateOfBirth,
              }
            : null,
      }),
    ),
    completedLast12Months: {
      count: Number(completed?.count ?? 0),
      medianDays:
        completed?.medianDays === null || completed?.medianDays === undefined
          ? null
          : Math.round(Number(completed.medianDays)),
      withinTargetPct: completed?.count
        ? Math.round((Number(completed.withinTarget) / Number(completed.count)) * 1000) / 10
        : null,
    },
  });
});

waitingListRouter.get('/national', requireRole('MINISTRY'), async (_req, res) => {
  const active = inArray(waitingListEntries.status, [...ACTIVE_STATUSES]);
  const bySpecialty = await db
    .select({ specialty: waitingListEntries.specialty, ...statsSelect })
    .from(waitingListEntries)
    .where(active)
    .groupBy(waitingListEntries.specialty)
    .orderBy(waitingListEntries.specialty);
  const byFacility = await db
    .select({
      facilityId: waitingListEntries.facilityId,
      facilityName: facilities.name,
      specialty: waitingListEntries.specialty,
      ...statsSelect,
    })
    .from(waitingListEntries)
    .innerJoin(facilities, eq(facilities.id, waitingListEntries.facilityId))
    .where(active)
    .groupBy(waitingListEntries.facilityId, facilities.name, waitingListEntries.specialty)
    .orderBy(facilities.name, waitingListEntries.specialty);
  const [totals] = await db.select(statsSelect).from(waitingListEntries).where(active);
  res.json({
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    totals: totals ? suppress(toStats(totals)) : null,
    bySpecialty: bySpecialty.map((r) => ({ specialty: r.specialty, ...suppress(toStats(r)) })),
    byFacility: byFacility.map((r) => ({
      facilityId: r.facilityId,
      facilityName: r.facilityName,
      specialty: r.specialty,
      ...suppress(toStats(r)),
    })),
  });
});

/* ------------------------------------------------------------------------------ portal -- */

/** The patient's own entries (guardians with appointments-only access see dates and places only). */
waitingListRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  // Guardians with appointments-only access see dates and the facility, not what the procedure is.
  const limited = Boolean(ctx.proxy && ctx.proxy.scope !== 'FULL');
  if (ctx.proxy) {
    await auditRecordView(ctx, ctx.patientId, 'GUARDIAN', 'waiting-lists', requestMeta(req));
  }
  const rows = await db
    .select({ entry: waitingListEntries, facilityName: facilities.name })
    .from(waitingListEntries)
    .innerJoin(facilities, eq(facilities.id, waitingListEntries.facilityId))
    .where(eq(waitingListEntries.patientId, ctx.patientId))
    .orderBy(desc(waitingListEntries.addedAt));
  res.json({
    items: rows.map((r) => {
      const p = present(r.entry, { facilityName: r.facilityName });
      // No queue positions, no internal identifiers of staff.
      return {
        id: p.id,
        facilityName: p.facilityName,
        specialty: limited ? null : p.specialty,
        kind: p.kind,
        procedureName: limited ? null : p.procedureName,
        priority: limited ? null : p.priority,
        status: p.status,
        addedAt: p.addedAt,
        targetDate: p.targetDate,
        scheduledFor: p.scheduledFor,
        completedAt: p.completedAt,
        removedReason: limited ? null : p.removedReason,
        waitingDays: p.waitingDays,
        maxDays: p.maxDays,
        suspendedDays: p.suspendedDays,
      };
    }),
  });
});

/* -------------------------------------------------------------------------- chart tab -- */

waitingListRouter.get('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const meta = requestMeta(req);
  let clinical = false;
  if (ctx.role === 'DOCTOR' || ctx.role === 'NURSE') {
    const basis = await resolveClinicalReadAccess(ctx, patientId, meta);
    await auditRecordView(ctx, patientId, basis, 'waiting-lists', meta);
    clinical = true;
  } else if (ctx.role === 'RECEPTION' || ctx.role === 'DIRECTOR') {
    await assertDemographicsAccess(ctx, patientId);
  } else {
    throw forbidden();
  }
  const rows = await db
    .select({
      entry: waitingListEntries,
      facilityName: facilities.name,
      addedByName: users.fullName,
    })
    .from(waitingListEntries)
    .innerJoin(facilities, eq(facilities.id, waitingListEntries.facilityId))
    .leftJoin(users, eq(users.id, waitingListEntries.addedById))
    .where(
      and(
        eq(waitingListEntries.patientId, patientId),
        // Non-clinical staff see their own facility's entries only.
        clinical ? undefined : eq(waitingListEntries.facilityId, ctx.facilityId ?? ''),
      ),
    )
    .orderBy(desc(waitingListEntries.addedAt));
  res.json({
    items: rows.map((r) =>
      present(r.entry, {
        facilityName: r.facilityName,
        addedByName: r.addedByName,
        includeClinicalReason: clinical,
      }),
    ),
  });
});

/* ------------------------------------------------------------------------------- entry -- */

waitingListRouter.get('/:id', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const entry = await loadEntry(ctx, id);
  const [p] = await db
    .select({
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(patients)
    .where(eq(patients.id, entry.patientId));
  const [addedBy] = await db
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, entry.addedById));
  const events = await db
    .select({
      id: waitingListEvents.id,
      event: waitingListEvents.event,
      details: waitingListEvents.details,
      reason: waitingListEvents.reason,
      createdAt: waitingListEvents.createdAt,
      actorName: users.fullName,
    })
    .from(waitingListEvents)
    .leftJoin(users, eq(users.id, waitingListEvents.actorId))
    .where(eq(waitingListEvents.entryId, entry.id))
    .orderBy(asc(waitingListEvents.createdAt));
  res.json({
    ...present(entry, {
      addedByName: addedBy?.name ?? null,
      // The clinical reason is shown to the doctor who added the entry; others use the chart.
      includeClinicalReason: entry.addedById === ctx.userId,
      patient: p
        ? {
            id: entry.patientId,
            name: `${p.firstName} ${p.lastName}`,
            nationalId: p.nationalId,
            dateOfBirth: p.dateOfBirth,
          }
        : null,
    }),
    events,
  });
});

/* --------------------------------------------------------------------------- lifecycle -- */

const Reason = z.string().trim().min(3).max(500);

/** Runs a change in a transaction on a locked entry of the caller's facility. */
async function change(
  req: Request,
  roles: readonly string[],
  mutate: (
    entry: Entry,
    tx: Executor,
    ctx: AuthContext,
  ) => Promise<{
    set: Partial<typeof waitingListEntries.$inferInsert>;
    event: string;
    details?: Record<string, unknown>;
    reason?: string | null;
  } | null>,
) {
  const ctx = requireAuth(req);
  if (!roles.includes(ctx.role)) throw forbidden();
  const { id } = parse(IdParam, req.params);
  return db.transaction(async (tx) => {
    const entry = await loadEntry(ctx, id, tx, true);
    const result = await mutate(entry, tx, ctx);
    if (!result) return entry;
    const [updated] = await tx
      .update(waitingListEntries)
      .set(result.set)
      .where(eq(waitingListEntries.id, entry.id))
      .returning();
    await recordEvent(
      tx,
      entry,
      ctx.userId,
      result.event,
      result.details ?? null,
      result.reason ?? null,
    );
    await auditChange(req, ctx, updated!, result.event, tx, result.details ?? {});
    return updated!;
  });
}

const ScheduleInput = z
  .object({
    scheduledFor: z.coerce.date(),
    surgicalCaseId: z.string().uuid().optional().nullable(),
    appointmentId: z.string().uuid().optional().nullable(),
  })
  .refine((v) => !(v.surgicalCaseId && v.appointmentId), {
    message: 'Link either an operation or an appointment, not both',
  });

waitingListRouter.post('/:id/schedule', async (req, res) => {
  const input = parse(ScheduleInput, req.body);
  let notify: { patientId: string; date: Date; facilityId: string } | null = null;
  const updated = await change(req, ['DOCTOR', 'RECEPTION'], async (entry, tx) => {
    assertStatus(
      entry,
      ['WAITING', 'SCHEDULED'],
      'Only waiting or scheduled entries can be scheduled (resume a postponed entry first)',
    );
    if (input.scheduledFor.getTime() < Date.now() - 60 * 60_000) {
      throw badRequest('The scheduled date must be in the future');
    }
    if (input.surgicalCaseId) {
      const [c] = await tx
        .select({ patientId: surgicalCases.patientId })
        .from(surgicalCases)
        .where(eq(surgicalCases.id, input.surgicalCaseId));
      if (!c || c.patientId !== entry.patientId) {
        throw badRequest('The operation does not belong to this patient');
      }
    }
    if (input.appointmentId) {
      const [a] = await tx
        .select({ patientId: appointments.patientId })
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId));
      if (!a || a.patientId !== entry.patientId) {
        throw badRequest('The appointment does not belong to this patient');
      }
    }
    notify = { patientId: entry.patientId, date: input.scheduledFor, facilityId: entry.facilityId };
    return {
      set: {
        status: 'SCHEDULED',
        scheduledFor: input.scheduledFor,
        surgicalCaseId: input.surgicalCaseId ?? null,
        appointmentId: input.appointmentId ?? null,
      },
      event: entry.status === 'SCHEDULED' ? 'RESCHEDULED' : 'SCHEDULED',
      details: {
        scheduledFor: input.scheduledFor.toISOString(),
        previous: entry.scheduledFor?.toISOString() ?? null,
        surgicalCaseId: input.surgicalCaseId ?? null,
        appointmentId: input.appointmentId ?? null,
      },
    };
  });
  const n = notify as { patientId: string; date: Date; facilityId: string } | null;
  if (n) {
    const [f] = await db
      .select({ name: facilities.name })
      .from(facilities)
      .where(eq(facilities.id, n.facilityId));
    // Date and place only – never the procedure.
    await notifyPatient(
      n.patientId,
      {
        type: 'appointment',
        title: 'Your planned treatment is scheduled for {date} at {facility}',
        vars: { date: n.date, facility: f?.name ?? '' },
        link: '/portal/waiting-lists',
        important: true,
      },
      db,
      { guardians: 'all' },
    ).catch(() => undefined);
  }
  res.json(present(updated));
});

waitingListRouter.post('/:id/unschedule', async (req, res) => {
  const { reason } = parse(z.object({ reason: Reason }), req.body);
  const updated = await change(req, ['DOCTOR', 'RECEPTION'], async (entry) => {
    assertStatus(entry, ['SCHEDULED'], 'The entry is not scheduled');
    return {
      set: { status: 'WAITING', scheduledFor: null, surgicalCaseId: null, appointmentId: null },
      event: 'UNSCHEDULED',
      details: { previous: entry.scheduledFor?.toISOString() ?? null },
      reason,
    };
  });
  res.json(present(updated));
});

waitingListRouter.post('/:id/suspend', async (req, res) => {
  const { reason } = parse(z.object({ reason: Reason }), req.body);
  const updated = await change(req, ['DOCTOR', 'RECEPTION'], async (entry) => {
    assertStatus(
      entry,
      ['WAITING', 'SCHEDULED'],
      'Only waiting or scheduled entries can be postponed',
    );
    return {
      set: {
        status: 'SUSPENDED',
        suspendedSince: new Date(),
        scheduledFor: null,
        surgicalCaseId: null,
        appointmentId: null,
      },
      event: 'SUSPENDED',
      details: {
        previousStatus: entry.status,
        previousSchedule: entry.scheduledFor?.toISOString() ?? null,
      },
      reason,
    };
  });
  res.json(present(updated));
});

waitingListRouter.post('/:id/resume', async (req, res) => {
  const updated = await change(req, ['DOCTOR', 'RECEPTION'], async (entry) => {
    assertStatus(entry, ['SUSPENDED'], 'The entry is not postponed');
    const now = new Date();
    const closed = closeSuspension(entry, now);
    return {
      set: {
        status: 'WAITING',
        ...closed,
        suspendedSince: null,
        targetDate: targetDateFor(entry.addedAt, entry.priority as Priority, closed.suspendedDays),
      },
      event: 'RESUMED',
      details: { pausedDays: closed.suspendedDays - entry.suspendedDays },
    };
  });
  res.json(present(updated));
});

waitingListRouter.post('/:id/priority', async (req, res) => {
  const input = parse(z.object({ priority: z.enum(PRIORITIES), reason: Reason }), req.body);
  const updated = await change(req, ['DOCTOR'], async (entry, _tx, ctx) => {
    assertStatus(entry, ACTIVE_STATUSES, 'Only active entries can change priority');
    if (entry.priority === input.priority) throw badRequest('The entry already has this priority');
    await assertClinicalWriteAccess(ctx, entry.patientId, requestMeta(req), ['DOCTOR']);
    return {
      set: {
        priority: input.priority,
        targetDate: targetDateFor(entry.addedAt, input.priority, entry.suspendedDays),
      },
      event: 'PRIORITY_CHANGED',
      details: { from: entry.priority, to: input.priority },
      reason: input.reason,
    };
  });
  res.json(present(updated));
});

waitingListRouter.post('/:id/complete', async (req, res) => {
  const input = parse(z.object({ completedAt: z.coerce.date().optional() }), req.body ?? {});
  const updated = await change(req, ['DOCTOR', 'RECEPTION'], async (entry) => {
    assertStatus(
      entry,
      ['WAITING', 'SCHEDULED'],
      'Only waiting or scheduled entries can be completed',
    );
    const at = input.completedAt ?? new Date();
    if (at.getTime() > Date.now() + 5 * 60_000 || at < entry.addedAt) {
      throw badRequest('The completion date must be between the date added and now');
    }
    return {
      set: { status: 'COMPLETED', completedAt: at },
      event: 'COMPLETED',
      details: {
        completedAt: at.toISOString(),
        waitingDays: waitingDays({ ...entry, status: 'COMPLETED', completedAt: at }),
      },
    };
  });
  res.json(present(updated));
});

waitingListRouter.post('/:id/remove', async (req, res) => {
  const input = parse(
    z.object({
      reasonCode: z.enum(REMOVAL_REASONS),
      reason: z.string().trim().max(500).optional(),
    }),
    req.body,
  );
  const updated = await change(req, ['DOCTOR', 'RECEPTION'], async (entry, _tx, ctx) => {
    assertStatus(entry, ACTIVE_STATUSES, 'The entry is no longer active');
    if (CLINICAL_REMOVAL_REASONS.has(input.reasonCode)) {
      if (ctx.role !== 'DOCTOR') {
        throw forbidden('Only a doctor can remove a patient from the list for clinical reasons');
      }
      await assertClinicalWriteAccess(ctx, entry.patientId, requestMeta(req), ['DOCTOR']);
    }
    if (input.reasonCode === 'OTHER' && !input.reason) {
      throw badRequest('Describe the reason for removal');
    }
    const closed = closeSuspension(entry, new Date());
    return {
      set: { status: 'REMOVED', removedReason: input.reasonCode, ...closed, suspendedSince: null },
      event: 'REMOVED',
      details: { reasonCode: input.reasonCode },
      reason: input.reason ?? null,
    };
  });
  res.json(present(updated));
});
