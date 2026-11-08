import { and, count, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  beds,
  careUnits,
  dialysisSchedules,
  dialysisSessions,
  unitStaff,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';

/**
 * Haemodialysis.
 *
 * A DIALYSIS care unit runs regular schedules (days, shift, duration, target weight, vascular
 * access). Its staff get record access to patients with an active schedule (unitAccessVia).
 *
 * Capacity: a unit's stations are its beds (one bed record per dialysis station/chair), so a shift
 * on a given weekday can take as many patients as the unit has beds. There is no per-session
 * station assignment in the schema; the machine/station label is recorded with the session.
 *
 * The thresholds below are illustrative and must be confirmed by the renal service:
 * - interdialytic weight gain above 4% of target (dry) weight is flagged;
 * - adequacy targets: single-pool Kt/V ≥ 1.2 or URR ≥ 65%;
 * - pre-dialysis blood pressure: systolic ≥ 180 or < 100, diastolic ≥ 110 are flagged; post-dialysis
 *   systolic < 90 is flagged.
 */

export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Day = (typeof DAYS)[number];
export const SHIFTS = ['MORNING', 'AFTERNOON', 'EVENING'] as const;
export const VASCULAR_ACCESS = [
  'FISTULA',
  'GRAFT',
  'TUNNELLED_CATHETER',
  'TEMPORARY_CATHETER',
] as const;
export const COMPLICATIONS = [
  'HYPOTENSION',
  'CRAMPS',
  'ACCESS_PROBLEM',
  'CLOTTING',
  'FEVER',
  'CHEST_PAIN',
  'OTHER',
] as const;
export const END_REASONS = [
  'TRANSPLANT',
  'TRANSFERRED',
  'RECOVERED',
  'PERITONEAL_DIALYSIS',
  'CONSERVATIVE_CARE',
  'DECEASED',
  'OTHER',
] as const;

export const IDWG_WARNING_PERCENT = 4;
export const TARGET_KTV = 1.2;
export const TARGET_URR = 65;
/** Sessions are planned this many days ahead. */
export const PLAN_AHEAD_DAYS = 14;

export type ScheduleRow = typeof dialysisSchedules.$inferSelect;
export type SessionRow = typeof dialysisSessions.$inferSelect;

/* ---------------------------------------------------------------------------- dates ---- */

/** Calendar date in Kosovo (YYYY-MM-DD). */
export function kosovoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** MON…SUN for a calendar date. */
export function weekdayOf(date: string): Day {
  const index = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return DAYS[(index + 6) % 7]!;
}

/* ------------------------------------------------------------------------- adequacy ---- */

const num = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? null : Number(v);

/** Urea reduction ratio in percent. */
export function urr(preUrea: number, postUrea: number): number {
  return ((preUrea - postUrea) / preUrea) * 100;
}

/**
 * Single-pool Kt/V by the second-generation Daugirdas formula:
 * spKt/V = −ln(R − 0.008 × t) + (4 − 3.5 × R) × UF / W
 * with R = post/pre urea, t = session length in hours, UF = ultrafiltration in litres, W = post-
 * dialysis weight in kg.
 */
export function daugirdasKtV(input: {
  preUrea: number;
  postUrea: number;
  hours: number;
  ultrafiltrationL: number;
  postWeightKg: number;
}): number {
  const r = input.postUrea / input.preUrea;
  const inner = r - 0.008 * input.hours;
  if (inner <= 0) throw badRequest('The urea values and session length give no valid Kt/V');
  return -Math.log(inner) + ((4 - 3.5 * r) * input.ultrafiltrationL) / input.postWeightKg;
}

export interface Adequacy {
  urr: number | null;
  ktv: number | null;
  meetsTarget: boolean | null;
}

/** URR and Kt/V of a completed session (null when urea values are missing). */
export function adequacyOf(s: SessionRow, plannedMinutes: number | null): Adequacy {
  const pre = num(s.preUrea);
  const post = num(s.postUrea);
  if (!pre || post === null || pre <= 0 || post < 0 || post >= pre) {
    return { urr: null, ktv: null, meetsTarget: null };
  }
  const reduction = urr(pre, post);
  const minutes =
    s.startedAt && s.endedAt
      ? (s.endedAt.getTime() - s.startedAt.getTime()) / 60_000
      : (plannedMinutes ?? null);
  const weight = num(s.postWeightKg);
  let ktv: number | null = null;
  if (minutes && minutes > 0 && weight && weight > 0) {
    try {
      ktv = daugirdasKtV({
        preUrea: pre,
        postUrea: post,
        hours: minutes / 60,
        ultrafiltrationL: (s.ultrafiltrationMl ?? 0) / 1000,
        postWeightKg: weight,
      });
    } catch {
      ktv = null;
    }
  }
  const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    urr: round(reduction, 1),
    ktv: ktv === null ? null : round(ktv, 2),
    meetsTarget: ktv !== null ? ktv >= TARGET_KTV : reduction >= TARGET_URR,
  };
}

