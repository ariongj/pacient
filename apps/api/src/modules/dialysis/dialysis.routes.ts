import { Router } from 'express';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  careUnits,
  dialysisSchedules,
  dialysisSessions,
  facilities,
  patients,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertNotMerged,
  getPatientOrThrow,
  resolveAndAuditRead,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { assertLicensed } from '../licences/licences.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  addDays,
  adequacyOf,
  assertCapacity,
  assertSameFacility,
  clearFuturePlanned,
  COMPLICATIONS,
  DAYS,
  END_REASONS,
  interdialyticGain,
  isUnitStaff,
  kosovoDate,
  loadDialysisUnit,
  planSessions,
  previousPostWeight,
  previousPostWeights,
  sessionWarnings,
  SHIFTS,
  stationsOf,
  TARGET_KTV,
  TARGET_URR,
  VASCULAR_ACCESS,
  type ScheduleRow,
  type SessionRow,
} from './dialysis.service.js';

/**
 * Dialysis (see dialysis.service.ts): schedules and sessions of DIALYSIS units, adequacy (URR and
 * Kt/V), the unit board for its staff, the patient's chart section and aggregate statistics for
 * directors and the Ministry.
 */
export const dialysisRouter = Router();
dialysisRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const UnitParam = z.object({ unitId: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Weight = z.coerce.number().min(20).max(250);
const Systolic = z.coerce.number().int().min(50).max(260);
const Diastolic = z.coerce.number().int().min(20).max(160);
const Urea = z.coerce.number().min(0.5).max(80);

const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/* ------------------------------------------------------------------------ helpers ---- */

async function loadSession(id: string) {
  const [row] = await db
    .select({ session: dialysisSessions, schedule: dialysisSchedules })
    .from(dialysisSessions)
    .leftJoin(dialysisSchedules, eq(dialysisSchedules.id, dialysisSessions.scheduleId))
    .where(eq(dialysisSessions.id, id));
  if (!row) throw notFound('Dialysis session not found');
  return row;
}

async function loadSchedule(id: string) {
  const [row] = await db.select().from(dialysisSchedules).where(eq(dialysisSchedules.id, id));
  if (!row) throw notFound('Dialysis schedule not found');
  return row;
}

/** Board and patient lists: staff of the unit only (they see names). */
async function assertUnitStaff(ctx: AuthContext, unitId: string) {
  const unit = await loadDialysisUnit(unitId);
  assertSameFacility(ctx, unit);
  if (!(await isUnitStaff(ctx.userId, unitId))) {
    throw forbidden('Only the staff of this dialysis unit can see its patients');
  }
  return unit;
}

/**
 * Starting or changing a schedule: a doctor of the unit, or a doctor with write access to the
 * patient (care team) referring to a dialysis unit of their own facility.
 */
async function assertCanSchedule(
  ctx: AuthContext,
  patientId: string,
  unitId: string,
  meta: ReturnType<typeof requestMeta>,
  opts: { allowDeceased?: boolean } = {},
) {
  const unit = await loadDialysisUnit(unitId);
  assertSameFacility(ctx, unit);
  if (await isUnitStaff(ctx.userId, unitId)) {
    const patient = await getPatientOrThrow(patientId);
    assertNotMerged(patient);
    await assertLicensed(ctx, meta);
  } else {
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.doctorOnly);
  }
  const patient = await getPatientOrThrow(patientId);
  if (patient.deceasedAt && !opts.allowDeceased) {
    throw conflict('The patient is recorded as deceased');
  }
  return unit;
}

/** Recording a session: doctor or nurse with access (unit staff have it while scheduled). */
async function assertCanRecord(
  ctx: AuthContext,
  session: SessionRow,
  meta: ReturnType<typeof requestMeta>,
) {
  const unit = await loadDialysisUnit(session.unitId);
  assertSameFacility(ctx, unit);
  await assertClinicalWriteAccess(ctx, session.patientId, meta, WRITERS.careTeam);
  return unit;
}

async function auditSession(
  ctx: AuthContext,
  session: SessionRow,
  meta: ReturnType<typeof requestMeta>,
  step: string,
) {
  await audit({
    action: AuditAction.DIALYSIS_SESSION_RECORDED,
    actor: ctx,
    resourceType: 'dialysis_session',
    resourceId: session.id,
    patientId: session.patientId,
    meta,
    metadata: { step, sessionDate: session.sessionDate },
  });
}

async function auditSchedule(
  ctx: AuthContext,
  schedule: ScheduleRow,
  meta: ReturnType<typeof requestMeta>,
  change: string,
) {
  await audit({
    action: AuditAction.DIALYSIS_SCHEDULE_CHANGED,
    actor: ctx,
    resourceType: 'dialysis_schedule',
    resourceId: schedule.id,
    patientId: schedule.patientId,
    meta,
    metadata: { change, unitId: schedule.unitId, days: schedule.days, shift: schedule.shift },
  });
}

function presentSchedule(s: ScheduleRow, unitName?: string | null) {
  return {
    id: s.id,
    patientId: s.patientId,
    unitId: s.unitId,
    unitName: unitName ?? null,
    days: s.days,
    shift: s.shift,
    durationMinutes: s.durationMinutes,
    targetWeightKg: num(s.targetWeightKg),
    vascularAccess: s.vascularAccess,
    status: s.status,
    startedOn: s.startedOn,
    endedOn: s.endedOn,
    endReason: s.endReason,
  };
}

function presentSession(
  s: SessionRow,
  context: { schedule: ScheduleRow | null; previousPostWeightKg: number | null },
) {
  const target = num(context.schedule?.targetWeightKg ?? null);
  const adequacy = adequacyOf(s, context.schedule?.durationMinutes ?? null);
  const gain = interdialyticGain(num(s.preWeightKg), context.previousPostWeightKg, target);
  return {
    id: s.id,
    patientId: s.patientId,
    unitId: s.unitId,
    scheduleId: s.scheduleId,
    sessionDate: s.sessionDate,
    shift: context.schedule?.shift ?? null,
    status: s.status,
    machine: s.machine,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    preWeightKg: num(s.preWeightKg),
    postWeightKg: num(s.postWeightKg),
    preSystolic: s.preSystolic,
    preDiastolic: s.preDiastolic,
    postSystolic: s.postSystolic,
    postDiastolic: s.postDiastolic,
    ultrafiltrationMl: s.ultrafiltrationMl,
    bloodFlowMlMin: s.bloodFlowMlMin,
    preUrea: num(s.preUrea),
    postUrea: num(s.postUrea),
    complications: s.complications,
    notes: s.notes,
    missedReason: s.missedReason,
    targetWeightKg: target,
    interdialyticGainKg: gain?.gainKg ?? null,
    interdialyticGainPercent: gain?.percent ?? null,
    adequacy,
    warnings: sessionWarnings(s, {
      previousPostWeightKg: context.previousPostWeightKg,
      targetWeightKg: target,
      adequacy,
    }),
  };
}

/* -------------------------------------------------------------------------- units ---- */

/** Dialysis units of my facility: stations, active patients, shift load per weekday. */
dialysisRouter.get('/units', requireRole('DOCTOR', 'NURSE', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const units = await db
    .select()
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, ctx.facilityId),
        sql`${careUnits.type}::text = 'DIALYSIS'`,
        eq(careUnits.isActive, true),
      ),
    )
    .orderBy(asc(careUnits.name));
  const ids = units.map((u) => u.id);
  const schedules = ids.length
    ? await db
        .select({
          unitId: dialysisSchedules.unitId,
          days: dialysisSchedules.days,
          shift: dialysisSchedules.shift,
        })
        .from(dialysisSchedules)
        .where(and(inArray(dialysisSchedules.unitId, ids), eq(dialysisSchedules.status, 'ACTIVE')))
    : [];
  const items = [];
  for (const u of units) {
    const mine = schedules.filter((s) => s.unitId === u.id);
    const load: Record<string, Record<string, number>> = {};
    for (const shift of SHIFTS) {
      load[shift] = Object.fromEntries(
        DAYS.map((d) => [d, mine.filter((s) => s.shift === shift && s.days.includes(d)).length]),
      );
    }
    items.push({
      id: u.id,
      name: u.name,
      code: u.code,
      stations: await stationsOf(u.id),
      activePatients: mine.length,
      isStaff: ctx.role === 'DIRECTOR' ? false : await isUnitStaff(ctx.userId, u.id),
      load,
    });
  }
  res.json({ items, shifts: SHIFTS, days: DAYS });
});

