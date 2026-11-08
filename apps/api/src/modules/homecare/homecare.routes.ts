import { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  careUnits,
  facilities,
  homeCareEpisodes,
  homeVisits,
  patients,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertNotMerged,
  auditRecordView,
  getPatientOrThrow,
  resolveAndAuditRead,
  resolveClinicalReadAccess,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { assertLicensed } from '../licences/licences.service.js';
import { scoreVitalSign } from '../news/news.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';
import {
  assertTeamMember,
  FREQUENCIES,
  isTeamMember,
  kosovoDate,
  loadTeam,
  MAX_SCHEDULE_WEEKS,
  notifyMissedVisit,
  OPEN_EPISODE_STATUSES,
  parseCarePlan,
  scheduleTimes,
  serialiseCarePlan,
  TASKS,
  teamMembers,
  teamsOf,
  visitState,
  type EpisodeRow,
  type VisitRow,
} from './homecare.service.js';

/**
 * Home care and community nursing (see homecare.service.ts). Doctors refer, the community nursing
 * team accepts, plans and records visits; the patient sees upcoming visits in the portal; the
 * director sees team activity without names.
 */
export const homeCareRouter = Router();
homeCareRouter.use(authenticate);

/**
 * Clinical writes by the community nursing team: the user must be on the team, hold a valid
 * licence, and the patient record must not have been merged into another.
 */
async function assertTeamWrite(
  ctx: AuthContext,
  req: Parameters<typeof requestMeta>[0],
  episode: { teamUnitId: string; patientId: string },
) {
  await assertTeamMember(ctx, episode.teamUnitId);
  await assertLicensed(ctx, requestMeta(req));
  assertNotMerged(await getPatientOrThrow(episode.patientId));
}

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const Reason = z.string().trim().min(3).max(300);
const Tasks = z.array(z.enum(TASKS)).max(TASKS.length);

/* ------------------------------------------------------------------ helpers --------------- */

async function loadEpisode(id: string) {
  const [row] = await db.select().from(homeCareEpisodes).where(eq(homeCareEpisodes.id, id));
  if (!row) throw notFound('Home care episode not found');
  return row;
}

async function loadVisit(id: string) {
  const [row] = await db
    .select({ visit: homeVisits, episode: homeCareEpisodes })
    .from(homeVisits)
    .innerJoin(homeCareEpisodes, eq(homeCareEpisodes.id, homeVisits.episodeId))
    .where(eq(homeVisits.id, id));
  if (!row) throw notFound('Home visit not found');
  return row;
}

const isOpen = (e: EpisodeRow) => (OPEN_EPISODE_STATUSES as readonly string[]).includes(e.status);

function presentVisit(v: VisitRow, names: Map<string, string>, now = new Date()) {
  return {
    id: v.id,
    episodeId: v.episodeId,
    patientId: v.patientId,
    scheduledFor: v.scheduledFor,
    assignedToId: v.assignedToId,
    assignedTo: v.assignedToId ? (names.get(v.assignedToId) ?? null) : null,
    status: v.status,
    tasks: v.tasks,
    notes: v.notes,
    missedReason: v.missedReason,
    recordedBy: v.recordedById ? (names.get(v.recordedById) ?? null) : null,
    ...visitState(v, now),
  };
}

function presentEpisode(
  e: EpisodeRow,
  extra: { teamName: string; facilityName: string; referredBy: string | null },
) {
  return {
    id: e.id,
    patientId: e.patientId,
    teamUnitId: e.teamUnitId,
    teamName: extra.teamName,
    teamFacilityName: extra.facilityName,
    referredById: e.referredById,
    referredBy: extra.referredBy,
    reason: e.reason,
    carePlan: parseCarePlan(e.carePlan),
    visitAddress: e.visitAddress,
    accessNotes: e.accessNotes,
    status: e.status,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    endReason: e.endReason,
    createdAt: e.createdAt,
  };
}

async function namesFor(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function episodesWithVisits(where: ReturnType<typeof eq>, visitLimit = 60) {
  const rows = await db
    .select({ e: homeCareEpisodes, teamName: careUnits.name, facilityName: facilities.name })
    .from(homeCareEpisodes)
    .innerJoin(careUnits, eq(careUnits.id, homeCareEpisodes.teamUnitId))
    .innerJoin(facilities, eq(facilities.id, careUnits.facilityId))
    .where(where)
    .orderBy(desc(homeCareEpisodes.createdAt));
  const ids = rows.map((r) => r.e.id);
  const visits = ids.length
    ? await db
        .select()
        .from(homeVisits)
        .where(inArray(homeVisits.episodeId, ids))
        .orderBy(desc(homeVisits.scheduledFor))
    : [];
  const names = await namesFor([
    ...rows.map((r) => r.e.referredById),
    ...visits.flatMap((v) => [v.assignedToId, v.recordedById]),
  ]);
  return rows.map((r) => ({
    ...presentEpisode(r.e, {
      teamName: r.teamName,
      facilityName: r.facilityName,
      referredBy: names.get(r.e.referredById) ?? null,
    }),
    visits: visits
      .filter((v) => v.episodeId === r.e.id)
      .slice(0, visitLimit)
      .map((v) => presentVisit(v, names)),
  }));
}

async function auditChange(
  ctx: AuthContext,
  req: Parameters<typeof requestMeta>[0],
  e: { id: string; patientId: string },
  change: string,
  metadata: Record<string, unknown> = {},
  action: (typeof AuditAction)[keyof typeof AuditAction] = AuditAction.HOME_CARE_CHANGED,
  executor: Executor = db,
) {
  await audit(
    {
      action,
      actor: ctx,
      resourceType: action === AuditAction.HOME_VISIT_RECORDED ? 'home_visit' : 'home_care_episode',
      resourceId: e.id,
      patientId: e.patientId,
      meta: requestMeta(req),
      metadata: { change, ...metadata },
    },
    executor,
  );
}

/** Team members of the episode, or a clinician of the patient's care team with write access. */
async function assertCanPlan(
  ctx: AuthContext,
  episode: EpisodeRow,
  meta: ReturnType<typeof requestMeta>,
) {
  if (await isTeamMember(ctx.userId, episode.teamUnitId)) {
    if (ctx.role === 'NURSE' || ctx.role === 'DOCTOR') return;
  }
  if (ctx.role === 'DOCTOR') {
    await assertClinicalWriteAccess(ctx, episode.patientId, meta);
    return;
  }
  throw forbidden('Only the community nursing team or the patient’s doctor can change this');
}

/* ------------------------------------------------------------------ reference ------------- */

/**
 * Community nursing teams a patient can be referred to: at the caller's facility and at the
 * patient's registered facility (hospital discharge to the family medicine centre's team).
 * Without a patient: the teams the caller belongs to.
 */
homeCareRouter.get('/teams', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(z.object({ patientId: z.string().uuid().optional() }), req.query);
  const mine = await teamsOf(ctx.userId);
  let facilityIds: string[] = [];
  if (patientId) {
    if (ctx.role !== 'DOCTOR') throw forbidden();
    await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
    const patient = await getPatientOrThrow(patientId);
    facilityIds = [ctx.facilityId, patient.primaryFacilityId].filter((x): x is string => !!x);
  } else if (ctx.role === 'DIRECTOR' && ctx.facilityId) {
    facilityIds = [ctx.facilityId];
  }
  const teams = facilityIds.length
    ? await db
        .select({
          id: careUnits.id,
          name: careUnits.name,
          facilityId: careUnits.facilityId,
          facilityName: facilities.name,
        })
        .from(careUnits)
        .innerJoin(facilities, eq(facilities.id, careUnits.facilityId))
        .where(
          and(
            inArray(careUnits.facilityId, [...new Set(facilityIds)]),
            eq(careUnits.isActive, true),
            sql`${careUnits.type}::text = 'COMMUNITY_NURSING'`,
          ),
        )
        .orderBy(careUnits.name)
    : [];
  res.json({ teams, myTeams: mine.map((t) => t.id), tasks: TASKS, frequencies: FREQUENCIES });
});

homeCareRouter.get('/teams/:id/members', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const team = await loadTeam(id);
  if (
    !(await isTeamMember(ctx.userId, id)) &&
    !(ctx.role === 'DIRECTOR' && ctx.facilityId === team.facilityId)
  ) {
    throw forbidden();
  }
  res.json({ items: await teamMembers(id) });
});

