import { Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  careAssignments,
  careTasks,
  facilities,
  patients,
  referrals,
  screeningEpisodes,
  screeningOptOuts,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertFullProxyScope,
  resolveAndAuditRead,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  ageOn,
  addMonths,
  bandFor,
  DEFAULT_DAILY_CAP,
  DISCLAIMER,
  FOLLOW_UP_SAFETY_NET_DAYS,
  INADEQUATE_REPEAT_MONTHS,
  inPopulation,
  INVITATION_OVERDUE_DAYS,
  isoDate,
  nextDueAfter,
  PROGRAMME_CODES,
  PROGRAMMES,
  REMINDER_AFTER_DAYS,
  RESULTS,
  TEST_TYPES,
  testFor,
  type ProgrammeCode,
} from './definitions.js';
import {
  coverage,
  loadScreening,
  personOf,
  programmeStatus,
  statusesFor,
  type Episode,
} from './screening.service.js';

/**
 * Cancer screening programmes: the person's programmes in the chart (care team), the invitation
 * → booking → test → result lifecycle, clinical ceasing (no longer applicable) and opt-outs, the
 * practice worklist (due, invitations not taken up, abnormal results awaiting follow-up),
 * coverage for directors (own facility) and the Ministry (national, small-cell suppression), and
 * the person's own view in the portal.
 */
export const screeningRouter = Router();
screeningRouter.use(authenticate);

const ProgrammeEnum = z.enum(PROGRAMME_CODES);
const PatientParam = z.object({ patientId: z.string().uuid() });
const IdParam = z.object({ id: z.string().uuid() });
const DAY = 86_400_000;

const notFuture = (d: Date) => d.getTime() <= Date.now() + 5 * 60_000;

/* ------------------------------------------------------------------------- programmes -- */

screeningRouter.get('/programmes', (_req, res) => {
  res.json({
    programmes: PROGRAMME_CODES.map((code) => {
      const p = PROGRAMMES[code];
      return {
        code,
        label: p.label,
        sex: p.sex,
        minAge: p.minAge,
        maxAge: p.maxAge,
        bands: p.bands,
        tests: p.tests,
        followUp: p.followUp,
      };
    }),
    rules: {
      inadequateRepeatMonths: INADEQUATE_REPEAT_MONTHS,
      reminderAfterDays: REMINDER_AFTER_DAYS,
      invitationOverdueDays: INVITATION_OVERDUE_DAYS,
      followUpSafetyNetDays: FOLLOW_UP_SAFETY_NET_DAYS,
      defaultDailyCap: DEFAULT_DAILY_CAP,
    },
    disclaimer: DISCLAIMER,
  });
});

/* ---------------------------------------------------------------------- patient view -- */

async function episodeHistory(patientId: string) {
  return db
    .select({
      episode: screeningEpisodes,
      facilityName: facilities.name,
      recordedBy: users.fullName,
    })
    .from(screeningEpisodes)
    .innerJoin(facilities, eq(facilities.id, screeningEpisodes.facilityId))
    .leftJoin(users, eq(users.id, screeningEpisodes.recordedById))
    .where(eq(screeningEpisodes.patientId, patientId))
    .orderBy(desc(screeningEpisodes.createdAt))
    .limit(100);
}

screeningRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'screening');
  const person = (await personOf(patientId))!;
  const { programmes, optOuts } = await statusesFor(person);
  const history = await episodeHistory(patientId);
  // Recent referrals of the patient, to link the follow-up of an abnormal result.
  const recentReferrals = await db
    .select({
      id: referrals.id,
      specialty: referrals.specialty,
      status: referrals.status,
      createdAt: referrals.createdAt,
      toFacilityName: facilities.name,
    })
    .from(referrals)
    .innerJoin(facilities, eq(facilities.id, referrals.toFacilityId))
    .where(eq(referrals.patientId, patientId))
    .orderBy(desc(referrals.createdAt))
    .limit(20);
  res.json({
    referrals: recentReferrals,
    person: {
      sex: person.sex,
      age: ageOn(person.dateOfBirth, new Date()),
      deceased: Boolean(person.deceasedAt),
    },
    programmes,
    optOuts,
    history: history.map((h) => ({
      ...h.episode,
      facilityName: h.facilityName,
      recordedBy: h.recordedBy,
    })),
    canRecord: WRITERS.careTeam.includes(ctx.role),
    canDecide: ctx.role === 'DOCTOR',
    disclaimer: DISCLAIMER,
  });
});

