import { Router, type Request } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { scoreVitalSign } from '../news/news.service.js';
import { enrolFromDiagnosis } from '../registers/registers.service.js';
import { db, type Executor } from '../../db/client.js';
import type { Role } from '../../db/schema.js';
import {
  allergies,
  allergySeverityEnum,
  correctionRequests,
  diagnoses,
  diagnosisStatusEnum,
  encounterAddenda,
  encounters,
  encounterTypeEnum,
  labFlagEnum,
  careTasks,
  immunizations,
  labResults,
  medicationAdministrations,
  administrationStatusEnum,
  taskPriorityEnum,
  patients,
  prescriptions,
  prescriptionStatusEnum,
  resultStatusEnum,
  users,
  verificationStatusEnum,
  vitalSigns,
  medicationCatalog,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { PaginationSchema } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertDemographicsAccess,
  hasActiveCareAssignment,
  WRITERS,
  resolveClinicalReadAccess,
  type ClinicalAccessBasis,
} from '../access/policy.js';
import { audit, AuditAction, type AuditActionValue } from '../audit/audit.service.js';
import {
  notifyCareTeam,
  notifyFacilityRole,
  notifyCareTeamRole,
  notifyPatient,
  notifyUsers,
} from '../notifications/notifications.service.js';
import * as clinical from './clinical.service.js';
import {
  checkBeforePrescribing,
  localeOf as safetyLocaleOf,
  recordPrescriptionAlerts,
} from '../safety/safety.service.js';
import { loadContexts, toPublicAlert } from '../safety/engine.js';
import {
  doseText,
  DOSE_UNITS,
  FREQUENCY_CODES,
  routeCode,
  type StructuredDose,
} from '../safety/dosing.js';
import {
  loadAdministrablePrescription,
  runChecks,
  unitCompliance,
  currentStay,
  wristbandData,
  type CheckResult,
} from '../bcma/bcma.service.js';

const PatientParam = z.object({ patientId: z.string().uuid() });
const EntryParams = PatientParam.extend({ entryId: z.string().uuid() });

const isoDateTime = z.string().datetime({ offset: true });
const OptionalEncounter = { encounterId: z.string().uuid().optional().nullable() };

const EncounterInput = z.object({
  type: z.enum(encounterTypeEnum.enumValues),
  reason: z.string().trim().min(2).max(500),
  notes: z.string().trim().max(20_000).optional().nullable(),
  startedAt: isoDateTime.optional(),
  endedAt: isoDateTime.optional().nullable(),
});
const EncounterPatch = z.object({
  /** The version the edit is based on; stale edits are rejected instead of silently overwriting. */
  version: z.number().int().positive(),
  notes: z.string().trim().max(20_000).optional().nullable(),
  endedAt: isoDateTime.optional().nullable(),
});
const SignSchema = z.object({ version: z.number().int().positive() });
const AddendumSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  content: z.string().trim().min(2).max(10_000),
});

const DiagnosisInput = z.object({
  ...OptionalEncounter,
  icd10Code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/, 'Must be a valid ICD-10 code, e.g. E11.9'),
  description: z.string().trim().min(2).max(300),
  status: z.enum(diagnosisStatusEnum.enumValues).default('ACTIVE'),
  notes: z.string().trim().max(5000).optional().nullable(),
});
const DiagnosisPatch = z.object({
  status: z.enum(diagnosisStatusEnum.enumValues),
  notes: z.string().trim().max(5000).optional().nullable(),
});

const PrescriptionInput = z
  .object({
    ...OptionalEncounter,
    medication: z.string().trim().min(2).max(200),
    /** Optional national catalogue item (lets the pharmacy track stock for it). */
    catalogItemId: z.string().uuid().optional().nullable(),
    /** Free text (legacy); generated from the structured dose when that is given. */
    dosage: z.string().trim().min(1).max(100).optional(),
    frequency: z.string().trim().min(1).max(100).optional(),
    route: z.string().trim().min(1).max(50).default('oral'),
    /** Structured dose (enables dose-range checks). */
    doseAmount: z.coerce.number().positive().max(1_000_000).optional().nullable(),
    doseUnit: z.enum(DOSE_UNITS).optional().nullable(),
    frequencyCode: z.enum(FREQUENCY_CODES).optional().nullable(),
    maxDosesPer24h: z.coerce.number().int().min(1).max(24).optional().nullable(),
    durationDays: z.coerce.number().int().min(1).max(3650).optional().nullable(),
    asNeeded: z.boolean().optional(),
    instructions: z.string().trim().max(2000).optional().nullable(),
    startDate: z.string().date(),
    endDate: z.string().date().optional().nullable(),
    /** Reasons for proceeding despite blocking safety alerts (one per alert code). */
    overrides: z
      .array(
        z.object({
          code: z.string().trim().min(3).max(200),
          reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
        }),
      )
      .max(30)
      .optional(),
  })
  .refine((p) => !p.endDate || p.endDate >= p.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  })
  .refine((p) => (p.doseAmount ? p.doseUnit && p.frequencyCode : p.dosage && p.frequency), {
    message: 'Give the dose amount, unit and frequency (or a dosage and frequency text)',
    path: ['doseAmount'],
  })
  .refine((p) => p.frequencyCode !== 'PRN' || Boolean(p.maxDosesPer24h), {
    message: 'Give the maximum number of doses in 24 hours for an as-needed prescription',
    path: ['maxDosesPer24h'],
  });
