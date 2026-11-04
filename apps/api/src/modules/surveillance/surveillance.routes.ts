import { Router } from 'express';
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  caseReports,
  diagnoses,
  facilities,
  notifiableDiseases,
  patients,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { resolveClinicalReadAccess } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { buildDashboard, casesForStats } from './surveillance.service.js';

/**
 * Notifiable infectious disease surveillance. Diagnoses of notifiable diseases become DRAFT case
 * reports automatically (see surveillance.service.ts); the diagnosing doctor completes and submits
 * them; the Ministry (public-health authority, legal basis for identifiable data) reviews them and
 * follows the national dashboard. Directors see their facility's cases without patient names.
 */
export const surveillanceRouter = Router();
surveillanceRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const IcdPrefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,2})?$/, 'Use an ICD-10 code or category, e.g. A23 or A05.1');
const CLASSIFICATIONS = ['SUSPECTED', 'PROBABLE', 'CONFIRMED'] as const;

const ageYears = (dob: string, at = new Date()) => {
  const d = new Date(`${dob}T00:00:00Z`);
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) a--;
  return a;
};

/* ---------------------------------------------------------------------------------- diseases -- */

surveillanceRouter.get('/diseases', async (_req, res) => {
  const rows = await db.select().from(notifiableDiseases).orderBy(notifiableDiseases.name);
  res.json({ items: rows });
});

const DiseaseInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,30}$/),
  name: z.string().trim().min(2).max(200),
  icd10Prefixes: z.array(IcdPrefix).min(1).max(30),
  urgency: z.enum(['IMMEDIATE', 'WEEKLY']),
});

surveillanceRouter.post('/diseases', requireRole('MINISTRY'), async (req, res) => {
  const input = parse(DiseaseInput, req.body);
  const [row] = await db
    .insert(notifiableDiseases)
    .values(input)
    .onConflictDoNothing({ target: notifiableDiseases.code })
    .returning();
  if (!row) throw conflict('A disease with this code already exists');
  res.status(201).json(row);
});

surveillanceRouter.patch('/diseases/:id', requireRole('MINISTRY'), async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(
    DiseaseInput.omit({ code: true })
      .partial()
      .extend({ isActive: z.boolean().optional() })
      .refine((v) => Object.keys(v).length > 0, 'Nothing to change'),
    req.body,
  );
  const [row] = await db
    .update(notifiableDiseases)
    .set(input)
    .where(eq(notifiableDiseases.id, id))
    .returning();
  if (!row) throw notFound('Disease not found');
  res.json(row);
});

/* ------------------------------------------------------------------------------------- cases -- */

const caseSelect = {
  id: caseReports.id,
  status: caseReports.status,
  classification: caseReports.classification,
  onsetDate: caseReports.onsetDate,
  details: caseReports.details,
  createdAt: caseReports.createdAt,
  submittedAt: caseReports.submittedAt,
  reviewedAt: caseReports.reviewedAt,
  reviewNote: caseReports.reviewNote,
  reportedById: caseReports.reportedById,
  facilityId: caseReports.facilityId,
  facilityName: facilities.name,
  diagnosisId: caseReports.diagnosisId,
  icd10Code: diagnoses.icd10Code,
  disease: {
    id: notifiableDiseases.id,
    code: notifiableDiseases.code,
    name: notifiableDiseases.name,
    urgency: notifiableDiseases.urgency,
  },
  patient: {
    id: patients.id,
    firstName: patients.firstName,
    lastName: patients.lastName,
    nationalId: patients.nationalId,
    dateOfBirth: patients.dateOfBirth,
    sex: patients.sex,
    municipality: patients.municipality,
  },
  reporterName: users.fullName,
};

const caseQuery = () =>
  db
    .select(caseSelect)
    .from(caseReports)
    .innerJoin(notifiableDiseases, eq(notifiableDiseases.id, caseReports.diseaseId))
    .innerJoin(patients, eq(patients.id, caseReports.patientId))
    .innerJoin(facilities, eq(facilities.id, caseReports.facilityId))
    .leftJoin(diagnoses, eq(diagnoses.id, caseReports.diagnosisId))
    .leftJoin(users, eq(users.id, caseReports.reportedById));

