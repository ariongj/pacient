import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  antenatalVisits,
  facilities,
  imagingOrders,
  labResults,
  pregnancies,
  users,
} from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  addDays,
  contactSchedule,
  daysBetween,
  decodeRiskFactors,
  formatGestation,
  gestationDays,
  KEY_TESTS,
  keyTestState,
  kosovoDay,
  NEAR_EDD_DAYS,
  POST_TERM_DAYS,
  toDay,
  visitAlerts,
  type KeyTestDef,
} from './definitions.js';

type PregnancyRow = typeof pregnancies.$inferSelect;
type VisitRow = typeof antenatalVisits.$inferSelect;

/** Gestational age (days) on the day the pregnancy was booked. */
export const bookingGestation = (p: Pick<PregnancyRow, 'eddDate' | 'createdAt'>) =>
  gestationDays(p.eddDate, kosovoDay(p.createdAt));

/** Flags used by the worklist and the dashboards. */
export function pregnancyFlags(p: PregnancyRow, today: string) {
  const ga = gestationDays(p.eddDate, today);
  const ongoing = p.status === 'ONGOING';
  return {
    gestationDays: ga,
    gestation: formatGestation(ga),
    postTerm: ongoing && daysBetween(p.eddDate, today) > POST_TERM_DAYS,
    nearEdd: ongoing && daysBetween(today, p.eddDate) <= NEAR_EDD_DAYS && ga <= 280 + POST_TERM_DAYS,
  };
}

function scheduleFor(p: PregnancyRow, visits: VisitRow[], today: string) {
  return contactSchedule(
    p.eddDate,
    bookingGestation(p),
    visits.map((v) => ({ gestationDays: v.gestationDays, visitAt: v.visitAt.toISOString() })),
    gestationDays(p.eddDate, today),
    p.status !== 'ONGOING',
  );
}

/** Gestational day on which each key test was first done in this pregnancy (null = not done). */
async function keyTestsDone(p: PregnancyRow, executor: Executor) {
  const start = addDays(p.eddDate, -280);
  const end = p.endedAt ? toDay(p.endedAt) : addDays(p.eddDate, POST_TERM_DAYS + 7);
  const startAt = new Date(`${start}T00:00:00Z`);
  const endAt = new Date(`${addDays(end, 1)}T00:00:00Z`);
  const labs = await executor
    .select({
      testName: labResults.testName,
      testCode: labResults.testCode,
      collectedAt: labResults.collectedAt,
    })
    .from(labResults)
    .where(
      and(
        eq(labResults.patientId, p.patientId),
        isNull(labResults.supersededById),
        sql`${labResults.status} <> 'PRELIMINARY'`,
        sql`${labResults.collectedAt} >= ${startAt} AND ${labResults.collectedAt} < ${endAt}`,
      ),
    )
    .orderBy(asc(labResults.collectedAt));
  const scans = await executor
    .select({ performedAt: imagingOrders.performedAt })
    .from(imagingOrders)
    .where(
      and(
        eq(imagingOrders.patientId, p.patientId),
        eq(imagingOrders.modality, 'ULTRASOUND'),
        inArray(imagingOrders.status, ['PERFORMED', 'REPORTED']),
        sql`${imagingOrders.performedAt} >= ${startAt} AND ${imagingOrders.performedAt} < ${endAt}`,
      ),
    )
    .orderBy(asc(imagingOrders.performedAt));
  const ga = (at: Date) => gestationDays(p.eddDate, kosovoDay(at));
  const matches = (def: KeyTestDef) => {
    const s = def.source;
    if (s.kind === 'ULTRASOUND') {
      // A scan around the anomaly-scan window (two weeks either side) counts.
      const hit = scans.find(
        (x) =>
          x.performedAt &&
          ga(x.performedAt) >= def.fromDay - 14 &&
          ga(x.performedAt) <= def.dueByDay + 14,
      );
      return hit?.performedAt ? ga(hit.performedAt) : null;
    }
    const re = new RegExp(s.namePattern, 'i');
    // Booking tests: any time in the pregnancy; later tests: from two weeks before their window.
    const from = def.atBooking ? 0 : def.fromDay - 14;
    const hit = labs.find(
      (l) =>
        ((l.testCode !== null && s.loinc.includes(l.testCode)) || re.test(l.testName)) &&
        ga(l.collectedAt) >= from,
    );
    return hit ? ga(hit.collectedAt) : null;
  };
  return KEY_TESTS.map((def) => ({ def, doneOnDay: matches(def) }));
}

