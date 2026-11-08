import { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  cancerCases,
  careAssignments,
  mdtCaseReviews,
  mdtMeetings,
  patients,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import type { RequestMeta } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertClinicalWriteAccess, resolveAndAuditRead } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { kosovoDate } from '../identity/identity.service.js';
import {
  BASES_OF_DIAGNOSIS,
  checkCase,
  ICD10_CANCER,
  LATERALITIES,
  MORPHOLOGIES,
  MORPHOLOGY,
  PAIRED_SITE_GROUPS,
  RECOMMENDATIONS,
  SITE_GROUPS,
  STAGES,
  TNM_M,
  TNM_N,
  TNM_T,
  TOPOGRAPHY,
  topographyFromIcd10,
  TUMOUR_GROUPS,
} from './definitions.js';
import {
  dcoCandidateCount,
  dcoCandidates,
  findPossibleDuplicate,
  patientCases,
  registryStats,
  type CancerCase,
} from './oncology.service.js';

/**
 * Cancer registry (registration of primary cancers with ICD-O-3 coding and stage) and tumour board
 * (multidisciplinary team) meetings. Registrations are clinical data: only the care team reads
 * them; directors and the Ministry see aggregate statistics.
 */
export const oncologyRouter = Router();
oncologyRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const reason = z.string().trim().min(10, 'Give the reason (at least 10 characters)').max(500);

const optTnm = (re: RegExp, message: string) =>
  z
    .string()
    .trim()
    .max(6)
    .regex(re, message)
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null));

const CaseFieldsBase = z.object({
  diagnosedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((d) => d <= kosovoDate(new Date()), 'The date of diagnosis cannot be in the future'),
  icd10: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      ICD10_CANCER,
      'Use an ICD-10 code for a malignant (C00–C97) or in-situ (D00–D09) tumour',
    ),
  topography: z
    .string()
    .trim()
    .toUpperCase()
    .regex(TOPOGRAPHY, 'Use an ICD-O-3 topography code such as C50.4'),
  morphology: z
    .string()
    .trim()
    .regex(MORPHOLOGY, 'Use an ICD-O-3 morphology code with behaviour, such as 8500/3'),
  laterality: z.enum(LATERALITIES),
  basisOfDiagnosis: z.enum(BASES_OF_DIAGNOSIS),
  tnmT: optTnm(TNM_T, 'Not a valid T category (e.g. cT2, pT1c, Tis)'),
  tnmN: optTnm(TNM_N, 'Not a valid N category (e.g. N0, pN1a)'),
  tnmM: optTnm(TNM_M, 'Not a valid M category (M0, M1, M1b)'),
  stage: z.enum(STAGES).optional().nullable(),
  tnmEdition: z.string().trim().max(10).optional().nullable(),
});
const CaseFields = CaseFieldsBase.extend({
  laterality: z.enum(LATERALITIES).default('NOT_APPLICABLE'),
});

function assertProblems(c: z.infer<typeof CaseFields>) {
  const { problems, warnings } = checkCase(c);
  if (problems.length) {
    throw badRequest(
      'The registration is incomplete',
      problems.map((p) => ({ path: 'laterality', message: p.message, code: p.code })),
    );
  }
  return warnings;
}

/** A case as shown in the chart, with the current coding warnings. */
function presentCase(c: CancerCase) {
  const { warnings } = checkCase(c);
  return { ...c, warnings, siteGroup: c.topography.slice(0, 3) };
}

/* ------------------------------------------------------------------ reference data -------- */

oncologyRouter.get(
  '/definitions',
  requireRole('DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'),
  (_req, res) => {
    res.json({
      siteGroups: SITE_GROUPS,
      pairedSiteGroups: [...PAIRED_SITE_GROUPS],
      morphologies: MORPHOLOGIES,
      lateralities: LATERALITIES,
      basesOfDiagnosis: BASES_OF_DIAGNOSIS,
      stages: STAGES,
      tumourGroups: TUMOUR_GROUPS,
      recommendations: RECOMMENDATIONS,
    });
  },
);

/* ------------------------------------------------------------------ chart --------------- */

oncologyRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'cancer_registry');
  const cases = await patientCases(patientId);
  const reviews = await db
    .select({
      review: mdtCaseReviews,
      meeting: mdtMeetings,
      referredBy: users.fullName,
    })
    .from(mdtCaseReviews)
    .innerJoin(mdtMeetings, eq(mdtMeetings.id, mdtCaseReviews.meetingId))
    .innerJoin(users, eq(users.id, mdtCaseReviews.referredById))
    .where(eq(mdtCaseReviews.patientId, patientId))
    .orderBy(desc(mdtMeetings.scheduledFor));
  res.json({
    cases: cases.map(presentCase),
    reviews: reviews.map((r) => ({
      ...r.review,
      referredBy: r.referredBy,
      meeting: {
        id: r.meeting.id,
        tumourGroup: r.meeting.tumourGroup,
        scheduledFor: r.meeting.scheduledFor,
        status: r.meeting.status,
      },
    })),
  });
});

const RegisterInput = CaseFields.extend({
  /** Set after the doctor confirmed that a similar case is a different primary tumour. */
  confirmNotDuplicate: z.boolean().default(false),
});

oncologyRouter.post('/patients/:patientId/cases', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, patientId, meta);
  const input = parse(RegisterInput, req.body);
  if (!ctx.facilityId) throw forbidden();
  const warnings = assertProblems(input);
  const created = await db.transaction(async (tx) => {
    // One registration at a time per patient (duplicate check and insert together).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cancer_case_${patientId}`}))`);
    const similar = await findPossibleDuplicate(
      patientId,
      input.topography,
      input.diagnosedOn,
      null,
      tx,
    );
    if (similar && !input.confirmNotDuplicate) {
      throw new HttpError(
        409,
        'POSSIBLE_DUPLICATE',
        'A cancer of the same site was registered for this patient within three months',
        { duplicateOfId: similar.id, diagnosedOn: similar.diagnosedOn },
      );
    }
    const { confirmNotDuplicate: _c, ...values } = input;
    const [row] = await tx
      .insert(cancerCases)
      .values({ ...values, patientId, facilityId: ctx.facilityId!, registeredById: ctx.userId })
      .returning();
    await audit(
      {
        action: AuditAction.CANCER_REGISTERED,
        actor: ctx,
        resourceType: 'cancer_case',
        resourceId: row!.id,
        patientId,
        meta,
        metadata: {
          warnings: warnings.map((w) => w.code),
          confirmedNotDuplicate: Boolean(similar),
        },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(presentCase(created));
});

async function loadCase(id: string) {
  const [row] = await db.select().from(cancerCases).where(eq(cancerCases.id, id));
  if (!row) throw notFound('Cancer registration not found');
  return row;
}

async function changeCase(
  ctx: AuthContext,
  meta: RequestMeta,
  row: CancerCase,
  set: Partial<typeof cancerCases.$inferInsert>,
  metadata: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(cancerCases)
      .set(set)
      .where(and(eq(cancerCases.id, row.id), eq(cancerCases.status, 'ACTIVE')))
      .returning();
    if (!updated) throw conflict('Only an active registration can be changed');
    await audit(
      {
        action: AuditAction.CANCER_UPDATED,
        actor: ctx,
        resourceType: 'cancer_case',
        resourceId: row.id,
        patientId: row.patientId,
        meta,
        metadata,
      },
      tx,
    );
    return updated;
  });
}

/** Correct or complete the coding (e.g. pathological stage after surgery). */
oncologyRouter.patch('/cases/:id', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const row = await loadCase(id);
  await assertClinicalWriteAccess(ctx, row.patientId, meta);
  const changes = parse(CaseFieldsBase.partial().strict(), req.body ?? {});
  const merged = { ...row, ...changes } as z.infer<typeof CaseFields>;
  const warnings = assertProblems(merged);
  const changed = Object.keys(changes).filter(
    (k) => (changes as Record<string, unknown>)[k] !== (row as Record<string, unknown>)[k],
  );
  if (!changed.length) {
    res.json(presentCase(row));
    return;
  }
  const updated = await changeCase(ctx, meta, row, changes, {
    change: 'CODING',
    fields: changed,
    warnings: warnings.map((w) => w.code),
  });
  res.json(presentCase(updated));
});

/** Registered in error: the row stays (with the reason in the audit log) but no longer counts. */
oncologyRouter.post('/cases/:id/withdraw', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const { reason: why } = parse(z.object({ reason }), req.body);
  const row = await loadCase(id);
  await assertClinicalWriteAccess(ctx, row.patientId, meta);
  const updated = await changeCase(
    ctx,
    meta,
    row,
    { status: 'WITHDRAWN' },
    {
      change: 'WITHDRAWN',
      reason: why,
    },
  );
  res.json(presentCase(updated));
});

