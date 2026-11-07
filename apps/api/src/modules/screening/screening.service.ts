import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { patients, screeningEpisodes, screeningOptOuts } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  ageOn,
  DEFAULT_DAILY_CAP,
  FOLLOW_UP_SAFETY_NET_DAYS,
  inPopulation,
  INVITATION_OVERDUE_DAYS,
  isoDate,
  PROGRAMME_CODES,
  PROGRAMMES,
  REMINDER_AFTER_DAYS,
  testFor,
  type ProgrammeCode,
} from './definitions.js';

const DAY = 86_400_000;

export type Episode = typeof screeningEpisodes.$inferSelect;
export type OptOut = typeof screeningOptOuts.$inferSelect;

/**
 * Where a person stands in a programme:
 * - NOT_IN_POPULATION: outside the programme's sex or age range;
 * - OPTED_OUT: the person chose not to be invited;
 * - CEASED: a clinician recorded that the programme no longer applies (e.g. after a
 *   hysterectomy) – the latest episode is NOT_ELIGIBLE; a new invitation reinstates;
 * - FOLLOW_UP: an abnormal result is being followed up (open REFERRED episode);
 * - IN_PROGRESS: invited, booked or tested, result pending;
 * - UP_TO_DATE: next routine test due in the future;
 * - LEFT: no further routine invitation (e.g. last test near the upper age limit);
 * - DUE: due now (never screened, or the due date has passed).
 */
export type ProgrammeState =
  | 'NOT_IN_POPULATION'
  | 'OPTED_OUT'
  | 'CEASED'
  | 'FOLLOW_UP'
  | 'IN_PROGRESS'
  | 'UP_TO_DATE'
  | 'LEFT'
  | 'DUE';

export interface ProgrammeStatus {
  programme: ProgrammeCode;
  state: ProgrammeState;
  inPopulation: boolean;
  testOffered: string;
  openEpisode: Episode | null;
  lastScreenedAt: Date | null;
  lastResult: string | null;
  nextDueDate: string | null;
  optOut: OptOut | null;
  /** Invited more than INVITATION_OVERDUE_DAYS ago without a test. */
  invitationOverdue: boolean;
  /** Abnormal result without a referral after FOLLOW_UP_SAFETY_NET_DAYS. */
  followUpOverdue: boolean;
}

const OPEN = new Set(['INVITED', 'BOOKED', 'SCREENED', 'REFERRED']);

export function programmeStatus(
  code: ProgrammeCode,
  person: { sex: string; dateOfBirth: string },
  episodes: Episode[],
  optOuts: OptOut[],
  now = new Date(),
): ProgrammeStatus {
  const mine = episodes
    .filter((e) => e.programme === code)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = mine[0] ?? null;
  const open = mine.find((e) => OPEN.has(e.status)) ?? null;
  const screened = mine.find((e) => e.screenedAt);
  const optOut = optOuts.find((o) => o.programme === code && !o.withdrawnAt) ?? null;
  const population = inPopulation(code, person, now);
  const today = isoDate(now);
  const nextDue =
    latest && ['RESULTED', 'CLOSED', 'DECLINED'].includes(latest.status)
      ? latest.nextDueDate
      : null;
  let state: ProgrammeState;
  if (open?.status === 'REFERRED') state = 'FOLLOW_UP';
  else if (open) state = 'IN_PROGRESS';
  else if (optOut) state = 'OPTED_OUT';
  else if (latest?.status === 'NOT_ELIGIBLE') state = 'CEASED';
  else if (!population) state = 'NOT_IN_POPULATION';
  else if (latest && ['RESULTED', 'CLOSED'].includes(latest.status) && !nextDue) state = 'LEFT';
  else if (nextDue && nextDue > today) state = 'UP_TO_DATE';
  else state = 'DUE';
  return {
    programme: code,
    state,
    inPopulation: population,
    testOffered: testFor(code, ageOn(person.dateOfBirth, now)),
    openEpisode: open,
    lastScreenedAt: screened?.screenedAt ?? null,
    lastResult: screened?.result ?? null,
    nextDueDate: nextDue,
    optOut,
    invitationOverdue: Boolean(
      open &&
      open.status !== 'REFERRED' &&
      !open.screenedAt &&
      open.invitedAt &&
      open.invitedAt.getTime() < now.getTime() - INVITATION_OVERDUE_DAYS * DAY,
    ),
    followUpOverdue: Boolean(
      open?.status === 'REFERRED' &&
      !open.referralId &&
      (open.resultedAt ?? open.updatedAt).getTime() <
        now.getTime() - FOLLOW_UP_SAFETY_NET_DAYS * DAY,
    ),
  };
}