type CaseRow = Awaited<ReturnType<ReturnType<typeof caseQuery>['execute']>>[number];

/** Directors (operational oversight) never see who the patient is – only age, sex, municipality. */
function present(row: CaseRow, identifiable: boolean) {
  const { patient, ...rest } = row;
  const base = {
    age: ageYears(patient.dateOfBirth),
    sex: patient.sex,
    municipality: patient.municipality,
  };
  return {
    ...rest,
    patient: identifiable
      ? {
          ...base,
          id: patient.id,
          name: `${patient.firstName} ${patient.lastName}`,
          nationalId: patient.nationalId,
          dateOfBirth: patient.dateOfBirth,
        }
      : base,
  };
}

async function loadCase(id: string) {
  const [row] = await caseQuery().where(eq(caseReports.id, id));
  if (!row) throw notFound('Case report not found');
  return row;
}

/** Doctors may work on a case they reported or for a patient whose record they may open. */
async function assertDoctorAccess(
  ctx: AuthContext,
  row: CaseRow,
  meta: ReturnType<typeof requestMeta>,
) {
  if (ctx.role !== 'DOCTOR') throw forbidden('Only doctors complete case reports');
  if (row.reportedById === ctx.userId) return;
  await resolveClinicalReadAccess(ctx, row.patient.id, meta);
}

async function auditCaseView(
  ctx: AuthContext,
  row: CaseRow,
  req: Parameters<typeof requestMeta>[0],
) {
  await audit({
    action: AuditAction.PATIENT_RECORD_VIEWED,
    actor: ctx,
    resourceType: 'case_report',
    resourceId: row.id,
    patientId: row.patient.id,
    meta: requestMeta(req),
    metadata: { section: 'surveillance', basis: 'PUBLIC_HEALTH' },
  });
}

/** Draft case reports the doctor should complete, and their recently submitted ones. */
surveillanceRouter.get('/my-cases', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await caseQuery()
    .where(
      and(
        eq(caseReports.reportedById, ctx.userId),
        sql`(${caseReports.status} = 'DRAFT' OR ${caseReports.submittedAt} > now() - interval '30 days')`,
      ),
    )
    .orderBy(desc(caseReports.createdAt))
    .limit(100);
  res.json({
    items: rows.map((r) => present(r, true)),
    drafts: rows.filter((r) => r.status === 'DRAFT').length,
  });
});

/** Case reports of one patient (for the chart's problem list). */
surveillanceRouter.get(
  '/patients/:patientId/cases',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
    await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
    const rows = await db
      .select({
        id: caseReports.id,
        diagnosisId: caseReports.diagnosisId,
        status: caseReports.status,
        classification: caseReports.classification,
        diseaseName: notifiableDiseases.name,
        urgency: notifiableDiseases.urgency,
        reportedById: caseReports.reportedById,
      })
      .from(caseReports)
      .innerJoin(notifiableDiseases, eq(notifiableDiseases.id, caseReports.diseaseId))
      .where(eq(caseReports.patientId, patientId));
    res.json({ items: rows });
  },
);

surveillanceRouter.get(
  '/cases/:id',
  requireRole('DOCTOR', 'MINISTRY', 'DIRECTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const row = await loadCase(id);
    if (ctx.role === 'DIRECTOR') {
      if (row.facilityId !== ctx.facilityId) throw notFound('Case report not found');
      res.json(present(row, false));
      return;
    }
    if (ctx.role === 'DOCTOR') await assertDoctorAccess(ctx, row, requestMeta(req));
    else await auditCaseView(ctx, row, req);
    res.json(present(row, true));
  },
);