const PrescriptionPatch = z.object({ status: z.enum(prescriptionStatusEnum.enumValues) });

const AllergyInput = z.object({
  substance: z.string().trim().min(2).max(200),
  reaction: z.string().trim().max(300).optional().nullable(),
  severity: z.enum(allergySeverityEnum.enumValues),
  verificationStatus: z.enum(['UNCONFIRMED', 'CONFIRMED']).default('UNCONFIRMED'),
  source: z.enum(['CLINICIAN', 'PATIENT_REPORTED']).default('CLINICIAN'),
});
const AllergyPatch = z.object({ verificationStatus: z.enum(verificationStatusEnum.enumValues) });
const AllergyAssessmentSchema = z.object({ status: z.enum(['NO_KNOWN_ALLERGIES', 'UNKNOWN']) });

const VitalsInput = z
  .object({
    ...OptionalEncounter,
    systolic: z.number().int().min(40).max(300).optional(),
    diastolic: z.number().int().min(20).max(200).optional(),
    heartRate: z.number().int().min(20).max(300).optional(),
    temperatureC: z.number().min(25).max(45).optional(),
    respiratoryRate: z.number().int().min(4).max(80).optional(),
    oxygenSaturation: z.number().int().min(30).max(100).optional(),
    weightKg: z.number().min(0.3).max(500).optional(),
    heightCm: z.number().min(20).max(260).optional(),
    /** ACVPU level of consciousness and supplemental oxygen – both needed for NEWS2. */
    consciousness: z.enum(['A', 'C', 'V', 'P', 'U']).optional(),
    onSupplementalOxygen: z.boolean().optional(),
    painScore: z.number().int().min(0).max(10).optional(),
    /** Paediatric observations (scored by PEWS). */
    capillaryRefillSeconds: z.number().min(0).max(20).optional(),
    respiratoryEffort: z.enum(['NONE', 'MILD', 'MODERATE', 'SEVERE']).optional(),
    /** When the observation was actually taken – lets paper downtime charts be back-entered. */
    recordedAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'recordedAt cannot be in the future')
      .refine(
        (d) => d.getTime() >= Date.now() - 14 * 86_400_000,
        'recordedAt is too far in the past',
      )
      .optional(),
  })
  .refine(
    (v) =>
      Object.entries(v).some(
        ([k, val]) => k !== 'encounterId' && k !== 'recordedAt' && val !== undefined,
      ),
    'At least one measurement is required',
  );

const LabInput = z.object({
  ...OptionalEncounter,
  testName: z.string().trim().min(2).max(200),
  value: z.string().trim().min(1).max(100),
  unit: z.string().trim().max(40).optional().nullable(),
  referenceRange: z.string().trim().max(100).optional().nullable(),
  flag: z.enum(labFlagEnum.enumValues).default('NORMAL'),
  status: z.enum(resultStatusEnum.enumValues).default('FINAL'),
  collectedAt: isoDateTime.optional(),
});

const CorrectionInput = z.object({
  section: z.enum([
    'demographics',
    'allergies',
    'diagnoses',
    'prescriptions',
    'encounters',
    'lab-results',
    'vitals',
    'other',
  ]),
  entryId: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(10).max(4000),
});
const CorrectionResolution = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED']),
  response: z.string().trim().min(5).max(4000),
});

/** Audits a read of identifiable clinical data, recording the basis for the access. */
async function auditView(
  req: Request,
  ctx: AuthContext,
  patientId: string,
  basis: ClinicalAccessBasis,
  section: string,
) {
  // Patients reading their own record are not logged as "accesses" so their access log answers
  // the question "who else looked at my data?".
  if (basis === 'SELF') return;
  await audit({
    action: AuditAction.PATIENT_RECORD_VIEWED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta: requestMeta(req),
    metadata: { section, basis },
  });
}

function auditChange(
  req: Request,
  ctx: AuthContext,
  patientId: string,
  resourceType: string,
  resourceId: string,
  tx: Executor,
  action: AuditActionValue = AuditAction.CLINICAL_ENTRY_CREATED,
  metadata?: Record<string, unknown>,
) {
  return audit(
    { action, actor: ctx, resourceType, resourceId, patientId, meta: requestMeta(req), metadata },
    tx,
  );
}

async function ensureEncounter(encounterId: string | null | undefined, patientId: string) {
  if (encounterId) await clinical.assertEncounterBelongsToPatient(encounterId, patientId);
}

/** Common preamble: authenticate the patient param and resolve write access. */
/** Common preamble for writes; by default only doctors author entries. */
async function writeContext(req: Request, roles: Role[] = WRITERS.doctorOnly) {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req), roles);
  return { ctx, patientId };
}

export const clinicalRouter = Router({ mergeParams: true });
clinicalRouter.use(authenticate);

/* ---------------------------------------------- reads ---------------------------------------- */

clinicalRouter.get('/summary', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  await auditView(req, ctx, patientId, basis, 'summary');
  res.json({
    ...(await clinical.getClinicalSummary(patientId, clinical.viewFor(basis))),
    accessBasis: basis,
  });
});

clinicalRouter.get('/encounters', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const page = parse(PaginationSchema, req.query);
  const basis = await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  await auditView(req, ctx, patientId, basis, 'encounters');
  res.json(await clinical.listEncounters(patientId, page, clinical.viewFor(basis)));
});

const listEndpoints: Record<
  string,
  (patientId: string, view: clinical.ViewOptions) => Promise<unknown[]>
