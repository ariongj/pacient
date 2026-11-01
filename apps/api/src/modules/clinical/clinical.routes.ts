import { Router, type Request } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
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
  labResults,
  patients,
  prescriptions,
  prescriptionStatusEnum,
  resultStatusEnum,
  users,
  verificationStatusEnum,
  vitalSigns,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { PaginationSchema } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  resolveClinicalReadAccess,
  type ClinicalAccessBasis,
} from '../access/policy.js';
import { audit, AuditAction, type AuditActionValue } from '../audit/audit.service.js';
import * as clinical from './clinical.service.js';

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
    dosage: z.string().trim().min(1).max(100),
    frequency: z.string().trim().min(1).max(100),
    route: z.string().trim().min(1).max(50).default('oral'),
    instructions: z.string().trim().max(2000).optional().nullable(),
    startDate: z.string().date(),
    endDate: z.string().date().optional().nullable(),
  })
  .refine((p) => !p.endDate || p.endDate >= p.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
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
  })
  .refine(
    (v) => Object.entries(v).some(([k, val]) => k !== 'encounterId' && val !== undefined),
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
async function writeContext(req: Request) {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req));
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
  diagnoses: (id) => clinical.listDiagnoses(id),
  prescriptions: (id) => clinical.listPrescriptions(id),
  allergies: (id) => clinical.listAllergies(id),
  vitals: (id) => clinical.listVitals(id, 200),
  'lab-results': (id, view) => clinical.listLabResults(id, view),
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

clinicalRouter.post('/prescriptions', async (req, res) => {
  const { ctx, patientId } = await writeContext(req);
  const input = parse(PrescriptionInput, req.body);
  await ensureEncounter(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(prescriptions)
      .values({ ...input, patientId, doctorId: ctx.userId })
      .returning();
    await auditChange(req, ctx, patientId, 'prescription', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
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
  const { ctx, patientId } = await writeContext(req);
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
  const { ctx, patientId } = await writeContext(req);
  const input = parse(VitalsInput, req.body);
  await ensureEncounter(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(vitalSigns)
      .values({
        ...input,
        temperatureC: input.temperatureC?.toString(),
        weightKg: input.weightKg?.toString(),
        heightCm: input.heightCm?.toString(),
        patientId,
        recordedById: ctx.userId,
      })
      .returning();
    await auditChange(req, ctx, patientId, 'vital_signs', created!.id, tx);
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
  if (basis !== 'SELF') throw forbidden('Only the patient can submit a correction request');
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
    return updated;
  });
  res.json(row);
});