/** Two registrations of the same tumour: this one is the duplicate of the other. */
oncologyRouter.post('/cases/:id/mark-duplicate', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(z.object({ duplicateOfId: z.string().uuid(), reason }), req.body);
  const row = await loadCase(id);
  await assertClinicalWriteAccess(ctx, row.patientId, meta);
  const original = await loadCase(input.duplicateOfId);
  if (original.id === row.id || original.patientId !== row.patientId) {
    throw badRequest('Choose another registration of the same patient');
  }
  if (original.status !== 'ACTIVE') throw conflict('The other registration is not active');
  const updated = await changeCase(
    ctx,
    meta,
    row,
    { status: 'DUPLICATE' },
    {
      change: 'DUPLICATE',
      duplicateOfId: original.id,
      reason: input.reason,
    },
  );
  res.json(presentCase(updated));
});

/* ------------------------------------------------------------------ death certificate only - */

oncologyRouter.get('/dco-candidates', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  res.json({ items: await dcoCandidates(ctx.userId) });
});

const DcoInput = z.object({
  topography: z.string().trim().toUpperCase().regex(TOPOGRAPHY).optional(),
  morphology: z.string().trim().regex(MORPHOLOGY).default('8000/3'),
  laterality: z.enum(LATERALITIES).default('UNKNOWN'),
});

/** Register a cancer known only from the death certificate (basis DEATH_CERTIFICATE_ONLY). */
oncologyRouter.post('/dco-candidates/:id/register', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(DcoInput, req.body ?? {});
  const candidate = (await dcoCandidates(ctx.userId)).find((c) => c.deathRecordId === id);
  if (!candidate) throw notFound('No death-certificate-only candidate for you with this record');
  await assertClinicalWriteAccess(ctx, candidate.patientId, meta);
  if (!ctx.facilityId) throw forbidden();
  const icd10 = candidate.underlyingCauseIcd10;
  const topography = input.topography ?? topographyFromIcd10(icd10);
  if (!topography) {
    throw badRequest('Give the ICD-O-3 site: it cannot be derived from this ICD-10 code', [
      { path: 'topography', message: 'Give the ICD-O-3 site code' },
    ]);
  }
  const values = {
    diagnosedOn: kosovoDate(new Date(candidate.diedAt)),
    icd10,
    topography,
    morphology: input.morphology,
    laterality: input.laterality,
    basisOfDiagnosis: 'DEATH_CERTIFICATE_ONLY' as const,
  };
  assertProblems({ ...values, stage: null, tnmM: null });
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(cancerCases)
      .values({
        ...values,
        patientId: candidate.patientId,
        facilityId: ctx.facilityId!,
        registeredById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.CANCER_REGISTERED,
        actor: ctx,
        resourceType: 'cancer_case',
        resourceId: row!.id,
        patientId: candidate.patientId,
        meta,
        metadata: { deathCertificateOnly: true, deathRecordId: id },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(presentCase(created));
});

/* ------------------------------------------------------------------ statistics ---------- */

const StatsQuery = z.object({
  fromYear: z.coerce.number().int().min(1990).max(2100).optional(),
  toYear: z.coerce.number().int().min(1990).max(2100).optional(),
});

oncologyRouter.get('/stats', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(StatsQuery, req.query);
  const thisYear = Number(kosovoDate(new Date()).slice(0, 4));
  const toYear = q.toYear ?? thisYear;
  const fromYear = q.fromYear ?? toYear - 4;
  if (fromYear > toYear || toYear - fromYear > 24) throw badRequest('Choose up to 25 years');
  if (ctx.role === 'DIRECTOR' && !ctx.facilityId) throw forbidden();
  const stats = await registryStats({
    fromYear,
    toYear,
    facilityId: ctx.role === 'DIRECTOR' ? ctx.facilityId! : undefined,
  });
  res.json({
    ...stats,
    deathCertificateOnlyCandidates: ctx.role === 'MINISTRY' ? await dcoCandidateCount() : null,
  });
});

/* ------------------------------------------------------------------ tumour boards ------- */