/** Today's (or a given day's) sessions of a unit, grouped by shift. Unit staff only. */
dialysisRouter.get('/units/:unitId/board', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { unitId } = parse(UnitParam, req.params);
  const { date } = parse(z.object({ date: DateString.optional() }), req.query);
  const unit = await assertUnitStaff(ctx, unitId);
  const day = date ?? kosovoDate(new Date());
  const rows = await db
    .select({
      session: dialysisSessions,
      schedule: dialysisSchedules,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nationalId: patients.nationalId,
        dateOfBirth: patients.dateOfBirth,
      },
    })
    .from(dialysisSessions)
    .innerJoin(patients, eq(patients.id, dialysisSessions.patientId))
    .leftJoin(dialysisSchedules, eq(dialysisSchedules.id, dialysisSessions.scheduleId))
    .where(and(eq(dialysisSessions.unitId, unitId), eq(dialysisSessions.sessionDate, day)))
    .orderBy(asc(patients.lastName), asc(patients.firstName));
  const prev = await previousPostWeights(
    rows.map((r) => ({ patientId: r.session.patientId, sessionDate: r.session.sessionDate })),
  );
  const stations = await stationsOf(unitId);
  const shifts = SHIFTS.map((shift) => {
    const items = rows
      .filter((r) => (r.schedule?.shift ?? 'MORNING') === shift)
      .map((r) => ({
        ...presentSession(r.session, {
          schedule: r.schedule,
          previousPostWeightKg: prev.get(`${r.session.patientId}:${r.session.sessionDate}`) ?? null,
        }),
        patient: r.patient,
        vascularAccess: r.schedule?.vascularAccess ?? null,
      }));
    return { shift, stations, items };
  });
  res.json({ unit: { id: unit.id, name: unit.name }, date: day, shifts });
});