/* ------------------------------------------------------------------------ warnings ---- */

export type Warning =
  | { code: 'IDWG_HIGH'; gainKg: number; percent: number }
  | { code: 'PRE_BP_HIGH'; systolic: number | null; diastolic: number | null }
  | { code: 'PRE_BP_LOW'; systolic: number }
  | { code: 'POST_BP_LOW'; systolic: number }
  | { code: 'BELOW_TARGET_WEIGHT'; kg: number }
  | { code: 'ADEQUACY_BELOW_TARGET' };

/** Interdialytic weight gain: pre-dialysis weight minus the previous session's post weight. */
export function interdialyticGain(
  preWeightKg: number | null,
  previousPostWeightKg: number | null,
  targetWeightKg: number | null,
) {
  if (preWeightKg === null || previousPostWeightKg === null) return null;
  const gainKg = Math.round((preWeightKg - previousPostWeightKg) * 10) / 10;
  const reference = targetWeightKg ?? previousPostWeightKg;
  const percent = reference > 0 ? Math.round((gainKg / reference) * 1000) / 10 : 0;
  return { gainKg, percent, warning: percent > IDWG_WARNING_PERCENT };
}

export function sessionWarnings(
  s: SessionRow,
  context: {
    previousPostWeightKg: number | null;
    targetWeightKg: number | null;
    adequacy?: Adequacy;
  },
): Warning[] {
  const out: Warning[] = [];
  const gain = interdialyticGain(
    num(s.preWeightKg),
    context.previousPostWeightKg,
    context.targetWeightKg,
  );
  if (gain?.warning) out.push({ code: 'IDWG_HIGH', gainKg: gain.gainKg, percent: gain.percent });
  if ((s.preSystolic ?? 0) >= 180 || (s.preDiastolic ?? 0) >= 110) {
    out.push({ code: 'PRE_BP_HIGH', systolic: s.preSystolic, diastolic: s.preDiastolic });
  } else if (s.preSystolic !== null && s.preSystolic < 100) {
    out.push({ code: 'PRE_BP_LOW', systolic: s.preSystolic });
  }
  if (s.postSystolic !== null && s.postSystolic < 90) {
    out.push({ code: 'POST_BP_LOW', systolic: s.postSystolic });
  }
  const post = num(s.postWeightKg);
  if (post !== null && context.targetWeightKg !== null && post < context.targetWeightKg - 0.5) {
    out.push({
      code: 'BELOW_TARGET_WEIGHT',
      kg: Math.round((context.targetWeightKg - post) * 10) / 10,
    });
  }
  if (context.adequacy?.meetsTarget === false) out.push({ code: 'ADEQUACY_BELOW_TARGET' });
  return out;
}

/* ---------------------------------------------------------------------------- units ---- */

export async function loadDialysisUnit(unitId: string, executor: Executor = db) {
  const [unit] = await executor
    .select()
    .from(careUnits)
    .where(and(eq(careUnits.id, unitId), sql`${careUnits.type}::text = 'DIALYSIS'`));
  if (!unit || !unit.isActive) throw notFound('Dialysis unit not found');
  return unit;
}

/** Number of stations (beds) of a dialysis unit. */
export async function stationsOf(unitId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor.select({ n: count() }).from(beds).where(eq(beds.unitId, unitId));
  return Number(row?.n ?? 0);
}

export async function isUnitStaff(userId: string, unitId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ id: unitStaff.id })
    .from(unitStaff)
    .where(and(eq(unitStaff.userId, userId), eq(unitStaff.unitId, unitId)));
  return Boolean(row);
}

/** Staff actions on a unit's patients happen at that unit's facility only. */
export function assertSameFacility(ctx: AuthContext, unit: { facilityId: string }) {
  if (ctx.facilityId !== unit.facilityId) {
    throw forbidden('This dialysis unit belongs to another facility');
  }
}

/**
 * Capacity check for a schedule: on every chosen weekday the shift must have a free station.
 * Counts ACTIVE schedules of the unit (excluding the one being changed).
 */
export async function assertCapacity(
  input: { unitId: string; shift: string; days: string[]; excludeScheduleId?: string },
  executor: Executor = db,
) {
  const stations = await stationsOf(input.unitId, executor);
  if (stations === 0) throw conflict('This dialysis unit has no stations (beds) configured');
  const rows = await executor
    .select({ days: dialysisSchedules.days })
    .from(dialysisSchedules)
    .where(
      and(
        eq(dialysisSchedules.unitId, input.unitId),
        eq(dialysisSchedules.shift, input.shift),
        eq(dialysisSchedules.status, 'ACTIVE'),
        input.excludeScheduleId ? ne(dialysisSchedules.id, input.excludeScheduleId) : undefined,
      ),
    );
  const full = input.days.filter(
    (day) => rows.filter((r) => r.days.includes(day)).length >= stations,
  );
  if (full.length) {
    throw new HttpError(
      409,
      'SHIFT_FULL',
      'The shift is full on some of the chosen days',
      full.map((day) => ({ path: 'days', message: day, code: 'SHIFT_FULL' })),
    );
  }
  return stations;
}