const recentAgendaAudits = new Map<string, number>();
/** Seeing a patient on a tumour board agenda is recorded in their access log (once per 10 min). */
async function auditAgendaView(ctx: AuthContext, patientIds: string[], meta: RequestMeta) {
  const now = Date.now();
  for (const patientId of patientIds) {
    const key = `${ctx.userId}:${patientId}`;
    if ((recentAgendaAudits.get(key) ?? 0) > now - 10 * 60_000) continue;
    recentAgendaAudits.set(key, now);
    await audit({
      action: AuditAction.PATIENT_RECORD_VIEWED,
      actor: ctx,
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      meta,
      metadata: { section: 'tumour_board_agenda', basis: 'TUMOUR_BOARD' },
    });
  }
  if (recentAgendaAudits.size > 20_000) recentAgendaAudits.clear();
}

async function loadMeeting(ctx: AuthContext, id: string) {
  const [m] = await db.select().from(mdtMeetings).where(eq(mdtMeetings.id, id));
  if (!m || m.facilityId !== ctx.facilityId) throw notFound('Tumour board meeting not found');
  return m;
}

async function assertFacilityDoctor(ctx: AuthContext, userId: string) {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.role, 'DOCTOR'),
        eq(users.facilityId, ctx.facilityId!),
        eq(users.isActive, true),
      ),
    );
  if (!u) throw badRequest('The chair must be an active doctor of your facility');
}

const MeetingQuery = z.object({ when: z.enum(['upcoming', 'past']).default('upcoming') });

oncologyRouter.get('/mdt/meetings', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { when } = parse(MeetingQuery, req.query);
  if (!ctx.facilityId) throw forbidden();
  const since = new Date(Date.now() - 12 * 3_600_000);
  const rows = await db
    .select({
      meeting: mdtMeetings,
      chair: users.fullName,
      cases: sql<number>`(SELECT count(*)::int FROM ${mdtCaseReviews} r WHERE r.meeting_id = ${mdtMeetings.id})`,
      pending: sql<number>`(SELECT count(*)::int FROM ${mdtCaseReviews} r WHERE r.meeting_id = ${mdtMeetings.id} AND r.status = 'PENDING')`,
    })
    .from(mdtMeetings)
    .innerJoin(users, eq(users.id, mdtMeetings.chairId))
    .where(
      and(
        eq(mdtMeetings.facilityId, ctx.facilityId),
        when === 'upcoming'
          ? gte(mdtMeetings.scheduledFor, since)
          : lt(mdtMeetings.scheduledFor, since),
      ),
    )
    .orderBy(when === 'upcoming' ? asc(mdtMeetings.scheduledFor) : desc(mdtMeetings.scheduledFor))
    .limit(100);
  res.json({
    items: rows.map((r) => ({
      ...r.meeting,
      chair: r.chair,
      caseCount: Number(r.cases),
      pendingCount: Number(r.pending),
      isChair: r.meeting.chairId === ctx.userId,
    })),
  });
});

const MeetingInput = z.object({
  tumourGroup: z.enum(TUMOUR_GROUPS),
  scheduledFor: z.coerce.date(),
  chairId: z.string().uuid().optional(),
});

oncologyRouter.post('/mdt/meetings', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(MeetingInput, req.body);
  if (!ctx.facilityId) throw forbidden();
  if (input.scheduledFor.getTime() < Date.now() - 3_600_000) {
    throw badRequest('Schedule the meeting in the future');
  }
  const chairId = input.chairId ?? ctx.userId;
  await assertFacilityDoctor(ctx, chairId);
  const [m] = await db
    .insert(mdtMeetings)
    .values({
      facilityId: ctx.facilityId,
      tumourGroup: input.tumourGroup,
      scheduledFor: input.scheduledFor,
      chairId,
    })
    .returning();
  await audit({
    action: AuditAction.MDT_MEETING_CHANGED,
    actor: ctx,
    resourceType: 'mdt_meeting',
    resourceId: m!.id,
    meta: requestMeta(req),
    metadata: { change: 'SCHEDULED', tumourGroup: input.tumourGroup },
  });
  if (chairId !== ctx.userId) {
    await notifyUsers([chairId], {
      type: 'tumour_board',
      title: 'You were made chair of a tumour board on {date}',
      vars: { date: input.scheduledFor },
      link: `/oncology?meeting=${m!.id}`,
    });
  }
  res.status(201).json(m);
});

/**
 * Meeting with its cases. Doctors and nurses of the facility see the agenda (patient, referring
 * doctor, status); the question, summary and recommendation only the chair, the referring doctor
 * and the patient's care team.
 */