export interface PregnancyViewOptions {
  /** Clinician notes are not shown in the portal. */
  includeNotes: boolean;
  executor?: Executor;
  now?: Date;
}

/** All pregnancies of a patient (newest first) with visits, alerts, schedule and key tests. */
export async function pregnancyView(patientId: string, opts: PregnancyViewOptions) {
  const executor = opts.executor ?? db;
  const today = kosovoDay(opts.now ?? new Date());
  const rows = await executor
    .select({ p: pregnancies, facilityName: facilities.name, bookedBy: users.fullName })
    .from(pregnancies)
    .innerJoin(facilities, eq(facilities.id, pregnancies.facilityId))
    .leftJoin(users, eq(users.id, pregnancies.bookedById))
    .where(eq(pregnancies.patientId, patientId))
    .orderBy(desc(pregnancies.createdAt));
  const visitsByPregnancy = new Map<string, (VisitRow & { recordedBy: string | null })[]>();
  if (rows.length) {
    const visits = await executor
      .select({ v: antenatalVisits, recordedBy: users.fullName })
      .from(antenatalVisits)
      .leftJoin(users, eq(users.id, antenatalVisits.recordedById))
      .where(
        inArray(
          antenatalVisits.pregnancyId,
          rows.map((r) => r.p.id),
        ),
      )
      .orderBy(asc(antenatalVisits.visitAt));
    for (const { v, recordedBy } of visits) {
      const list = visitsByPregnancy.get(v.pregnancyId) ?? [];
      list.push({ ...v, recordedBy });
      visitsByPregnancy.set(v.pregnancyId, list);
    }
  }
  const out = [];
  for (const { p, facilityName, bookedBy } of rows) {
    const visits = visitsByPregnancy.get(p.id) ?? [];
    const flags = pregnancyFlags(p, p.status === 'ONGOING' ? today : toDay(p.endedAt ?? p.updatedAt));
    const todayGa = gestationDays(p.eddDate, today);
    const booking = bookingGestation(p);
    const risk = decodeRiskFactors(p.riskFactors);
    const tests = await keyTestsDone(p, executor);
    const lastVisit = visits.at(-1);
    out.push({
      id: p.id,
      status: p.status,
      facilityId: p.facilityId,
      facilityName,
      bookedBy,
      bookedAt: p.createdAt,
      lmpDate: p.lmpDate,
      eddDate: p.eddDate,
      eddMethod: p.eddMethod,
      gravida: p.gravida,
      para: p.para,
      riskLevel: p.riskLevel,
      riskFactors: risk.codes,
      otherRiskNote: risk.otherNote,
      endedAt: p.endedAt,
      outcomeNote: opts.includeNotes ? p.outcomeNote : null,
      birthId: p.birthId,
      bookingGestationDays: booking,
      bookingGestation: formatGestation(booking),
      ...flags,
      nextVisitDate: lastVisit?.nextVisitDate ?? null,
      visits: visits
        .slice()
        .reverse()
        .map((v) => ({
          id: v.id,
          visitAt: v.visitAt,
          gestationDays: v.gestationDays,
          gestation: formatGestation(v.gestationDays),
          systolic: v.systolic,
          diastolic: v.diastolic,
          weightKg: v.weightKg,
          fundalHeightCm: v.fundalHeightCm,
          fetalHeartRate: v.fetalHeartRate,
          presentation: v.presentation,
          urineProtein: v.urineProtein,
          oedema: v.oedema,
          fetalMovements: v.fetalMovements,
          nextVisitDate: v.nextVisitDate,
          notes: opts.includeNotes ? v.notes : null,
          recordedBy: opts.includeNotes ? v.recordedBy : null,
          alerts: visitAlerts(v),
        })),
      schedule: scheduleFor(p, visits, today),
      keyTests: tests.map(({ def, doneOnDay }) => ({
        code: def.code,
        label: def.label,
        fromWeek: Math.floor(def.fromDay / 7),
        dueByWeek: Math.floor(def.dueByDay / 7),
        state: keyTestState(def, doneOnDay, booking, todayGa, p.status !== 'ONGOING'),
        doneAtGestation: doneOnDay === null ? null : formatGestation(doneOnDay),
      })),
    });
  }
  return out;
}

