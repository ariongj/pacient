import { Router } from 'express';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  allergies,
  diagnoses,
  labResults,
  patients,
  pharmacyStatusEnum,
  prescriptions,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { checkPrescription, type SafetyAlert } from '../../lib/medication-safety.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';

/**
 * Pharmacy verification and dispensing. Pharmacists see prescriptions written at their facility and
 * the minimum clinical context needed to check them (allergies, other active medicines, active
 * problems, renal function, weight) – never the full record. Every context view is audited and
 * shows in the patient's access log.
 */
const QueueQuery = z.object({ status: z.enum(pharmacyStatusEnum.enumValues).default('PENDING') });
const IdParam = z.object({ id: z.string().uuid() });
const VerifySchema = z.object({
  note: z.string().trim().max(2000).optional().nullable(),
  /** Required when safety alerts exist: the pharmacist confirms they reviewed them. */
  alertsReviewed: z.boolean().default(false),
});
const ReturnSchema = z.object({ note: z.string().trim().min(5).max(2000) });
const DispenseSchema = z.object({
  quantity: z.string().trim().min(1).max(100),
  note: z.string().trim().max(2000).optional().nullable(),
});

const prescriber = users;

const queueColumns = {
  id: prescriptions.id,
  patientId: prescriptions.patientId,
  patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
  patientDateOfBirth: patients.dateOfBirth,
  patientSex: patients.sex,
  medication: prescriptions.medication,
  dosage: prescriptions.dosage,
  frequency: prescriptions.frequency,
  route: prescriptions.route,
  instructions: prescriptions.instructions,
  startDate: prescriptions.startDate,
  endDate: prescriptions.endDate,
  status: prescriptions.status,
  pharmacyStatus: prescriptions.pharmacyStatus,
  pharmacistNote: prescriptions.pharmacistNote,
  verifiedAt: prescriptions.verifiedAt,
  dispensedAt: prescriptions.dispensedAt,
  dispensedQuantity: prescriptions.dispensedQuantity,
  createdAt: prescriptions.createdAt,
  prescriberId: prescriptions.doctorId,
  prescriberName: prescriber.fullName,
};

/** Prescriptions belong to the facility of the prescribing doctor. */
const atFacility = (ctx: AuthContext) => eq(prescriber.facilityId, ctx.facilityId!);

async function contextFor(patientIds: string[], excludePrescriptionIds: string[] = []) {
  if (!patientIds.length) return { allergyMap: new Map(), medsMap: new Map() };
  const [allergyRows, medRows] = await Promise.all([
    db
      .select({
        patientId: allergies.patientId,
        substance: allergies.substance,
        severity: allergies.severity,
        verificationStatus: allergies.verificationStatus,
      })
      .from(allergies)
      .where(inArray(allergies.patientId, patientIds)),
    db
      .select({
        id: prescriptions.id,
        patientId: prescriptions.patientId,
        medication: prescriptions.medication,
      })
      .from(prescriptions)
      .where(and(inArray(prescriptions.patientId, patientIds), eq(prescriptions.status, 'ACTIVE'))),
  ]);
  const allergyMap = new Map<string, typeof allergyRows>();
  for (const a of allergyRows)
    allergyMap.set(a.patientId, [...(allergyMap.get(a.patientId) ?? []), a]);
  const medsMap = new Map<string, { id: string; medication: string }[]>();
  for (const m of medRows) {
    if (excludePrescriptionIds.includes(m.id)) continue;
    medsMap.set(m.patientId, [...(medsMap.get(m.patientId) ?? []), m]);
  }
  return { allergyMap, medsMap };
}

function alertsFor(
  row: { id: string; patientId: string; medication: string },
  ctx: Awaited<ReturnType<typeof contextFor>>,
): SafetyAlert[] {
  const others = ((ctx.medsMap.get(row.patientId) ?? []) as { id: string; medication: string }[])
    .filter((m) => m.id !== row.id)
    .map((m) => m.medication);
  return checkPrescription(row.medication, ctx.allergyMap.get(row.patientId) ?? [], others);
}

async function loadAtFacility(ctx: AuthContext, id: string) {
  const [row] = await db
    .select(queueColumns)
    .from(prescriptions)
    .innerJoin(patients, eq(patients.id, prescriptions.patientId))
    .innerJoin(prescriber, eq(prescriber.id, prescriptions.doctorId))
    .where(and(eq(prescriptions.id, id), atFacility(ctx)));
  if (!row) throw notFound('Prescription not found in your facility');
  return row;
}