/* ------------------------------------------------------------------------ sessions ---- */

/**
 * Create PLANNED sessions for the next PLAN_AHEAD_DAYS days for active schedules (all, or one).
 * Idempotent: the (patient, date) unique index makes repeated runs and parallel workers harmless.
 */
export async function planSessions(
  opts: { scheduleId?: string; today?: string } = {},
  executor: Executor = db,
): Promise<number> {
  const today = opts.today ?? kosovoDate(new Date());
  const schedules = await executor
    .select()
    .from(dialysisSchedules)
    .where(
      and(
        eq(dialysisSchedules.status, 'ACTIVE'),
        opts.scheduleId ? eq(dialysisSchedules.id, opts.scheduleId) : undefined,
      ),
    );
  const rows: (typeof dialysisSessions.$inferInsert)[] = [];
  for (const s of schedules) {
    for (let i = 0; i < PLAN_AHEAD_DAYS; i++) {
      const date = addDays(today, i);
      if (date < s.startedOn) continue;
      if (s.endedOn && date > s.endedOn) continue;
      if (!s.days.includes(weekdayOf(date))) continue;
      rows.push({
        patientId: s.patientId,
        unitId: s.unitId,
        scheduleId: s.id,
        sessionDate: date,
        status: 'PLANNED',
      });
    }
  }
  if (!rows.length) return 0;
  let created = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const inserted = await executor
      .insert(dialysisSessions)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ id: dialysisSessions.id });
    created += inserted.length;
  }
  return created;
}

/** Future planned sessions of a schedule are removed (schedule changed) or cancelled (ended). */
export async function clearFuturePlanned(
  scheduleId: string,
  fromDate: string,
  mode: 'delete' | 'cancel',
  executor: Executor = db,
) {
  const where = and(
    eq(dialysisSessions.scheduleId, scheduleId),
    eq(dialysisSessions.status, 'PLANNED'),
    gte(dialysisSessions.sessionDate, fromDate),
  );
  if (mode === 'delete') {
    const r = await executor
      .delete(dialysisSessions)
      .where(where)
      .returning({ id: dialysisSessions.id });
    return r.length;
  }
  const r = await executor
    .update(dialysisSessions)
    .set({ status: 'CANCELLED' })
    .where(where)
    .returning({ id: dialysisSessions.id });
  return r.length;
}

/** The previous completed session's post weight (for the interdialytic weight gain). */
export async function previousPostWeight(
  patientId: string,
  beforeDate: string,
  executor: Executor = db,
): Promise<number | null> {
  const [row] = await executor
    .select({ w: dialysisSessions.postWeightKg })
    .from(dialysisSessions)
    .where(
      and(
        eq(dialysisSessions.patientId, patientId),
        eq(dialysisSessions.status, 'COMPLETED'),
        lt(dialysisSessions.sessionDate, beforeDate),
      ),
    )
    .orderBy(sql`${dialysisSessions.sessionDate} DESC`)
    .limit(1);
  return num(row?.w);
}

/** Previous post weights for many (patient, date) pairs in one query. */
export async function previousPostWeights(
  pairs: { patientId: string; sessionDate: string }[],
  executor: Executor = db,
) {
  const ids = [...new Set(pairs.map((p) => p.patientId))];
  const out = new Map<string, number | null>();
  if (!ids.length) return out;
  const rows = await executor
    .select({
      patientId: dialysisSessions.patientId,
      date: dialysisSessions.sessionDate,
      w: dialysisSessions.postWeightKg,
    })
    .from(dialysisSessions)
    .where(and(inArray(dialysisSessions.patientId, ids), eq(dialysisSessions.status, 'COMPLETED')))
    .orderBy(sql`${dialysisSessions.sessionDate} DESC`);
  for (const p of pairs) {
    const prev = rows.find((r) => r.patientId === p.patientId && r.date < p.sessionDate);
    out.set(`${p.patientId}:${p.sessionDate}`, num(prev?.w));
  }
  return out;
}

/* -------------------------------------------------------------------------- worker ---- */

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  planSessions().then(
    (n) => n && logger.info({ sessions: n }, 'Dialysis sessions planned'),
    (err: unknown) => logger.error({ err }, 'Dialysis planning worker failed'),
  );
}

/** Plans sessions daily (first run 5 minutes after start). Not started in tests. */
export function startDialysisWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 5 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 24 * 60 * 60_000);
  timer.unref();
}

export function stopDialysisWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}
