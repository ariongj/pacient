import { and, asc, eq, gt, inArray, lt, ne, notInArray, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { admissions, beds, careUnits, rosterShifts, users } from '../../db/schema.js';
import {
  addDays,
  localDate,
  localTime,
  SCHEDULING_TZ,
  weekdayOf,
  zonedToUtc,
} from '../scheduling/time.js';

/**
 * Staff rosters and on-call.
 *
 * Shifts are entered as a local date (Europe/Belgrade) with a kind and optional local start/end
 * times; they are stored as UTC instants, so a night shift across the change to summer or winter
 * time is 7 or 9 hours long, as on the ward clock.
 *
 * Working-time rules are ILLUSTRATIVE (EU Working Time Directive 2003/88/EC): at least 11 hours of
 * rest between two shifts and no more than 48 hours of work a week. Breaking them is a warning the
 * director confirms with a reason, not a hard block – local collective agreements decide. On-call
 * periods are exempt from the rest check and the weekly total (they are governed by local on-call
 * agreements); overlapping shifts of the same person are always refused.
 */

export const SHIFT_KINDS = ['DAY', 'LATE', 'NIGHT', 'ON_CALL'] as const;
export type ShiftKind = (typeof SHIFT_KINDS)[number];
export const WORK_KINDS: ShiftKind[] = ['DAY', 'LATE', 'NIGHT'];

/** Default local times per kind; an end before the start means the next day. */
export const DEFAULT_TIMES: Record<ShiftKind, { start: string; end: string }> = {
  DAY: { start: '07:00', end: '15:00' },
  LATE: { start: '15:00', end: '23:00' },
  NIGHT: { start: '23:00', end: '07:00' },
  ON_CALL: { start: '16:00', end: '08:00' },
};

/**
 * Specialties with an on-call rota. Not the waiting-list list: on-call covers acute specialties
 * (internal medicine, anaesthesia, obstetrics, paediatrics…) that have no elective waiting list.
 */
export const ON_CALL_SPECIALTIES = [
  'INTERNAL_MEDICINE',
  'GENERAL_SURGERY',
  'ANAESTHESIA',
  'CARDIOLOGY',
  'NEUROLOGY',
  'OBSTETRICS',
  'PAEDIATRICS',
  'ORTHOPAEDICS',
  'NEUROSURGERY',
  'UROLOGY',
  'PSYCHIATRY',
  'RADIOLOGY',
] as const;
export type OnCallSpecialty = (typeof ON_CALL_SPECIALTIES)[number];

/** Roles that work rostered shifts (and may read their facility's roster). */
export const ROSTERED_ROLES = ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR'] as const;

/** Wards whose nurse staffing is compared with occupied beds. */
export const WARD_TYPES = [
  'GENERAL_WARD',
  'SURGICAL_WARD',
  'ICU',
  'PAEDIATRIC',
  'MATERNITY',
  'NEONATAL',
] as const;
/** Illustrative maximum patients per nurse; the director can pass other values. */
export const DEFAULT_RATIO = { general: 8, intensive: 2 };
const INTENSIVE_TYPES = new Set(['ICU', 'NEONATAL']);

export const MIN_REST_HOURS = 11;
export const MAX_WEEK_HOURS = 48;

export type Warning = { code: 'REST_PERIOD' | 'WEEKLY_HOURS'; message: string; hours: number };

/** Monday of the week (local calendar) containing `date`. */
export function weekStartOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export const isMonday = (date: string) => weekdayOf(date) === 1;

/** UTC instant of local midnight at the start of `date`. */
export function localMidnight(date: string): Date {
  // Midnight always exists in Europe/Belgrade (clocks change at 02:00/03:00).
  return zonedToUtc(date, '00:00')!;
}

/**
 * The UTC window of a shift that starts on local `date`. Returns null when a local time does not
 * exist (the hour skipped when the clocks go forward).
 */
export function shiftWindow(
  date: string,
  kind: ShiftKind,
  startTime?: string | null,
  endTime?: string | null,
): { startsAt: Date; endsAt: Date } | null {
  const start = startTime ?? DEFAULT_TIMES[kind].start;
  const end = endTime ?? DEFAULT_TIMES[kind].end;
  const startsAt = zonedToUtc(date, start);
  const endsAt = zonedToUtc(end > start ? date : addDays(date, 1), end);
  if (!startsAt || !endsAt) return null;
  return { startsAt, endsAt };
}

const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

/** Shifts of a person that overlap [startsAt, endsAt). */
export async function overlapping(
  ex: Executor,
  userId: string,
  startsAt: Date,
  endsAt: Date,
  excludeIds: string[] = [],
) {
  return ex
    .select({ id: rosterShifts.id, startsAt: rosterShifts.startsAt, endsAt: rosterShifts.endsAt })
    .from(rosterShifts)
    .where(
      and(
        eq(rosterShifts.userId, userId),
        eq(rosterShifts.status, 'PLANNED'),
        lt(rosterShifts.startsAt, endsAt),
        gt(rosterShifts.endsAt, startsAt),
        excludeIds.length ? notInArray(rosterShifts.id, excludeIds) : undefined,
      ),
    );
}

export interface PlannedShift {
  userId: string;
  kind: ShiftKind;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Working-time warnings for one new or changed shift, taking `pending` (other shifts created in
 * the same request) into account. On-call periods are exempt.
 */
export async function workingTimeWarnings(
  ex: Executor,
  shift: PlannedShift,
  opts: { excludeIds?: string[]; pending?: PlannedShift[] } = {},
): Promise<Warning[]> {
  if (shift.kind === 'ON_CALL') return [];
  const exclude = opts.excludeIds ?? [];
  const pending = (opts.pending ?? []).filter(
    (p) => p.userId === shift.userId && p !== shift && p.kind !== 'ON_CALL',
  );
  const warnings: Warning[] = [];
  const windowFrom = new Date(shift.startsAt.getTime() - 8 * 86_400_000);
  const windowTo = new Date(shift.endsAt.getTime() + 8 * 86_400_000);
  const stored = await ex
    .select({ startsAt: rosterShifts.startsAt, endsAt: rosterShifts.endsAt })
    .from(rosterShifts)
    .where(
      and(
        eq(rosterShifts.userId, shift.userId),
        eq(rosterShifts.status, 'PLANNED'),
        ne(rosterShifts.kind, 'ON_CALL'),
        gt(rosterShifts.endsAt, windowFrom),
        lt(rosterShifts.startsAt, windowTo),
        exclude.length ? notInArray(rosterShifts.id, exclude) : undefined,
      ),
    );
  const others = [...stored, ...pending];

  // Rest before and after.
  const before = others
    .filter((o) => o.endsAt.getTime() <= shift.startsAt.getTime())
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  const after = others
    .filter((o) => o.startsAt.getTime() >= shift.endsAt.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  const rests = [
    before ? hoursBetween(before.endsAt, shift.startsAt) : Infinity,
    after ? hoursBetween(shift.endsAt, after.startsAt) : Infinity,
  ];
  const shortest = Math.min(...rests);
  if (shortest < MIN_REST_HOURS) {
    warnings.push({
      code: 'REST_PERIOD',
      message: 'Less than {min} hours of rest between shifts ({hours} h)',
      hours: Math.round(shortest * 10) / 10,
    });
  }

  // Hours in the calendar week (Monday–Sunday, local) of the shift's start.
  const monday = weekStartOf(localDate(shift.startsAt));
  const from = localMidnight(monday);
  const to = localMidnight(addDays(monday, 7));
  const inWeek = (s: { startsAt: Date; endsAt: Date }) => {
    const a = Math.max(s.startsAt.getTime(), from.getTime());
    const b = Math.min(s.endsAt.getTime(), to.getTime());
    return b > a ? (b - a) / 3_600_000 : 0;
  };
  const total = [...others, shift].reduce((sum, s) => sum + inWeek(s), 0);
  if (total > MAX_WEEK_HOURS) {
    warnings.push({
      code: 'WEEKLY_HOURS',
      message: 'More than {max} working hours in the week ({hours} h)',
      hours: Math.round(total * 10) / 10,
    });
  }
  return warnings;
}

/** Active staff of the facility who work rostered shifts. */
export async function facilityStaffMember(facilityId: string, userId: string) {
  const [u] = await db
    .select({ id: users.id, role: users.role, fullName: users.fullName })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.facilityId, facilityId),
        eq(users.isActive, true),
        inArray(users.role, [...ROSTERED_ROLES]),
      ),
    );
  return u ?? null;
}