export const pharmacyRouter = Router();
pharmacyRouter.use(authenticate, requireRole('PHARMACIST'));

pharmacyRouter.get('/queue', async (req, res) => {
  const ctx = requireAuth(req);
  const { status } = parse(QueueQuery, req.query);
  const rows = await db
    .select(queueColumns)
    .from(prescriptions)
    .innerJoin(patients, eq(patients.id, prescriptions.patientId))
    .innerJoin(prescriber, eq(prescriber.id, prescriptions.doctorId))
    .where(
      and(
        atFacility(ctx),
        eq(prescriptions.pharmacyStatus, status),
        status === 'DISPENSED' ? undefined : ne(prescriptions.status, 'CANCELLED'),
      ),
    )
    .orderBy(
      status === 'PENDING' || status === 'VERIFIED'
        ? prescriptions.createdAt
        : desc(prescriptions.createdAt),
    )
    .limit(200);
  const context = await contextFor([...new Set(rows.map((r) => r.patientId))]);
  const counts = await db
    .select({ status: prescriptions.pharmacyStatus, total: sql<number>`count(*)::int` })
    .from(prescriptions)
    .innerJoin(prescriber, eq(prescriber.id, prescriptions.doctorId))
    .where(and(atFacility(ctx), ne(prescriptions.status, 'CANCELLED')))
    .groupBy(prescriptions.pharmacyStatus);
  res.json({
    items: rows.map((r) => ({ ...r, alerts: alertsFor(r, context) })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.total])),
  });
});

/** Medication context for one prescription – the minimum a pharmacist needs to verify it. */
pharmacyRouter.get('/prescriptions/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const rx = await loadAtFacility(ctx, id);
  const [patient] = await db
    .select({ allergyAssessment: patients.allergyAssessment })
    .from(patients)
    .where(eq(patients.id, rx.patientId));
  const [allergyList, otherMeds, problems, renal, weight] = await Promise.all([
    db
      .select({
        substance: allergies.substance,
        reaction: allergies.reaction,
        severity: allergies.severity,
        verificationStatus: allergies.verificationStatus,
      })
      .from(allergies)
      .where(eq(allergies.patientId, rx.patientId)),
    db
      .select({
        id: prescriptions.id,
        medication: prescriptions.medication,
        dosage: prescriptions.dosage,
        frequency: prescriptions.frequency,
        pharmacyStatus: prescriptions.pharmacyStatus,
      })
      .from(prescriptions)
      .where(
        and(
          eq(prescriptions.patientId, rx.patientId),
          eq(prescriptions.status, 'ACTIVE'),
          ne(prescriptions.id, id),
        ),
      ),
    db
      .select({
        icd10Code: diagnoses.icd10Code,
        description: diagnoses.description,
        status: diagnoses.status,
      })
      .from(diagnoses)
      .where(and(eq(diagnoses.patientId, rx.patientId), ne(diagnoses.status, 'RESOLVED'))),
    db
      .select({
        testName: labResults.testName,
        value: labResults.value,
        unit: labResults.unit,
        flag: labResults.flag,
        collectedAt: labResults.collectedAt,
      })
      .from(labResults)
      .where(
        and(
          eq(labResults.patientId, rx.patientId),
          sql`lower(${labResults.testName}) IN ('creatinine', 'egfr', 'potassium')`,
        ),
      )
      .orderBy(desc(labResults.collectedAt))
      .limit(3),
    db
      .select({ weightKg: vitalSigns.weightKg, recordedAt: vitalSigns.recordedAt })
      .from(vitalSigns)
      .where(and(eq(vitalSigns.patientId, rx.patientId), sql`${vitalSigns.weightKg} IS NOT NULL`))
      .orderBy(desc(vitalSigns.recordedAt))
      .limit(1),
  ]);
  await audit({
    action: AuditAction.PHARMACY_CONTEXT_VIEWED,
    actor: ctx,
    resourceType: 'prescription',
    resourceId: id,
    patientId: rx.patientId,
    meta: requestMeta(req),
    metadata: { section: 'medication-context', basis: 'PHARMACY' },
  });
  res.json({
    prescription: rx,
    allergyAssessment: patient?.allergyAssessment,
    allergies: allergyList,
    otherActiveMedications: otherMeds,
    activeProblems: problems,
    renalAndElectrolytes: renal,
    latestWeight: weight[0] ?? null,
    alerts: checkPrescription(
      rx.medication,
      allergyList,
      otherMeds.map((m) => m.medication),
    ),
  });
});