> = {
  diagnoses: (id, view) => clinical.listDiagnoses(id, view),
  prescriptions: (id, view) => clinical.listPrescriptions(id, view),
  allergies: (id) => clinical.listAllergies(id),
  vitals: (id, view) => clinical.listVitals(id, 200, view),
  'lab-results': (id, view) => clinical.listLabResults(id, view),
  immunizations: (id, view) => clinical.listImmunizations(id, view),
  'medication-administrations': (id, view) => clinical.listAdministrations(id, view),
  'care-tasks': (id) => clinical.listCareTasks(id),
};

for (const [section, loader] of Object.entries(listEndpoints)) {
  clinicalRouter.get(`/${section}`, async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const basis = await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
    await auditView(req, ctx, patientId, basis, section);
    res.json({ items: await loader(patientId, clinical.viewFor(basis)) });
  });
}

clinicalRouter.get('/export', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  await audit({
    action: AuditAction.PATIENT_RECORD_EXPORTED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta: requestMeta(req),
    metadata: { basis },
  });
  res.setHeader('Content-Disposition', `attachment; filename="medical-record-${patientId}.json"`);
  res.json(await clinical.exportFullRecord(patientId, clinical.viewFor(basis)));
});

/* ---------------------------------------------- encounters & notes --------------------------- */

clinicalRouter.post('/encounters', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const input = parse(EncounterInput, req.body);
  if (input.endedAt && input.startedAt && input.endedAt < input.startedAt) {
    throw badRequest('Encounter cannot end before it starts');
  }
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(encounters)
      .values({
        patientId,
        doctorId: ctx.userId,
        facilityId: ctx.facilityId!,
        type: input.type,
        reason: input.reason,
        notes: input.notes ?? null,
        startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
        endedAt: input.endedAt ? new Date(input.endedAt) : null,
      })
      .returning();
    await auditChange(req, ctx, patientId, 'encounter', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

async function loadOwnEncounter(tx: Executor, ctx: AuthContext, patientId: string, id: string) {
  const [existing] = await tx
    .select()
    .from(encounters)
    .where(and(eq(encounters.id, id), eq(encounters.patientId, patientId)));
  if (!existing) throw notFound('Encounter not found');
  if (existing.doctorId !== ctx.userId) throw forbidden('Only the authoring doctor can do this');
  return existing;
}

/** Draft notes can be edited by their author, with optimistic concurrency. */
clinicalRouter.patch('/encounters/:entryId', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const { version, ...patch } = parse(EncounterPatch, req.body);
  const row = await db.transaction(async (tx) => {
    const existing = await loadOwnEncounter(tx, ctx, patientId, entryId);
    if (existing.noteStatus === 'SIGNED') {
      throw conflict('This note is signed. Add an addendum to amend it.');
    }
    const [updated] = await tx
      .update(encounters)
      .set({
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.endedAt !== undefined
          ? { endedAt: patch.endedAt ? new Date(patch.endedAt) : null }
          : {}),
        version: existing.version + 1,
      })
      .where(and(eq(encounters.id, entryId), eq(encounters.version, version)))
      .returning();
    if (!updated) {
      throw conflict('This note was changed by someone else. Reload and re-apply your edit.');
    }
    await auditChange(
      req,
      ctx,
      patientId,
      'encounter',
      entryId,
      tx,
      AuditAction.CLINICAL_ENTRY_UPDATED,
      {
        fields: Object.keys(patch),
        version: updated.version,
      },
    );
    return updated;
  });
  res.json(row);
});

/**
 * Marks a visit confidential from guardians (e.g. adolescent sexual or mental health care, as the
 * applicable law allows). Allowed after signing: it changes who may see the note, not its content.
 */
clinicalRouter.post('/encounters/:entryId/confidentiality', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const { confidential } = parse(z.object({ confidential: z.boolean() }), req.body);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(encounters)
      .set({ confidentialFromGuardians: confidential })
      .where(and(eq(encounters.id, entryId), eq(encounters.patientId, patientId)))
      .returning({
        id: encounters.id,
        confidentialFromGuardians: encounters.confidentialFromGuardians,
      });
    if (!updated) throw notFound('Encounter not found');
    await auditChange(
      req,
      ctx,
      patientId,
      'encounter',
      entryId,
      tx,
      AuditAction.ENCOUNTER_CONFIDENTIALITY_CHANGED,
      {
        confidential,
      },
    );
    return updated;
  });
  res.json(row);
});

clinicalRouter.post('/encounters/:entryId/sign', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const { version } = parse(SignSchema, req.body);
  const row = await db.transaction(async (tx) => {
    const existing = await loadOwnEncounter(tx, ctx, patientId, entryId);
    if (existing.noteStatus === 'SIGNED') throw conflict('This note is already signed');
    const now = new Date();
    const [updated] = await tx
      .update(encounters)
      .set({
        noteStatus: 'SIGNED',
        signedAt: now,
        signedById: ctx.userId,
        endedAt: existing.endedAt ?? now,
        version: existing.version + 1,
      })
      .where(and(eq(encounters.id, entryId), eq(encounters.version, version)))
      .returning();
    if (!updated)
      throw conflict('This note was changed since you loaded it. Review before signing.');
    await auditChange(req, ctx, patientId, 'encounter', entryId, tx, AuditAction.NOTE_SIGNED);
    return updated;
  });
  res.json(row);
});

