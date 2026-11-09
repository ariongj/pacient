import { Router } from 'express';
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  labOrders,
  labPriorityEnum,
  labResults,
  labSpecimenEvents,
  patients,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { auditRecordView } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { catalogByCode, flagFor } from './catalog.js';
import { alertDoctor } from './ingest.js';
import {
  assertLabStaff,
  barcodes,
  currentResult,
  enteredBy,
  isLabStaff,
  latestEvents,
  OPEN_STATUSES,
  percentiles,
  recordSpecimenEvent,
  REJECTION_REASONS,
} from './work.service.js';

/** Laboratory work: worklist, specimen tracking, manual result entry and validation. */
export const labWorkRouter = Router();
labWorkRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const Barcode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{4,40}$/, 'A barcode has 4–40 letters, digits or dashes');

const WorklistQuery = PaginationSchema.extend({
  /** open: waiting for collection, receipt or a result; validation: results to validate; done: last 7 days. */
  view: z.enum(['open', 'validation', 'done']).default('open'),
  priority: z.enum(labPriorityEnum.enumValues).optional(),
  q: z.string().trim().max(60).optional(),
});

/** What the laboratory sees of each order (no chart content beyond the order itself). */
labWorkRouter.get('/worklist', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = await assertLabStaff(ctx);
  const q = parse(WorklistQuery, req.query);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const statusFilter =
    q.view === 'open'
      ? inArray(labOrders.status, [...OPEN_STATUSES])
      : q.view === 'validation'
        ? eq(labOrders.status, 'IN_PROGRESS')
        : and(eq(labOrders.status, 'RESULTED'), gte(labOrders.resultedAt, since));
  const search = q.q
    ? or(
        ilike(labOrders.placerOrderNumber, `%${q.q}%`),
        ilike(patients.lastName, `%${q.q}%`),
        ilike(patients.firstName, `%${q.q}%`),
        eq(patients.nationalId, q.q),
      )
    : undefined;
  const where = and(
    eq(labOrders.facilityId, facilityId),
    statusFilter,
    q.priority ? eq(labOrders.priority, q.priority) : undefined,
    search,
  );
  const priorityOrder = sql`CASE ${labOrders.priority} WHEN 'STAT' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END`;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        order: labOrders,
        orderedBy: users.fullName,
        patient: {
          id: patients.id,
          firstName: patients.firstName,
          lastName: patients.lastName,
          dateOfBirth: patients.dateOfBirth,
          sex: patients.sex,
          nationalId: patients.nationalId,
          temporaryIdentity: patients.temporaryIdentity,
        },
      })
      .from(labOrders)
      .innerJoin(patients, eq(patients.id, labOrders.patientId))
      .innerJoin(users, eq(users.id, labOrders.orderedById))
      .where(where)
      .orderBy(
        q.view === 'done' ? desc(labOrders.resultedAt) : priorityOrder,
        asc(labOrders.createdAt),
      )
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db
      .select({ n: count() })
      .from(labOrders)
      .innerJoin(patients, eq(patients.id, labOrders.patientId))
      .where(where),
  ]);
  const ids = rows.map((r) => r.order.id);
  const [events, codes] = await Promise.all([latestEvents(db, ids), barcodes(db, ids)]);
  const results = ids.length
    ? await db
        .select()
        .from(labResults)
        .where(and(inArray(labResults.orderId, ids), sql`${labResults.supersededById} IS NULL`))
    : [];
  const resultByOrder = new Map(results.map((r) => [r.orderId!, r]));
  const authors = await enteredBy(
    db,
    results.filter((r) => r.status === 'PRELIMINARY').map((r) => r.id),
  );
  const authorNames = new Map(
    (authors.size
      ? await db
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(inArray(users.id, [...new Set(authors.values())]))
      : []
    ).map((u) => [u.id, u.name]),
  );
  const meta = requestMeta(req);
  // Each patient shown to laboratory staff appears in their access log (at most every 10 min).
  for (const r of rows) await auditRecordView(ctx, r.patient.id, 'UNIT', 'lab-worklist', meta);
  res.json(
    paginated(
      rows.map((r) => {
        const result = resultByOrder.get(r.order.id) ?? null;
        const author = result ? (authors.get(result.id) ?? null) : null;
        const event = events.get(r.order.id) ?? null;
        return {
          id: r.order.id,
          placerOrderNumber: r.order.placerOrderNumber,
          testCode: r.order.testCode,
          testName: r.order.testName,
          specimen: r.order.specimen,
          priority: r.order.priority,
          status: r.order.status,
          clinicalNotes: r.order.clinicalNotes,
          createdAt: r.order.createdAt,
          receivedAt: r.order.receivedAt,
          resultedAt: r.order.resultedAt,
          orderedBy: r.orderedBy,
          lisManaged: r.order.labClientId !== null,
          patient: r.patient,
          barcode: codes.get(r.order.id) ?? null,
          lastEvent: event
            ? { event: event.event, reason: event.reason, at: event.occurredAt }
            : null,
          result: result
            ? {
                id: result.id,
                value: result.value,
                unit: result.unit,
                referenceRange: result.referenceRange,
                flag: result.flag,
                status: result.status,
                enteredById: author,
                enteredByName: author ? (authorNames.get(author) ?? null) : null,
                canValidate:
                  result.status === 'PRELIMINARY' &&
                  result.source === 'MANUAL' &&
                  author !== null &&
                  author !== ctx.userId,
              }
            : null,
        };
      }),
      total?.n ?? 0,
      q,
    ),
  );
});

