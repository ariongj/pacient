import { publishBoardChanges } from '../../lib/events.js';
import { Router } from 'express';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  edVisits,
  encounters,
  imagingModalityEnum,
  imagingOrders,
  imagingStatusEnum,
  labPriorityEnum,
  patients,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  getPatientOrThrow,
  resolveClinicalReadAccess,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { assertEncounterBelongsToPatient, viewFor } from '../clinical/clinical.service.js';
import { activeCoverDoctorsFor } from '../cover/cover.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';
import {
  isRadiologyStaff,
  newAccessionNumber,
  radiologyStaff,
  SafetyChecksSchema,
  validateSafetyChecks,
} from './imaging.service.js';

/**
 * Radiology (RIS): doctors order examinations; the facility's radiology unit schedules, performs
 * and reports them; the ordering doctor acknowledges the report and releases it to the patient.
 * A signed report is immutable (database trigger) – corrections are a new examination or note.
 */
export const imagingRouter = Router();
imagingRouter.use(authenticate, publishBoardChanges('imaging.worklist', ['DOCTOR', 'NURSE']));

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });

const OrderInput = z.object({
  patientId: z.string().uuid(),
  modality: z.enum(imagingModalityEnum.enumValues),
  bodyPart: z.string().trim().min(2).max(120),
  clinicalQuestion: z.string().trim().min(5).max(1000),
  priority: z.enum(labPriorityEnum.enumValues).default('ROUTINE'),
  safetyChecks: SafetyChecksSchema,
  encounterId: z.string().uuid().optional().nullable(),
  admissionId: z.string().uuid().optional().nullable(),
  edVisitId: z.string().uuid().optional().nullable(),
});

const orderedBy = alias(users, 'ordered_by');
const reportedBy = alias(users, 'reported_by');
const performedBy = alias(users, 'performed_by');

const ORDER_COLUMNS = {
  id: imagingOrders.id,
  accessionNumber: imagingOrders.accessionNumber,
  patientId: imagingOrders.patientId,
  facilityId: imagingOrders.facilityId,
  modality: imagingOrders.modality,
  bodyPart: imagingOrders.bodyPart,
  clinicalQuestion: imagingOrders.clinicalQuestion,
  priority: imagingOrders.priority,
  safetyChecks: imagingOrders.safetyChecks,
  status: imagingOrders.status,
  scheduledAt: imagingOrders.scheduledAt,
  performedAt: imagingOrders.performedAt,
  findings: imagingOrders.findings,
  impression: imagingOrders.impression,
  critical: imagingOrders.critical,
  reportedAt: imagingOrders.reportedAt,
  acknowledgedAt: imagingOrders.acknowledgedAt,
  releasedAt: imagingOrders.releasedAt,
  cancelledAt: imagingOrders.cancelledAt,
  cancelReason: imagingOrders.cancelReason,
  createdAt: imagingOrders.createdAt,
  encounterId: imagingOrders.encounterId,
  admissionId: imagingOrders.admissionId,
  edVisitId: imagingOrders.edVisitId,
  orderedById: imagingOrders.orderedById,
  orderedBy: orderedBy.fullName,
  reportedBy: reportedBy.fullName,
  performedBy: performedBy.fullName,
};

function selectOrders(executor: Executor = db) {
  return executor
    .select(ORDER_COLUMNS)
    .from(imagingOrders)
    .innerJoin(orderedBy, eq(orderedBy.id, imagingOrders.orderedById))
    .leftJoin(reportedBy, eq(reportedBy.id, imagingOrders.reportedById))
    .leftJoin(performedBy, eq(performedBy.id, imagingOrders.performedById));
}

async function loadOrder(id: string, executor: Executor = db) {
  const [row] = await executor
    .select()
    .from(imagingOrders)
    .where(eq(imagingOrders.id, id))
    .for('update');
  if (!row) throw notFound('Imaging order not found');
  return row;
}

async function assertRadiology(
  ctx: AuthContext,
  facilityId: string,
  roles: ('DOCTOR' | 'NURSE')[],
  message: string,
) {
  if (ctx.facilityId !== facilityId || !(await isRadiologyStaff(ctx.userId, facilityId, roles))) {
    throw forbidden(message);
  }
}