/** Signed notes are amended by attributable addenda; the original text is preserved. */
clinicalRouter.post('/encounters/:entryId/addenda', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const input = parse(AddendumSchema, req.body);
  const row = await db.transaction(async (tx) => {
    const [enc] = await tx
      .select({ noteStatus: encounters.noteStatus })
      .from(encounters)
      .where(and(eq(encounters.id, entryId), eq(encounters.patientId, patientId)));
    if (!enc) throw notFound('Encounter not found');
    if (enc.noteStatus !== 'SIGNED') throw conflict('Draft notes are edited directly, not amended');
    const [created] = await tx
      .insert(encounterAddenda)
      .values({ encounterId: entryId, patientId, authorId: ctx.userId, ...input })
      .returning();
    await auditChange(
      req,
      ctx,
      patientId,
      'encounter_addendum',
      created!.id,
      tx,
      AuditAction.NOTE_ADDENDUM_ADDED,
      {
        encounterId: entryId,
        reason: input.reason,
      },
    );
    return created!;
  });
  res.status(201).json(row);
});

/* ---------------------------------------------- problems & medications ----------------------- */

clinicalRouter.post('/diagnoses', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const input = parse(DiagnosisInput, req.body);
  await ensureEncounter(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(diagnoses)
      .values({
        ...input,
        patientId,
        doctorId: ctx.userId,
        resolvedAt: input.status === 'RESOLVED' ? new Date() : null,
      })
      .returning();
    await auditChange(req, ctx, patientId, 'diagnosis', created!.id, tx);
    return created!;
  });
  // Chronic disease registers: a matching ICD-10 code enrols the patient (never blocks the visit).
  await enrolFromDiagnosis(row.id).catch(() => undefined);
  res.status(201).json(row);
});

clinicalRouter.patch('/diagnoses/:entryId', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const patch = parse(DiagnosisPatch, req.body);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(diagnoses)
      .set({
        status: patch.status,
        resolvedAt: patch.status === 'RESOLVED' ? new Date() : null,
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      })
      .where(and(eq(diagnoses.id, entryId), eq(diagnoses.patientId, patientId)))
      .returning();
    if (!updated) throw notFound('Diagnosis not found');
    await auditChange(
      req,
      ctx,
      patientId,
      'diagnosis',
      entryId,
      tx,
      AuditAction.CLINICAL_ENTRY_UPDATED,
      {
        status: patch.status,
      },
    );
    return updated;
  });
  res.json(row);
});

/** Dosage and frequency text for a structured dose, in the prescriber's language. */
async function structuredDoseText(userId: string, patientId: string, dose: StructuredDose) {
  const [locale, contexts] = await Promise.all([
    safetyLocaleOf(userId),
    dose.doseUnit === 'mg/kg' ? loadContexts([patientId]) : Promise.resolve(null),
  ]);
  return doseText(locale, dose, contexts?.get(patientId)?.weightKg ?? null);
}

clinicalRouter.post('/prescriptions', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const input = parse(PrescriptionInput, req.body);
  await ensureEncounter(input.encounterId, patientId);
  if (input.catalogItemId) {
    const [item] = await db
      .select({ id: medicationCatalog.id })
      .from(medicationCatalog)
      .where(
        and(eq(medicationCatalog.id, input.catalogItemId), eq(medicationCatalog.isActive, true)),
      );
    if (!item) throw badRequest('Unknown medication catalogue item');
  }
  // Medication safety: blocking alerts need an override reason (409 SAFETY_ALERTS otherwise).
  const {
    overrides,
    doseAmount,
    doseUnit,
    frequencyCode,
    maxDosesPer24h,
    durationDays,
    asNeeded,
    ...rxInput
  } = input;
  const dose: StructuredDose | null =
    doseAmount && doseUnit && frequencyCode
      ? {
          doseAmount,
          doseUnit,
          frequencyCode,
          maxDosesPer24h,
          durationDays,
          asNeeded: asNeeded || frequencyCode === 'PRN',
          route: rxInput.route,
        }
      : null;
  const safetyAlerts = await checkBeforePrescribing(ctx, {
    patientId,
    medication: rxInput.medication,
    catalogItemId: rxInput.catalogItemId,
    overrides,
    dose,
  });
  // Structured doses generate the free text in the prescriber's language ("500 mg", "three
  // times a day, for 5 days"); the duration sets the end date when none is given.
  const structured = dose
    ? {
        ...(await structuredDoseText(ctx.userId, patientId, dose)),
        route: routeCode(rxInput.route),
        doseAmount: String(dose.doseAmount),
        doseUnit: dose.doseUnit,
        frequencyCode: dose.frequencyCode,
        durationDays: dose.durationDays ?? null,
        asNeeded: Boolean(dose.asNeeded),
        maxDosesPer24h: dose.maxDosesPer24h ?? null,
        endDate:
          rxInput.endDate ??
          (dose.durationDays
            ? new Date(
                new Date(`${rxInput.startDate}T00:00:00Z`).getTime() +
                  (dose.durationDays - 1) * 86_400_000,
              )
                .toISOString()
                .slice(0, 10)
            : null),
      }
    : null;
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(prescriptions)
      .values({
        ...rxInput,
        dosage: rxInput.dosage ?? '',
        frequency: rxInput.frequency ?? '',
        ...structured,
        patientId,
        doctorId: ctx.userId,
      })
      .returning();
    await auditChange(req, ctx, patientId, 'prescription', created!.id, tx);
    await recordPrescriptionAlerts(tx, {
      ctx,
      meta: requestMeta(req),
      prescriptionId: created!.id,
      patientId,
      alerts: safetyAlerts,
      overrides,
    });
    await notifyFacilityRole(
      ctx.facilityId!,
      ['PHARMACIST'],
      {
        type: 'pharmacy',
        title: 'New prescription awaiting verification',
        link: '/pharmacy',
      },
      tx,
    );
    return created!;
  });
  const locale = await safetyLocaleOf(ctx.userId);
  res.status(201).json({ ...row, alerts: safetyAlerts.map((a) => toPublicAlert(a, locale)) });
});

