import { Router } from 'express';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { careAssignments, patients, promAssignments, promResponses } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  auditRecordView,
  getPatientOrThrow,
  resolveAndAuditRead,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  dueState,
  FREQUENCIES,
  INSTRUMENT_CODES,
  INSTRUMENTS,
  nextDueAfter,
  publicInstrument,
  type InstrumentCode,
} from './instruments.js';
import {
  activeAssignment,
  assertGuardianMayUse,
  assignmentsOf,
  lockInstrument,
  responsesOf,
  submitResponse,
} from './proms.service.js';

/**
 * Patient-reported outcome measures: clinicians ask a patient to fill in a validated questionnaire
 * (once or repeatedly); the patient answers in the portal and sees their scores; answers that
 * suggest a risk to the patient notify the care team at once and top the review list.
 *
 * Guardians: PHQ-9, GAD-7 and AUDIT-C are never shown to or answered by a guardian (adolescent
 * confidentiality) – a guardian acting for a child sees only the WHO-5 well-being questionnaire,
 * and only with full guardian access. The clinician decides whether to ask a young person to
 * answer in their own portal account.
 */
export const promsRouter = Router();
promsRouter.use(authenticate);

const DAY = 86_400_000;
const SECTION = 'questionnaires';
const InstrumentEnum = z.enum(INSTRUMENT_CODES);
const FrequencyEnum = z.enum(FREQUENCIES);
const PatientParam = z.object({ patientId: z.string().uuid() });
const IdParam = z.object({ id: z.string().uuid() });

promsRouter.get('/instruments', (_req, res) => {
  res.json({
    instruments: INSTRUMENT_CODES.map((c) => publicInstrument(INSTRUMENTS[c])),
    frequencies: FREQUENCIES,
    translationNote:
      'Albanian and Serbian wording is a working translation, to be replaced by validated translations before clinical use.',
  });
});

/* ---------------------------------------------------------------------- chart (clinicians) -- */

promsRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), SECTION);
  const now = new Date();
  const assignments = await assignmentsOf(patientId);
  res.json({
    assignments: assignments.map(({ assignedById: _a, facilityId: _f, ...a }) => ({
      ...a,
      due: dueState(a, now),
    })),
    responses: await responsesOf(patientId),
    canAssign: WRITERS.careTeam.includes(ctx.role),
    canReview: WRITERS.careTeam.includes(ctx.role),
  });
});

const AssignInput = z.object({
  instrument: InstrumentEnum,
  frequency: FrequencyEnum,
  /** When the first questionnaire is due (default: now). */
  firstDueAt: z.coerce.date().optional(),
});

promsRouter.post(
  '/patients/:patientId/assignments',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const input = parse(AssignInput, req.body);
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
    const patient = await getPatientOrThrow(patientId);
    if (patient.deceasedAt) throw conflict('The patient is recorded as deceased');
    const facilityId = ctx.facilityId ?? patient.primaryFacilityId;
    if (!facilityId) throw forbidden();
    const now = new Date();
    const firstDueAt = input.firstDueAt ?? now;
    if (Number.isNaN(firstDueAt.getTime())) throw badRequest('Invalid date');
    if (firstDueAt.getTime() > now.getTime() + 366 * DAY) {
      throw badRequest('The first questionnaire must be due within a year');
    }
    const due = firstDueAt < now ? now : firstDueAt;
    const sensitive = INSTRUMENTS[input.instrument].sensitive;
    const row = await db.transaction(async (tx) => {
      await lockInstrument(tx, patientId, input.instrument);
      if (await activeAssignment(patientId, input.instrument, tx)) {
        throw conflict('This questionnaire is already requested for the patient');
      }
      const [created] = await tx
        .insert(promAssignments)
        .values({
          patientId,
          facilityId,
          assignedById: ctx.userId,
          instrument: input.instrument,
          frequency: input.frequency,
          nextDueAt: due,
        })
        .returning();
      await audit(
        {
          action: AuditAction.PROM_ASSIGNED,
          actor: ctx,
          resourceType: 'prom_assignment',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: {
            change: 'ASSIGNED',
            instrument: input.instrument,
            frequency: input.frequency,
          },
        },
        tx,
      );
      // Only when it is due now; later ones get the reminder when due.
      if (due.getTime() <= now.getTime() + 60_000) {
        await notifyPatient(
          patientId,
          {
            type: 'prom_assigned',
            title: 'Your care team has asked you to fill in a questionnaire',
            link: '/portal/questionnaires',
          },
          tx,
          { guardians: sensitive ? 'none' : 'full' },
        );
      }
      return created!;
    });
    res.status(201).json({ ...row, due: dueState(row, now) });
  },
);