const priorityOrder = sql`CASE ${imagingOrders.priority} WHEN 'STAT' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END`;

/* ------------------------------------------------------------------ ordering ----------------- */

imagingRouter.post('/orders', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(OrderInput, req.body);
  await assertClinicalWriteAccess(ctx, input.patientId, requestMeta(req), WRITERS.doctorOnly);
  const patient = await getPatientOrThrow(input.patientId);
  const safetyChecks = validateSafetyChecks(input.modality, patient, input.safetyChecks);
  if (input.encounterId) await assertEncounterBelongsToPatient(input.encounterId, input.patientId);
  if (input.admissionId) {
    const [a] = await db
      .select({ patientId: admissions.patientId })
      .from(admissions)
      .where(eq(admissions.id, input.admissionId));
    if (a?.patientId !== input.patientId)
      throw badRequest('The stay does not belong to this patient');
  }
  if (input.edVisitId) {
    const [v] = await db
      .select({ patientId: edVisits.patientId })
      .from(edVisits)
      .where(eq(edVisits.id, input.edVisitId));
    if (v?.patientId !== input.patientId) {
      throw badRequest('The emergency visit does not belong to this patient');
    }
  }

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(imagingOrders)
      .values({
        accessionNumber: newAccessionNumber(),
        patientId: input.patientId,
        facilityId: ctx.facilityId!,
        encounterId: input.encounterId ?? null,
        admissionId: input.admissionId ?? null,
        edVisitId: input.edVisitId ?? null,
        orderedById: ctx.userId,
        modality: input.modality,
        bodyPart: input.bodyPart,
        clinicalQuestion: input.clinicalQuestion,
        priority: input.priority,
        safetyChecks,
      })
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_ORDERED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: row!.id,
        patientId: input.patientId,
        meta: requestMeta(req),
        metadata: { modality: input.modality, priority: input.priority },
      },
      tx,
    );
    if (input.priority !== 'ROUTINE') {
      await notifyUsers(
        await radiologyStaff(ctx.facilityId!, ['DOCTOR', 'NURSE'], tx),
        {
          type: 'imaging',
          title:
            input.priority === 'STAT'
              ? 'STAT imaging request – perform now'
              : 'New urgent imaging request',
          link: '/imaging',
          important: input.priority === 'STAT',
        },
        tx,
      );
    }
    return row!;
  });
  res.status(201).json(created);
});

/* ------------------------------------------------------------------ worklist ----------------- */

const WorklistQuery = z.object({
  status: z.enum(imagingStatusEnum.enumValues).optional(),
  modality: z.enum(imagingModalityEnum.enumValues).optional(),
  priority: z.enum(labPriorityEnum.enumValues).optional(),
});

/** The radiology unit's queue at my facility (open examinations, plus today's reports). */
imagingRouter.get('/worklist', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!(await isRadiologyStaff(ctx.userId, ctx.facilityId))) {
    throw forbidden('The radiology worklist is for staff of the radiology unit');
  }
  const q = parse(WorklistQuery, req.query);
  const filters: SQL[] = [eq(imagingOrders.facilityId, ctx.facilityId!)];
  if (q.status) filters.push(eq(imagingOrders.status, q.status));
  else
    filters.push(
      sql`(${imagingOrders.status} IN ('ORDERED', 'SCHEDULED', 'PERFORMED') OR (${imagingOrders.status} = 'REPORTED' AND ${imagingOrders.reportedAt} > now() - interval '24 hours'))`,
    );
  if (q.modality) filters.push(eq(imagingOrders.modality, q.modality));
  if (q.priority) filters.push(eq(imagingOrders.priority, q.priority));
  const rows = await db
    .select({
      ...ORDER_COLUMNS,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      nationalId: patients.nationalId,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(imagingOrders)
    .innerJoin(patients, eq(patients.id, imagingOrders.patientId))
    .innerJoin(orderedBy, eq(orderedBy.id, imagingOrders.orderedById))
    .leftJoin(reportedBy, eq(reportedBy.id, imagingOrders.reportedById))
    .leftJoin(performedBy, eq(performedBy.id, imagingOrders.performedById))
    .where(and(...filters))
    .orderBy(
      sql`CASE ${imagingOrders.status} WHEN 'REPORTED' THEN 1 ELSE 0 END`,
      priorityOrder,
      asc(imagingOrders.createdAt),
    )
    .limit(200);
  const counts = await db
    .select({ status: imagingOrders.status, n: sql<number>`count(*)::int` })
    .from(imagingOrders)
    .where(
      and(
        eq(imagingOrders.facilityId, ctx.facilityId!),
        inArray(imagingOrders.status, ['ORDERED', 'SCHEDULED', 'PERFORMED']),
      ),
    )
    .groupBy(imagingOrders.status);
  res.json({
    items: rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    isRadiologist: await isRadiologyStaff(ctx.userId, ctx.facilityId, ['DOCTOR']),
  });
});