/**
 * Birth registration hook: the mother's ongoing pregnancy ends as DELIVERED and is linked to the
 * birth. Twins: the second birth finds the pregnancy already closed and leaves it as it is.
 */
export async function closePregnancyOnBirth(
  motherPatientId: string,
  birthId: string,
  bornAt: Date,
  executor: Executor,
) {
  const rows = await executor
    .update(pregnancies)
    .set({ status: 'DELIVERED', endedAt: bornAt, birthId })
    .where(and(eq(pregnancies.patientId, motherPatientId), eq(pregnancies.status, 'ONGOING')))
    .returning({ id: pregnancies.id });
  return rows[0]?.id ?? null;
}

/* ------------------------------------------------------------------------ dashboards -- */

/** Ongoing pregnancies with their visits (for worklists and the facility dashboard). */
export async function ongoingWithVisits(where: ReturnType<typeof and>) {
  const rows = await db
    .select()
    .from(pregnancies)
    .where(and(eq(pregnancies.status, 'ONGOING'), where))
    .orderBy(asc(pregnancies.eddDate))
    .limit(5000);
  const visits = rows.length
    ? await db
        .select()
        .from(antenatalVisits)
        .where(
          inArray(
            antenatalVisits.pregnancyId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(antenatalVisits.visitAt))
    : [];
  const byP = new Map<string, VisitRow[]>();
  for (const v of visits) byP.set(v.pregnancyId, [...(byP.get(v.pregnancyId) ?? []), v]);
  const today = kosovoDay(new Date());
  return rows.map((p) => {
    const vs = byP.get(p.id) ?? [];
    const schedule = scheduleFor(p, vs, today);
    const last = vs.at(-1);
    return {
      pregnancy: p,
      flags: pregnancyFlags(p, today),
      overdueContact: schedule.some((c) => c.state === 'OVERDUE'),
      visitCount: vs.length,
      lastVisitAt: last?.visitAt ?? null,
      nextVisitDate: last?.nextVisitDate ?? null,
      alerts: last ? visitAlerts(last) : [],
    };
  });
}

export const suppress = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);
const pct = (num: number, den: number) =>
  den >= SMALL_CELL_THRESHOLD && suppress(num) !== null
    ? Math.round((1000 * num) / den) / 10
    : null;

type AggregateRow = {
  municipality: string | null;
  booked: number;
  first_trimester: number;
  high_risk: number;
  ended: number;
  anc4: number;
  anc8: number;
};

/**
 * Maternity indicators over pregnancies booked (and ended) in the last 12 months:
 * - booked, first-trimester booking (booked before 14+0 weeks) and high-risk shares;
 * - among pregnancies ended by delivery in the period: at least 4 and at least 8 antenatal visits.
 * Counts below SMALL_CELL_THRESHOLD (1–4) are suppressed together with their percentages.
 */