clinicalRouter.patch('/prescriptions/:entryId', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const { status } = parse(PrescriptionPatch, req.body);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(prescriptions)
      .set({
        status,
        ...(status !== 'ACTIVE' ? { endDate: new Date().toISOString().slice(0, 10) } : {}),
      })
      .where(and(eq(prescriptions.id, entryId), eq(prescriptions.patientId, patientId)))
      .returning();
    if (!updated) throw notFound('Prescription not found');
    await auditChange(
      req,
      ctx,
      patientId,
      'prescription',
      entryId,
      tx,
      AuditAction.CLINICAL_ENTRY_UPDATED,
      {
        status,
      },
    );
    return updated;
  });
  res.json(row);
});

/* ---------------------------------------------- allergies ------------------------------------ */

clinicalRouter.post('/allergies', async (req, res) => {
  // Nurses record observations, reported allergies and vaccinations they give.
  const { ctx, patientId } = await writeContext(req, WRITERS.careTeam);
  const input = parse(AllergyInput, req.body);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(allergies)
      .values({ ...input, patientId, recordedById: ctx.userId })
      .returning();
    await tx
      .update(patients)
      .set({ allergyAssessment: 'ALLERGIES_RECORDED' })
      .where(eq(patients.id, patientId));
    await auditChange(req, ctx, patientId, 'allergy', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

clinicalRouter.patch('/allergies/:entryId', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const { verificationStatus } = parse(AllergyPatch, req.body);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(allergies)
      .set({ verificationStatus })
      .where(and(eq(allergies.id, entryId), eq(allergies.patientId, patientId)))
      .returning();
    if (!updated) throw notFound('Allergy not found');
    await auditChange(
      req,
      ctx,
      patientId,
      'allergy',
      entryId,
      tx,
      AuditAction.CLINICAL_ENTRY_UPDATED,
      {
        verificationStatus,
      },
    );
    return updated;
  });
  res.json(row);
});

/** Records "no known allergies" or "unknown" explicitly – an empty list is not a negative. */
clinicalRouter.put('/allergy-assessment', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { status } = parse(AllergyAssessmentSchema, req.body);
  await db.transaction(async (tx) => {
    if (status === 'NO_KNOWN_ALLERGIES') {
      const active = await tx
        .select({ id: allergies.id })
        .from(allergies)
        .where(
          and(
            eq(allergies.patientId, patientId),
            inArray(allergies.verificationStatus, ['UNCONFIRMED', 'CONFIRMED']),
          ),
        )
        .limit(1);
      if (active.length) {
        throw conflict('The patient has recorded allergies. Refute them first if they are wrong.');
      }
    }
    await tx.update(patients).set({ allergyAssessment: status }).where(eq(patients.id, patientId));
    await auditChange(
      req,
      ctx,
      patientId,
      'patient',
      patientId,
      tx,
      AuditAction.CLINICAL_ENTRY_UPDATED,
      {
        allergyAssessment: status,
      },
    );
  });
  res.json({ allergyAssessment: status });
});

/* ---------------------------------------------- vitals & results ----------------------------- */

clinicalRouter.post('/vitals', async (req, res) => {
  // Nurses record observations, reported allergies and vaccinations they give.
  const { ctx, patientId } = await writeContext(req, WRITERS.careTeam);
  const input = parse(VitalsInput, req.body);
  await ensureEncounter(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(vitalSigns)
      .values({
        ...input,
        temperatureC: input.temperatureC?.toString(),
        capillaryRefillSeconds: input.capillaryRefillSeconds?.toString(),
        weightKg: input.weightKg?.toString(),
        heightCm: input.heightCm?.toString(),
        patientId,
        recordedById: ctx.userId,
      })
      .returning();
    await auditChange(req, ctx, patientId, 'vital_signs', created!.id, tx);
    return created!;
  });
  // NEWS2 is scored straight away (and escalated for inpatients); a failure never loses the vitals.
  const news = await scoreVitalSign(row.id).catch(() => null);
  res.status(201).json({
    ...row,
    news: news && {
      id: news.id,
      scale: news.scale,
      score: news.score,
      risk: news.risk,
      complete: news.complete,
    },
  });
});

const ImmunizationInput = z.object({
  ...OptionalEncounter,
  vaccine: z.string().trim().min(2).max(200),
  doseNumber: z.number().int().min(1).max(20).optional().nullable(),
  lotNumber: z.string().trim().max(60).optional().nullable(),
  site: z.string().trim().max(60).optional().nullable(),
  administeredAt: isoDateTime
    .optional()
    .refine((d) => !d || new Date(d) <= new Date(), 'Cannot be in the future'),
  notes: z.string().trim().max(2000).optional().nullable(),
});