/* ------------------------------------------------------------------ chart ----------------- */

homeCareRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'home_care');
  const items = await episodesWithVisits(eq(homeCareEpisodes.patientId, patientId));
  const myTeams = (await teamsOf(ctx.userId)).map((t) => t.id);
  const patient = await getPatientOrThrow(patientId);
  res.json({
    items: items.map((e) => ({ ...e, isMyTeam: myTeams.includes(e.teamUnitId) })),
    canRefer: ctx.role === 'DOCTOR' && !patient.deceasedAt,
    defaultAddress: patient.address,
  });
});

const ReferInput = z.object({
  teamUnitId: z.string().uuid(),
  reason: z.string().trim().min(5).max(300),
  tasks: Tasks.min(1, 'Choose at least one need'),
  goals: z.string().trim().max(4000).optional(),
  visitAddress: z.string().trim().max(300).optional(),
  accessNotes: z.string().trim().max(300).optional(),
  /** Referral at a hospital discharge (the stay of the same patient). */
  admissionId: z.string().uuid().optional(),
});

/** Refer a patient to a community nursing team (one open episode per patient and team). */
homeCareRouter.post('/patients/:patientId/episodes', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(ReferInput, req.body);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, patientId, meta);
  const patient = await getPatientOrThrow(patientId);
  if (patient.deceasedAt) throw conflict('The patient is recorded as deceased');
  const team = await loadTeam(input.teamUnitId);
  if (team.facilityId !== ctx.facilityId && team.facilityId !== patient.primaryFacilityId) {
    throw badRequest(
      'Refer to a community nursing team of your facility or of the patient’s registered facility',
    );
  }
  if (input.admissionId) {
    const [a] = await db
      .select({ patientId: admissions.patientId })
      .from(admissions)
      .where(eq(admissions.id, input.admissionId));
    if (!a || a.patientId !== patientId)
      throw badRequest('The hospital stay is not this patient’s');
  }
  const address = input.visitAddress || patient.address;
  if (!address) throw badRequest('Enter the address where the patient will be visited');
  const created = await db.transaction(async (tx) => {
    // Serialise referrals of the same patient (one open episode per team).
    await tx.execute(sql`SELECT id FROM patients WHERE id = ${patientId} FOR UPDATE`);
    const [open] = await tx
      .select({ id: homeCareEpisodes.id })
      .from(homeCareEpisodes)
      .where(
        and(
          eq(homeCareEpisodes.patientId, patientId),
          eq(homeCareEpisodes.teamUnitId, team.id),
          inArray(homeCareEpisodes.status, [...OPEN_EPISODE_STATUSES]),
        ),
      );
    if (open) throw conflict('The patient already has an open home care episode with this team');
    const [row] = await tx
      .insert(homeCareEpisodes)
      .values({
        patientId,
        teamUnitId: team.id,
        referredById: ctx.userId,
        reason: input.reason,
        carePlan: serialiseCarePlan({ goals: input.goals ?? '', tasks: input.tasks }),
        visitAddress: address,
        accessNotes: input.accessNotes || null,
      })
      .returning();
    await auditChange(
      ctx,
      req,
      row!,
      'REFERRED',
      {
        teamUnitId: team.id,
        fromAdmissionId: input.admissionId ?? null,
      },
      AuditAction.HOME_CARE_CHANGED,
      tx,
    );
    const members = await teamMembers(team.id, tx);
    await notifyUsers(
      members.map((m) => m.id).filter((id) => id !== ctx.userId),
      {
        type: 'home_care',
        title: 'New home care referral for {team}',
        vars: { team: team.name },
        link: `/home-care?episode=${row!.id}`,
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(created);
});

/* ------------------------------------------------------------------ episodes -------------- */

homeCareRouter.get('/episodes/:id', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const e = await loadEpisode(id);
  await resolveAndAuditRead(ctx, e.patientId, requestMeta(req), 'home_care');
  const [item] = await episodesWithVisits(eq(homeCareEpisodes.id, id), 500);
  const [p] = await db
    .select({
      id: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      phone: patients.phone,
    })
    .from(patients)
    .where(eq(patients.id, e.patientId));
  res.json({ ...item, patient: p, isMyTeam: await isTeamMember(ctx.userId, e.teamUnitId) });
});

homeCareRouter.post('/episodes/:id/accept', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const e = await loadEpisode(id);
  await assertTeamWrite(ctx, req, e);
  if (e.status !== 'REFERRED') throw conflict('Only a new referral can be accepted');
  const [row] = await db
    .update(homeCareEpisodes)
    .set({ status: 'ACTIVE', startedAt: new Date() })
    .where(and(eq(homeCareEpisodes.id, id), eq(homeCareEpisodes.status, 'REFERRED')))
    .returning();
  if (!row) throw conflict('Only a new referral can be accepted');
  await auditChange(ctx, req, row, 'ACCEPTED');
  const team = await loadTeam(e.teamUnitId);
  await notifyUsers([e.referredById], {
    type: 'home_care',
    title: '{team} accepted your home care referral',
    vars: { team: team.name },
    link: `/doctor/patients/${e.patientId}?tab=homecare`,
  });
  await notifyPatient(e.patientId, {
    type: 'home_care',
    title: 'Home care visits will start – see your home visits',
    link: '/portal/home-visits',
  });
  res.json(row);
});