/* ------------------------------------------------------------------ on-call ------------- */

export interface OnCallPerson {
  shiftId: string;
  userId: string;
  name: string;
  role: string;
  startsAt: Date;
  endsAt: Date;
}

/** Specialties with on-call cover at the facility in the last 28 or the next 7 days. */
export async function coveredSpecialties(facilityId: string, now = new Date()) {
  const rows = await db
    .selectDistinct({ specialty: rosterShifts.specialty })
    .from(rosterShifts)
    .where(
      and(
        eq(rosterShifts.facilityId, facilityId),
        eq(rosterShifts.kind, 'ON_CALL'),
        eq(rosterShifts.status, 'PLANNED'),
        gt(rosterShifts.endsAt, new Date(now.getTime() - 28 * 86_400_000)),
        lt(rosterShifts.startsAt, new Date(now.getTime() + 7 * 86_400_000)),
      ),
    );
  return rows
    .map((r) => r.specialty)
    .filter((s): s is string => Boolean(s))
    .sort(
      (a, b) =>
        ON_CALL_SPECIALTIES.indexOf(a as OnCallSpecialty) -
        ON_CALL_SPECIALTIES.indexOf(b as OnCallSpecialty),
    );
}

/** Who is on call now and next, per specialty (one indexed query for the next 7 days). */
export async function onCallBoard(facilityId: string, now = new Date()) {
  const rows = await db
    .select({
      shiftId: rosterShifts.id,
      specialty: rosterShifts.specialty,
      userId: users.id,
      name: users.fullName,
      role: users.role,
      startsAt: rosterShifts.startsAt,
      endsAt: rosterShifts.endsAt,
    })
    .from(rosterShifts)
    .innerJoin(users, eq(users.id, rosterShifts.userId))
    .where(
      and(
        eq(rosterShifts.facilityId, facilityId),
        eq(rosterShifts.kind, 'ON_CALL'),
        eq(rosterShifts.status, 'PLANNED'),
        gt(rosterShifts.endsAt, now),
        lt(rosterShifts.startsAt, new Date(now.getTime() + 7 * 86_400_000)),
      ),
    )
    .orderBy(asc(rosterShifts.startsAt));
  const specialties = await coveredSpecialties(facilityId, now);
  for (const r of rows)
    if (r.specialty && !specialties.includes(r.specialty)) specialties.push(r.specialty);
  return specialties.map((specialty) => {
    const mine = rows.filter((r) => r.specialty === specialty);
    const current = mine.filter((r) => r.startsAt <= now && r.endsAt > now);
    const lastCurrentEnd = current.length
      ? Math.max(...current.map((c) => c.endsAt.getTime()))
      : now.getTime();
    const next = mine.find((r) => r.startsAt.getTime() >= lastCurrentEnd) ?? null;
    const strip = (r: (typeof rows)[number]): OnCallPerson => ({
      shiftId: r.shiftId,
      userId: r.userId,
      name: r.name,
      role: r.role,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
    });
    return { specialty, current: current.map(strip), next: next ? strip(next) : null };
  });
}