clinicalRouter.post('/immunizations', async (req, res) => {
  // Nurses record observations, reported allergies and vaccinations they give.
  const { ctx, patientId } = await writeContext(req, WRITERS.careTeam);
  const input = parse(ImmunizationInput, req.body);
  await ensureEncounter(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(immunizations)
      .values({
        ...input,
        administeredAt: input.administeredAt ? new Date(input.administeredAt) : new Date(),
        patientId,
        administeredById: ctx.userId,
        facilityId: ctx.facilityId!,
      })
      .returning();
    await auditChange(req, ctx, patientId, 'immunization', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

/* ---------------------------------------------- medication administration (MAR) ------------ */

const AdministrationInput = z
  .object({
    prescriptionId: z.string().uuid(),
    status: z.enum(administrationStatusEnum.enumValues),
    doseGiven: z.string().trim().max(100).optional().nullable(),
    reason: z.string().trim().max(500).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
    administeredAt: isoDateTime
      .optional()
      .refine(
        (d) => !d || new Date(d) <= new Date(Date.now() + 5 * 60_000),
        'Cannot be in the future',
      ),
    /** Barcode-checked administration: what the nurse scanned at the bedside. */
    patientScanned: z.boolean().optional().default(false),
    medicationScanned: z.boolean().optional().default(false),
    scanToken: z.string().trim().max(512).optional().nullable(),
    barcode: z.string().trim().max(120).optional().nullable(),
    scanOverrideReason: z.string().trim().max(300).optional().nullable(),
  })
  .refine((v) => v.status === 'GIVEN' || (v.reason && v.reason.length >= 3), {
    message: 'A reason is required when a dose is withheld, refused or omitted',
    path: ['reason'],
  })
  .refine((v) => !v.patientScanned || v.scanToken, {
    message: 'A scanned wristband must include the scanned code',
    path: ['scanToken'],
  })
  .refine((v) => !v.medicationScanned || v.barcode, {
    message: 'A scanned pack must include the scanned barcode',
    path: ['barcode'],
  });

const MIN_SCAN_OVERRIDE = 10;

const ScanCheckInput = z.object({
  prescriptionId: z.string().uuid(),
  patientToken: z.string().trim().max(512).optional().nullable(),
  medicationBarcode: z.string().trim().max(120).optional().nullable(),
});

/** Problems that a reason cannot override (wrong patient, wrong medicine) stop the dose. */
function stopProblems(checks: CheckResult) {
  return checks.problems.filter((p) => !p.overridable);
}

/**
 * Each dose is recorded explicitly – given, withheld, refused or omitted – by the clinician at the
 * bedside, and only against a prescription the pharmacy has verified. Entries are append-only.
 *
 * A dose recorded as GIVEN is barcode-checked: the wristband and the pack are scanned and checked
 * again here. Whatever was not scanned, and every warning (not due, already given, allergy …),
 * needs a written reason, which is audited. A wrong patient or wrong medicine is never accepted.
 */
clinicalRouter.post('/medication-administrations', async (req, res) => {
  const { ctx, patientId } = await writeContext(req, WRITERS.careTeam);
  const input = parse(AdministrationInput, req.body);
  const {
    scanToken,
    barcode,
    patientScanned: claimedPatient,
    medicationScanned: claimedMedication,
    scanOverrideReason,
    ...entry
  } = input;
  const rx = await loadAdministrablePrescription(patientId, entry.prescriptionId);
  const given = entry.status === 'GIVEN';
  const checks =
    given || scanToken || barcode
      ? await runChecks(
          patientId,
          { prescriptionId: rx.id, patientToken: scanToken, medicationBarcode: barcode },
          await safetyLocaleOf(ctx.userId),
          { rx, checkTiming: given },
        )
      : null;
  const stops = checks ? stopProblems(checks) : [];
  if (stops.length) {
    await audit({
      action: AuditAction.BARCODE_OVERRIDE,
      actor: ctx,
      resourceType: 'prescription',
      resourceId: rx.id,
      patientId,
      outcome: 'DENIED',
      meta: requestMeta(req),
      metadata: { refused: stops.map((p) => p.code) },
    });
    throw new HttpError(409, 'BCMA_STOP', stops[0]!.message, { problems: stops });
  }
  const patientScanned = Boolean(checks?.patientConfirmed);
  const medicationScanned = Boolean(checks?.medicationConfirmed);
  if (claimedPatient && !patientScanned) {
    throw badRequest('The wristband scan could not be confirmed');
  }
  if (claimedMedication && !medicationScanned) {
    throw badRequest('The medicine pack scan could not be confirmed');
  }
  const warnings = given ? (checks?.problems ?? []) : [];
  const needsOverride = given && (!patientScanned || !medicationScanned || warnings.length > 0);
  if (needsOverride && (!scanOverrideReason || scanOverrideReason.length < MIN_SCAN_OVERRIDE)) {
    throw badRequest(
      `A reason of at least ${MIN_SCAN_OVERRIDE} characters is required to give a dose without both scans or despite a warning`,
      {
        field: 'scanOverrideReason',
        patientScanned,
        medicationScanned,
        problems: warnings,
      },
    );
  }
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(medicationAdministrations)
      .values({
        ...entry,
        patientScanned,
        medicationScanned,
        scanOverrideReason: needsOverride ? scanOverrideReason : null,
        administeredAt: entry.administeredAt ? new Date(entry.administeredAt) : new Date(),
        patientId,
        administeredById: ctx.userId,
      })
      .returning();
    await auditChange(
      req,
      ctx,
      patientId,
      'medication_administration',
      created!.id,
      tx,
      AuditAction.MEDICATION_ADMINISTERED,
      {
        status: entry.status,
        patientScanned,
        medicationScanned,
      },
    );
    if (needsOverride) {
      await auditChange(
        req,
        ctx,
        patientId,
        'medication_administration',
        created!.id,
        tx,
        AuditAction.BARCODE_OVERRIDE,
        {
          prescriptionId: rx.id,
          patientScanned,
          medicationScanned,
          problems: warnings.map((p) => p.code),
          reason: scanOverrideReason,
        },
      );
    }
    return created!;
  });
  res.status(201).json(row);
});

/** Bedside check before giving: wristband + pack + timing + allergy, without recording anything. */
clinicalRouter.post('/bcma/verify', async (req, res) => {
  const { ctx, patientId } = await writeContext(req, WRITERS.careTeam);
  const input = parse(ScanCheckInput, req.body);
  const checks = await runChecks(
    patientId,
    {
      prescriptionId: input.prescriptionId,
      patientToken: input.patientToken,
      medicationBarcode: input.medicationBarcode,
    },
    await safetyLocaleOf(ctx.userId),
  );
  res.json(checks);
});

/** Scanning compliance of the ward the patient is on (aggregate; no other patient's data). */
clinicalRouter.get('/bcma/compliance', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const { days } = parse(
    z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
    req.query,
  );
  if (!['NURSE', 'DOCTOR', 'DIRECTOR'].includes(ctx.role)) throw forbidden();
  await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  const stay = await currentStay(patientId);
  if (!stay) {
    res.json({ unit: null, compliance: null });
    return;
  }
  res.json({
    unit: { id: stay.unitId, name: stay.unit },
    compliance: await unitCompliance(stay.unitId, days),
  });
});

/**
 * Prints (issues) a wristband: a signed code carrying only the patient's identity, plus the data
 * printed on the band. Allowed for reception, nurses and doctors who may see the demographics of
 * a patient who is admitted or in the emergency department.
 */
clinicalRouter.post('/wristband', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  if (!['NURSE', 'RECEPTION', 'DOCTOR'].includes(ctx.role)) throw forbidden();
  await assertDemographicsAccess(ctx, patientId);
  const band = await wristbandData(patientId);
  await audit({
    action: AuditAction.WRISTBAND_PRINTED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta: requestMeta(req),
    metadata: { stay: band.stay.kind, issuedAt: band.issuedAt },
  });
  res.status(201).json(band);
});