const PlanInput = z
  .object({
    goals: z.string().trim().max(4000).optional(),
    tasks: Tasks.optional(),
    visitAddress: z.string().trim().min(3).max(300).optional(),
    accessNotes: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

homeCareRouter.patch('/episodes/:id/care-plan', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(PlanInput, req.body);
  const e = await loadEpisode(id);
  if (!isOpen(e)) throw conflict('The home care episode has ended');
  await assertCanPlan(ctx, e, requestMeta(req));
  const plan = parseCarePlan(e.carePlan);
  const next = {
    goals: input.goals ?? plan.goals,
    tasks: input.tasks ?? plan.tasks,
  };
  const [row] = await db
    .update(homeCareEpisodes)
    .set({
      carePlan: serialiseCarePlan(next),
      visitAddress: input.visitAddress ?? e.visitAddress,
      accessNotes: input.accessNotes === undefined ? e.accessNotes : input.accessNotes || null,
    })
    .where(eq(homeCareEpisodes.id, id))
    .returning();
  await auditChange(ctx, req, row!, 'CARE_PLAN', { fields: Object.keys(input) });
  res.json({ ...row!, carePlan: next });
});

/** Cancel planned, not yet started visits from `from` on (used by hold and discharge). */
async function cancelFutureVisits(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  episodeId: string,
  from: Date,
  reason: string,
) {
  const rows = await tx
    .update(homeVisits)
    .set({ status: 'CANCELLED', missedReason: reason })
    .where(
      and(
        eq(homeVisits.episodeId, episodeId),
        eq(homeVisits.status, 'PLANNED'),
        isNull(homeVisits.visitedAt),
        gte(homeVisits.scheduledFor, from),
      ),
    )
    .returning({ id: homeVisits.id });
  return rows.length;
}

homeCareRouter.post('/episodes/:id/hold', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: Reason }), req.body);
  const e = await loadEpisode(id);
  await assertTeamWrite(ctx, req, e);
  if (e.status !== 'ACTIVE') throw conflict('Only an active episode can be put on hold');
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(homeCareEpisodes)
      .set({ status: 'ON_HOLD' })
      .where(eq(homeCareEpisodes.id, id))
      .returning();
    const cancelled = await cancelFutureVisits(tx, id, new Date(), 'Episode on hold: ' + reason);
    await auditChange(
      ctx,
      req,
      row!,
      'ON_HOLD',
      { reason, visitsCancelled: cancelled },
      AuditAction.HOME_CARE_CHANGED,
      tx,
    );
    return { row: row!, cancelled };
  });
  res.json({ ...result.row, visitsCancelled: result.cancelled });
});