/** Episodes and opt-outs of several people (for the chart, the worklist and the portal). */
export async function loadScreening(patientIds: string[], executor: Executor = db) {
  if (!patientIds.length) return { episodes: [] as Episode[], optOuts: [] as OptOut[] };
  const [episodes, optOuts] = await Promise.all([
    executor
      .select()
      .from(screeningEpisodes)
      .where(inArray(screeningEpisodes.patientId, patientIds))
      .orderBy(desc(screeningEpisodes.createdAt)),
    executor
      .select()
      .from(screeningOptOuts)
      .where(
        and(inArray(screeningOptOuts.patientId, patientIds), isNull(screeningOptOuts.withdrawnAt)),
      ),
  ]);
  return { episodes, optOuts };
}

export async function statusesFor(
  person: { id: string; sex: string; dateOfBirth: string },
  now = new Date(),
) {
  const { episodes, optOuts } = await loadScreening([person.id]);
  return {
    episodes,
    optOuts,
    programmes: PROGRAMME_CODES.map((c) => programmeStatus(c, person, episodes, optOuts, now)),
  };
}

/* ------------------------------------------------------------------------ invitations -- */

const INVITATION = {
  type: 'screening_invitation',
  title: 'Invitation to a free screening programme',
  body: 'Please contact your family medicine centre to book an appointment. The details are in the portal.',
  link: '/portal/screening',
} as const;

const REMINDER = {
  type: 'screening_invitation',
  title: 'Reminder: your screening invitation',
  body: 'You have not booked your screening test yet. Please contact your family medicine centre.',
  link: '/portal/screening',
} as const;

/** The programmes as an SQL VALUES list (code, sex, min age, max age). */
const programmeValues = (): SQL =>
  sql.join(
    PROGRAMME_CODES.map((c) => {
      const p = PROGRAMMES[c];
      return sql`(${c}::text, ${p.sex}::text, ${p.minAge}::int, ${p.maxAge}::int)`;
    }),
    sql`, `,
  );

/**
 * Invites people who are due, at their registered facility, at most `dailyCap` new invitations
 * per facility and day (longest overdue first). Excluded: deceased, merged and temporary records,
 * people outside the age and sex range, opted out, ceased, already in an open episode (invited,
 * booked, awaiting a result, under follow-up) or not yet due. Runs under an advisory lock, so
 * concurrent runs on several instances cannot invite anyone twice.
 */