/* ------------------------------------------------------------------ patient view ------------- */

imagingRouter.get('/patients/:patientId/orders', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const view = viewFor(await resolveClinicalReadAccess(ctx, patientId, requestMeta(req)));
  const filters: SQL[] = [eq(imagingOrders.patientId, patientId)];
  if (view.patientView) {
    filters.push(eq(imagingOrders.status, 'REPORTED'), isNotNull(imagingOrders.releasedAt));
  }
  if (view.hideConfidential) {
    filters.push(
      sql`NOT EXISTS (SELECT 1 FROM ${encounters} WHERE ${encounters.id} = ${imagingOrders.encounterId} AND ${encounters.confidentialFromGuardians})`,
    );
  }
  const rows = await selectOrders()
    .where(and(...filters))
    .orderBy(desc(imagingOrders.createdAt))
    .limit(200);
  const items = view.patientView
    ? rows.map((r) => ({
        id: r.id,
        accessionNumber: r.accessionNumber,
        modality: r.modality,
        bodyPart: r.bodyPart,
        status: r.status,
        performedAt: r.performedAt,
        findings: r.findings,
        impression: r.impression,
        reportedAt: r.reportedAt,
        reportedBy: r.reportedBy,
        releasedAt: r.releasedAt,
        orderedBy: r.orderedBy,
        createdAt: r.createdAt,
      }))
    : rows;
  res.json({ items });
});

/* ------------------------------------------------------------------ radiology workflow ------- */

const ScheduleInput = z.object({ scheduledAt: z.coerce.date() });