async function loadAssignment(id: string) {
  const [row] = await db.select().from(promAssignments).where(eq(promAssignments.id, id));
  if (!row) throw notFound('Questionnaire request not found');
  return row;
}

const ChangeInput = z.object({ frequency: FrequencyEnum });

promsRouter.patch('/assignments/:id', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { frequency } = parse(ChangeInput, req.body);
  const a = await loadAssignment(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, a.patientId, meta, WRITERS.careTeam);
  if (a.status !== 'ACTIVE') throw conflict('This questionnaire request has ended');
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    // The next due date follows the new rhythm from the last answer (or keeps the current one).
    const [last] = await tx
      .select({ at: promResponses.submittedAt })
      .from(promResponses)
      .where(eq(promResponses.assignmentId, id))
      .orderBy(desc(promResponses.submittedAt))
      .limit(1);
    const nextDueAt = last
      ? (nextDueAfter(frequency, last.at) ?? a.nextDueAt ?? now)
      : (a.nextDueAt ?? now);
    const [updated] = await tx
      .update(promAssignments)
      .set({ frequency, nextDueAt, updatedAt: now })
      .where(and(eq(promAssignments.id, id), eq(promAssignments.status, 'ACTIVE')))
      .returning();
    if (!updated) throw conflict('This questionnaire request has ended');
    await audit(
      {
        action: AuditAction.PROM_ASSIGNED,
        actor: ctx,
        resourceType: 'prom_assignment',
        resourceId: id,
        patientId: a.patientId,
        meta,
        metadata: { change: 'FREQUENCY', instrument: a.instrument, frequency },
      },
      tx,
    );
    return updated;
  });
  res.json({ ...row, due: dueState(row, now) });
});

const EndInput = z.object({ reason: z.string().trim().min(3).max(300) });

promsRouter.post('/assignments/:id/end', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(EndInput, req.body);
  const a = await loadAssignment(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, a.patientId, meta, WRITERS.careTeam);
  if (a.status !== 'ACTIVE') throw conflict('This questionnaire request has already ended');
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(promAssignments)
      .set({ status: 'ENDED', endedAt: now, endReason: reason, nextDueAt: null, updatedAt: now })
      .where(and(eq(promAssignments.id, id), eq(promAssignments.status, 'ACTIVE')))
      .returning();
    if (!updated) throw conflict('This questionnaire request has already ended');
    await audit(
      {
        action: AuditAction.PROM_ASSIGNED,
        actor: ctx,
        resourceType: 'prom_assignment',
        resourceId: id,
        patientId: a.patientId,
        meta,
        metadata: { change: 'ENDED', instrument: a.instrument, reason },
      },
      tx,
    );
    return updated;
  });
  res.json({ ...row, due: 'NONE' });
});

/* ---------------------------------------------------------------------------- portal -- */

function ownPatientId(ctx: AuthContext) {
  if (!ctx.patientId) throw forbidden('No patient record is linked to this account');
  return ctx.patientId;
}

/** Instruments the caller may see in the portal (guardians: non-sensitive ones only). */
const visibleTo = (ctx: AuthContext) =>
  INSTRUMENT_CODES.filter((c) => !ctx.proxy || !INSTRUMENTS[c].sensitive);

promsRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx);
  // Self, or a guardian with full access (appointments-only guardians are refused here).
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), SECTION);
  const allowed = new Set<string>(visibleTo(ctx));
  const now = new Date();
  const assignments = (await assignmentsOf(patientId)).filter((a) => allowed.has(a.instrument));
  const responses = (await responsesOf(patientId)).filter((r) => allowed.has(r.instrument));
  res.json({
    acting: Boolean(ctx.proxy),
    assignments: assignments
      .filter((a) => a.status === 'ACTIVE')
      .map((a) => ({
        id: a.id,
        instrument: a.instrument,
        frequency: a.frequency,
        nextDueAt: a.nextDueAt,
        due: dueState(a, now),
        assignedBy: a.assignedBy,
        createdAt: a.createdAt,
      })),
    // The review note is written for colleagues; the person sees that the answers were looked at.
    responses: responses.map((r) => ({
      id: r.id,
      instrument: r.instrument,
      answers: r.answers,
      score: r.score,
      severity: r.severity,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      change: r.change,
    })),
  });
});

const SubmitInputSchema = z.object({
  instrument: InstrumentEnum,
  assignmentId: z.string().uuid().optional().nullable(),
  answers: z.record(z.string(), z.unknown()),
});