/** Patients of a unit with adequacy and attendance. Unit staff only. */
dialysisRouter.get('/units/:unitId/patients', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { unitId } = parse(UnitParam, req.params);
  await assertUnitStaff(ctx, unitId);
  const schedules = await db
    .select({
      schedule: dialysisSchedules,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nationalId: patients.nationalId,
      },
    })
    .from(dialysisSchedules)
    .innerJoin(patients, eq(patients.id, dialysisSchedules.patientId))
    .where(and(eq(dialysisSchedules.unitId, unitId), eq(dialysisSchedules.status, 'ACTIVE')))
    .orderBy(asc(patients.lastName));
  const ids = schedules.map((s) => s.patient.id);
  const since = addDays(kosovoDate(new Date()), -30);
  const today = kosovoDate(new Date());
  const sessions = ids.length
    ? await db
        .select()
        .from(dialysisSessions)
        .where(
          and(
            inArray(dialysisSessions.patientId, ids),
            gte(dialysisSessions.sessionDate, addDays(today, -120)),
          ),
        )
        .orderBy(desc(dialysisSessions.sessionDate))
    : [];
  res.json({
    items: schedules.map(({ schedule, patient }) => {
      const mine = sessions.filter((s) => s.patientId === patient.id);
      const recent = mine.filter((s) => s.sessionDate >= since && s.sessionDate <= today);
      const lastMeasured = mine.find(
        (s) => s.status === 'COMPLETED' && s.preUrea !== null && s.postUrea !== null,
      );
      const lastCompleted = mine.find((s) => s.status === 'COMPLETED');
      return {
        patient,
        schedule: presentSchedule(schedule),
        lastSessionDate: lastCompleted?.sessionDate ?? null,
        completed30: recent.filter((s) => s.status === 'COMPLETED').length,
        missed30: recent.filter((s) => s.status === 'MISSED').length,
        lastAdequacy: lastMeasured
          ? {
              sessionDate: lastMeasured.sessionDate,
              ...adequacyOf(lastMeasured, schedule.durationMinutes),
            }
          : null,
      };
    }),
    targets: { ktv: TARGET_KTV, urr: TARGET_URR },
  });
});

/* ------------------------------------------------------------------- patient chart ---- */

dialysisRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'dialysis');
  const patient = await getPatientOrThrow(patientId);
  const schedules = await db
    .select({ schedule: dialysisSchedules, unitName: careUnits.name })
    .from(dialysisSchedules)
    .innerJoin(careUnits, eq(careUnits.id, dialysisSchedules.unitId))
    .where(eq(dialysisSchedules.patientId, patientId))
    .orderBy(desc(dialysisSchedules.createdAt));
  const sessions = await db
    .select()
    .from(dialysisSessions)
    .where(eq(dialysisSessions.patientId, patientId))
    .orderBy(desc(dialysisSessions.sessionDate))
    .limit(90);
  const scheduleById = new Map(schedules.map((s) => [s.schedule.id, s.schedule]));
  const ordered = [...sessions].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  let lastPost: number | null = null;
  const presented = new Map<string, ReturnType<typeof presentSession>>();
  for (const s of ordered) {
    presented.set(
      s.id,
      presentSession(s, {
        schedule: s.scheduleId ? (scheduleById.get(s.scheduleId) ?? null) : null,
        previousPostWeightKg: lastPost,
      }),
    );
    if (s.status === 'COMPLETED' && s.postWeightKg !== null) lastPost = Number(s.postWeightKg);
  }
  // Monthly adequacy: the last measured session of each month.
  const monthly = new Map<string, ReturnType<typeof adequacyOf> & { sessionDate: string }>();
  for (const s of ordered) {
    const a = presented.get(s.id)!.adequacy;
    if (a.urr === null) continue;
    monthly.set(s.sessionDate.slice(0, 7), { sessionDate: s.sessionDate, ...a });
  }
  const units = ctx.facilityId
    ? await db
        .select({ id: careUnits.id, name: careUnits.name })
        .from(careUnits)
        .where(
          and(
            eq(careUnits.facilityId, ctx.facilityId),
            sql`${careUnits.type}::text = 'DIALYSIS'`,
            eq(careUnits.isActive, true),
          ),
        )
    : [];
  res.json({
    schedules: schedules.map((s) => presentSchedule(s.schedule, s.unitName)),
    sessions: sessions.map((s) => presented.get(s.id)!),
    monthlyAdequacy: [...monthly.entries()].map(([month, a]) => ({ month, ...a })),
    targets: { ktv: TARGET_KTV, urr: TARGET_URR },
    canSchedule:
      ctx.role === 'DOCTOR' &&
      !patient.deceasedAt &&
      !schedules.some((s) => s.schedule.status === 'ACTIVE'),
    units,
  });
});

/* ----------------------------------------------------------------------- schedules ---- */

const ScheduleInput = z.object({
  unitId: z.string().uuid(),
  days: z
    .array(z.enum(DAYS))
    .min(1)
    .max(7)
    .refine((d) => new Set(d).size === d.length, 'Each day once'),
  shift: z.enum(SHIFTS),
  durationMinutes: z.coerce.number().int().min(60).max(600).default(240),
  targetWeightKg: Weight.optional().nullable(),
  vascularAccess: z.enum(VASCULAR_ACCESS),
  startedOn: DateString.optional(),
});

dialysisRouter.post('/patients/:patientId/schedules', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const meta = requestMeta(req);
  const input = parse(ScheduleInput, req.body);
  await assertCanSchedule(ctx, patientId, input.unitId, meta);
  const today = kosovoDate(new Date());
  const startedOn = input.startedOn ?? today;
  if (startedOn < addDays(today, -7)) throw badRequest('The start date is too far in the past');
  const created = await db.transaction(async (tx) => {
    // Serialise schedule changes per unit so two doctors cannot fill the last station together.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'dialysis:' + input.unitId}))`);
    const [existing] = await tx
      .select({ id: dialysisSchedules.id })
      .from(dialysisSchedules)
      .where(
        and(eq(dialysisSchedules.patientId, patientId), eq(dialysisSchedules.status, 'ACTIVE')),
      );
    if (existing) throw conflict('The patient already has an active dialysis schedule');
    await assertCapacity({ unitId: input.unitId, shift: input.shift, days: input.days }, tx);
    const [row] = await tx
      .insert(dialysisSchedules)
      .values({
        patientId,
        unitId: input.unitId,
        days: [...input.days].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)),
        shift: input.shift,
        durationMinutes: input.durationMinutes,
        targetWeightKg: input.targetWeightKg?.toString() ?? null,
        vascularAccess: input.vascularAccess,
        startedOn,
        createdById: ctx.userId,
      })
      .returning();
    await planSessions({ scheduleId: row!.id, today }, tx);
    return row!;
  });
  await auditSchedule(ctx, created, meta, 'started');
  res.status(201).json(presentSchedule(created));
});

const ScheduleUpdate = ScheduleInput.omit({ unitId: true, startedOn: true }).partial();