oncologyRouter.get('/mdt/meetings/:id', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const m = await loadMeeting(ctx, id);
  const [chair] = await db
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, m.chairId));
  const rows = await db
    .select({
      review: mdtCaseReviews,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      referredBy: users.fullName,
    })
    .from(mdtCaseReviews)
    .innerJoin(patients, eq(patients.id, mdtCaseReviews.patientId))
    .innerJoin(users, eq(users.id, mdtCaseReviews.referredById))
    .where(eq(mdtCaseReviews.meetingId, id))
    .orderBy(asc(mdtCaseReviews.createdAt));
  const patientIds = [...new Set(rows.map((r) => r.review.patientId))];
  const inCare = new Set(
    patientIds.length
      ? (
          await db
            .select({ patientId: careAssignments.patientId })
            .from(careAssignments)
            .where(
              and(
                eq(careAssignments.doctorId, ctx.userId),
                isNull(careAssignments.endedAt),
                inArray(careAssignments.patientId, patientIds),
              ),
            )
        ).map((r) => r.patientId)
      : [],
  );
  const caseIds = rows.map((r) => r.review.cancerCaseId).filter((x): x is string => Boolean(x));
  const cases = caseIds.length
    ? await db.select().from(cancerCases).where(inArray(cancerCases.id, caseIds))
    : [];
  await auditAgendaView(ctx, patientIds, requestMeta(req));
  const isChair = m.chairId === ctx.userId;
  res.json({
    ...m,
    chair: chair?.name ?? null,
    isChair,
    cases: rows.map((r) => {
      const full =
        isChair || r.review.referredById === ctx.userId || inCare.has(r.review.patientId);
      const c = cases.find((x) => x.id === r.review.cancerCaseId);
      return {
        id: r.review.id,
        patientId: r.review.patientId,
        patient: {
          firstName: r.firstName,
          lastName: r.lastName,
          nationalId: r.nationalId,
          dateOfBirth: r.dateOfBirth,
          sex: r.sex,
        },
        referredBy: r.referredBy,
        referredById: r.review.referredById,
        status: r.review.status,
        decidedAt: r.review.decidedAt,
        patientInformedAt: r.review.patientInformedAt,
        details: full
          ? {
              question: r.review.question,
              summary: r.review.summary,
              recommendation: r.review.recommendation,
              recommendationText: r.review.recommendationText,
              cancerCase: c
                ? {
                    icd10: c.icd10,
                    topography: c.topography,
                    morphology: c.morphology,
                    stage: c.stage,
                  }
                : null,
            }
          : null,
      };
    }),
  });
});

const MeetingChange = z.object({
  scheduledFor: z.coerce.date().optional(),
  chairId: z.string().uuid().optional(),
});

/** Reschedule or hand over the chair (chair only, before the meeting is held). */
oncologyRouter.patch('/mdt/meetings/:id', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(MeetingChange, req.body ?? {});
  const m = await loadMeeting(ctx, id);
  if (m.chairId !== ctx.userId) throw forbidden('Only the chair can change the meeting');
  if (m.status !== 'PLANNED') throw conflict('Only a planned meeting can be changed');
  if (input.chairId) await assertFacilityDoctor(ctx, input.chairId);
  const [updated] = await db
    .update(mdtMeetings)
    .set({
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
      ...(input.chairId ? { chairId: input.chairId } : {}),
    })
    .where(eq(mdtMeetings.id, id))
    .returning();
  await audit({
    action: AuditAction.MDT_MEETING_CHANGED,
    actor: ctx,
    resourceType: 'mdt_meeting',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { change: 'UPDATED', fields: Object.keys(input) },
  });
  if (input.chairId && input.chairId !== ctx.userId) {
    await notifyUsers([input.chairId], {
      type: 'tumour_board',
      title: 'You were made chair of a tumour board on {date}',
      vars: { date: updated!.scheduledFor },
      link: `/oncology?meeting=${id}`,
    });
  }
  res.json(updated);
});

