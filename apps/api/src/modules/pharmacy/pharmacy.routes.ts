import { Router } from 'express';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  allergies,
  diagnoses,
  labResults,
  medicationCatalog,
  patients,
  pharmacyStatusEnum,
  prescriptions,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import {
  evaluate,
  ingredientsFromText,
  loadContexts,
  toPublicAlert,
  type PublicAlert,
} from '../../lib/medication-safety.js';
import { interactionIndex } from '../safety/engine.js';
import { localeOf, storedAlertsFor } from '../safety/safety.service.js';
import type { Locale } from '../../i18n/index.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';
import {
  alertLowStock,
  allocateFefo,
  batchesFor,
  catalogCandidates,
  isoDay,
  stockLevels,
  withdrawStock,
} from '../stock/stock.service.js';

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
const ReturnSchema = z.object({
  note: z.string().trim().min(5).max(2000),
  /** Safety alert the return refers to (code from the alerts list). */
  alertCode: z.string().trim().max(200).optional(),
});
/**
 * Dispensing draws stock: `stock` names the catalogue item (defaults to the prescription's) and the
 * units handed out; without `lines` the units are taken first-expiry-first-out. A medicine that is
 * not in the catalogue can still be dispensed without stock tracking, with a recorded reason.
 */
const DispenseSchema = z
  .object({
    /** Label shown on the prescription, e.g. "30 tablets"; derived from the units when omitted. */
    quantity: z.string().trim().min(1).max(100).optional(),
    note: z.string().trim().max(2000).optional().nullable(),
    stock: z
      .object({
        itemId: z.string().uuid().optional(),
        units: z.number().int().positive().max(100_000),
        lines: z
          .array(z.object({ batchId: z.string().uuid(), units: z.number().int().positive() }))
          .max(20)
          .optional(),
      })
      .optional(),
    untrackedReason: z.string().trim().min(5).max(500).optional(),
  })
  .refine((v) => v.stock || v.quantity, {
    message: 'Enter the quantity dispensed',
    path: ['quantity'],
  });

const word = (alternatives: string) =>
  new RegExp(`(?<![\\p{L}\\d])(?:${alternatives})(?![\\p{L}\\d])`, 'iu');
const TIMES_PER_DAY: [RegExp, number][] = [
  [word('once|1 ?x|një herë|jednom|qd|od'), 1],
  [word('twice|2 ?x|dy herë|dva puta|bid'), 2],
  [word('three times|3 ?x|tri herë|tre herë|tri puta|tid'), 3],
  [word('four times|4 ?x|katër herë|četiri puta|qid'), 4],
];

/** Units to dispense when the frequency and the treatment period make it obvious, else null. */
export function suggestUnits(rx: { frequency: string; startDate: string; endDate: string | null }) {
  if (!rx.endDate) return null;
  let perDay: number | null = null;
  const every = /every\s+(\d{1,2})\s*h|çdo\s+(\d{1,2})\s*or|svakih\s+(\d{1,2})\s*h/i.exec(
    rx.frequency,
  );
  if (every) perDay = Math.round(24 / Number(every[1] ?? every[2] ?? every[3]));
  else perDay = TIMES_PER_DAY.find(([re]) => re.test(rx.frequency))?.[1] ?? null;
  if (!perDay) return null;
  const days = Math.round((Date.parse(rx.endDate) - Date.parse(rx.startDate)) / 86_400_000) + 1;
  return days > 0 && days <= 180 ? perDay * days : null;
}

const prescriber = users;

const queueColumns = {
  id: prescriptions.id,
  patientId: prescriptions.patientId,
  patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
  patientDateOfBirth: patients.dateOfBirth,
  patientSex: patients.sex,
  medication: prescriptions.medication,
  catalogItemId: prescriptions.catalogItemId,
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

/**
 * Safety context for prescriptions in the queue: the engine's patient contexts (other medicines,
 * allergies, kidney function, age, pregnancy) plus the interaction index – loaded once per request.
 */
async function contextFor(patientIds: string[]) {
  const [contexts, index] = await Promise.all([loadContexts(patientIds), interactionIndex()]);
  return { contexts, index };
}

/** Fresh alerts for one prescription, comparing it with the patient's other medicines. */
function alertsFor(
  row: { id: string; patientId: string; medication: string },
  ctx: Awaited<ReturnType<typeof contextFor>>,
  locale: Locale,
): PublicAlert[] {
  const pctx = ctx.contexts.get(row.patientId);
  if (!pctx) return [];
  const self = pctx.medications.find((m) => m.id === row.id);
  const candidate = self ?? {
    medication: row.medication,
    ingredients: ingredientsFromText(row.medication, ctx.index.names),
    atc: null,
  };
  const others = { ...pctx, medications: pctx.medications.filter((m) => m.id !== row.id) };
  return evaluate(others, candidate, ctx.index.pairs).map((a) => toPublicAlert(a, locale));
}

/** Alerts that require the pharmacist's documented review (everything except minor notes). */
const needsReview = (alerts: PublicAlert[]) => alerts.filter((a) => a.severity !== 'MINOR');

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
  const [context, locale] = await Promise.all([
    contextFor([...new Set(rows.map((r) => r.patientId))]),
    localeOf(ctx.userId),
  ]);
  const counts = await db
    .select({ status: prescriptions.pharmacyStatus, total: sql<number>`count(*)::int` })
    .from(prescriptions)
    .innerJoin(prescriber, eq(prescriber.id, prescriptions.doctorId))
    .where(and(atFacility(ctx), ne(prescriptions.status, 'CANCELLED')))
    .groupBy(prescriptions.pharmacyStatus);
  res.json({
    items: rows.map((r) => ({ ...r, alerts: alertsFor(r, context, locale) })),
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
  const [context, locale] = await Promise.all([contextFor([rx.patientId]), localeOf(ctx.userId)]);
  const stored = await storedAlertsFor({ prescriptionIds: [id] }, locale);
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
    alerts: alertsFor(rx, context, locale),
    /** Alerts raised when the prescription was written, with the prescriber's override reasons. */
    prescribingAlerts: stored.get(id) ?? [],
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
  const [context, locale] = await Promise.all([contextFor([rx.patientId]), localeOf(ctx.userId)]);
  const alerts = needsReview(alertsFor(rx, context, locale));
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
        metadata: { alerts: alerts.map((a) => a.code) },
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
  const { note, alertCode } = parse(ReturnSchema, req.body);
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
        metadata: alertCode ? { alertCode } : undefined,
      },
      tx,
    );
    await notifyUsers(
      [rx.prescriberId],
      {
        type: 'pharmacy',
        title: 'A prescription was returned by the pharmacy',
        important: true,
        link: `/doctor/patients/${rx.patientId}`,
      },
      tx,
    );
  });
  res.json(await loadAtFacility(ctx, id));
});