export async function maternityIndicators(opts: {
  facilityId: string | null;
  byMunicipality: boolean;
}) {
  const facility = opts.facilityId ? sql`AND p.facility_id = ${opts.facilityId}` : sql``;
  const group = opts.byMunicipality ? sql`pt.municipality` : sql`NULL::text`;
  const result = await db.execute<AggregateRow>(sql`
    WITH booked AS (
      SELECT p.*, ${group} AS municipality,
        280 - ((p.edd_date - (p.created_at AT TIME ZONE 'Europe/Belgrade')::date)) AS booking_ga,
        (SELECT count(*)::int FROM antenatal_visits v WHERE v.pregnancy_id = p.id) AS visits
      FROM pregnancies p JOIN patients pt ON pt.id = p.patient_id
      WHERE pt.merged_into_id IS NULL AND p.created_at >= now() - interval '365 days' ${facility}
    )
    SELECT municipality,
      count(*)::int AS booked,
      count(*) FILTER (WHERE booking_ga < 98)::int AS first_trimester,
      count(*) FILTER (WHERE risk_level = 'HIGH')::int AS high_risk,
      count(*) FILTER (WHERE status = 'DELIVERED')::int AS ended,
      count(*) FILTER (WHERE status = 'DELIVERED' AND visits >= 4)::int AS anc4,
      count(*) FILTER (WHERE status = 'DELIVERED' AND visits >= 8)::int AS anc8
    FROM booked GROUP BY municipality ORDER BY municipality NULLS LAST`);
  return result.rows.map((r) => ({
    municipality: r.municipality,
    booked: suppress(r.booked),
    firstTrimesterPct: pct(r.first_trimester, r.booked),
    highRiskPct: pct(r.high_risk, r.booked),
    delivered: suppress(r.ended),
    anc4Pct: pct(r.anc4, r.ended),
    anc8Pct: pct(r.anc8, r.ended),
  }));
}

/* ----------------------------------------------------------------- visit reminders -- */

const REMINDER_TYPE = 'antenatal_reminder';
/** Remind this many days before the planned next visit. */
export const REMINDER_DAYS_BEFORE = 3;

/**
 * Reminds the mother (and guardians with full access) of her next antenatal visit, three days
 * before the date planned at the last visit; once per visit (the notification link carries the
 * visit id). A worker that missed a day still sends while the visit is 1–3 days away.
 */
export async function runAntenatalRemindersOnce(now = new Date()): Promise<number> {
  const today = kosovoDay(now);
  const from = addDays(today, 1);
  const to = addDays(today, REMINDER_DAYS_BEFORE);
  const due = await db.execute<{ visit_id: string; patient_id: string; next_visit_date: string }>(
    sql`
    SELECT DISTINCT ON (v.pregnancy_id) v.id AS visit_id, v.patient_id,
      v.next_visit_date::text AS next_visit_date
    FROM antenatal_visits v
    JOIN pregnancies p ON p.id = v.pregnancy_id AND p.status = 'ONGOING'
    JOIN patients pt ON pt.id = v.patient_id
    WHERE pt.merged_into_id IS NULL AND pt.deceased_at IS NULL
    ORDER BY v.pregnancy_id, v.visit_at DESC`,
  );
  let sent = 0;
  for (const row of due.rows) {
    if (!row.next_visit_date || row.next_visit_date < from || row.next_visit_date > to) continue;
    const delivered = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`antenatal:${row.visit_id}`}))`);
      const [already] = (
        await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM notifications
          WHERE type = ${REMINDER_TYPE} AND link LIKE ${`%visit=${row.visit_id}%`}`)
      ).rows;
      if ((already?.n ?? 0) > 0) return false;
      await notifyPatient(
        row.patient_id,
        {
          type: REMINDER_TYPE,
          title: 'Your next pregnancy check-up is on {date}',
          body: 'Bring your pregnancy card. Contact your midwife or doctor if you cannot come.',
          vars: { date: new Date(`${row.next_visit_date}T12:00:00Z`) },
          link: `/portal/pregnancy?visit=${row.visit_id}&patient=${row.patient_id}`,
        },
        tx,
      );
      return true;
    });
    if (delivered) sent++;
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runAntenatalRemindersOnce().then(
    (n) => n && logger.info({ reminders: n }, 'Antenatal visit reminders sent'),
    (err: unknown) => logger.error({ err }, 'Antenatal reminder worker failed'),
  );
}

/** Daily (first run ten minutes after start). Not started in tests. */
export function startMaternityWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 10 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 24 * 60 * 60_000);
  timer.unref();
}

export function stopMaternityWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}