/* ------------------------------------------------------------------ staffing ------------ */

export interface StaffingRow {
  unitId: string;
  unitName: string;
  unitType: string;
  beds: number;
  occupied: number;
  threshold: number;
  shifts: Record<'DAY' | 'LATE' | 'NIGHT', { nurses: number; ratio: number | null; over: boolean }>;
}

/** Rostered nurses per ward and shift on a local date, against the patients in the ward now. */
export async function staffing(
  facilityId: string,
  date: string,
  ratio: { general: number; intensive: number } = DEFAULT_RATIO,
): Promise<StaffingRow[]> {
  const units = await db
    .select({ id: careUnits.id, name: careUnits.name, type: careUnits.type })
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.isActive, true),
        inArray(careUnits.type, [...WARD_TYPES]),
      ),
    )
    .orderBy(asc(careUnits.name));
  if (!units.length) return [];
  const ids = units.map((u) => u.id);
  const [bedCounts, occupied, shifts] = await Promise.all([
    db
      .select({ unitId: beds.unitId, n: sql<number>`count(*)::int` })
      .from(beds)
      .where(inArray(beds.unitId, ids))
      .groupBy(beds.unitId),
    db
      .select({ unitId: admissions.unitId, n: sql<number>`count(*)::int` })
      .from(admissions)
      .where(and(inArray(admissions.unitId, ids), eq(admissions.status, 'ADMITTED')))
      .groupBy(admissions.unitId),
    db
      .select({
        unitId: rosterShifts.unitId,
        kind: rosterShifts.kind,
        n: sql<number>`count(DISTINCT ${rosterShifts.userId})::int`,
      })
      .from(rosterShifts)
      .innerJoin(users, eq(users.id, rosterShifts.userId))
      .where(
        and(
          inArray(rosterShifts.unitId, ids),
          eq(rosterShifts.status, 'PLANNED'),
          eq(users.role, 'NURSE'),
          inArray(rosterShifts.kind, ['DAY', 'LATE', 'NIGHT']),
          sql`(${rosterShifts.startsAt} AT TIME ZONE ${SCHEDULING_TZ})::date = ${date}::date`,
        ),
      )
      .groupBy(rosterShifts.unitId, rosterShifts.kind),
  ]);
  return units.map((u) => {
    const threshold = INTENSIVE_TYPES.has(u.type) ? ratio.intensive : ratio.general;
    const occ = occupied.find((o) => o.unitId === u.id)?.n ?? 0;
    const per = (kind: 'DAY' | 'LATE' | 'NIGHT') => {
      const nurses = shifts.find((s) => s.unitId === u.id && s.kind === kind)?.n ?? 0;
      const r = nurses ? Math.round((occ / nurses) * 10) / 10 : null;
      return { nurses, ratio: r, over: occ > 0 && (nurses === 0 || occ / nurses > threshold) };
    };
    return {
      unitId: u.id,
      unitName: u.name,
      unitType: u.type,
      beds: bedCounts.find((b) => b.unitId === u.id)?.n ?? 0,
      occupied: occ,
      threshold,
      shifts: { DAY: per('DAY'), LATE: per('LATE'), NIGHT: per('NIGHT') },
    };
  });
}