/** Whether the caller works in the laboratory (the web app shows the worklist or statistics). */
labWorkRouter.get('/me', async (req, res) => {
  const ctx = requireAuth(req);
  res.json({ labStaff: await isLabStaff(ctx), canSeeStats: ctx.role === 'DIRECTOR' });
});

async function loadOrder(id: string, facilityId: string) {
  const [order] = await db.select().from(labOrders).where(eq(labOrders.id, id));
  if (!order || order.facilityId !== facilityId) throw notFound('Order not found');
  return order;
}

const CollectInput = z.object({ barcode: Barcode.optional() });

/** The specimen was taken (barcode defaults to the order number). */
labWorkRouter.post('/orders/:id/collect', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = await assertLabStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(CollectInput, req.body ?? {});
  const order = await loadOrder(id, facilityId);
  if (order.status !== 'ORDERED') throw conflict('The specimen was already received');
  const barcode = input.barcode ?? order.placerOrderNumber;
  await db.transaction(async (tx) => {
    await recordSpecimenEvent(tx, order.id, ctx.userId, 'COLLECTED', { specimenBarcode: barcode });
    await audit(
      {
        action: AuditAction.SPECIMEN_EVENT,
        actor: ctx,
        resourceType: 'lab_order',
        resourceId: order.id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { event: 'COLLECTED' },
      },
      tx,
    );
  });
  res.json({ id: order.id, status: order.status, barcode });
});

const ReceiveInput = z.object({ barcode: Barcode });

/** The specimen arrived in the laboratory: the scanned barcode must match the order. */
labWorkRouter.post('/orders/:id/receive', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = await assertLabStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(ReceiveInput, req.body);
  const order = await loadOrder(id, facilityId);
  if (order.status !== 'ORDERED') throw conflict('The specimen was already received');
  const known = (await barcodes(db, [order.id])).get(order.id) ?? order.placerOrderNumber;
  if (input.barcode !== known) {
    throw badRequest('The barcode does not match this order – check the specimen label');
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(labOrders)
      .set({ status: 'RECEIVED', receivedAt: new Date() })
      .where(and(eq(labOrders.id, order.id), eq(labOrders.status, 'ORDERED')))
      .returning();
    if (!row) throw conflict('The specimen was already received');
    await recordSpecimenEvent(tx, order.id, ctx.userId, 'RECEIVED', {
      specimenBarcode: input.barcode,
    });
    await audit(
      {
        action: AuditAction.SPECIMEN_EVENT,
        actor: ctx,
        resourceType: 'lab_order',
        resourceId: order.id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { event: 'RECEIVED' },
      },
      tx,
    );
    return row;
  });
  res.json({ id: updated.id, status: updated.status, receivedAt: updated.receivedAt });
});

const RejectInput = z.object({
  reason: z.enum(REJECTION_REASONS),
  note: z.string().trim().max(250).optional().nullable(),
});

/**
 * The specimen cannot be used: the order goes back to "ordered" so a new sample can be taken, and
 * the ordering doctor is told (no patient name or test in the title).
 */