pharmacyRouter.post('/prescriptions/:id/verify', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(VerifySchema, req.body ?? {});
  const rx = await loadAtFacility(ctx, id);
  if (rx.pharmacyStatus !== 'PENDING')
    throw conflict(`Prescription is ${rx.pharmacyStatus.toLowerCase()}`);
  if (rx.status !== 'ACTIVE') throw conflict('Only active prescriptions can be verified');
  const context = await contextFor([rx.patientId]);
  const alerts = alertsFor(rx, context);
  if (alerts.length && (!input.alertsReviewed || !input.note || input.note.length < 5)) {
    throw badRequest(
      'Review the safety alerts and record a note explaining why it is safe to proceed',
      alerts,
    );
  }
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(prescriptions)
      .set({
        pharmacyStatus: 'VERIFIED',
        verifiedById: ctx.userId,
        verifiedAt: new Date(),
        pharmacistNote: input.note ?? null,
      })
      .where(and(eq(prescriptions.id, id), eq(prescriptions.pharmacyStatus, 'PENDING')))
      .returning({ id: prescriptions.id });
    if (!updated.length) throw conflict('Prescription was updated by someone else');
    await audit(
      {
        action: AuditAction.PRESCRIPTION_VERIFIED,
        actor: ctx,
        resourceType: 'prescription',
        resourceId: id,
        patientId: rx.patientId,
        meta: requestMeta(req),
        metadata: { alerts: alerts.map((a) => a.kind) },
      },
      tx,
    );
  });
  res.json(await loadAtFacility(ctx, id));
});

/** Return to the prescriber with a reason (e.g. allergy, dose, interaction). */
pharmacyRouter.post('/prescriptions/:id/return', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { note } = parse(ReturnSchema, req.body);
  const rx = await loadAtFacility(ctx, id);
  if (!['PENDING', 'VERIFIED'].includes(rx.pharmacyStatus)) {
    throw conflict(`Prescription is ${rx.pharmacyStatus.toLowerCase()}`);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(prescriptions)
      .set({
        pharmacyStatus: 'RETURNED',
        pharmacistNote: note,
        verifiedById: ctx.userId,
        verifiedAt: new Date(),
      })
      .where(eq(prescriptions.id, id));
    await audit(
      {
        action: AuditAction.PRESCRIPTION_RETURNED,
        actor: ctx,
        resourceType: 'prescription',
        resourceId: id,
        patientId: rx.patientId,
        meta: requestMeta(req),
      },
      tx,
    );
    await notifyUsers(
      [rx.prescriberId],
      {
        type: 'pharmacy',
        title: 'A prescription was returned by the pharmacy',
        link: `/doctor/patients/${rx.patientId}`,
      },
      tx,
    );
  });
  res.json(await loadAtFacility(ctx, id));
});

pharmacyRouter.post('/prescriptions/:id/dispense', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(DispenseSchema, req.body);
  const rx = await loadAtFacility(ctx, id);
  if (rx.pharmacyStatus !== 'VERIFIED')
    throw conflict('Only verified prescriptions can be dispensed');
  await db.transaction(async (tx) => {
    await tx
      .update(prescriptions)
      .set({
        pharmacyStatus: 'DISPENSED',
        dispensedById: ctx.userId,
        dispensedAt: new Date(),
        dispensedQuantity: input.quantity,
        ...(input.note ? { pharmacistNote: input.note } : {}),
      })
      .where(eq(prescriptions.id, id));
    await audit(
      {
        action: AuditAction.PRESCRIPTION_DISPENSED,
        actor: ctx,
        resourceType: 'prescription',
        resourceId: id,
        patientId: rx.patientId,
        meta: requestMeta(req),
        metadata: { quantity: input.quantity },
      },
      tx,
    );
    await notifyPatient(
      rx.patientId,
      {
        type: 'pharmacy',
        title: 'Your medication is ready at the pharmacy',
        link: '/portal/history',
      },
      tx,
    );
  });
  res.json(await loadAtFacility(ctx, id));
});