export type Gap =
  | { type: 'NO_NIGHT_NURSE'; date: string; unitId: string; unitName: string }
  | { type: 'NO_ON_CALL'; date: string; specialty: string }
  /** A ward with no nurse rostered at all in the last 28 days or the coming period. */
  | { type: 'WARD_NOT_ROSTERED'; unitId: string; unitName: string };

/**
 * Gaps in the next `days` days from `today`: rostered wards without a night nurse, and nights
 * when a specialty that normally has on-call cover has nobody at 02:00. Wards whose nurses are not
 * rostered in Pacient at all are listed once (WARD_NOT_ROSTERED) instead of once per night.
 */
export async function upcomingGaps(facilityId: string, today: string, days = 7): Promise<Gap[]> {
  const from = localMidnight(today);
  const to = localMidnight(addDays(today, days + 1));
  const [units, nights, onCall, specialties, rosteredWards] = await Promise.all([
    db
      .select({ id: careUnits.id, name: careUnits.name })
      .from(careUnits)
      .where(
        and(
          eq(careUnits.facilityId, facilityId),
          eq(careUnits.isActive, true),
          inArray(careUnits.type, [...WARD_TYPES]),
        ),
      )
      .orderBy(asc(careUnits.name)),
    db
      .select({ unitId: rosterShifts.unitId, startsAt: rosterShifts.startsAt })
      .from(rosterShifts)
      .innerJoin(users, eq(users.id, rosterShifts.userId))
      .where(
        and(
          eq(rosterShifts.facilityId, facilityId),
          eq(rosterShifts.status, 'PLANNED'),
          eq(rosterShifts.kind, 'NIGHT'),
          eq(users.role, 'NURSE'),
          gt(rosterShifts.startsAt, from),
          lt(rosterShifts.startsAt, to),
        ),
      ),
    db
      .select({
        specialty: rosterShifts.specialty,
        startsAt: rosterShifts.startsAt,
        endsAt: rosterShifts.endsAt,
      })
      .from(rosterShifts)
      .where(
        and(
          eq(rosterShifts.facilityId, facilityId),
          eq(rosterShifts.status, 'PLANNED'),
          eq(rosterShifts.kind, 'ON_CALL'),
          gt(rosterShifts.endsAt, from),
          lt(rosterShifts.startsAt, to),
        ),
      ),
    coveredSpecialties(facilityId, from),
    db
      .selectDistinct({ unitId: rosterShifts.unitId })
      .from(rosterShifts)
      .innerJoin(users, eq(users.id, rosterShifts.userId))
      .where(
        and(
          eq(rosterShifts.facilityId, facilityId),
          eq(rosterShifts.status, 'PLANNED'),
          eq(users.role, 'NURSE'),
          gt(rosterShifts.endsAt, new Date(from.getTime() - 28 * 86_400_000)),
          lt(rosterShifts.startsAt, to),
        ),
      ),
  ]);
  const rostered = new Set(rosteredWards.map((r) => r.unitId));
  const gaps: Gap[] = units
    .filter((u) => !rostered.has(u.id))
    .map((u) => ({ type: 'WARD_NOT_ROSTERED' as const, unitId: u.id, unitName: u.name }));
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    for (const u of units) {
      if (!rostered.has(u.id)) continue;
      const has = nights.some((n) => n.unitId === u.id && localDate(n.startsAt) === date);
      if (!has) gaps.push({ type: 'NO_NIGHT_NURSE', date, unitId: u.id, unitName: u.name });
    }
    const probe = zonedToUtc(addDays(date, 1), '02:00') ?? localMidnight(addDays(date, 1));
    for (const specialty of specialties) {
      const covered = onCall.some(
        (s) => s.specialty === specialty && s.startsAt <= probe && s.endsAt > probe,
      );
      if (!covered) gaps.push({ type: 'NO_ON_CALL', date, specialty });
    }
  }
  return gaps;
}

/* ------------------------------------------------------------------ iCalendar ----------- */

const icsDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const icsText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** RFC 5545 lines are folded at 75 octets. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

export function toIcs(
  shifts: {
    id: string;
    summary: string;
    location: string | null;
    startsAt: Date;
    endsAt: Date;
    cancelled: boolean;
  }[],
  now = new Date(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pacient//Rosters//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const s of shifts) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@pacient`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(s.startsAt)}`,
      `DTEND:${icsDate(s.endsAt)}`,
      `SUMMARY:${icsText(s.summary)}`,
      ...(s.location ? [`LOCATION:${icsText(s.location)}`] : []),
      `STATUS:${s.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export { localDate, localTime };