promsRouter.post('/mine/responses', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx);
  const input = parse(SubmitInputSchema, req.body);
  const meta = requestMeta(req);
  assertGuardianMayUse(ctx, input.instrument as InstrumentCode);
  await resolveAndAuditRead(ctx, patientId, meta, SECTION);
  const { response, scored, change } = await submitResponse(
    ctx,
    patientId,
    {
      instrument: input.instrument,
      assignmentId: input.assignmentId ?? null,
      answers: input.answers,
    },
    meta,
  );
  res.status(201).json({
    response: {
      id: response.id,
      instrument: response.instrument,
      score: scored.score,
      severity: scored.severity,
      submittedAt: response.submittedAt,
    },
    change,
    /**
     * CRISIS: thoughts of self-harm – the portal shows 112 and the helpline at once (the care team
     * has been notified too); HIGH: contact the doctor within the next few days. Texts in the web.
     */
    advice: scored.advice,
    careTeamNotified: scored.safetyFlag,
  });
});

/* ------------------------------------------------------------------------ review (team) -- */

const ReviewQuery = PaginationSchema.extend({
  show: z.enum(['UNREVIEWED', 'FLAGGED', 'ALL']).default('UNREVIEWED'),
  instrument: InstrumentEnum.optional(),
});

/**
 * Answers of patients in the caller's care: safety-flagged ones not yet reviewed first, then the
 * newest. Each patient shown counts as a view of their questionnaires.
 */
promsRouter.get('/review', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ReviewQuery, req.query);
  const where = and(
    q.show === 'UNREVIEWED' ? isNull(promResponses.reviewedAt) : undefined,
    q.show === 'FLAGGED'
      ? and(eq(promResponses.safetyFlag, true), isNull(promResponses.reviewedAt))
      : undefined,
    q.instrument ? eq(promResponses.instrument, q.instrument) : undefined,
    isNull(patients.mergedIntoId),
  );
  const inCare = and(
    eq(careAssignments.patientId, promResponses.patientId),
    eq(careAssignments.doctorId, ctx.userId),
    isNull(careAssignments.endedAt),
  );
  const rows = await db
    .select({
      id: promResponses.id,
      instrument: promResponses.instrument,
      score: promResponses.score,
      severity: promResponses.severity,
      safetyFlag: promResponses.safetyFlag,
      submittedAt: promResponses.submittedAt,
      reviewedAt: promResponses.reviewedAt,
      previousScore: sql<string | null>`(
        SELECT p.score FROM prom_responses p
        WHERE p.patient_id = ${promResponses.patientId} AND p.instrument = ${promResponses.instrument}
          AND p.submitted_at < ${promResponses.submittedAt}
        ORDER BY p.submitted_at DESC LIMIT 1)`,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nationalId: patients.nationalId,
        dateOfBirth: patients.dateOfBirth,
        phone: patients.phone,
      },
    })
    .from(promResponses)
    .innerJoin(patients, eq(patients.id, promResponses.patientId))
    .innerJoin(careAssignments, inCare)
    .where(where)
    .orderBy(
      sql`CASE WHEN ${promResponses.safetyFlag} AND ${promResponses.reviewedAt} IS NULL THEN 0 ELSE 1 END`,
      desc(promResponses.submittedAt),
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(promResponses)
    .innerJoin(patients, eq(patients.id, promResponses.patientId))
    .innerJoin(careAssignments, inCare)
    .where(where);
  const [{ flagged } = { flagged: 0 }] = await db
    .select({ flagged: sql<number>`count(*)::int` })
    .from(promResponses)
    .innerJoin(patients, eq(patients.id, promResponses.patientId))
    .innerJoin(careAssignments, inCare)
    .where(
      and(
        eq(promResponses.safetyFlag, true),
        isNull(promResponses.reviewedAt),
        isNull(patients.mergedIntoId),
      ),
    );
  const meta = requestMeta(req);
  for (const pid of new Set(rows.map((r) => r.patient.id))) {
    await auditRecordView(ctx, pid, 'CARE_TEAM', SECTION, meta);
  }
  res.json({
    ...paginated(
      rows.map(({ previousScore, ...r }) => {
        const score = r.score === null ? null : Number(r.score);
        const prev = previousScore === null ? null : Number(previousScore);
        const inst = INSTRUMENTS[r.instrument as InstrumentCode];
        return {
          ...r,
          score,
          previousScore: prev,
          difference: score !== null && prev !== null ? score - prev : null,
          meaningful:
            score !== null && prev !== null && inst?.mcid != null
              ? Math.abs(score - prev) >= inst.mcid
              : false,
        };
      }),
      total,
      q,
    ),
    counts: { flagged },
  });
});

const ReviewInput = z.object({ note: z.string().trim().max(500).optional().nullable() });