export async function inviteDuePeople(now = new Date(), dailyCap = DEFAULT_DAILY_CAP) {
  const today = isoDate(now);
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ ok: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('screening_invitations')) AS ok`,
    );
    if (!lock.rows[0]?.ok) return 0;
    const candidates = await tx.execute<{
      patient_id: string;
      facility_id: string;
      programme: ProgrammeCode;
      date_of_birth: string;
      due: string;
    }>(sql`
      WITH latest AS (
        SELECT DISTINCT ON (patient_id, programme) patient_id, programme, status, next_due_date
        FROM screening_episodes ORDER BY patient_id, programme, created_at DESC
      ), sent_today AS (
        SELECT facility_id, count(*)::int AS n FROM screening_episodes
        WHERE invited_at >= ${today}::date AND invited_at < ${today}::date + 1
        GROUP BY facility_id
      ), cand AS (
        SELECT p.id AS patient_id, p.primary_facility_id AS facility_id, prog.code AS programme,
               p.date_of_birth::text AS date_of_birth,
               coalesce(l.next_due_date, (p.date_of_birth + make_interval(years => prog.min_age))::date) AS due
        FROM patients p
        CROSS JOIN (VALUES ${programmeValues()}) AS prog(code, sex, min_age, max_age)
        LEFT JOIN latest l ON l.patient_id = p.id AND l.programme = prog.code
        WHERE p.merged_into_id IS NULL AND p.deceased_at IS NULL AND p.temporary_identity IS NULL
          AND (prog.sex IS NULL OR p.sex::text = prog.sex)
          AND date_part('year', age(${today}::date, p.date_of_birth)) BETWEEN prog.min_age AND prog.max_age
          AND NOT EXISTS (SELECT 1 FROM screening_opt_outs o WHERE o.patient_id = p.id
                          AND o.programme = prog.code AND o.withdrawn_at IS NULL)
          AND (l.status IS NULL
               OR (l.status IN ('RESULTED', 'CLOSED')
                   AND l.next_due_date IS NOT NULL AND l.next_due_date <= ${today}::date)
               OR (l.status = 'DECLINED' AND coalesce(l.next_due_date, ${today}::date) <= ${today}::date))
      )
      SELECT patient_id, facility_id, programme, date_of_birth, due::text AS due FROM (
        SELECT cand.*, row_number() OVER (PARTITION BY cand.facility_id ORDER BY due, patient_id) AS rn,
               coalesce(s.n, 0) AS already
        FROM cand LEFT JOIN sent_today s ON s.facility_id = cand.facility_id
      ) ranked
      WHERE rn <= ${dailyCap} - already
      ORDER BY facility_id, rn`);
    if (!candidates.rows.length) return 0;
    const rows = await tx
      .insert(screeningEpisodes)
      .values(
        candidates.rows.map((c) => ({
          patientId: c.patient_id,
          programme: c.programme,
          facilityId: c.facility_id,
          status: 'INVITED',
          invitedAt: now,
          dueDate: c.due < today ? today : c.due,
          testType: testFor(c.programme, ageOn(c.date_of_birth, now)),
        })),
      )
      .returning({
        id: screeningEpisodes.id,
        patientId: screeningEpisodes.patientId,
        programme: screeningEpisodes.programme,
      });
    for (const r of rows) {
      await audit(
        {
          action: AuditAction.SCREENING_INVITED,
          actor: null,
          resourceType: 'screening_episode',
          resourceId: r.id,
          patientId: r.patientId,
          metadata: { programme: r.programme, automatic: true },
        },
        tx,
      );
    }
    // One message per person, however many programmes they were invited to.
    for (const patientId of new Set(rows.map((r) => r.patientId))) {
      await notifyPatient(patientId, INVITATION, tx);
    }
    return rows.length;
  });
}

/** One reminder for invitations without a booking or test after REMINDER_AFTER_DAYS. */
export async function sendReminders(now = new Date()) {
  const cutoff = new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY);
  return db.transaction(async (tx) => {
    const due = await tx
      .update(screeningEpisodes)
      .set({ reminderSentAt: now })
      .where(
        and(
          eq(screeningEpisodes.status, 'INVITED'),
          isNull(screeningEpisodes.reminderSentAt),
          sql`${screeningEpisodes.invitedAt} < ${cutoff}`,
        ),
      )
      .returning({ patientId: screeningEpisodes.patientId });
    for (const patientId of new Set(due.map((r) => r.patientId))) {
      await notifyPatient(patientId, REMINDER, tx);
    }
    return due.length;
  });
}

export async function runScreeningOnce(now = new Date(), dailyCap = DEFAULT_DAILY_CAP) {
  const invited = await inviteDuePeople(now, dailyCap);
  const reminded = await sendReminders(now);
  return { invited, reminded };
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  const cap = Number(process.env.SCREENING_DAILY_CAP ?? DEFAULT_DAILY_CAP) || DEFAULT_DAILY_CAP;
  runScreeningOnce(new Date(), cap).then(
    (r) => (r.invited || r.reminded) && logger.info(r, 'Screening invitations sent'),
    (err: unknown) => logger.error({ err }, 'Screening worker failed'),
  );
}

/** Daily (first run ten minutes after start). Not started in tests. */
export function startScreeningWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 10 * 60_000);
  first.unref();
  timer = setInterval(runSafely, DAY);
  timer.unref();
}

export function stopScreeningWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}

/* --------------------------------------------------------------------------- coverage -- */

export interface CoverageRow {
  group: string | null;
  programme: ProgrammeCode;
  population: number | null;
  screenedInInterval: number | null;
  coveragePct: number | null;
  optedOut: number | null;
  invited12m: number | null;
  tookUp12m: number | null;
  uptakePct: number | null;
  resulted12m: number | null;
  abnormal12m: number | null;
  abnormalPct: number | null;
  followUpOverdue: number | null;
  suppressed: boolean;
}

/** Interval (months) for the person's age, as an SQL CASE over the programme's bands. */
function intervalMonths(code: ProgrammeCode, today: string): SQL {
  const bands = PROGRAMMES[code].bands;
  return sql`(CASE ${sql.join(
    bands.map(
      (b) =>
        sql`WHEN date_part('year', age(${today}::date, p.date_of_birth)) BETWEEN ${b.fromAge} AND ${b.toAge} THEN ${b.months}::int`,
    ),
    sql` `,
  )} ELSE ${bands.at(-1)!.months} END)::int`;
}

const small = (n: number) => n > 0 && n < SMALL_CELL_THRESHOLD;
const pct = (num: number | null, den: number | null) =>
  num === null || den === null || den === 0 ? null : Math.round((num / den) * 1000) / 10;

/**
 * Coverage per programme: the population in range (alive, registered at the facility or
 * nationally), those with a test within their routine interval, opt-outs, invitation uptake in
 * the last 12 months (invited and tested), the abnormal rate of results in the last 12 months,
 * and abnormal results still without a referral after the safety-net period. Counts below
 * SMALL_CELL_THRESHOLD (except zero) are suppressed with the percentages derived from them.
 */
export async function coverage(opts: {
  facilityId: string | null;
  groupBy: 'NONE' | 'MUNICIPALITY';
  now?: Date;
}): Promise<CoverageRow[]> {
  const now = opts.now ?? new Date();
  const today = isoDate(now);
  const out: CoverageRow[] = [];
  for (const code of PROGRAMME_CODES) {
    const prog = PROGRAMMES[code];
    const group = opts.groupBy === 'MUNICIPALITY' ? sql`coalesce(p.municipality, '')` : sql`''`;
    const scope = opts.facilityId ? sql`AND p.primary_facility_id = ${opts.facilityId}` : sql``;
    const sexRule = prog.sex ? sql`AND p.sex::text = ${prog.sex}` : sql``;
    const result = await db.execute<{
      grp: string;
      population: number;
      screened: number;
      opted_out: number;
      invited: number;
      took_up: number;
      resulted: number;
      abnormal: number;
      follow_up_overdue: number;
    }>(sql`
      SELECT ${group} AS grp,
        count(*)::int AS population,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM screening_episodes e
          WHERE e.patient_id = p.id AND e.programme = ${code} AND e.screened_at IS NOT NULL
            AND e.screened_at >= ${today}::date - make_interval(months => ${intervalMonths(code, today)})))::int AS screened,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM screening_opt_outs o
          WHERE o.patient_id = p.id AND o.programme = ${code} AND o.withdrawn_at IS NULL))::int AS opted_out,
        coalesce(sum((SELECT count(*) FROM screening_episodes e WHERE e.patient_id = p.id
          AND e.programme = ${code} AND e.invited_at >= ${today}::date - 365)), 0)::int AS invited,
        coalesce(sum((SELECT count(*) FROM screening_episodes e WHERE e.patient_id = p.id
          AND e.programme = ${code} AND e.invited_at >= ${today}::date - 365
          AND e.screened_at IS NOT NULL)), 0)::int AS took_up,
        coalesce(sum((SELECT count(*) FROM screening_episodes e WHERE e.patient_id = p.id
          AND e.programme = ${code} AND e.result IS NOT NULL
          AND e.resulted_at >= ${today}::date - 365)), 0)::int AS resulted,
        coalesce(sum((SELECT count(*) FROM screening_episodes e WHERE e.patient_id = p.id
          AND e.programme = ${code} AND e.result = 'ABNORMAL'
          AND e.resulted_at >= ${today}::date - 365)), 0)::int AS abnormal,
        coalesce(sum((SELECT count(*) FROM screening_episodes e WHERE e.patient_id = p.id
          AND e.programme = ${code} AND e.status = 'REFERRED' AND e.referral_id IS NULL
          AND coalesce(e.resulted_at, e.updated_at) < ${now}::timestamptz - make_interval(days => ${FOLLOW_UP_SAFETY_NET_DAYS}::int))), 0)::int AS follow_up_overdue
      FROM patients p
      WHERE p.merged_into_id IS NULL AND p.deceased_at IS NULL AND p.temporary_identity IS NULL
        ${sexRule} ${scope}
        AND date_part('year', age(${today}::date, p.date_of_birth)) BETWEEN ${prog.minAge} AND ${prog.maxAge}
      GROUP BY 1 ORDER BY 1`);
    for (const r of result.rows) {
      const s = (n: number) => (small(n) ? null : n);
      const suppressed = [
        r.population,
        r.screened,
        r.opted_out,
        r.invited,
        r.took_up,
        r.resulted,
        r.abnormal,
        r.follow_up_overdue,
      ].some(small);
      const population = s(r.population);
      const screened = s(r.screened);
      const invited = s(r.invited);
      const tookUp = s(r.took_up);
      const resulted = s(r.resulted);
      const abnormal = s(r.abnormal);
      out.push({
        group: opts.groupBy === 'MUNICIPALITY' ? r.grp || null : null,
        programme: code,
        population,
        screenedInInterval: screened,
        coveragePct: pct(screened, population),
        optedOut: s(r.opted_out),
        invited12m: invited,
        tookUp12m: tookUp,
        uptakePct: pct(tookUp, invited),
        resulted12m: resulted,
        abnormal12m: abnormal,
        abnormalPct: pct(abnormal, resulted),
        followUpOverdue: s(r.follow_up_overdue),
        suppressed,
      });
    }
    if (!result.rows.length && opts.groupBy === 'NONE') {
      out.push({
        group: null,
        programme: code,
        population: 0,
        screenedInInterval: 0,
        coveragePct: null,
        optedOut: 0,
        invited12m: 0,
        tookUp12m: 0,
        uptakePct: null,
        resulted12m: 0,
        abnormal12m: 0,
        abnormalPct: null,
        followUpOverdue: 0,
        suppressed: false,
      });
    }
  }
  return out;
}

/** The person's record (sex and date of birth) for eligibility checks. */
export async function personOf(patientId: string, executor: Executor = db) {
  const [p] = await executor
    .select({
      id: patients.id,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
      primaryFacilityId: patients.primaryFacilityId,
      deceasedAt: patients.deceasedAt,
      mergedIntoId: patients.mergedIntoId,
    })
    .from(patients)
    .where(eq(patients.id, patientId));
  return p ?? null;
}