/* ------------------------------------------------------------------------- lifecycle -- */

async function loadEpisode(id: string) {
  const [episode] = await db.select().from(screeningEpisodes).where(eq(screeningEpisodes.id, id));
  if (!episode) throw notFound('Screening episode not found');
  return episode;
}

async function recordStep(
  ctx: AuthContext,
  episode: Episode,
  step: string,
  meta: ReturnType<typeof requestMeta>,
  executor: Executor,
  extra: Record<string, unknown> = {},
) {
  await audit(
    {
      action: AuditAction.SCREENING_RECORDED,
      actor: ctx,
      resourceType: 'screening_episode',
      resourceId: episode.id,
      patientId: episode.patientId,
      meta,
      metadata: { programme: episode.programme, step, ...extra },
    },
    executor,
  );
}

/** Updates the episode only if it is still in one of `from` (concurrent changes get 409). */
async function transition(
  tx: Executor,
  episode: Episode,
  from: string[],
  set: Partial<typeof screeningEpisodes.$inferInsert>,
) {
  const [updated] = await tx
    .update(screeningEpisodes)
    .set(set)
    .where(and(eq(screeningEpisodes.id, episode.id), inArray(screeningEpisodes.status, from)))
    .returning();
  if (!updated) throw conflict('This screening episode has changed. Reload and try again.');
  return updated;
}

function requireStatus(episode: Episode, allowed: string[], message: string) {
  if (!allowed.includes(episode.status)) throw conflict(message);
}

const InviteInput = z.object({ programme: ProgrammeEnum });

/**
 * Invites the person now (also reinstates a programme that was ceased). Refused while an episode
 * is open, when the person opted out, or outside the programme's age and sex range.
 */