oncologyRouter.post('/mdt/meetings/:id/cancel', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason: why } = parse(z.object({ reason }), req.body);
  const m = await loadMeeting(ctx, id);
  if (m.chairId !== ctx.userId) throw forbidden('Only the chair can cancel the meeting');
  if (m.status !== 'PLANNED') throw conflict('Only a planned meeting can be cancelled');
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mdtCaseReviews)
    .where(and(eq(mdtCaseReviews.meetingId, id), eq(mdtCaseReviews.status, 'PENDING')));
  if (Number(pending?.n ?? 0) > 0) {
    throw conflict('Defer the patients on the agenda to another meeting first');
  }
  const [updated] = await db
    .update(mdtMeetings)
    .set({ status: 'CANCELLED' })
    .where(eq(mdtMeetings.id, id))
    .returning();
  await audit({
    action: AuditAction.MDT_MEETING_CHANGED,
    actor: ctx,
    resourceType: 'mdt_meeting',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { change: 'CANCELLED', reason: why },
  });
  res.json(updated);
});

const HoldInput = z.object({
  attendees: z
    .array(z.string().trim().min(2).max(200))
    .min(2, 'Record at least two attendees')
    .max(40),
});

/** Record that the meeting took place and who attended (chair). */
oncologyRouter.post('/mdt/meetings/:id/hold', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { attendees } = parse(HoldInput, req.body);
  const m = await loadMeeting(ctx, id);
  if (m.chairId !== ctx.userId) throw forbidden('Only the chair can record the meeting');
  if (m.status === 'CANCELLED') throw conflict('The meeting was cancelled');
  const [updated] = await db
    .update(mdtMeetings)
    .set({ status: 'HELD', attendees })
    .where(eq(mdtMeetings.id, id))
    .returning();
  await audit({
    action: AuditAction.MDT_MEETING_CHANGED,
    actor: ctx,
    resourceType: 'mdt_meeting',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { change: 'HELD', attendeeCount: attendees.length },
  });
  res.json(updated);
});

const AddCaseInput = z.object({
  patientId: z.string().uuid(),
  cancerCaseId: z.string().uuid().optional().nullable(),
  question: z.string().trim().min(5).max(500),
  summary: z.string().trim().max(5000).optional().nullable(),
});

/** A doctor of the patient's care team puts the patient on the agenda. */
oncologyRouter.post('/mdt/meetings/:id/cases', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(AddCaseInput, req.body);
  const m = await loadMeeting(ctx, id);
  if (m.status !== 'PLANNED') throw conflict('Patients can be added to a planned meeting only');
  await assertClinicalWriteAccess(ctx, input.patientId, meta);
  if (input.cancerCaseId) {
    const [c] = await db.select().from(cancerCases).where(eq(cancerCases.id, input.cancerCaseId));
    if (!c || c.patientId !== input.patientId) {
      throw badRequest('The cancer registration is not this patient’s');
    }
  }
  const review = await db.transaction(async (tx) => {
    const [already] = await tx
      .select({ id: mdtCaseReviews.id })
      .from(mdtCaseReviews)
      .where(
        and(
          eq(mdtCaseReviews.meetingId, id),
          eq(mdtCaseReviews.patientId, input.patientId),
          eq(mdtCaseReviews.status, 'PENDING'),
        ),
      );
    if (already) throw conflict('The patient is already on this meeting’s agenda');
    const [row] = await tx
      .insert(mdtCaseReviews)
      .values({
        meetingId: id,
        patientId: input.patientId,
        cancerCaseId: input.cancerCaseId ?? null,
        referredById: ctx.userId,
        question: input.question,
        summary: input.summary ?? null,
      })
      .returning();
    await audit(
      {
        action: AuditAction.MDT_REVIEW_RECORDED,
        actor: ctx,
        resourceType: 'mdt_case_review',
        resourceId: row!.id,
        patientId: input.patientId,
        meta,
        metadata: { event: 'ADDED', meetingId: id },
      },
      tx,
    );
    if (m.chairId !== ctx.userId) {
      await notifyUsers(
        [m.chairId],
        {
          type: 'tumour_board',
          title: 'A patient was added to the tumour board of {date}',
          vars: { date: m.scheduledFor },
          link: `/oncology?meeting=${id}`,
        },
        tx,
      );
    }
    return row!;
  });
  res.status(201).json(review);
});

const DecisionInput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('DISCUSSED'),
    recommendation: z.enum(RECOMMENDATIONS),
    recommendationText: z.string().trim().min(10).max(5000),
  }),
  z.object({
    status: z.literal('DEFERRED'),
    deferToMeetingId: z.string().uuid(),
    note: z.string().trim().max(500).optional(),
  }),
]);