homeCareRouter.post('/episodes/:id/resume', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const e = await loadEpisode(id);
  await assertTeamWrite(ctx, req, e);
  if (e.status !== 'ON_HOLD') throw conflict('The episode is not on hold');
  const [row] = await db
    .update(homeCareEpisodes)
    .set({ status: 'ACTIVE' })
    .where(eq(homeCareEpisodes.id, id))
    .returning();
  await auditChange(ctx, req, row!, 'RESUMED');
  res.json(row);
});

homeCareRouter.post('/episodes/:id/discharge', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: Reason }), req.body);
  const e = await loadEpisode(id);
  if (!isOpen(e)) throw conflict('The home care episode has already ended');
  await assertCanPlan(ctx, e, requestMeta(req));
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(homeCareEpisodes)
      .set({ status: 'DISCHARGED', endedAt: now, endReason: reason })
      .where(eq(homeCareEpisodes.id, id))
      .returning();
    const cancelled = await cancelFutureVisits(tx, id, now, 'Discharged from home care');
    await auditChange(
      ctx,
      req,
      row!,
      'DISCHARGED',
      { reason, visitsCancelled: cancelled },
      AuditAction.HOME_CARE_CHANGED,
      tx,
    );
    await notifyPatient(
      e.patientId,
      {
        type: 'home_care',
        title: 'Your home care has ended',
        link: '/portal/home-visits',
      },
      tx,
    );
    return { row: row!, cancelled };
  });
  res.json({ ...result.row, visitsCancelled: result.cancelled });
});

/* ------------------------------------------------------------------ visits ---------------- */

const ScheduleInput = z.object({
  startAt: z.coerce.date(),
  frequency: z.enum(FREQUENCIES),
  weeks: z.coerce.number().int().min(1).max(MAX_SCHEDULE_WEEKS).default(1),
  assignedToId: z.string().uuid().nullable().optional(),
  tasks: Tasks.default([]),
});