/** After the pharmacy returns a prescription, the prescriber can correct the plan and resubmit. */
clinicalRouter.post('/prescriptions/:entryId/resubmit', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const input = parse(
    z.object({
      dosage: z.string().trim().min(1).max(100).optional(),
      frequency: z.string().trim().min(1).max(100).optional(),
      instructions: z.string().trim().max(2000).optional().nullable(),
      note: z.string().trim().min(3).max(1000),
    }),
    req.body,
  );
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(prescriptions)
      .set({
        ...(input.dosage ? { dosage: input.dosage } : {}),
        ...(input.frequency ? { frequency: input.frequency } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        pharmacyStatus: 'PENDING',
        pharmacistNote: null,
        verifiedById: null,
        verifiedAt: null,
      })
      .where(
        and(
          eq(prescriptions.id, entryId),
          eq(prescriptions.patientId, patientId),
          eq(prescriptions.pharmacyStatus, 'RETURNED'),
          eq(prescriptions.status, 'ACTIVE'),
        ),
      )
      .returning();
    if (!updated) throw notFound('No returned prescription to resubmit');
    await auditChange(
      req,
      ctx,
      patientId,
      'prescription',
      entryId,
      tx,
      AuditAction.PRESCRIPTION_RESUBMITTED,
      {
        note: input.note,
      },
    );
    await notifyFacilityRole(
      ctx.facilityId!,
      ['PHARMACIST'],
      { type: 'pharmacy', title: 'A returned prescription was resubmitted', link: '/pharmacy' },
      tx,
    );
    return updated;
  });
  res.json(row);
});

/* ---------------------------------------------- care tasks ---------------------------------- */

const CareTaskInput = z.object({
  title: z.string().trim().min(3).max(200),
  details: z.string().trim().max(4000).optional().nullable(),
  priority: z.enum(taskPriorityEnum.enumValues).default('ROUTINE'),
  dueAt: isoDateTime.optional().nullable(),
  assignedRole: z.enum(['NURSE', 'DOCTOR']).default('NURSE'),
  assignedToId: z.string().uuid().optional().nullable(),
});

clinicalRouter.post('/care-tasks', async (req, res) => {
  const { ctx, patientId } = await writeContext(req, WRITERS.careTeam);
  const input = parse(CareTaskInput, req.body);
  if (input.assignedToId) {
    const [member] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, input.assignedToId));
    if (
      !member ||
      member.role !== input.assignedRole ||
      !(await hasActiveCareAssignment(input.assignedToId, patientId))
    ) {
      throw badRequest(
        `The assignee must be a ${input.assignedRole.toLowerCase()} in the patient's care team`,
      );
    }
  }
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(careTasks)
      .values({
        ...input,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        patientId,
        facilityId: ctx.facilityId!,
        createdById: ctx.userId,
      })
      .returning();
    await auditChange(
      req,
      ctx,
      patientId,
      'care_task',
      created!.id,
      tx,
      AuditAction.CARE_TASK_CREATED,
      {
        priority: input.priority,
      },
    );
    const n = {
      type: 'task',
      title: input.priority === 'URGENT' ? 'New URGENT care task' : 'New care task',
      important: input.priority === 'URGENT',
      link: '/tasks',
    };
    if (input.assignedToId) await notifyUsers([input.assignedToId], n, tx);
    else await notifyCareTeamRole(patientId, input.assignedRole, n, tx, ctx.userId);
    return created!;
  });
  res.status(201).json(row);
});