screeningRouter.post(
  '/patients/:patientId/invitations',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const { programme } = parse(InviteInput, req.body);
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
    const person = (await personOf(patientId))!;
    if (person.deceasedAt) throw conflict('The patient has died');
    const now = new Date();
    if (!inPopulation(programme, person, now)) {
      throw badRequest('The patient is outside the age or sex range of this programme');
    }
    const row = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`screening:${patientId}:${programme}`}))`,
      );
      const { episodes, optOuts } = await loadScreening([patientId], tx);
      const status = programmeStatus(programme, person, episodes, optOuts, now);
      if (status.openEpisode) throw conflict('The patient already has an open screening episode');
      if (status.optOut) throw conflict('The patient has opted out of this programme');
      const [created] = await tx
        .insert(screeningEpisodes)
        .values({
          patientId,
          programme,
          facilityId: person.primaryFacilityId,
          status: 'INVITED',
          invitedAt: now,
          dueDate: isoDate(now),
          testType: testFor(programme, ageOn(person.dateOfBirth, now)),
          recordedById: ctx.userId,
        })
        .returning();
      await audit(
        {
          action: AuditAction.SCREENING_INVITED,
          actor: ctx,
          resourceType: 'screening_episode',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: { programme, automatic: false, reinstated: status.state === 'CEASED' },
        },
        tx,
      );
      await notifyPatient(
        patientId,
        {
          type: 'screening_invitation',
          title: 'Invitation to a free screening programme',
          body: 'Please contact your family medicine centre to book an appointment. The details are in the portal.',
          link: '/portal/screening',
        },
        tx,
      );
      return created!;
    });
    res.status(201).json(row);
  },
);

const BookInput = z.object({
  bookedFor: z.coerce
    .date()
    .refine((d) => d.getTime() >= Date.now() - DAY, 'The appointment cannot be in the past')
    .refine((d) => d.getTime() <= Date.now() + 365 * DAY, 'The appointment is too far ahead'),
});

screeningRouter.post('/episodes/:id/book', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { bookedFor } = parse(BookInput, req.body);
  const episode = await loadEpisode(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, episode.patientId, meta, WRITERS.careTeam);
  requireStatus(episode, ['INVITED', 'BOOKED'], 'Only an invitation can be booked');
  const row = await db.transaction(async (tx) => {
    const updated = await transition(tx, episode, ['INVITED', 'BOOKED'], {
      status: 'BOOKED',
      bookedFor,
      recordedById: ctx.userId,
    });
    await recordStep(ctx, episode, 'BOOKED', meta, tx);
    return updated;
  });
  res.json(row);
});

const TestFields = {
  screenedAt: z.coerce
    .date()
    .refine(notFuture, 'The test date cannot be in the future')
    .refine((d) => d.getTime() >= Date.now() - 365 * DAY, 'The test date is too far back'),
  testType: z.enum(TEST_TYPES),
};

function checkTestType(programme: ProgrammeCode, testType: string) {
  if (!PROGRAMMES[programme].tests.includes(testType as never)) {
    throw badRequest('This test is not used in this programme', {
      allowed: PROGRAMMES[programme].tests,
    });
  }
}

screeningRouter.post('/episodes/:id/test', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(z.object(TestFields), req.body);
  const episode = await loadEpisode(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, episode.patientId, meta, WRITERS.careTeam);
  requireStatus(episode, ['INVITED', 'BOOKED'], 'The test has already been recorded');
  checkTestType(episode.programme as ProgrammeCode, input.testType);
  const row = await db.transaction(async (tx) => {
    const updated = await transition(tx, episode, ['INVITED', 'BOOKED'], {
      status: 'SCREENED',
      screenedAt: input.screenedAt,
      testType: input.testType,
      recordedById: ctx.userId,
    });
    await recordStep(ctx, episode, 'SCREENED', meta, tx, { testType: input.testType });
    return updated;
  });
  res.json(row);
});

const ResultInput = z.object({
  result: z.enum(RESULTS),
  resultDetail: z.string().trim().max(300).optional().nullable(),
  referralId: z.string().uuid().optional().nullable(),
  /** When the test was not recorded separately. */
  screenedAt: TestFields.screenedAt.optional(),
  testType: TestFields.testType.optional(),
});

/** The care-team doctor who follows up an abnormal result (the longest-standing assignment). */
async function followUpDoctor(patientId: string, executor: Executor) {
  const [doctor] = await executor
    .select({ id: users.id })
    .from(careAssignments)
    .innerJoin(users, eq(users.id, careAssignments.doctorId))
    .where(
      and(
        eq(careAssignments.patientId, patientId),
        isNull(careAssignments.endedAt),
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
      ),
    )
    .orderBy(careAssignments.startedAt)
    .limit(1);
  return doctor?.id ?? null;
}

async function assertReferralOfPatient(referralId: string, patientId: string) {
  const [ref] = await db
    .select({ patientId: referrals.patientId })
    .from(referrals)
    .where(eq(referrals.id, referralId));
  if (!ref || ref.patientId !== patientId) {
    throw badRequest('The referral does not belong to this patient');
  }
}

screeningRouter.post('/episodes/:id/result', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(ResultInput, req.body);
  const episode = await loadEpisode(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, episode.patientId, meta, WRITERS.careTeam);
  const from = ['INVITED', 'BOOKED', 'SCREENED'];
  requireStatus(episode, from, 'A result has already been recorded for this episode');
  const programme = episode.programme as ProgrammeCode;
  const screenedAt = episode.screenedAt ?? input.screenedAt;
  const testType = episode.screenedAt ? episode.testType : input.testType;
  if (!screenedAt || !testType) {
    throw badRequest('Record the test date and the test type with the result');
  }
  checkTestType(programme, testType);
  if (input.referralId) await assertReferralOfPatient(input.referralId, episode.patientId);
  if (input.referralId && input.result !== 'ABNORMAL') {
    throw badRequest('A referral is linked to abnormal results only');
  }
  const person = (await personOf(episode.patientId))!;
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const updated = await transition(tx, episode, from, {
      status: input.result === 'ABNORMAL' ? 'REFERRED' : 'RESULTED',
      screenedAt,
      testType,
      result: input.result,
      resultDetail: input.resultDetail ?? null,
      resultedAt: now,
      referralId: input.referralId ?? null,
      nextDueDate: nextDueAfter(programme, person, screenedAt, input.result),
      recordedById: ctx.userId,
    });
    await recordStep(ctx, episode, 'RESULT', meta, tx, { result: input.result });
    if (input.result === 'ABNORMAL') {
      // Safety net: the patient's doctor gets a task and a notification (no result in the text).
      const doctorId = (await followUpDoctor(episode.patientId, tx)) ?? ctx.userId;
      await tx.insert(careTasks).values({
        patientId: episode.patientId,
        facilityId: ctx.facilityId ?? episode.facilityId,
        createdById: ctx.userId,
        assignedToId: doctorId,
        assignedRole: 'DOCTOR',
        title: 'Follow up an abnormal screening result',
        details: `${PROGRAMMES[programme].label}: ${PROGRAMMES[programme].followUp}`,
        priority: 'URGENT',
        dueAt: new Date(now.getTime() + FOLLOW_UP_SAFETY_NET_DAYS * DAY),
      });
      await notifyUsers(
        [doctorId],
        {
          type: 'screening_follow_up',
          title: 'A screening result needs follow-up',
          link: `/doctor/patients/${episode.patientId}?tab=screening`,
        },
        tx,
      );
    }
    await notifyPatient(
      episode.patientId,
      {
        type: 'screening_result',
        title: 'Your screening result is available',
        body: 'You can read it in the portal.',
        link: '/portal/screening',
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

const LinkReferralInput = z.object({ referralId: z.string().uuid() });

screeningRouter.post('/episodes/:id/referral', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { referralId } = parse(LinkReferralInput, req.body);
  const episode = await loadEpisode(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, episode.patientId, meta, WRITERS.doctorOnly);
  requireStatus(episode, ['REFERRED'], 'Only an abnormal result under follow-up has a referral');
  await assertReferralOfPatient(referralId, episode.patientId);
  const row = await db.transaction(async (tx) => {
    const updated = await transition(tx, episode, ['REFERRED'], { referralId });
    await recordStep(ctx, episode, 'REFERRAL_LINKED', meta, tx);
    return updated;
  });
  res.json(row);
});

const CloseInput = z.object({
  /** Back to routine screening from this date; null = no further routine invitations. */
  nextDueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  note: z.string().trim().max(300).optional(),
});

/** Ends the follow-up of an abnormal result (doctor). */
screeningRouter.post('/episodes/:id/close', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(CloseInput, req.body);
  const episode = await loadEpisode(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, episode.patientId, meta, WRITERS.doctorOnly);
  requireStatus(episode, ['REFERRED'], 'Only a follow-up can be closed');
  if (input.nextDueDate && input.nextDueDate <= isoDate(new Date())) {
    throw badRequest('The next routine test must be in the future');
  }
  const row = await db.transaction(async (tx) => {
    const updated = await transition(tx, episode, ['REFERRED'], {
      status: 'CLOSED',
      nextDueDate: input.nextDueDate,
    });
    await recordStep(ctx, episode, 'FOLLOW_UP_CLOSED', meta, tx, {
      nextDueDate: input.nextDueDate,
      note: input.note ?? null,
    });
    return updated;
  });
  res.json(row);
});

const ReasonInput = z.object({ reason: z.string().trim().min(3).max(300) });

/** The person declined this round: invited again at the next routine interval. */
screeningRouter.post('/episodes/:id/decline', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonInput, req.body);
  const episode = await loadEpisode(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, episode.patientId, meta, WRITERS.careTeam);
  requireStatus(episode, ['INVITED', 'BOOKED'], 'Only an invitation can be declined');
  const person = (await personOf(episode.patientId))!;
  const now = new Date();
  const band = bandFor(episode.programme as ProgrammeCode, ageOn(person.dateOfBirth, now));
  const months = band?.months ?? PROGRAMMES[episode.programme as ProgrammeCode].bands[0]!.months;
  const row = await db.transaction(async (tx) => {
    const updated = await transition(tx, episode, ['INVITED', 'BOOKED'], {
      status: 'DECLINED',
      resultDetail: reason,
      nextDueDate: isoDate(addMonths(now, months)),
      recordedById: ctx.userId,
    });
    await recordStep(ctx, episode, 'DECLINED', meta, tx);
    return updated;
  });
  res.json(row);
});

const CeaseInput = z.object({
  programme: ProgrammeEnum,
  reason: z.string().trim().min(3).max(300),
});

/**
 * Clinical ceasing (doctor): the programme no longer applies to the person, e.g. after a total
 * hysterectomy (cervical), bilateral mastectomy (breast) or colectomy, or while under specialist
 * surveillance. Recorded as a NOT_ELIGIBLE episode – an open invitation becomes NOT_ELIGIBLE,
 * otherwise a new one is added – and no invitations follow until a doctor invites again. This is
 * kept apart from opt-outs, which are the person's own choice.
 */
screeningRouter.post('/patients/:patientId/cease', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const { programme, reason } = parse(CeaseInput, req.body);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.doctorOnly);
  const person = (await personOf(patientId))!;
  const row = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`screening:${patientId}:${programme}`}))`,
    );
    const { episodes, optOuts } = await loadScreening([patientId], tx);
    const status = programmeStatus(programme, person, episodes, optOuts);
    if (status.openEpisode?.status === 'REFERRED' || status.openEpisode?.status === 'SCREENED') {
      throw conflict('Record the result or close the follow-up first');
    }
    if (status.state === 'CEASED') throw conflict('This programme is already ceased');
    let episode: Episode;
    if (status.openEpisode) {
      episode = await transition(tx, status.openEpisode, ['INVITED', 'BOOKED'], {
        status: 'NOT_ELIGIBLE',
        resultDetail: reason,
        recordedById: ctx.userId,
      });
    } else {
      [episode] = (await tx
        .insert(screeningEpisodes)
        .values({
          patientId,
          programme,
          facilityId: person.primaryFacilityId,
          status: 'NOT_ELIGIBLE',
          dueDate: isoDate(new Date()),
          resultDetail: reason,
          recordedById: ctx.userId,
        })
        .returning()) as [Episode];
    }
    await recordStep(ctx, episode, 'CEASED', meta, tx);
    return episode;
  });
  res.status(201).json(row);
});