dialysisRouter.patch('/schedules/:id', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(ScheduleUpdate, req.body);
  const current = await loadSchedule(id);
  if (current.status !== 'ACTIVE') throw conflict('The schedule has ended');
  await assertCanSchedule(ctx, current.patientId, current.unitId, meta);
  const today = kosovoDate(new Date());
  const updated = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'dialysis:' + current.unitId}))`);
    const days = input.days
      ? [...input.days].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b))
      : current.days;
    const shift = input.shift ?? current.shift;
    if (input.days || input.shift) {
      await assertCapacity({ unitId: current.unitId, shift, days, excludeScheduleId: id }, tx);
    }
    const [row] = await tx
      .update(dialysisSchedules)
      .set({
        days,
        shift,
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.targetWeightKg !== undefined
          ? { targetWeightKg: input.targetWeightKg?.toString() ?? null }
          : {}),
        ...(input.vascularAccess ? { vascularAccess: input.vascularAccess } : {}),
      })
      .where(eq(dialysisSchedules.id, id))
      .returning();
    if (input.days || input.shift) {
      // Planned (not started) sessions follow the new days; today's sessions stay.
      await clearFuturePlanned(id, addDays(today, 1), 'delete', tx);
      await planSessions({ scheduleId: id, today }, tx);
    }
    return row!;
  });
  await auditSchedule(ctx, updated, meta, 'changed');
  res.json(presentSchedule(updated));
});

dialysisRouter.post('/schedules/:id/end', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const { reason, note } = parse(
    z.object({
      reason: z.enum(END_REASONS),
      note: z.string().trim().max(250).optional().nullable(),
    }),
    req.body,
  );
  if (reason === 'OTHER' && !note) throw badRequest('Describe the reason');
  const current = await loadSchedule(id);
  if (current.status !== 'ACTIVE') throw conflict('The schedule has already ended');
  // A deceased patient's schedule can still be ended.
  await assertCanSchedule(ctx, current.patientId, current.unitId, meta, { allowDeceased: true });
  const today = kosovoDate(new Date());
  const ended = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(dialysisSchedules)
      .set({
        status: 'ENDED',
        endedOn: today,
        endReason: note ? `${reason}: ${note}` : reason,
      })
      .where(and(eq(dialysisSchedules.id, id), eq(dialysisSchedules.status, 'ACTIVE')))
      .returning();
    if (!row) throw conflict('The schedule has already ended');
    await clearFuturePlanned(id, today, 'cancel', tx);
    return row;
  });
  await auditSchedule(ctx, ended, meta, `ended:${reason}`);
  res.json(presentSchedule(ended));
});

/* ------------------------------------------------------------------------ sessions ---- */

const StartInput = z.object({
  machine: z.string().trim().min(1).max(40),
  preWeightKg: Weight,
  preSystolic: Systolic,
  preDiastolic: Diastolic,
  startedAt: z.coerce.date().optional(),
});

dialysisRouter.post('/sessions/:id/start', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(StartInput, req.body);
  const { session, schedule } = await loadSession(id);
  await assertCanRecord(ctx, session, meta);
  if (session.status !== 'PLANNED') throw conflict('Only a planned session can be started');
  const today = kosovoDate(new Date());
  if (session.sessionDate > today) throw conflict('A future session cannot be started');
  if (input.preSystolic <= input.preDiastolic) {
    throw badRequest('Systolic pressure must be higher than diastolic');
  }
  const startedAt = input.startedAt ?? new Date();
  if (startedAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('The start is in the future');
  const [row] = await db
    .update(dialysisSessions)
    .set({
      status: 'IN_PROGRESS',
      machine: input.machine,
      preWeightKg: input.preWeightKg.toString(),
      preSystolic: input.preSystolic,
      preDiastolic: input.preDiastolic,
      startedAt,
      nurseId: ctx.userId,
    })
    .where(and(eq(dialysisSessions.id, id), eq(dialysisSessions.status, 'PLANNED')))
    .returning();
  if (!row) throw conflict('Only a planned session can be started');
  await auditSession(ctx, row, meta, 'started');
  res.json(
    presentSession(row, {
      schedule,
      previousPostWeightKg: await previousPostWeight(row.patientId, row.sessionDate),
    }),
  );
});

const EndInput = z
  .object({
    postWeightKg: Weight,
    postSystolic: Systolic,
    postDiastolic: Diastolic,
    ultrafiltrationMl: z.coerce.number().int().min(0).max(8000),
    bloodFlowMlMin: z.coerce.number().int().min(100).max(600).optional().nullable(),
    preUrea: Urea.optional().nullable(),
    postUrea: Urea.optional().nullable(),
    complications: z.array(z.enum(COMPLICATIONS)).max(COMPLICATIONS.length).default([]),
    notes: z.string().trim().max(2000).optional().nullable(),
    endedAt: z.coerce.date().optional(),
  })
  .refine((v) => (v.preUrea == null) === (v.postUrea == null), {
    message: 'Give both urea values or neither',
    path: ['postUrea'],
  })
  .refine((v) => v.preUrea == null || v.postUrea! < v.preUrea, {
    message: 'Post-dialysis urea must be lower than pre-dialysis urea',
    path: ['postUrea'],
  })
  .refine((v) => !v.complications.includes('OTHER') || Boolean(v.notes), {
    message: 'Describe the other complication in the notes',
    path: ['notes'],
  });

dialysisRouter.post('/sessions/:id/end', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(EndInput, req.body);
  const { session, schedule } = await loadSession(id);
  await assertCanRecord(ctx, session, meta);
  if (session.status !== 'IN_PROGRESS') throw conflict('Only a session in progress can be ended');
  if (input.postSystolic <= input.postDiastolic) {
    throw badRequest('Systolic pressure must be higher than diastolic');
  }
  const endedAt = input.endedAt ?? new Date();
  if (session.startedAt && endedAt < session.startedAt) {
    throw badRequest('The end is before the start');
  }
  const [row] = await db
    .update(dialysisSessions)
    .set({
      status: 'COMPLETED',
      postWeightKg: input.postWeightKg.toString(),
      postSystolic: input.postSystolic,
      postDiastolic: input.postDiastolic,
      ultrafiltrationMl: input.ultrafiltrationMl,
      bloodFlowMlMin: input.bloodFlowMlMin ?? null,
      preUrea: input.preUrea?.toString() ?? null,
      postUrea: input.postUrea?.toString() ?? null,
      complications: input.complications,
      notes: input.notes ?? null,
      endedAt,
    })
    .where(and(eq(dialysisSessions.id, id), eq(dialysisSessions.status, 'IN_PROGRESS')))
    .returning();
  if (!row) throw conflict('Only a session in progress can be ended');
  await auditSession(ctx, row, meta, 'completed');
  res.json(
    presentSession(row, {
      schedule,
      previousPostWeightKg: await previousPostWeight(row.patientId, row.sessionDate),
    }),
  );
});

/** Urea results often arrive after the session (laboratory): added to a completed session. */
dialysisRouter.patch('/sessions/:id/urea', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(
    z.object({ preUrea: Urea, postUrea: Urea }).refine((v) => v.postUrea < v.preUrea, {
      message: 'Post-dialysis urea must be lower than pre-dialysis urea',
      path: ['postUrea'],
    }),
    req.body,
  );
  const { session, schedule } = await loadSession(id);
  await assertCanRecord(ctx, session, meta);
  if (session.status !== 'COMPLETED') throw conflict('Urea values belong to a completed session');
  const [row] = await db
    .update(dialysisSessions)
    .set({ preUrea: input.preUrea.toString(), postUrea: input.postUrea.toString() })
    .where(eq(dialysisSessions.id, id))
    .returning();
  await auditSession(ctx, row!, meta, 'urea');
  res.json(
    presentSession(row!, {
      schedule,
      previousPostWeightKg: await previousPostWeight(row!.patientId, row!.sessionDate),
    }),
  );
});

dialysisRouter.post('/sessions/:id/missed', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  const { session, schedule } = await loadSession(id);
  await assertCanRecord(ctx, session, meta);
  if (session.status !== 'PLANNED') throw conflict('Only a planned session can be marked missed');
  if (session.sessionDate > kosovoDate(new Date())) {
    throw conflict('A future session cannot be marked missed');
  }
  const [row] = await db
    .update(dialysisSessions)
    .set({ status: 'MISSED', missedReason: reason, nurseId: ctx.userId })
    .where(and(eq(dialysisSessions.id, id), eq(dialysisSessions.status, 'PLANNED')))
    .returning();
  if (!row) throw conflict('Only a planned session can be marked missed');
  await auditSession(ctx, row, meta, 'missed');
  res.json(presentSession(row, { schedule, previousPostWeightKg: null }));
});

/* ---------------------------------------------------------------------- statistics ---- */

interface FacilityStats {
  facilityId: string;
  facilityName: string;
  patientsOnDialysis: number | null;
  sessionsByMonth: { month: string; completed: number | null; missed: number | null }[];
  completed90: number | null;
  measuredPercent: number | null;
  meetingTargetPercent: number | null;
  missedPercent: number | null;
}

/**
 * Directors: their facility's units (exact counts). Ministry: every facility with dialysis,
 * counts of 1–4 hidden and percentages only from at least SMALL_CELL_THRESHOLD sessions.
 */
dialysisRouter.get('/stats', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const national = ctx.role === 'MINISTRY';
  if (!national && !ctx.facilityId) throw forbidden();
  const unitRows = await db
    .select({ id: careUnits.id, facilityId: careUnits.facilityId, facilityName: facilities.name })
    .from(careUnits)
    .innerJoin(facilities, eq(facilities.id, careUnits.facilityId))
    .where(
      and(
        sql`${careUnits.type}::text = 'DIALYSIS'`,
        national ? undefined : eq(careUnits.facilityId, ctx.facilityId!),
      ),
    );
  const unitIds = unitRows.map((u) => u.id);
  const today = kosovoDate(new Date());
  const from = addDays(today.slice(0, 7) + '-01', 0);
  const sixMonthsAgo = (() => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 5);
    return d.toISOString().slice(0, 10);
  })();
  const active = unitIds.length
    ? await db
        .select({ unitId: dialysisSchedules.unitId, n: count() })
        .from(dialysisSchedules)
        .where(
          and(inArray(dialysisSchedules.unitId, unitIds), eq(dialysisSchedules.status, 'ACTIVE')),
        )
        .groupBy(dialysisSchedules.unitId)
    : [];
  const sessions = unitIds.length
    ? await db
        .select({ session: dialysisSessions, duration: dialysisSchedules.durationMinutes })
        .from(dialysisSessions)
        .leftJoin(dialysisSchedules, eq(dialysisSchedules.id, dialysisSessions.scheduleId))
        .where(
          and(
            inArray(dialysisSessions.unitId, unitIds),
            gte(dialysisSessions.sessionDate, sixMonthsAgo),
            sql`${dialysisSessions.sessionDate} <= ${today}`,
          ),
        )
    : [];
  const hide = (n: number) => (national && n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);
  const pct = (part: number, whole: number) =>
    whole === 0 || (national && whole < SMALL_CELL_THRESHOLD)
      ? null
      : Math.round((part / whole) * 1000) / 10;
  const facilityIds = [...new Set(unitRows.map((u) => u.facilityId))];
  const since90 = addDays(today, -90);
  const items: FacilityStats[] = facilityIds.map((fid) => {
    const units = unitRows.filter((u) => u.facilityId === fid).map((u) => u.id);
    const mine = sessions.filter((s) => units.includes(s.session.unitId));
    const months = new Map<string, { completed: number; missed: number }>();
    for (const s of mine) {
      const m = s.session.sessionDate.slice(0, 7);
      const e = months.get(m) ?? { completed: 0, missed: 0 };
      if (s.session.status === 'COMPLETED') e.completed++;
      if (s.session.status === 'MISSED') e.missed++;
      months.set(m, e);
    }
    const recent = mine.filter((s) => s.session.sessionDate >= since90);
    const completed = recent.filter((s) => s.session.status === 'COMPLETED');
    const missed = recent.filter((s) => s.session.status === 'MISSED').length;
    const measured = completed
      .map((s) => adequacyOf(s.session, s.duration))
      .filter((a) => a.urr !== null);
    return {
      facilityId: fid,
      facilityName: unitRows.find((u) => u.facilityId === fid)!.facilityName,
      patientsOnDialysis: hide(
        active.filter((a) => units.includes(a.unitId)).reduce((x, a) => x + Number(a.n), 0),
      ),
      sessionsByMonth: [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, completed: hide(v.completed), missed: hide(v.missed) })),
      completed90: hide(completed.length),
      measuredPercent: pct(measured.length, completed.length),
      meetingTargetPercent: pct(measured.filter((a) => a.meetsTarget).length, measured.length),
      missedPercent: pct(missed, completed.length + missed),
    };
  });
  res.json({
    scope: national ? 'NATIONAL' : 'FACILITY',
    items,
    targets: { ktv: TARGET_KTV, urr: TARGET_URR },
    smallCellThreshold: national ? SMALL_CELL_THRESHOLD : null,
  });
});