clinicalRouter.post('/lab-results', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const input = parse(LabInput, req.body);
  await ensureEncounter(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(labResults)
      .values({
        ...input,
        collectedAt: input.collectedAt ? new Date(input.collectedAt) : new Date(),
        patientId,
        orderedById: ctx.userId,
      })
      .returning();
    await auditChange(req, ctx, patientId, 'lab_result', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

/**
 * Closed-loop result follow-up: a clinician acknowledges (reviews) a result, then releases it to
 * the patient. Viewing a result is not acknowledgement, and unacknowledged results stay on the
 * ordering clinician's worklist.
 */
clinicalRouter.post('/lab-results/:entryId/acknowledge', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(labResults)
      .where(and(eq(labResults.id, entryId), eq(labResults.patientId, patientId)));
    if (!existing) throw notFound('Result not found');
    if (existing.acknowledgedAt) throw conflict('Result already acknowledged');
    const [updated] = await tx
      .update(labResults)
      .set({ acknowledgedAt: new Date(), acknowledgedById: ctx.userId })
      .where(eq(labResults.id, entryId))
      .returning();
    await auditChange(
      req,
      ctx,
      patientId,
      'lab_result',
      entryId,
      tx,
      AuditAction.RESULT_ACKNOWLEDGED,
    );
    return updated!;
  });
  res.json(row);
});

clinicalRouter.post('/lab-results/:entryId/release', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(labResults)
      .where(and(eq(labResults.id, entryId), eq(labResults.patientId, patientId)));
    if (!existing) throw notFound('Result not found');
    if (!existing.acknowledgedAt) throw conflict('Acknowledge the result before releasing it');
    if (existing.status === 'PRELIMINARY') throw conflict('Preliminary results cannot be released');
    if (existing.releasedAt) throw conflict('Result already released');
    const [updated] = await tx
      .update(labResults)
      .set({ releasedAt: new Date(), releasedById: ctx.userId })
      .where(eq(labResults.id, entryId))
      .returning();
    await auditChange(req, ctx, patientId, 'lab_result', entryId, tx, AuditAction.RESULT_RELEASED);
    // Results from a visit that is confidential from guardians are not announced to guardians.
    const [visit] = existing.encounterId
      ? await tx
          .select({ confidential: encounters.confidentialFromGuardians })
          .from(encounters)
          .where(eq(encounters.id, existing.encounterId))
      : [];
    await notifyPatient(
      patientId,
      {
        type: 'result',
        title: 'A new test result is available',
        link: '/portal/results',
        important: true,
      },
      tx,
      { guardians: visit?.confidential ? 'none' : 'full' },
    );
    return updated!;
  });
  res.json(row);
});

/* ---------------------------------------------- correction requests -------------------------- */

clinicalRouter.get('/correction-requests', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  const rows = await db
    .select({
      id: correctionRequests.id,
      section: correctionRequests.section,
      entryId: correctionRequests.entryId,
      description: correctionRequests.description,
      status: correctionRequests.status,
      response: correctionRequests.response,
      resolvedAt: correctionRequests.resolvedAt,
      resolvedBy: users.fullName,
      createdAt: correctionRequests.createdAt,
    })
    .from(correctionRequests)
    .leftJoin(users, eq(users.id, correctionRequests.resolvedById))
    .where(eq(correctionRequests.patientId, patientId))
    .orderBy(desc(correctionRequests.createdAt));
  res.json({ items: rows });
});

/** Patients ask for corrections; they never edit the clinical record directly. */
clinicalRouter.post('/correction-requests', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  if (basis !== 'SELF' && basis !== 'GUARDIAN') {
    throw forbidden('Only the patient (or their guardian) can submit a correction request');
  }
  const input = parse(CorrectionInput, req.body);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(correctionRequests)
      .values({ ...input, patientId, requestedById: ctx.userId })
      .returning();
    await auditChange(
      req,
      ctx,
      patientId,
      'correction_request',
      created!.id,
      tx,
      AuditAction.CORRECTION_REQUESTED,
      {
        section: input.section,
      },
    );
    await notifyCareTeam(
      patientId,
      {
        type: 'correction',
        title: 'A patient requested a record correction',
        link: `/doctor/patients/${patientId}`,
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

clinicalRouter.patch('/correction-requests/:entryId', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const { entryId } = parse(EntryParams, req.params);
  const input = parse(CorrectionResolution, req.body);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(correctionRequests)
      .set({ ...input, resolvedById: ctx.userId, resolvedAt: new Date() })
      .where(
        and(
          eq(correctionRequests.id, entryId),
          eq(correctionRequests.patientId, patientId),
          eq(correctionRequests.status, 'OPEN'),
        ),
      )
      .returning();
    if (!updated) throw notFound('Open correction request not found');
    await auditChange(
      req,
      ctx,
      patientId,
      'correction_request',
      entryId,
      tx,
      AuditAction.CORRECTION_RESOLVED,
      {
        status: input.status,
      },
    );
    await notifyPatient(
      patientId,
      {
        type: 'correction',
        title: 'Your correction request was answered',
        important: true,
        link: '/portal/account',
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});