const DetailsSchema = z
  .object({
    symptoms: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    hospitalised: z.boolean().optional(),
    travelHistory: z.string().trim().max(500).optional(),
    contactsCount: z.coerce.number().int().min(0).max(10_000).optional(),
    vaccinationStatus: z.enum(['VACCINATED', 'PARTIALLY', 'NOT_VACCINATED', 'UNKNOWN']).optional(),
    labConfirmation: z.string().trim().max(300).optional(),
    outbreakSuspected: z.boolean().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

surveillanceRouter.patch('/cases/:id', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(
    z.object({
      onsetDate: isoDate.optional(),
      classification: z.enum(CLASSIFICATIONS).optional(),
      details: DetailsSchema.optional(),
    }),
    req.body,
  );
  const row = await loadCase(id);
  await assertDoctorAccess(ctx, row, requestMeta(req));
  if (row.status !== 'DRAFT') throw conflict('Only draft case reports can be changed');
  if (input.onsetDate && input.onsetDate > new Date().toISOString().slice(0, 10)) {
    throw badRequest('The onset date cannot be in the future');
  }
  await db
    .update(caseReports)
    .set({
      onsetDate: input.onsetDate ?? row.onsetDate,
      classification: input.classification ?? row.classification,
      details: input.details ? { ...row.details, ...input.details } : row.details,
    })
    .where(eq(caseReports.id, id));
  res.json(present(await loadCase(id), true));
});

surveillanceRouter.post('/cases/:id/submit', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const row = await loadCase(id);
  await assertDoctorAccess(ctx, row, requestMeta(req));
  if (row.status !== 'DRAFT') throw conflict('This case report was already submitted');
  if (!row.onsetDate) throw badRequest('Enter the date of onset before submitting');
  await db.transaction(async (tx) => {
    await tx
      .update(caseReports)
      .set({
        status: 'SUBMITTED',
        submittedAt: new Date(),
        reportedById: row.reportedById ?? ctx.userId,
      })
      .where(eq(caseReports.id, id));
    await audit(
      {
        action: AuditAction.CASE_REPORT_SUBMITTED,
        actor: ctx,
        resourceType: 'case_report',
        resourceId: id,
        patientId: row.patient.id,
        meta: requestMeta(req),
        metadata: { disease: row.disease.code, classification: row.classification },
      },
      tx,
    );
  });
  res.json(present(await loadCase(id), true));
});

/** The doctor rules the case out (e.g. wrong code, diagnosis refuted). */
surveillanceRouter.post('/cases/:id/discard', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
  const row = await loadCase(id);
  await assertDoctorAccess(ctx, row, requestMeta(req));
  if (row.status !== 'DRAFT') throw conflict('This case report was already submitted');
  await db.transaction(async (tx) => {
    await tx
      .update(caseReports)
      .set({
        status: 'SUBMITTED',
        classification: 'DISCARDED',
        submittedAt: new Date(),
        details: { ...row.details, discardReason: reason },
      })
      .where(eq(caseReports.id, id));
    await audit(
      {
        action: AuditAction.CASE_REPORT_SUBMITTED,
        actor: ctx,
        resourceType: 'case_report',
        resourceId: id,
        patientId: row.patient.id,
        meta: requestMeta(req),
        metadata: { disease: row.disease.code, classification: 'DISCARDED' },
      },
      tx,
    );
  });
  res.json(present(await loadCase(id), true));
});

const CaseQuery = PaginationSchema.extend({
  disease: z.string().trim().max(30).optional(),
  status: z.enum(['DRAFT', 'SUBMITTED', 'REVIEWED']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  facilityId: z.string().uuid().optional(),
});

/** Public-health case list: the Ministry nationally (identifiable), directors their facility. */
surveillanceRouter.get('/cases', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(CaseQuery, req.query);
  const filters: SQL[] = [];
  if (ctx.role === 'DIRECTOR') filters.push(eq(caseReports.facilityId, ctx.facilityId!));
  else if (q.facilityId) filters.push(eq(caseReports.facilityId, q.facilityId));
  if (q.disease) filters.push(eq(notifiableDiseases.code, q.disease.toUpperCase()));
  if (q.status) filters.push(eq(caseReports.status, q.status));
  if (q.from) filters.push(gte(caseReports.createdAt, new Date(`${q.from}T00:00:00Z`)));
  if (q.to) filters.push(lte(caseReports.createdAt, new Date(`${q.to}T23:59:59Z`)));
  const where = filters.length ? and(...filters) : undefined;
  const { limit, offset } = toOffset(q);
  const [rows, [total]] = await Promise.all([
    caseQuery().where(where).orderBy(desc(caseReports.createdAt)).limit(limit).offset(offset),
    db
      .select({ n: count() })
      .from(caseReports)
      .innerJoin(notifiableDiseases, eq(notifiableDiseases.id, caseReports.diseaseId))
      .where(where),
  ]);
  const identifiable = ctx.role === 'MINISTRY';
  if (identifiable) for (const r of rows) await auditCaseView(ctx, r, req);
  res.json(
    paginated(
      rows.map((r) => present(r, identifiable)),
      total?.n ?? 0,
      q,
    ),
  );
});

