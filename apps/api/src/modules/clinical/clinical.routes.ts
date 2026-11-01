import { Router, type Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  allergies,
  allergySeverityEnum,
  diagnoses,
  diagnosisStatusEnum,
  encounters,
  encounterTypeEnum,
  labFlagEnum,
  labResults,
  prescriptions,
  prescriptionStatusEnum,
  vitalSigns,
} from '../../db/schema.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { PaginationSchema } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  resolveClinicalReadAccess,
  type ClinicalAccessBasis,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
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
  notes: z.string().trim().max(20_000).optional().nullable(),
  endedAt: isoDateTime.optional().nullable(),
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
});

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
  collectedAt: isoDateTime.optional(),
});

/** Audits a read of identifiable clinical data, recording the legal basis for the access. */
async function auditView(
  req: Request,
  ctx: AuthContext,
  patientId: string,
  basis: ClinicalAccessBasis,
  section: string,
) {
  // Patients reading their own record are not logged as "accesses" to keep their access log
  // meaningful (it should answer "who else looked at my data?").
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

async function auditCreate(
  req: Request,
  ctx: AuthContext,
  patientId: string,
  resourceType: string,
  resourceId: string,
  tx: Parameters<typeof audit>[1],
) {
  await audit(
    {
      action: AuditAction.CLINICAL_ENTRY_CREATED,
      actor: ctx,
      resourceType,
      resourceId,
      patientId,
      meta: requestMeta(req),
    },
    tx,
  );
}

async function ensureEncounter(encounterId: string | null | undefined, patientId: string) {
  if (encounterId) await clinical.assertEncounterBelongsToPatient(encounterId, patientId);
}

export const clinicalRouter = Router({ mergeParams: true });
clinicalRouter.use(authenticate);

/* ---------------------------------------------- reads ---------------------------------------- */

clinicalRouter.get('/summary', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await resolveClinicalReadAccess(ctx, patientId);
  await auditView(req, ctx, patientId, basis, 'summary');
  res.json({ ...(await clinical.getClinicalSummary(patientId)), accessBasis: basis });
});

clinicalRouter.get('/encounters', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const page = parse(PaginationSchema, req.query);
  const basis = await resolveClinicalReadAccess(ctx, patientId);
  await auditView(req, ctx, patientId, basis, 'encounters');
  res.json(await clinical.listEncounters(patientId, page));
});

const listEndpoints: Record<string, (patientId: string) => Promise<unknown[]>> = {
  diagnoses: clinical.listDiagnoses,
  prescriptions: clinical.listPrescriptions,
  allergies: clinical.listAllergies,
  vitals: (id) => clinical.listVitals(id, 200),
  'lab-results': clinical.listLabResults,
};

for (const [section, loader] of Object.entries(listEndpoints)) {
  clinicalRouter.get(`/${section}`, async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const basis = await resolveClinicalReadAccess(ctx, patientId);
    await auditView(req, ctx, patientId, basis, section);
    res.json({ items: await loader(patientId) });
  });
}

clinicalRouter.get('/export', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await resolveClinicalReadAccess(ctx, patientId);
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
  res.json(await clinical.exportFullRecord(patientId));
});

/* ---------------------------------------------- writes --------------------------------------- */

clinicalRouter.post('/encounters', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(EncounterInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
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
    await auditCreate(req, ctx, patientId, 'encounter', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

/** Clinical notes can only be amended by their author, and every amendment is audited. */
clinicalRouter.patch('/encounters/:entryId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, entryId } = parse(EntryParams, req.params);
  const patch = parse(EncounterPatch, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(encounters)
      .where(and(eq(encounters.id, entryId), eq(encounters.patientId, patientId)));
    if (!existing) throw notFound('Encounter not found');
    if (existing.doctorId !== ctx.userId) throw forbidden('Only the authoring doctor can amend');
    const [updated] = await tx
      .update(encounters)
      .set({
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.endedAt !== undefined
          ? { endedAt: patch.endedAt ? new Date(patch.endedAt) : null }
          : {}),
      })
      .where(eq(encounters.id, entryId))
      .returning();
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_UPDATED,
        actor: ctx,
        resourceType: 'encounter',
        resourceId: entryId,
        patientId,
        meta: requestMeta(req),
        metadata: { fields: Object.keys(patch) },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

clinicalRouter.post('/diagnoses', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(DiagnosisInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
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
    await auditCreate(req, ctx, patientId, 'diagnosis', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

clinicalRouter.patch('/diagnoses/:entryId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, entryId } = parse(EntryParams, req.params);
  const patch = parse(DiagnosisPatch, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
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
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_UPDATED,
        actor: ctx,
        resourceType: 'diagnosis',
        resourceId: entryId,
        patientId,
        meta: requestMeta(req),
        metadata: { status: patch.status },
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

clinicalRouter.post('/prescriptions', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(PrescriptionInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
  await ensureEncounter(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(prescriptions)
      .values({ ...input, patientId, doctorId: ctx.userId })
      .returning();
    await auditCreate(req, ctx, patientId, 'prescription', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

clinicalRouter.patch('/prescriptions/:entryId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, entryId } = parse(EntryParams, req.params);
  const { status } = parse(PrescriptionPatch, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
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
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_UPDATED,
        actor: ctx,
        resourceType: 'prescription',
        resourceId: entryId,
        patientId,
        meta: requestMeta(req),
        metadata: { status },
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

clinicalRouter.post('/allergies', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(AllergyInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(allergies)
      .values({ ...input, patientId, recordedById: ctx.userId })
      .returning();
    await auditCreate(req, ctx, patientId, 'allergy', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

clinicalRouter.post('/vitals', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(VitalsInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
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
    await auditCreate(req, ctx, patientId, 'vital_signs', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});

clinicalRouter.post('/lab-results', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(LabInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId);
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
    await auditCreate(req, ctx, patientId, 'lab_result', created!.id, tx);
    return created!;
  });
  res.status(201).json(row);
});