/** What the pharmacist needs to pick stock for a prescription: item, batches (FEFO), suggestion. */
pharmacyRouter.get('/prescriptions/:id/stock', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { itemId: chosen } = parse(z.object({ itemId: z.string().uuid().optional() }), req.query);
  const rx = await loadAtFacility(ctx, id);
  const itemId = chosen ?? rx.catalogItemId;
  const candidates = itemId ? [] : await catalogCandidates(rx.medication);
  const suggestedUnits = suggestUnits(rx);
  if (!itemId) {
    res.json({
      item: null,
      candidates,
      batches: [],
      level: null,
      suggestedUnits,
      suggestion: null,
    });
    return;
  }
  const [item] = await db.select().from(medicationCatalog).where(eq(medicationCatalog.id, itemId));
  if (!item) throw notFound('Catalogue item not found');
  const batches = await batchesFor(ctx.facilityId!, itemId);
  const [level] = await stockLevels(ctx.facilityId!, { itemIds: [itemId] });
  res.json({
    item,
    candidates,
    batches,
    level: level ?? null,
    suggestedUnits,
    suggestion: suggestedUnits ? allocateFefo(batches, suggestedUnits, isoDay(new Date())) : null,
  });
});

pharmacyRouter.post('/prescriptions/:id/dispense', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(DispenseSchema, req.body);
  const rx = await loadAtFacility(ctx, id);
  if (rx.pharmacyStatus !== 'VERIFIED')
    throw conflict('Only verified prescriptions can be dispensed');
  const itemId = input.stock?.itemId ?? rx.catalogItemId;
  if (itemId && !input.stock) {
    throw badRequest('Choose the quantity to take from stock for this medicine');
  }
  if (!itemId && !input.untrackedReason) {
    throw badRequest(
      'This medicine is not linked to the catalogue: choose the catalogue item, or give a reason for dispensing without stock tracking',
    );
  }
  const [item] = itemId
    ? await db.select().from(medicationCatalog).where(eq(medicationCatalog.id, itemId))
    : [];
  if (itemId && !item) throw notFound('Catalogue item not found');
  const label = input.quantity ?? (item && input.stock ? `${input.stock.units} ${item.unit}` : '');
  await db.transaction(async (tx) => {
    let lines: { batchId: string; units: number }[] = [];
    if (item && input.stock) {
      lines = await withdrawStock(tx, {
        facilityId: ctx.facilityId!,
        itemId: item.id,
        units: input.stock.units,
        lines: input.stock.lines,
        type: 'DISPENSE',
        prescriptionId: id,
        userId: ctx.userId,
      });
    }
    const updated = await tx
      .update(prescriptions)
      .set({
        pharmacyStatus: 'DISPENSED',
        dispensedById: ctx.userId,
        dispensedAt: new Date(),
        dispensedQuantity: label,
        // Remember the catalogue item so the next dispense of this prescription is tracked.
        ...(item && !rx.catalogItemId ? { catalogItemId: item.id } : {}),
        ...(input.note ? { pharmacistNote: input.note } : {}),
      })
      .where(and(eq(prescriptions.id, id), eq(prescriptions.pharmacyStatus, 'VERIFIED')))
      .returning({ id: prescriptions.id });
    if (!updated.length) throw conflict('Prescription was updated by someone else');
    await audit(
      {
        action: AuditAction.PRESCRIPTION_DISPENSED,
        actor: ctx,
        resourceType: 'prescription',
        resourceId: id,
        patientId: rx.patientId,
        meta: requestMeta(req),
        metadata: {
          quantity: label,
          stockTracked: Boolean(item),
          ...(item ? {} : { untrackedReason: input.untrackedReason }),
          ...(item && rx.catalogItemId && item.id !== rx.catalogItemId
            ? { substitutedFor: rx.catalogItemId }
            : {}),
        },
      },
      tx,
    );
    if (item) {
      await audit(
        {
          action: AuditAction.STOCK_DISPENSED,
          actor: ctx,
          resourceType: 'prescription',
          resourceId: id,
          meta: requestMeta(req),
          metadata: { itemId: item.id, lines },
        },
        tx,
      );
      await alertLowStock(tx, ctx.facilityId!, [item.id]);
    }
    await notifyPatient(
      rx.patientId,
      {
        type: 'pharmacy',
        title: 'Your medication is ready at the pharmacy',
        important: true,
        link: '/portal/history',
      },
      tx,
    );
  });
  res.json(await loadAtFacility(ctx, id));
});