homeCareRouter.post('/episodes/:id/visits', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(ScheduleInput, req.body);
  const e = await loadEpisode(id);
  await assertTeamWrite(ctx, req, e);
  if (e.status !== 'ACTIVE') {
    throw conflict(
      'Visits can be planned once the referral is accepted and while the episode is active',
    );
  }
  if (input.startAt.getTime() < Date.now() - 24 * 3_600_000) {
    throw badRequest('The first visit cannot be more than a day in the past');
  }
  if (input.assignedToId && !(await isTeamMember(input.assignedToId, e.teamUnitId))) {
    throw badRequest('The nurse is not a member of this team');
  }
  const tasks = input.tasks.length ? input.tasks : parseCarePlan(e.carePlan).tasks;
  const times = scheduleTimes(input.startAt, input.frequency, input.weeks);
  const rows = await db.transaction(async (tx) => {
    const created = await tx
      .insert(homeVisits)
      .values(
        times.map((t) => ({
          episodeId: id,
          patientId: e.patientId,
          scheduledFor: t,
          assignedToId: input.assignedToId ?? null,
          tasks,
        })),
      )
      .returning();
    await auditChange(
      ctx,
      req,
      e,
      'VISITS_PLANNED',
      {
        count: created.length,
        frequency: input.frequency,
        weeks: input.weeks,
      },
      AuditAction.HOME_CARE_CHANGED,
      tx,
    );
    return created;
  });
  res.status(201).json({ count: rows.length, items: rows });
});

const VisitPatch = z
  .object({
    scheduledFor: z.coerce.date().optional(),
    assignedToId: z.string().uuid().nullable().optional(),
    tasks: Tasks.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

homeCareRouter.patch('/visits/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(VisitPatch, req.body);
  const { visit, episode } = await loadVisit(id);
  await assertTeamWrite(ctx, req, episode);
  if (visit.status !== 'PLANNED' || visit.visitedAt) {
    throw conflict('Only a planned visit that has not started can be changed');
  }
  if (input.assignedToId && !(await isTeamMember(input.assignedToId, episode.teamUnitId))) {
    throw badRequest('The nurse is not a member of this team');
  }
  const [row] = await db
    .update(homeVisits)
    .set({
      scheduledFor: input.scheduledFor ?? visit.scheduledFor,
      assignedToId: input.assignedToId === undefined ? visit.assignedToId : input.assignedToId,
      tasks: input.tasks ?? visit.tasks,
    })
    .where(eq(homeVisits.id, id))
    .returning();
  await auditChange(ctx, req, { id, patientId: visit.patientId }, 'VISIT_CHANGED', {
    fields: Object.keys(input),
  });
  res.json(row);
});

/** Check-in: the nurse is at the patient's home (start of the visit, for lone-working safety). */
homeCareRouter.post('/visits/:id/check-in', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { visit, episode } = await loadVisit(id);
  await assertTeamWrite(ctx, req, episode);
  if (visit.status !== 'PLANNED') throw conflict('The visit is already closed');
  if (visit.visitedAt) throw conflict('The visit has already started');
  if (episode.status !== 'ACTIVE') throw conflict('The home care episode is not active');
  const [row] = await db
    .update(homeVisits)
    .set({ visitedAt: new Date(), assignedToId: visit.assignedToId ?? ctx.userId })
    .where(and(eq(homeVisits.id, id), isNull(homeVisits.visitedAt)))
    .returning();
  if (!row) throw conflict('The visit has already started');
  await auditChange(
    ctx,
    req,
    { id, patientId: visit.patientId },
    'CHECKED_IN',
    {},
    AuditAction.HOME_VISIT_RECORDED,
  );
  res.json({ ...row, ...visitState(row) });
});

const Observations = z
  .object({
    systolic: z.number().int().min(40).max(300).optional(),
    diastolic: z.number().int().min(20).max(200).optional(),
    heartRate: z.number().int().min(20).max(300).optional(),
    respiratoryRate: z.number().int().min(4).max(80).optional(),
    oxygenSaturation: z.number().int().min(30).max(100).optional(),
    temperatureC: z.number().min(25).max(45).optional(),
    consciousness: z.enum(['A', 'C', 'V', 'P', 'U']).optional(),
    onSupplementalOxygen: z.boolean().optional(),
    painScore: z.number().int().min(0).max(10).optional(),
    weightKg: z.number().min(0.3).max(500).optional(),
  })
  .strict();

const CompleteInput = z.object({
  notes: z.string().trim().min(3).max(4000),
  tasksDone: Tasks.default([]),
  observations: Observations.optional(),
});