promsRouter.post('/responses/:id/review', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { note } = parse(ReviewInput, req.body ?? {});
  const [r] = await db.select().from(promResponses).where(eq(promResponses.id, id));
  if (!r) throw notFound('Questionnaire answers not found');
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, r.patientId, meta, WRITERS.careTeam);
  if (r.reviewedAt) throw conflict('These answers have already been reviewed');
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(promResponses)
      .set({ reviewedAt: new Date(), reviewedById: ctx.userId, reviewNote: note || null })
      .where(and(eq(promResponses.id, id), isNull(promResponses.reviewedAt)))
      .returning();
    if (!updated) throw conflict('These answers have already been reviewed');
    await audit(
      {
        action: AuditAction.PROM_REVIEWED,
        actor: ctx,
        resourceType: 'prom_response',
        resourceId: id,
        patientId: r.patientId,
        meta,
        metadata: { instrument: r.instrument, safetyFlag: r.safetyFlag, withNote: Boolean(note) },
      },
      tx,
    );
    return updated;
  });
  res.json({ ...row, score: row.score === null ? null : Number(row.score) });
});

/* ------------------------------------------------------------------------ director stats -- */

const isSmall = (n: number) => n > 0 && n < SMALL_CELL_THRESHOLD;

/**
 * Completion per questionnaire for the director's facility (requests made there), last 90 days:
 * patients asked (requests at least 14 days old, active during the period) and how many answered
 * at least once. Counts only, no names or scores; counts of 1–4 are hidden, and so is a count
 * from which a hidden one could be worked out.
 */
promsRouter.get('/stats', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const now = new Date();
  const since = new Date(now.getTime() - 90 * DAY);
  const rows = await db.execute<{
    instrument: string;
    asked: number;
    answered: number;
    responses: number;
    flagged: number;
    flagged_reviewed_24h: number;
  }>(sql`
    WITH a AS (
      SELECT DISTINCT ON (pa.patient_id, pa.instrument) pa.patient_id, pa.instrument
      FROM prom_assignments pa
      WHERE pa.facility_id = ${ctx.facilityId}
        AND pa.created_at <= ${new Date(now.getTime() - 14 * DAY)}
        AND (pa.status = 'ACTIVE' OR pa.ended_at >= ${since})
    )
    SELECT a.instrument,
      count(*)::int AS asked,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM prom_responses r
        WHERE r.patient_id = a.patient_id AND r.instrument = a.instrument AND r.submitted_at >= ${since}
      ))::int AS answered,
      (SELECT count(*)::int FROM prom_responses r JOIN prom_assignments x ON x.id = r.assignment_id
        WHERE x.facility_id = ${ctx.facilityId} AND r.instrument = a.instrument AND r.submitted_at >= ${since}) AS responses,
      (SELECT count(*)::int FROM prom_responses r JOIN prom_assignments x ON x.id = r.assignment_id
        WHERE x.facility_id = ${ctx.facilityId} AND r.instrument = a.instrument AND r.submitted_at >= ${since}
          AND r.safety_flag) AS flagged,
      (SELECT count(*)::int FROM prom_responses r JOIN prom_assignments x ON x.id = r.assignment_id
        WHERE x.facility_id = ${ctx.facilityId} AND r.instrument = a.instrument AND r.submitted_at >= ${since}
          AND r.safety_flag AND r.reviewed_at <= r.submitted_at + interval '24 hours') AS flagged_reviewed_24h
    FROM a GROUP BY a.instrument ORDER BY a.instrument`);
  const items = INSTRUMENT_CODES.map((code) => {
    const r = rows.rows.find((x) => x.instrument === code);
    const asked = r?.asked ?? 0;
    const answered = r?.answered ?? 0;
    const hideAnswered = isSmall(answered) || isSmall(asked - answered);
    const flagged = r?.flagged ?? 0;
    const reviewed = r?.flagged_reviewed_24h ?? 0;
    const hideReviewed = isSmall(reviewed) || isSmall(flagged - reviewed);
    return {
      instrument: code,
      asked: isSmall(asked) ? null : asked,
      answered: isSmall(asked) || hideAnswered ? null : answered,
      completionPct:
        isSmall(asked) || hideAnswered || asked === 0
          ? null
          : Math.round((answered / asked) * 1000) / 10,
      responses: isSmall(r?.responses ?? 0) ? null : (r?.responses ?? 0),
      safetyFlags: isSmall(flagged) ? null : flagged,
      flagsReviewedWithin24hPct:
        isSmall(flagged) || hideReviewed || flagged === 0
          ? null
          : Math.round((reviewed / flagged) * 1000) / 10,
    };
  });
  res.json({
    period: { from: since, to: now },
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    items,
  });
});