imagingRouter.post('/orders/:id/schedule', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { scheduledAt } = parse(ScheduleInput, req.body);
  const row = await db.transaction(async (tx) => {
    const order = await loadOrder(id, tx);
    await assertRadiology(
      ctx,
      order.facilityId,
      ['DOCTOR', 'NURSE'],
      'Only radiology staff schedule examinations',
    );
    if (!['ORDERED', 'SCHEDULED'].includes(order.status)) {
      throw conflict('Only ordered examinations can be scheduled');
    }
    const [updated] = await tx
      .update(imagingOrders)
      .set({ status: 'SCHEDULED', scheduledAt })
      .where(eq(imagingOrders.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { status: 'SCHEDULED' },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

imagingRouter.post('/orders/:id/perform', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const row = await db.transaction(async (tx) => {
    const order = await loadOrder(id, tx);
    await assertRadiology(
      ctx,
      order.facilityId,
      ['DOCTOR', 'NURSE'],
      'Only radiology staff perform examinations',
    );
    if (!['ORDERED', 'SCHEDULED'].includes(order.status)) {
      throw conflict('This examination cannot be marked as performed');
    }
    const [updated] = await tx
      .update(imagingOrders)
      .set({ status: 'PERFORMED', performedAt: new Date(), performedById: ctx.userId })
      .where(eq(imagingOrders.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { status: 'PERFORMED' },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

const ReportInput = z.object({
  findings: z.string().trim().min(10).max(10_000),
  impression: z.string().trim().min(3).max(2000),
  critical: z.boolean().default(false),
});

imagingRouter.post('/orders/:id/report', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(ReportInput, req.body);
  const row = await db.transaction(async (tx) => {
    const order = await loadOrder(id, tx);
    await assertRadiology(
      ctx,
      order.facilityId,
      ['DOCTOR'],
      'Only radiologists of the radiology unit sign reports',
    );
    if (order.status !== 'PERFORMED') throw conflict('Only performed examinations can be reported');
    const [updated] = await tx
      .update(imagingOrders)
      .set({
        status: 'REPORTED',
        findings: input.findings,
        impression: input.impression,
        critical: input.critical,
        reportedById: ctx.userId,
        reportedAt: new Date(),
      })
      .where(eq(imagingOrders.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_REPORTED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { critical: input.critical },
      },
      tx,
    );
    const alert = {
      type: 'imaging',
      title: input.critical
        ? 'CRITICAL imaging finding – review now'
        : 'New imaging report to review',
      link: `/doctor/patients/${order.patientId}?tab=imaging`,
      important: input.critical,
    };
    await notifyUsers([order.orderedById], alert, tx);
    for (const c of await activeCoverDoctorsFor([order.orderedById], tx)) {
      await notifyUsers(
        [c.coverDoctorId],
        {
          ...alert,
          wrap: [{ text: '{title} (covering for {doctor})', vars: { doctor: c.doctorName } }],
        },
        tx,
      );
    }
    return updated!;
  });
  res.json(row);
});

/* ------------------------------------------------------------------ follow-up ---------------- */

imagingRouter.post('/orders/:id/acknowledge', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const [existing] = await db.select().from(imagingOrders).where(eq(imagingOrders.id, id));
  if (!existing) throw notFound('Imaging order not found');
  await resolveClinicalReadAccess(ctx, existing.patientId, requestMeta(req));
  const row = await db.transaction(async (tx) => {
    const order = await loadOrder(id, tx);
    if (order.status !== 'REPORTED')
      throw conflict('Only reported examinations can be acknowledged');
    if (order.acknowledgedAt) throw conflict('Report already acknowledged');
    const [updated] = await tx
      .update(imagingOrders)
      .set({ acknowledgedAt: new Date(), acknowledgedById: ctx.userId })
      .where(eq(imagingOrders.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_ACKNOWLEDGED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: id,
        patientId: order.patientId,
        meta: requestMeta(req),
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

imagingRouter.post('/orders/:id/release', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const [existing] = await db.select().from(imagingOrders).where(eq(imagingOrders.id, id));
  if (!existing) throw notFound('Imaging order not found');
  await assertClinicalWriteAccess(ctx, existing.patientId, requestMeta(req), WRITERS.doctorOnly);
  const row = await db.transaction(async (tx) => {
    const order = await loadOrder(id, tx);
    if (!order.acknowledgedAt) throw conflict('Acknowledge the report before releasing it');
    if (order.releasedAt) throw conflict('Report already released');
    const [updated] = await tx
      .update(imagingOrders)
      .set({ releasedAt: new Date() })
      .where(eq(imagingOrders.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { released: true },
      },
      tx,
    );
    await notifyPatient(
      order.patientId,
      { type: 'result', title: 'A new imaging report is available', link: '/portal/imaging' },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

const CancelInput = z.object({ reason: z.string().trim().min(5).max(300) });

imagingRouter.post('/orders/:id/cancel', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(CancelInput, req.body);
  const [existing] = await db.select().from(imagingOrders).where(eq(imagingOrders.id, id));
  if (!existing) throw notFound('Imaging order not found');
  if (existing.orderedById !== ctx.userId) {
    await assertClinicalWriteAccess(ctx, existing.patientId, requestMeta(req), WRITERS.doctorOnly);
  }
  const row = await db.transaction(async (tx) => {
    const order = await loadOrder(id, tx);
    if (!['ORDERED', 'SCHEDULED'].includes(order.status)) {
      throw conflict('The examination has already been performed');
    }
    const [updated] = await tx
      .update(imagingOrders)
      .set({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason })
      .where(eq(imagingOrders.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: id,
        patientId: order.patientId,
        meta: requestMeta(req),
        metadata: { status: 'CANCELLED', reason },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});