/** Check-out: the visit is recorded as done; observations become vital signs (scored by NEWS2). */
homeCareRouter.post('/visits/:id/complete', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(CompleteInput, req.body);
  const { visit, episode } = await loadVisit(id);
  await assertTeamWrite(ctx, req, episode);
  if (visit.status !== 'PLANNED') throw conflict('The visit is already closed');
  if (episode.status !== 'ACTIVE') throw conflict('The home care episode is not active');
  const now = new Date();
  const obs =
    input.observations && Object.keys(input.observations).length ? input.observations : null;
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(homeVisits)
      .set({
        status: 'DONE',
        visitedAt: visit.visitedAt ?? now,
        notes: input.notes,
        tasks: input.tasksDone.length ? input.tasksDone : visit.tasks,
        recordedById: ctx.userId,
        assignedToId: visit.assignedToId ?? ctx.userId,
      })
      .where(and(eq(homeVisits.id, id), eq(homeVisits.status, 'PLANNED')))
      .returning();
    if (!row) throw conflict('The visit is already closed');
    let vitalSignId: string | null = null;
    if (obs) {
      const [v] = await tx
        .insert(vitalSigns)
        .values({
          patientId: visit.patientId,
          recordedById: ctx.userId,
          systolic: obs.systolic,
          diastolic: obs.diastolic,
          heartRate: obs.heartRate,
          respiratoryRate: obs.respiratoryRate,
          oxygenSaturation: obs.oxygenSaturation,
          temperatureC: obs.temperatureC?.toString(),
          consciousness: obs.consciousness,
          onSupplementalOxygen: obs.onSupplementalOxygen,
          painScore: obs.painScore,
          weightKg: obs.weightKg?.toString(),
          recordedAt: row.visitedAt ?? now,
        })
        .returning({ id: vitalSigns.id });
      vitalSignId = v!.id;
    }
    await auditChange(
      ctx,
      req,
      { id, patientId: visit.patientId },
      'DONE',
      { tasksDone: row.tasks, vitalSignId },
      AuditAction.HOME_VISIT_RECORDED,
      tx,
    );
    return { row, vitalSignId };
  });
  // Early warning score (NEWS2/PEWS) for the observations; never blocks the record.
  const news = result.vitalSignId
    ? await scoreVitalSign(result.vitalSignId).catch(() => null)
    : null;
  res.json({
    ...result.row,
    ...visitState(result.row),
    vitalSignId: result.vitalSignId,
    news: news && {
      scale: news.scale,
      score: news.score,
      risk: news.risk,
      complete: news.complete,
    },
  });
});

homeCareRouter.post('/visits/:id/missed', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: Reason }), req.body);
  const { visit, episode } = await loadVisit(id);
  await assertTeamWrite(ctx, req, episode);
  if (visit.status !== 'PLANNED') throw conflict('The visit is already closed');
  if (episode.status !== 'ACTIVE') throw conflict('The home care episode is not active');
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(homeVisits)
      .set({ status: 'MISSED', missedReason: reason, recordedById: ctx.userId })
      .where(and(eq(homeVisits.id, id), eq(homeVisits.status, 'PLANNED')))
      .returning();
    if (!row) throw conflict('The visit is already closed');
    const alerted = await notifyMissedVisit(row, episode, ctx.userId, tx);
    await auditChange(
      ctx,
      req,
      { id, patientId: visit.patientId },
      'MISSED',
      { reason, alerted },
      AuditAction.HOME_VISIT_RECORDED,
      tx,
    );
    return { row, alerted };
  });
  res.json({ ...result.row, alerted: result.alerted });
});

homeCareRouter.post('/visits/:id/cancel', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: Reason }), req.body);
  const { visit, episode } = await loadVisit(id);
  await assertTeamWrite(ctx, req, episode);
  if (visit.status !== 'PLANNED' || visit.visitedAt) {
    throw conflict('Only a planned visit that has not started can be cancelled');
  }
  const [row] = await db
    .update(homeVisits)
    .set({ status: 'CANCELLED', missedReason: reason, recordedById: ctx.userId })
    .where(and(eq(homeVisits.id, id), eq(homeVisits.status, 'PLANNED')))
    .returning();
  await auditChange(
    ctx,
    req,
    { id, patientId: visit.patientId },
    'CANCELLED',
    { reason },
    AuditAction.HOME_VISIT_RECORDED,
  );
  res.json(row);
});

/* ------------------------------------------------------------------ team board ------------ */

/**
 * The team's day: visits per nurse ordered by time (the route order is the planned times), with
 * the address and access notes, plus new referrals and visits that need attention (checked in more
 * than 2 hours ago without a check-out, planned and not started 2 hours after their time).
 */