labWorkRouter.post('/orders/:id/reject', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = await assertLabStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(RejectInput, req.body);
  if (input.reason === 'OTHER' && !input.note) throw badRequest('Describe the problem');
  const order = await loadOrder(id, facilityId);
  if (order.status !== 'ORDERED' && order.status !== 'RECEIVED') {
    throw conflict('Only a specimen waiting for testing can be rejected');
  }
  if (order.labClientId) {
    throw conflict('This order is handled by the laboratory system');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(labOrders)
      .set({ status: 'ORDERED', receivedAt: null })
      .where(eq(labOrders.id, order.id));
    await recordSpecimenEvent(tx, order.id, ctx.userId, 'REJECTED', {
      reason: input.note ? `${input.reason}: ${input.note}` : input.reason,
    });
    await audit(
      {
        action: AuditAction.SPECIMEN_EVENT,
        actor: ctx,
        resourceType: 'lab_order',
        resourceId: order.id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { event: 'REJECTED', reason: input.reason },
      },
      tx,
    );
    await notifyUsers(
      [order.orderedById],
      {
        type: 'result',
        title: 'A laboratory specimen was rejected – a new sample is needed',
        link: `/doctor/patients/${order.patientId}`,
        important: true,
      },
      tx,
    );
  });
  res.json({ id: order.id, status: 'ORDERED' });
});

const ResultInput = z.object({
  value: z.string().trim().min(1).max(100),
  /** The technician marks a value critical even when it is within the default limits. */
  critical: z.boolean().optional(),
});

/**
 * Manual result entry (no LIS for this order): a PRELIMINARY result that another person must
 * validate. Entering again replaces the previous preliminary value.
 */
labWorkRouter.post('/orders/:id/result', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = await assertLabStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(ResultInput, req.body);
  const order = await loadOrder(id, facilityId);
  if (order.labClientId) throw conflict('This order is handled by the laboratory system');
  if (order.status !== 'RECEIVED' && order.status !== 'IN_PROGRESS') {
    throw conflict('Receive the specimen before entering a result');
  }
  const test = catalogByCode(order.testCode);
  const flag = flagFor(test, input.value, input.critical);
  const created = await db.transaction(async (tx) => {
    const current = await currentResult(tx, order.id);
    if (current && current.status !== 'PRELIMINARY') {
      throw conflict('This result was already validated');
    }
    const [row] = await tx
      .insert(labResults)
      .values({
        patientId: order.patientId,
        encounterId: order.encounterId,
        orderedById: order.orderedById,
        orderId: order.id,
        testCode: order.testCode,
        testName: order.testName,
        value: input.value,
        unit: test?.unit ?? null,
        referenceRange: test?.referenceRange ?? null,
        flag,
        status: 'PRELIMINARY',
        collectedAt: order.receivedAt ?? new Date(),
        source: 'MANUAL',
      })
      .returning();
    if (current) {
      await tx
        .update(labResults)
        .set({ supersededById: row!.id, supersededAt: new Date() })
        .where(eq(labResults.id, current.id));
    }
    await tx.update(labOrders).set({ status: 'IN_PROGRESS' }).where(eq(labOrders.id, order.id));
    await recordSpecimenEvent(tx, order.id, ctx.userId, 'RESULT_ENTERED');
    await audit(
      {
        action: AuditAction.LAB_RESULT_ENTERED,
        actor: ctx,
        resourceType: 'lab_result',
        resourceId: row!.id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { orderId: order.id, flag, replaces: current?.id ?? null },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json({
    id: created.id,
    value: created.value,
    unit: created.unit,
    flag: created.flag,
    status: created.status,
  });
});

/**
 * Validation by a second person (another laboratory technician or a laboratory doctor): the
 * result becomes FINAL and goes to the ordering doctor's results (acknowledgement and release).
 */
labWorkRouter.post('/results/:id/validate', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = await assertLabStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const outcome = await db.transaction(async (tx) => {
    const [result] = await tx.select().from(labResults).where(eq(labResults.id, id)).for('update');
    if (!result?.orderId) throw notFound('Result not found');
    const [order] = await tx.select().from(labOrders).where(eq(labOrders.id, result.orderId));
    if (!order || order.facilityId !== facilityId) throw notFound('Result not found');
    if (result.supersededById || result.status !== 'PRELIMINARY' || result.source !== 'MANUAL') {
      throw conflict('Only a preliminary result entered in the laboratory can be validated');
    }
    const author = (await enteredBy(tx, [result.id])).get(result.id);
    if (!author || author === ctx.userId) {
      throw forbidden(
        'A result must be validated by a different person than the one who entered it',
      );
    }
    const [final] = await tx
      .insert(labResults)
      .values({
        patientId: result.patientId,
        encounterId: result.encounterId,
        orderedById: result.orderedById,
        orderId: result.orderId,
        testCode: result.testCode,
        testName: result.testName,
        value: result.value,
        unit: result.unit,
        referenceRange: result.referenceRange,
        flag: result.flag,
        status: 'FINAL',
        collectedAt: result.collectedAt,
        source: 'MANUAL',
      })
      .returning();
    await tx
      .update(labResults)
      .set({ supersededById: final!.id, supersededAt: new Date() })
      .where(eq(labResults.id, result.id));
    await tx
      .update(labOrders)
      .set({ status: 'RESULTED', resultedAt: new Date() })
      .where(eq(labOrders.id, order.id));
    await recordSpecimenEvent(tx, order.id, ctx.userId, 'VALIDATED');
    await audit(
      {
        action: AuditAction.LAB_RESULT_VALIDATED,
        actor: ctx,
        resourceType: 'lab_result',
        resourceId: final!.id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: {
          orderId: order.id,
          preliminaryId: result.id,
          enteredBy: author,
          flag: final!.flag,
        },
      },
      tx,
    );
    await alertDoctor(tx, order, final!.flag === 'CRITICAL', false);
    return final!;
  });
  res.json({ id: outcome.id, status: outcome.status, flag: outcome.flag });
});

/** Specimen label data (printed from the worklist). */
labWorkRouter.get('/orders/:id/label', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = await assertLabStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const order = await loadOrder(id, facilityId);
  const [p] = await db
    .select({
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      nationalId: patients.nationalId,
      sex: patients.sex,
      temporaryIdentity: patients.temporaryIdentity,
    })
    .from(patients)
    .where(eq(patients.id, order.patientId));
  const [collected] = await db
    .select({ at: labSpecimenEvents.occurredAt })
    .from(labSpecimenEvents)
    .where(and(eq(labSpecimenEvents.orderId, order.id), eq(labSpecimenEvents.event, 'COLLECTED')))
    .orderBy(desc(labSpecimenEvents.occurredAt))
    .limit(1);
  await auditRecordView(ctx, order.patientId, 'UNIT', 'lab-label', requestMeta(req));
  res.json({
    placerOrderNumber: order.placerOrderNumber,
    barcode: (await barcodes(db, [order.id])).get(order.id) ?? order.placerOrderNumber,
    testName: order.testName,
    specimen: order.specimen,
    priority: order.priority,
    collectedAt: collected?.at ?? null,
    patient: p,
  });
});

const StatsQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) });