async function loadReview(ctx: AuthContext, id: string) {
  const [r] = await db.select().from(mdtCaseReviews).where(eq(mdtCaseReviews.id, id));
  if (!r) throw notFound('Tumour board case not found');
  const m = await loadMeeting(ctx, r.meetingId);
  return { review: r, meeting: m };
}

/** The chair records the recommendation, or defers the patient to another meeting. */
oncologyRouter.post('/mdt/cases/:id/decision', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(DecisionInput, req.body);
  const { review, meeting } = await loadReview(ctx, id);
  if (meeting.chairId !== ctx.userId) throw forbidden('Only the chair records the recommendation');
  if (meeting.status === 'CANCELLED') throw conflict('The meeting was cancelled');
  if (review.status !== 'PENDING') throw conflict('This case was already decided');
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    if (input.status === 'DISCUSSED') {
      const [updated] = await tx
        .update(mdtCaseReviews)
        .set({
          status: 'DISCUSSED',
          recommendation: input.recommendation,
          recommendationText: input.recommendationText,
          decidedAt: now,
          recordedById: ctx.userId,
        })
        .where(and(eq(mdtCaseReviews.id, id), eq(mdtCaseReviews.status, 'PENDING')))
        .returning();
      if (!updated) throw conflict('This case was already decided');
      await notifyUsers(
        [review.referredById],
        {
          type: 'tumour_board',
          title: 'Tumour board recommendation recorded for your patient',
          link: `/doctor/patients/${review.patientId}?tab=oncology`,
        },
        tx,
      );
      return { updated, deferredTo: null };
    }
    const [target] = await tx
      .select()
      .from(mdtMeetings)
      .where(eq(mdtMeetings.id, input.deferToMeetingId));
    if (
      !target ||
      target.facilityId !== meeting.facilityId ||
      target.id === meeting.id ||
      target.status !== 'PLANNED'
    ) {
      throw badRequest('Choose another planned meeting of your facility');
    }
    const [updated] = await tx
      .update(mdtCaseReviews)
      .set({ status: 'DEFERRED', decidedAt: now, recordedById: ctx.userId })
      .where(and(eq(mdtCaseReviews.id, id), eq(mdtCaseReviews.status, 'PENDING')))
      .returning();
    if (!updated) throw conflict('This case was already decided');
    const [moved] = await tx
      .insert(mdtCaseReviews)
      .values({
        meetingId: target.id,
        patientId: review.patientId,
        cancerCaseId: review.cancerCaseId,
        referredById: review.referredById,
        question: review.question,
        summary: review.summary,
      })
      .returning();
    await notifyUsers(
      [review.referredById],
      {
        type: 'tumour_board',
        title: 'Tumour board discussion of your patient deferred to {date}',
        vars: { date: target.scheduledFor },
        link: `/doctor/patients/${review.patientId}?tab=oncology`,
      },
      tx,
    );
    return { updated, deferredTo: moved! };
  });
  await audit({
    action: AuditAction.MDT_REVIEW_RECORDED,
    actor: ctx,
    resourceType: 'mdt_case_review',
    resourceId: id,
    patientId: review.patientId,
    meta,
    metadata: {
      event: input.status,
      ...(input.status === 'DISCUSSED'
        ? { recommendation: input.recommendation }
        : { deferredToMeetingId: input.deferToMeetingId }),
    },
  });
  res.json(result);
});

/** The referring doctor (or the care team) told the patient about the recommendation. */
oncologyRouter.post('/mdt/cases/:id/informed', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const [r] = await db.select().from(mdtCaseReviews).where(eq(mdtCaseReviews.id, id));
  if (!r) throw notFound('Tumour board case not found');
  await assertClinicalWriteAccess(ctx, r.patientId, meta);
  if (r.status !== 'DISCUSSED') throw conflict('There is no recommendation to discuss yet');
  if (r.patientInformedAt) {
    res.json(r);
    return;
  }
  const [updated] = await db
    .update(mdtCaseReviews)
    .set({ patientInformedAt: new Date() })
    .where(eq(mdtCaseReviews.id, id))
    .returning();
  await audit({
    action: AuditAction.MDT_REVIEW_RECORDED,
    actor: ctx,
    resourceType: 'mdt_case_review',
    resourceId: id,
    patientId: r.patientId,
    meta,
    metadata: { event: 'PATIENT_INFORMED' },
  });
  res.json(updated);
});