/* --------------------------------------------------------------------------- opt-outs -- */

const OptOutInput = z.object({
  programme: ProgrammeEnum,
  reason: z.string().trim().max(300).optional().nullable(),
});

async function optOut(
  ctx: AuthContext,
  patientId: string,
  programme: ProgrammeCode,
  reason: string | null,
  via: 'PORTAL' | 'IN_PERSON',
  meta: ReturnType<typeof requestMeta>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`screening:${patientId}:${programme}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(screeningOptOuts)
      .where(
        and(
          eq(screeningOptOuts.patientId, patientId),
          eq(screeningOptOuts.programme, programme),
          isNull(screeningOptOuts.withdrawnAt),
        ),
      );
    if (existing) throw conflict('Already opted out of this programme');
    const [created] = await tx
      .insert(screeningOptOuts)
      .values({ patientId, programme, reason, recordedVia: via, recordedById: ctx.userId })
      .returning();
    // An open invitation is declined; a follow-up in progress is not affected.
    await tx
      .update(screeningEpisodes)
      .set({ status: 'DECLINED', resultDetail: 'Opted out', nextDueDate: null })
      .where(
        and(
          eq(screeningEpisodes.patientId, patientId),
          eq(screeningEpisodes.programme, programme),
          inArray(screeningEpisodes.status, ['INVITED', 'BOOKED']),
        ),
      );
    await audit(
      {
        action: AuditAction.SCREENING_OPT_OUT,
        actor: ctx,
        resourceType: 'screening_opt_out',
        resourceId: created!.id,
        patientId,
        meta,
        metadata: { programme, change: 'OPTED_OUT', via },
      },
      tx,
    );
    return created!;
  });
}

async function optBackIn(
  ctx: AuthContext,
  patientId: string,
  programme: ProgrammeCode,
  meta: ReturnType<typeof requestMeta>,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(screeningOptOuts)
      .set({ withdrawnAt: new Date() })
      .where(
        and(
          eq(screeningOptOuts.patientId, patientId),
          eq(screeningOptOuts.programme, programme),
          isNull(screeningOptOuts.withdrawnAt),
        ),
      )
      .returning();
    if (!updated) throw notFound('No opt-out for this programme');
    await audit(
      {
        action: AuditAction.SCREENING_OPT_OUT,
        actor: ctx,
        resourceType: 'screening_opt_out',
        resourceId: updated.id,
        patientId,
        meta,
        metadata: { programme, change: 'OPTED_BACK_IN' },
      },
      tx,
    );
    return updated;
  });
}

screeningRouter.post(
  '/patients/:patientId/opt-outs',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const input = parse(OptOutInput, req.body);
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
    res
      .status(201)
      .json(await optOut(ctx, patientId, input.programme, input.reason ?? null, 'IN_PERSON', meta));
  },
);

screeningRouter.post(
  '/patients/:patientId/opt-outs/:programme/withdraw',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId, programme } = parse(
      PatientParam.extend({ programme: ProgrammeEnum }),
      req.params,
    );
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
    res.json(await optBackIn(ctx, patientId, programme, meta));
  },
);

/* --------------------------------------------------------------------------- worklist -- */

const WorklistQuery = PaginationSchema.extend({
  view: z.enum(['due', 'followup', 'all']).default('all'),
  programme: ProgrammeEnum.optional(),
  q: z.string().trim().max(100).optional(),
});

/**
 * Patients in the caller's care (active care-team membership) who are due for screening, whose
 * invitation was not taken up, or whose abnormal result is being followed up (flagged when no
 * referral was recorded after the safety-net period).
 */
screeningRouter.get('/worklist', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(WorklistQuery, req.query);
  const people = await db
    .selectDistinct({
      id: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      phone: patients.phone,
    })
    .from(patients)
    .innerJoin(
      careAssignments,
      and(
        eq(careAssignments.patientId, patients.id),
        eq(careAssignments.doctorId, ctx.userId),
        isNull(careAssignments.endedAt),
      ),
    )
    .where(
      and(
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
        q.q
          ? sql`(${patients.firstName} || ' ' || ${patients.lastName} ILIKE ${`%${q.q}%`} OR ${patients.nationalId} ILIKE ${`${q.q}%`})`
          : undefined,
      ),
    )
    .limit(5000);
  const { episodes, optOuts } = await loadScreening(people.map((p) => p.id));
  const now = new Date();
  const items = people
    .map((p) => {
      const programmes = PROGRAMME_CODES.filter((c) => !q.programme || c === q.programme)
        .map((c) =>
          programmeStatus(
            c,
            p,
            episodes.filter((e) => e.patientId === p.id),
            optOuts.filter((o) => o.patientId === p.id),
            now,
          ),
        )
        .filter((s) => {
          const due = s.state === 'DUE' || (s.state === 'IN_PROGRESS' && s.invitationOverdue);
          const followUp = s.state === 'FOLLOW_UP';
          return q.view === 'due' ? due : q.view === 'followup' ? followUp : due || followUp;
        })
        .map((s) => ({
          programme: s.programme,
          state: s.state,
          testOffered: s.testOffered,
          nextDueDate: s.nextDueDate,
          lastScreenedAt: s.lastScreenedAt,
          invitationOverdue: s.invitationOverdue,
          followUpOverdue: s.followUpOverdue,
          episodeId: s.openEpisode?.id ?? null,
          invitedAt: s.openEpisode?.invitedAt ?? null,
        }));
      return { patient: p, programmes };
    })
    .filter((x) => x.programmes.length);
  const weight = (x: (typeof items)[number]) =>
    x.programmes.reduce(
      (a, s) => a + (s.followUpOverdue ? 100 : s.state === 'FOLLOW_UP' ? 10 : 1),
      0,
    );
  items.sort(
    (a, b) =>
      weight(b) - weight(a) ||
      a.patient.lastName.localeCompare(b.patient.lastName) ||
      a.patient.firstName.localeCompare(b.patient.firstName),
  );
  const start = (q.page - 1) * q.pageSize;
  res.json({
    ...paginated(items.slice(start, start + q.pageSize), items.length, q),
    counts: {
      due: items.reduce(
        (a, x) => a + x.programmes.filter((s) => s.state !== 'FOLLOW_UP').length,
        0,
      ),
      followUp: items.reduce(
        (a, x) => a + x.programmes.filter((s) => s.state === 'FOLLOW_UP').length,
        0,
      ),
      followUpOverdue: items.reduce(
        (a, x) => a + x.programmes.filter((s) => s.followUpOverdue).length,
        0,
      ),
      inCare: people.length,
    },
  });
});

/* --------------------------------------------------------------------------- coverage -- */

const CoverageQuery = z.object({
  groupBy: z.enum(['NONE', 'MUNICIPALITY']).default('NONE'),
  facilityId: z.string().uuid().optional(),
});

screeningRouter.get('/coverage', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(CoverageQuery, req.query);
  if (ctx.role === 'DIRECTOR') {
    if (!ctx.facilityId) throw forbidden();
    if (q.facilityId && q.facilityId !== ctx.facilityId) throw forbidden();
  }
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : (q.facilityId ?? null);
  const groupBy = ctx.role === 'DIRECTOR' ? 'NONE' : q.groupBy;
  const total = await coverage({ facilityId, groupBy: 'NONE' });
  const rows = groupBy === 'NONE' ? [] : await coverage({ facilityId, groupBy });
  res.json({
    scope: facilityId ? 'FACILITY' : 'NATIONAL',
    groupBy,
    asOf: isoDate(new Date()),
    threshold: SMALL_CELL_THRESHOLD,
    total,
    rows,
    disclaimer: DISCLAIMER,
  });
});

/* ----------------------------------------------------------------------------- portal -- */

screeningRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  assertFullProxyScope(ctx);
  const person = await personOf(ctx.patientId);
  if (!person) throw notFound('Patient not found');
  const { programmes, optOuts } = await statusesFor(person);
  const history = await episodeHistory(ctx.patientId);
  res.json({
    programmes: programmes.map((s) => ({
      programme: s.programme,
      state: s.state,
      inPopulation: s.inPopulation,
      testOffered: s.testOffered,
      nextDueDate: s.nextDueDate,
      lastScreenedAt: s.lastScreenedAt,
      lastResult: s.lastResult,
      optedOut: Boolean(s.optOut),
      openEpisode: s.openEpisode
        ? {
            id: s.openEpisode.id,
            status: s.openEpisode.status,
            invitedAt: s.openEpisode.invitedAt,
            bookedFor: s.openEpisode.bookedFor,
            screenedAt: s.openEpisode.screenedAt,
          }
        : null,
    })),
    optOuts: optOuts.map((o) => ({ programme: o.programme, since: o.createdAt })),
    // No clinical free text and no staff names: dates, status and the result category only.
    history: history.map((h) => ({
      id: h.episode.id,
      programme: h.episode.programme,
      status: h.episode.status,
      facilityName: h.facilityName,
      invitedAt: h.episode.invitedAt,
      bookedFor: h.episode.bookedFor,
      screenedAt: h.episode.screenedAt,
      testType: h.episode.testType,
      result: h.episode.result,
      nextDueDate: h.episode.nextDueDate,
    })),
    disclaimer: DISCLAIMER,
  });
});

screeningRouter.post('/mine/opt-outs', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  assertFullProxyScope(ctx);
  const input = parse(OptOutInput, req.body);
  res
    .status(201)
    .json(
      await optOut(
        ctx,
        ctx.patientId,
        input.programme,
        input.reason ?? null,
        'PORTAL',
        requestMeta(req),
      ),
    );
});

screeningRouter.post(
  '/mine/opt-outs/:programme/withdraw',
  requireRole('PATIENT'),
  async (req, res) => {
    const ctx = requireAuth(req);
    if (!ctx.patientId) throw forbidden();
    assertFullProxyScope(ctx);
    const { programme } = parse(z.object({ programme: ProgrammeEnum }), req.params);
    res.json(await optBackIn(ctx, ctx.patientId, programme, requestMeta(req)));
  },
);