surveillanceRouter.post('/cases/:id/review', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(
    z.object({
      classification: z.enum([...CLASSIFICATIONS, 'DISCARDED']),
      note: z.string().trim().max(1000).optional(),
    }),
    req.body,
  );
  const row = await loadCase(id);
  if (row.status !== 'SUBMITTED') throw conflict('Only submitted case reports can be reviewed');
  await db.transaction(async (tx) => {
    await tx
      .update(caseReports)
      .set({
        status: 'REVIEWED',
        classification: input.classification,
        reviewNote: input.note ?? null,
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
      })
      .where(eq(caseReports.id, id));
    await audit(
      {
        action: AuditAction.CASE_REPORT_REVIEWED,
        actor: ctx,
        resourceType: 'case_report',
        resourceId: id,
        patientId: row.patient.id,
        meta: requestMeta(req),
        metadata: { disease: row.disease.code, classification: input.classification },
      },
      tx,
    );
  });
  res.json(present(await loadCase(id), true));
});

/* ----------------------------------------------------------------------------------- dashboard -- */

surveillanceRouter.get('/dashboard', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { weeks } = parse(
    z.object({ weeks: z.coerce.number().int().min(4).max(52).default(12) }),
    req.query,
  );
  const now = new Date();
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : null;
  const from = new Date(now.getTime() - (weeks + 5) * 7 * 86_400_000);
  const cases = await casesForStats({ from, facilityId });
  const dashboard = buildDashboard(cases, now, weeks);

  // Reporting timeliness: drafts waiting, overdue drafts (24 h immediate / 7 days weekly).
  const [timeliness] = await db
    .select({
      drafts: sql<number>`count(*) FILTER (WHERE ${caseReports.status} = 'DRAFT')::int`,
      overdueDrafts: sql<number>`count(*) FILTER (WHERE ${caseReports.status} = 'DRAFT' AND ${caseReports.createdAt} < now() - CASE WHEN ${notifiableDiseases.urgency} = 'IMMEDIATE' THEN interval '24 hours' ELSE interval '7 days' END)::int`,
      submitted: sql<number>`count(*) FILTER (WHERE ${caseReports.submittedAt} IS NOT NULL)::int`,
      submittedOnTime: sql<number>`count(*) FILTER (WHERE ${caseReports.submittedAt} IS NOT NULL AND ${caseReports.submittedAt} - ${caseReports.createdAt} <= CASE WHEN ${notifiableDiseases.urgency} = 'IMMEDIATE' THEN interval '24 hours' ELSE interval '7 days' END)::int`,
    })
    .from(caseReports)
    .innerJoin(notifiableDiseases, eq(notifiableDiseases.id, caseReports.diseaseId))
    .where(
      and(
        gte(caseReports.createdAt, from),
        facilityId ? eq(caseReports.facilityId, facilityId) : undefined,
      ),
    );
  res.json({
    ...dashboard,
    scope: facilityId ? 'FACILITY' : 'NATIONAL',
    timeliness: {
      ...timeliness,
      onTimePct: timeliness?.submitted
        ? Math.round((timeliness.submittedOnTime / timeliness.submitted) * 100)
        : null,
    },
  });
});