/**
 * Turnaround (specimen received → result final) by priority, rejections by reason and the open
 * workload. Counts and times only – no patients.
 */
labWorkRouter.get(
  '/stats',
  requireRole('DIRECTOR', 'LAB_TECHNICIAN', 'DOCTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    if (ctx.role !== 'DIRECTOR') await assertLabStaff(ctx);
    if (!ctx.facilityId) throw forbidden();
    const { days } = parse(StatsQuery, req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const done = await db
      .select({
        priority: labOrders.priority,
        minutes: sql<number>`extract(epoch from (${labOrders.resultedAt} - ${labOrders.receivedAt})) / 60`,
        lis: sql<boolean>`${labOrders.labClientId} IS NOT NULL`,
      })
      .from(labOrders)
      .where(
        and(
          eq(labOrders.facilityId, ctx.facilityId),
          eq(labOrders.status, 'RESULTED'),
          gte(labOrders.resultedAt, since),
          isNotNull(labOrders.receivedAt),
        ),
      );
    const turnaround = labPriorityEnum.enumValues.map((priority) => {
      const mins = done
        .filter((d) => d.priority === priority)
        .map((d) => Math.max(0, Number(d.minutes)));
      return { priority, count: mins.length, ...percentiles(mins) };
    });
    const rejections = await db
      .select({ reason: sql<string>`split_part(${labSpecimenEvents.reason}, ':', 1)`, n: count() })
      .from(labSpecimenEvents)
      .innerJoin(labOrders, eq(labOrders.id, labSpecimenEvents.orderId))
      .where(
        and(
          eq(labOrders.facilityId, ctx.facilityId),
          eq(labSpecimenEvents.event, 'REJECTED'),
          gte(labSpecimenEvents.occurredAt, since),
        ),
      )
      .groupBy(sql`split_part(${labSpecimenEvents.reason}, ':', 1)`);
    const open = await db
      .select({ status: labOrders.status, n: count() })
      .from(labOrders)
      .where(
        and(
          eq(labOrders.facilityId, ctx.facilityId),
          inArray(labOrders.status, [...OPEN_STATUSES]),
        ),
      )
      .groupBy(labOrders.status);
    res.json({
      days,
      turnaround,
      resulted: done.length,
      resultedByLis: done.filter((d) => d.lis).length,
      rejections: rejections
        .map((r) => ({ reason: r.reason, count: r.n }))
        .sort((a, b) => b.count - a.count),
      open: Object.fromEntries(
        OPEN_STATUSES.map((s) => [s, open.find((o) => o.status === s)?.n ?? 0]),
      ),
    });
  },
);