homeCareRouter.get('/board', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(
    z.object({
      teamId: z.string().uuid().optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    req.query,
  );
  const mine = await teamsOf(ctx.userId);
  if (!mine.length) {
    res.json({ teams: [], team: null, date: q.date ?? kosovoDate(new Date()) });
    return;
  }
  const team = q.teamId ? mine.find((t) => t.id === q.teamId) : mine[0];
  if (!team) throw forbidden('You are not a member of this team');
  const date = q.date ?? kosovoDate(new Date());
  const now = new Date();
  const dayVisits = await db
    .select({
      v: homeVisits,
      firstName: patients.firstName,
      lastName: patients.lastName,
      phone: patients.phone,
      address: homeCareEpisodes.visitAddress,
      accessNotes: homeCareEpisodes.accessNotes,
    })
    .from(homeVisits)
    .innerJoin(homeCareEpisodes, eq(homeCareEpisodes.id, homeVisits.episodeId))
    .innerJoin(patients, eq(patients.id, homeVisits.patientId))
    .where(
      and(
        eq(homeCareEpisodes.teamUnitId, team.id),
        sql`(${homeVisits.scheduledFor} AT TIME ZONE 'Europe/Belgrade')::date = ${date}::date`,
      ),
    )
    .orderBy(asc(homeVisits.scheduledFor));
  // Visits still open from earlier days (started without check-out, or never recorded).
  const attention = await db
    .select({
      v: homeVisits,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(homeVisits)
    .innerJoin(homeCareEpisodes, eq(homeCareEpisodes.id, homeVisits.episodeId))
    .innerJoin(patients, eq(patients.id, homeVisits.patientId))
    .where(
      and(
        eq(homeCareEpisodes.teamUnitId, team.id),
        eq(homeVisits.status, 'PLANNED'),
        lt(homeVisits.scheduledFor, new Date(now.getTime() - 2 * 3_600_000)),
        gte(homeVisits.scheduledFor, new Date(now.getTime() - 14 * 86_400_000)),
      ),
    )
    .orderBy(asc(homeVisits.scheduledFor));
  const referrals = await db
    .select({
      e: homeCareEpisodes,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(homeCareEpisodes)
    .innerJoin(patients, eq(patients.id, homeCareEpisodes.patientId))
    .where(and(eq(homeCareEpisodes.teamUnitId, team.id), ne(homeCareEpisodes.status, 'DISCHARGED')))
    .orderBy(asc(homeCareEpisodes.createdAt));
  const names = await namesFor([
    ...dayVisits.flatMap((r) => [r.v.assignedToId, r.v.recordedById]),
    ...attention.map((r) => r.v.assignedToId),
    ...referrals.map((r) => r.e.referredById),
  ]);
  const members = await teamMembers(team.id);
  const visit = (r: (typeof dayVisits)[number]) => ({
    ...presentVisit(r.v, names, now),
    patientName: `${r.firstName} ${r.lastName}`,
    phone: r.phone,
    address: r.address,
    accessNotes: r.accessNotes,
  });
  const byNurse = [...members, { id: null as string | null, name: null, role: null }].map((m) => ({
    nurseId: m.id,
    nurse: m.name,
    visits: dayVisits.filter((r) => r.v.assignedToId === m.id).map(visit),
  }));
  res.json({
    teams: mine.map((t) => ({ id: t.id, name: t.name })),
    team: { id: team.id, name: (await loadTeam(team.id)).name },
    date,
    members,
    byNurse: byNurse.filter((g) => g.nurseId !== null || g.visits.length > 0),
    attention: attention.map((r) => ({
      ...presentVisit(r.v, names, now),
      patientName: `${r.firstName} ${r.lastName}`,
    })),
    episodes: referrals.map((r) => ({
      id: r.e.id,
      patientId: r.e.patientId,
      patientName: `${r.firstName} ${r.lastName}`,
      status: r.e.status,
      reason: r.e.reason,
      tasks: parseCarePlan(r.e.carePlan).tasks,
      referredBy: names.get(r.e.referredById) ?? null,
      createdAt: r.e.createdAt,
      startedAt: r.e.startedAt,
    })),
  });
});

/* ------------------------------------------------------------------ director -------------- */

/**
 * Team activity without names: visits per week by status (the last 8 weeks and the next week's
 * planned visits), active episodes and the average length of episodes ended in the last 12 months.
 */
homeCareRouter.get('/stats', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const teams = await db
    .select({ id: careUnits.id, name: careUnits.name })
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, ctx.facilityId),
        sql`${careUnits.type}::text = 'COMMUNITY_NURSING'`,
      ),
    )
    .orderBy(careUnits.name);
  const ids = teams.map((t) => t.id);
  if (!ids.length) {
    res.json({ teams: [], weeks: [] });
    return;
  }
  const weekly = await db.execute<{
    team_id: string;
    week: string;
    planned: number;
    done: number;
    missed: number;
    cancelled: number;
  }>(sql`
    SELECT e.team_unit_id AS team_id,
           to_char(date_trunc('week', v.scheduled_for AT TIME ZONE 'Europe/Belgrade'), 'YYYY-MM-DD') AS week,
           count(*)::int AS planned,
           count(*) FILTER (WHERE v.status = 'DONE')::int AS done,
           count(*) FILTER (WHERE v.status = 'MISSED')::int AS missed,
           count(*) FILTER (WHERE v.status = 'CANCELLED')::int AS cancelled
    FROM home_visits v JOIN home_care_episodes e ON e.id = v.episode_id
    WHERE e.team_unit_id IN (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})
      AND v.scheduled_for >= date_trunc('week', now()) - interval '7 weeks'
      AND v.scheduled_for < date_trunc('week', now()) + interval '2 weeks'
    GROUP BY 1, 2 ORDER BY 2`);
  const episodes = await db.execute<{
    team_id: string;
    referred: number;
    active: number;
    on_hold: number;
    discharged_12m: number;
    avg_days: string | null;
  }>(sql`
    SELECT team_unit_id AS team_id,
           count(*) FILTER (WHERE status = 'REFERRED')::int AS referred,
           count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
           count(*) FILTER (WHERE status = 'ON_HOLD')::int AS on_hold,
           count(*) FILTER (WHERE status = 'DISCHARGED' AND ended_at > now() - interval '12 months')::int AS discharged_12m,
           round(avg(EXTRACT(EPOCH FROM ended_at - started_at) / 86400)
                 FILTER (WHERE status = 'DISCHARGED' AND started_at IS NOT NULL
                         AND ended_at > now() - interval '12 months'), 1)::text AS avg_days
    FROM home_care_episodes
    WHERE team_unit_id IN (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})
    GROUP BY 1`);
  res.json({
    teams: teams.map((t) => {
      const e = episodes.rows.find((r) => r.team_id === t.id);
      return {
        id: t.id,
        name: t.name,
        referred: e?.referred ?? 0,
        active: e?.active ?? 0,
        onHold: e?.on_hold ?? 0,
        dischargedLast12Months: e?.discharged_12m ?? 0,
        averageEpisodeDays: e?.avg_days ? Number(e.avg_days) : null,
        weeks: weekly.rows
          .filter((w) => w.team_id === t.id)
          .map((w) => ({
            week: w.week,
            planned: w.planned,
            done: w.done,
            missed: w.missed,
            cancelled: w.cancelled,
          })),
      };
    }),
  });
});

/* ------------------------------------------------------------------ portal ---------------- */

/**
 * The patient's home care: the team, upcoming visits (with the nurse's name, so they know who
 * comes) and the care plan goals. Guardians with appointments-only access see the visit times only.
 */
homeCareRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  const limited = Boolean(ctx.proxy && ctx.proxy.scope !== 'FULL');
  if (!limited) await resolveClinicalReadAccess(ctx, ctx.patientId, requestMeta(req));
  if (ctx.proxy) {
    await auditRecordView(ctx, ctx.patientId, 'GUARDIAN', 'home-care', requestMeta(req));
  }
  const now = new Date();
  const items = await episodesWithVisits(eq(homeCareEpisodes.patientId, ctx.patientId), 200);
  res.json({
    limited,
    items: items
      .filter(
        (e) =>
          e.status !== 'DISCHARGED' ||
          (e.endedAt && e.endedAt > new Date(now.getTime() - 90 * 86_400_000)),
      )
      .map((e) => ({
        id: e.id,
        teamName: e.teamName,
        teamFacilityName: e.teamFacilityName,
        status: e.status,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        visitAddress: e.visitAddress,
        carePlan: limited ? null : e.carePlan,
        upcoming: e.visits
          .filter(
            (v) =>
              v.status === 'PLANNED' && v.scheduledFor >= new Date(now.getTime() - 2 * 3_600_000),
          )
          .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
          .slice(0, 20)
          .map((v) => ({
            id: v.id,
            scheduledFor: v.scheduledFor,
            nurse: v.assignedTo,
            tasks: limited ? [] : v.tasks,
          })),
        recent: limited
          ? []
          : e.visits
              .filter((v) => v.status === 'DONE' || v.status === 'MISSED')
              .slice(0, 10)
              .map((v) => ({
                id: v.id,
                date: v.startedAt ?? v.scheduledFor,
                status: v.status,
                nurse: v.assignedTo,
              })),
      })),
  });
});
