import { createHash, createHmac } from 'node:crypto';
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { env, isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  appointments,
  careUnits,
  complaints,
  edVisits,
  facilities,
  feedbackResponses,
  notifications,
  patients,
  users,
} from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  ACKNOWLEDGE_WORKING_DAYS,
  ESCALATION_DAYS,
  FEEDBACK_ITEMS,
  FEEDBACK_WINDOW_DAYS,
  RECENT_CARE_YEARS,
  REMINDER_DAYS_BEFORE,
  RESPONSE_DAYS,
  type FeedbackSetting,
} from './complaints.constants.js';

const DAY = 86_400_000;

/* ------------------------------------------------------------------------------- references -- */

const kosovoParts = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    weekday: 'short',
  }).formatToParts(d);
  return {
    year: Number(parts.find((p) => p.type === 'year')!.value),
    weekday: parts.find((p) => p.type === 'weekday')!.value,
  };
};

/**
 * Next reference "ANK-<year>-<5 digits>" (ankesë). Callers run inside a transaction: the advisory
 * lock serialises concurrent submissions; the unique index is the backstop.
 */
export async function nextComplaintReference(tx: Executor, now = new Date()): Promise<string> {
  const { year } = kosovoParts(now);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('complaints.reference'))`);
  const result = await tx.execute<{ max: string | null }>(sql`
    SELECT max(reference) AS max FROM complaints WHERE reference LIKE ${`ANK-${year}-%`}`);
  const last = result.rows[0]?.max;
  const n = last ? Number(last.slice(-5)) + 1 : 1;
  return `ANK-${year}-${String(n).padStart(5, '0')}`;
}

/* -------------------------------------------------------------------------------- deadlines -- */

/** Adds working days (Monday–Friday in Kosovo; public holidays are not considered). */
export function addWorkingDays(from: Date, days: number): Date {
  let d = new Date(from);
  let added = 0;
  while (added < days) {
    d = new Date(d.getTime() + DAY);
    const { weekday } = kosovoParts(d);
    if (weekday !== 'Sat' && weekday !== 'Sun') added++;
  }
  return d;
}

export function deadlinesFor(receivedAt: Date) {
  return {
    acknowledgeDueAt: addWorkingDays(receivedAt, ACKNOWLEDGE_WORKING_DAYS),
    responseDueAt: new Date(receivedAt.getTime() + RESPONSE_DAYS * DAY),
  };
}

type ComplaintRow = typeof complaints.$inferSelect;

/** Overdue flags and the escalation window, computed for display (never stored). */
export function timingOf(c: ComplaintRow, now = new Date()) {
  const open = c.status !== 'CLOSED' && c.status !== 'ESCALATED';
  const acknowledgeOverdue =
    !c.acknowledgedAt && open && now.getTime() > c.acknowledgeDueAt.getTime();
  const responseOverdue =
    !c.respondedAt &&
    c.status !== 'CLOSED' &&
    c.status !== 'ESCALATED' &&
    now.getTime() > c.responseDueAt.getTime();
  const escalateUntil = c.respondedAt
    ? new Date(c.respondedAt.getTime() + ESCALATION_DAYS * DAY)
    : null;
  const canEscalate =
    Boolean(c.respondedAt) &&
    !c.escalatedAt &&
    c.outcome !== 'WITHDRAWN' &&
    (c.status === 'RESPONDED' || c.status === 'CLOSED') &&
    escalateUntil !== null &&
    now.getTime() <= escalateUntil.getTime();
  const canWithdraw =
    c.status === 'RECEIVED' || c.status === 'ACKNOWLEDGED' || c.status === 'INVESTIGATING';
  return { acknowledgeOverdue, responseOverdue, escalateUntil, canEscalate, canWithdraw };
}

/* ----------------------------------------------------------------------- care at a facility -- */

/** Whether the patient had care at the facility (appointment, stay or emergency visit) recently. */
export async function hadRecentCare(patientId: string, facilityId: string, now = new Date()) {
  const since = new Date(now.getTime() - RECENT_CARE_YEARS * 365 * DAY);
  const result = await db.execute<{ found: boolean }>(sql`
    SELECT (
      EXISTS (SELECT 1 FROM appointments WHERE patient_id = ${patientId} AND facility_id = ${facilityId}
              AND scheduled_at >= ${since} AND status IN ('COMPLETED', 'CHECKED_IN', 'CONFIRMED'))
      OR EXISTS (SELECT 1 FROM admissions WHERE patient_id = ${patientId} AND facility_id = ${facilityId}
              AND admitted_at >= ${since} AND status <> 'CANCELLED')
      OR EXISTS (SELECT 1 FROM ed_visits WHERE patient_id = ${patientId} AND facility_id = ${facilityId}
              AND arrived_at >= ${since})
      OR EXISTS (SELECT 1 FROM encounters WHERE patient_id = ${patientId} AND facility_id = ${facilityId}
              AND started_at >= ${since})
    ) AS found`);
  return Boolean(result.rows[0]?.found);
}

/** Facilities where the patient had care in the last two years (for the complaint form). */
export async function careFacilities(patientId: string, now = new Date()) {
  const since = new Date(now.getTime() - RECENT_CARE_YEARS * 365 * DAY);
  const result = await db.execute<{ id: string }>(sql`
    SELECT facility_id AS id FROM appointments WHERE patient_id = ${patientId} AND scheduled_at >= ${since}
    UNION SELECT facility_id FROM admissions WHERE patient_id = ${patientId} AND admitted_at >= ${since}
    UNION SELECT facility_id FROM ed_visits WHERE patient_id = ${patientId} AND arrived_at >= ${since}
    UNION SELECT facility_id FROM encounters WHERE patient_id = ${patientId} AND started_at >= ${since}`);
  return new Set(result.rows.map((r) => r.id));
}

/* ------------------------------------------------------------------------------ recipients -- */

/** Who hears about a complaint's progress: whoever submitted it, else the patient's portal account. */
export async function complainantIds(c: ComplaintRow, executor: Executor = db) {
  if (c.submittedByUserId) return [c.submittedByUserId];
  if (!c.patientId) return [];
  const [p] = await executor
    .select({ userId: patients.userId })
    .from(patients)
    .where(eq(patients.id, c.patientId));
  return p?.userId ? [p.userId] : [];
}

export async function directorIds(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    );
  return rows.map((r) => r.id);
}

export async function ministryIds(executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'MINISTRY'), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}

/* -------------------------------------------------------------------------------- feedback -- */

/**
 * Feedback is anonymous: the response stores no patient, user or visit. The dedupe key is an
 * HMAC of the visit with a server secret, so the same visit cannot be rated twice while the
 * response cannot be linked back to the visit without that secret. Invitations use a different
 * key, so a notification cannot be matched to a response either.
 */
const feedbackKey = createHash('sha256')
  .update(`pacient-feedback:${env.MFA_ENCRYPTION_KEY}`)
  .digest();
const inviteKey = createHash('sha256')
  .update(`pacient-feedback-invite:${env.MFA_ENCRYPTION_KEY}`)
  .digest();

export const dedupeKeyFor = (setting: FeedbackSetting, visitId: string) =>
  createHmac('sha256', feedbackKey).update(`${setting}:${visitId}`).digest('hex');
const inviteTokenFor = (setting: FeedbackSetting, visitId: string) =>
  createHmac('sha256', inviteKey).update(`${setting}:${visitId}`).digest('hex').slice(0, 32);

export interface RateableVisit {
  setting: FeedbackSetting;
  visitId: string;
  facilityId: string;
  facilityName: string;
  unitId: string | null;
  unitName: string | null;
  endedAt: Date;
}

/**
 * Visits of the patient that ended in the last 30 days (completed appointments and video visits,
 * discharges, emergency attendances). With `appointmentsOnly` (a guardian with appointment-only
 * access) stays and emergency visits are left out.
 */
export async function recentVisits(
  patientId: string,
  opts: { appointmentsOnly?: boolean; now?: Date; endedAfter?: Date; endedBefore?: Date } = {},
): Promise<RateableVisit[]> {
  const now = opts.now ?? new Date();
  const from = opts.endedAfter ?? new Date(now.getTime() - FEEDBACK_WINDOW_DAYS * DAY);
  const to = opts.endedBefore ?? now;
  const out: RateableVisit[] = [];
  const appts = await db
    .select({
      id: appointments.id,
      mode: appointments.mode,
      at: appointments.scheduledAt,
      facilityId: appointments.facilityId,
      facilityName: facilities.name,
    })
    .from(appointments)
    .innerJoin(facilities, eq(facilities.id, appointments.facilityId))
    .where(
      and(
        eq(appointments.patientId, patientId),
        eq(appointments.status, 'COMPLETED'),
        gte(appointments.scheduledAt, from),
        lte(appointments.scheduledAt, to),
      ),
    );
  for (const a of appts) {
    out.push({
      setting: a.mode === 'VIDEO' ? 'VIDEO' : 'OUTPATIENT',
      visitId: a.id,
      facilityId: a.facilityId,
      facilityName: a.facilityName,
      unitId: null,
      unitName: null,
      endedAt: a.at,
    });
  }
  if (!opts.appointmentsOnly) {
    const stays = await db
      .select({
        id: admissions.id,
        at: admissions.dischargedAt,
        facilityId: admissions.facilityId,
        facilityName: facilities.name,
        unitId: admissions.unitId,
        unitName: careUnits.name,
      })
      .from(admissions)
      .innerJoin(facilities, eq(facilities.id, admissions.facilityId))
      .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
      .where(
        and(
          eq(admissions.patientId, patientId),
          eq(admissions.status, 'DISCHARGED'),
          or(isNull(admissions.disposition), ne(admissions.disposition, 'DECEASED')),
          isNotNull(admissions.dischargedAt),
          gte(admissions.dischargedAt, from),
          lte(admissions.dischargedAt, to),
        ),
      );
    for (const s of stays) {
      out.push({
        setting: 'INPATIENT',
        visitId: s.id,
        facilityId: s.facilityId,
        facilityName: s.facilityName,
        unitId: s.unitId,
        unitName: s.unitName,
        endedAt: s.at!,
      });
    }
    const ed = await db
      .select({
        id: edVisits.id,
        at: edVisits.departedAt,
        facilityId: edVisits.facilityId,
        facilityName: facilities.name,
      })
      .from(edVisits)
      .innerJoin(facilities, eq(facilities.id, edVisits.facilityId))
      .where(
        and(
          eq(edVisits.patientId, patientId),
          inArray(edVisits.status, ['DISCHARGED', 'ADMITTED', 'TRANSFERRED']),
          isNotNull(edVisits.departedAt),
          gte(edVisits.departedAt, from),
          lte(edVisits.departedAt, to),
        ),
      );
    for (const e of ed) {
      out.push({
        setting: 'EMERGENCY',
        visitId: e.id,
        facilityId: e.facilityId,
        facilityName: e.facilityName,
        unitId: null,
        unitName: null,
        endedAt: e.at!,
      });
    }
  }
  return out.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
}

/** Recent visits not rated yet (only the HMAC tells whether a visit has been rated). */
export async function rateableVisits(
  patientId: string,
  opts: { appointmentsOnly?: boolean; now?: Date } = {},
) {
  const visits = await recentVisits(patientId, opts);
  if (!visits.length) return [];
  const keys = visits.map((v) => dedupeKeyFor(v.setting, v.visitId));
  const done = new Set(
    (
      await db
        .select({ key: feedbackResponses.dedupeKey })
        .from(feedbackResponses)
        .where(inArray(feedbackResponses.dedupeKey, keys))
    ).map((r) => r.key),
  );
  return visits.filter((_, i) => !done.has(keys[i]!));
}

/** First day of the month in Kosovo time, as YYYY-MM-01 (feedback keeps only the month). */
export function monthOf(d: Date): string {
  const ym = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
  }).format(d);
  return `${ym}-01`;
}

/* ---------------------------------------------------------------------------- dashboards -- */

export const suppressed = (n: number) => n > 0 && n < SMALL_CELL_THRESHOLD;

export interface FeedbackGroup {
  key: string;
  label?: string;
  responses: number | null;
  overall: number | null;
  items: Record<string, number | null>;
  recommendPct: number | null;
  suppressed: boolean;
}

interface FeedbackAgg {
  key: string;
  label: string | null;
  n: number;
  overall: number | null;
  recommend_yes: number;
  recommend_n: number;
  [item: string]: unknown;
}

const round1 = (v: unknown) =>
  v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;

function toGroup(r: FeedbackAgg): FeedbackGroup {
  const n = Number(r.n);
  if (suppressed(n)) {
    return {
      key: r.key,
      label: r.label ?? undefined,
      responses: null,
      overall: null,
      items: Object.fromEntries(FEEDBACK_ITEMS.map((i) => [i, null])),
      recommendPct: null,
      suppressed: true,
    };
  }
  return {
    key: r.key,
    label: r.label ?? undefined,
    responses: n,
    overall: round1(r.overall),
    items: Object.fromEntries(FEEDBACK_ITEMS.map((i) => [i, round1(r[`i_${i}`])])),
    recommendPct:
      Number(r.recommend_n) > 0
        ? Math.round((Number(r.recommend_yes) / Number(r.recommend_n)) * 100)
        : null,
    suppressed: false,
  };
}

const itemColumns = sql.join(
  FEEDBACK_ITEMS.map((i) => sql`avg((f.scores ->> ${i})::numeric) AS ${sql.identifier(`i_${i}`)}`),
  sql`, `,
);

/**
 * Feedback averages for a facility (or nationally), grouped. Groups with fewer responses than the
 * small-cell threshold are suppressed so that a single person's rating cannot be singled out.
 */
export async function feedbackGroups(
  groupBy: 'all' | 'month' | 'setting' | 'unit' | 'facility',
  opts: { facilityId?: string; since: string },
): Promise<FeedbackGroup[]> {
  const where = sql`f.month >= ${opts.since}${opts.facilityId ? sql` AND f.facility_id = ${opts.facilityId}` : sql``}`;
  const keyExpr = {
    all: sql`'all'`,
    month: sql`to_char(f.month, 'YYYY-MM')`,
    setting: sql`f.setting`,
    unit: sql`f.unit_id::text`,
    facility: sql`f.facility_id::text`,
  }[groupBy];
  const labelExpr = {
    all: sql`NULL`,
    month: sql`NULL`,
    setting: sql`NULL`,
    unit: sql`max(u.name)`,
    facility: sql`max(fa.name)`,
  }[groupBy];
  const result = await db.execute<FeedbackAgg>(sql`
    SELECT ${keyExpr} AS key, ${labelExpr} AS label, count(*)::int AS n,
      avg(f.overall)::numeric AS overall,
      count(*) FILTER (WHERE f.would_recommend)::int AS recommend_yes,
      count(f.would_recommend)::int AS recommend_n,
      ${itemColumns}
    FROM feedback_responses f
    LEFT JOIN care_units u ON u.id = f.unit_id
    LEFT JOIN facilities fa ON fa.id = f.facility_id
    WHERE ${where}${groupBy === 'unit' ? sql` AND f.unit_id IS NOT NULL` : sql``}
    GROUP BY 1 ORDER BY 1`);
  return result.rows.map(toGroup);
}

/**
 * Comments for the director: only from settings with at least the threshold of responses in the
 * window, shown with month and setting only (no unit), newest first.
 */
export async function feedbackComments(facilityId: string, since: string, limit = 50) {
  const result = await db.execute<{
    month: string;
    setting: string;
    overall: number;
    comment: string;
  }>(sql`
    WITH big AS (
      SELECT setting FROM feedback_responses WHERE facility_id = ${facilityId} AND month >= ${since}
      GROUP BY setting HAVING count(*) >= ${SMALL_CELL_THRESHOLD}
    )
    SELECT to_char(f.month, 'YYYY-MM') AS month, f.setting, f.overall, f.comment
    FROM feedback_responses f
    WHERE f.facility_id = ${facilityId} AND f.month >= ${since}
      AND f.comment IS NOT NULL AND f.comment <> '' AND f.setting IN (SELECT setting FROM big)
    ORDER BY f.month DESC, f.created_at DESC LIMIT ${limit}`);
  return result.rows;
}

/** Complaint counts by key for a facility (or nationally) received since `since`. */
export async function complaintCounts(
  column: 'category' | 'status' | 'outcome' | 'month' | 'facility',
  opts: { facilityId?: string; since: Date },
) {
  const expr = {
    category: sql`c.category`,
    status: sql`c.status`,
    outcome: sql`coalesce(c.outcome, 'NONE')`,
    month: sql`to_char(c.created_at AT TIME ZONE 'Europe/Belgrade', 'YYYY-MM')`,
    facility: sql`c.facility_id::text`,
  }[column];
  const result = await db.execute<{ key: string; label: string | null; count: number }>(sql`
    SELECT ${expr} AS key, ${column === 'facility' ? sql`max(f.name)` : sql`NULL`} AS label,
      count(*)::int AS count
    FROM complaints c JOIN facilities f ON f.id = c.facility_id
    WHERE c.created_at >= ${opts.since}${opts.facilityId ? sql` AND c.facility_id = ${opts.facilityId}` : sql``}
    GROUP BY 1 ORDER BY 3 DESC, 1`);
  return result.rows.map((r) => ({ key: r.key, label: r.label, count: Number(r.count) }));
}

/** Share of complaints acknowledged / responded to within their deadline. */
export async function complaintTimeliness(opts: { facilityId?: string; since: Date; now?: Date }) {
  const now = opts.now ?? new Date();
  const result = await db.execute<{
    ack_due: number;
    ack_on_time: number;
    resp_due: number;
    resp_on_time: number;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE acknowledged_at IS NOT NULL OR acknowledge_due_at < ${now})::int AS ack_due,
      count(*) FILTER (WHERE acknowledged_at IS NOT NULL AND acknowledged_at <= acknowledge_due_at)::int AS ack_on_time,
      count(*) FILTER (WHERE (responded_at IS NOT NULL OR response_due_at < ${now})
                        AND coalesce(outcome, '') <> 'WITHDRAWN')::int AS resp_due,
      count(*) FILTER (WHERE responded_at IS NOT NULL AND responded_at <= response_due_at)::int AS resp_on_time
    FROM complaints
    WHERE created_at >= ${opts.since}${opts.facilityId ? sql` AND facility_id = ${opts.facilityId}` : sql``}`);
  const r = result.rows[0]!;
  const pct = (a: number, b: number) =>
    Number(b) > 0 ? Math.round((Number(a) / Number(b)) * 100) : null;
  return {
    acknowledgedOnTimePct: pct(r.ack_on_time, r.ack_due),
    acknowledgementsDue: Number(r.ack_due),
    respondedOnTimePct: pct(r.resp_on_time, r.resp_due),
    responsesDue: Number(r.resp_due),
  };
}

/* ---------------------------------------------------------------------------------- worker -- */

const reminderLink = (id: string, kind: string) => `/complaints?complaint=${id}&reminder=${kind}`;

async function alreadySent(link: string) {
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.link, link))
    .limit(1);
  return Boolean(row);
}

/**
 * Deadline reminders to the handler (the assignee, else the facility's directors): once three
 * days before and once on the deadline, for acknowledgement and for the response. The link of the
 * reminder notification records that it was sent. Then invitations to rate visits that ended
 * yesterday (once per visit; the invitation token is unrelated to the feedback dedupe key).
 */
export async function runComplaintsWorker(now = new Date()) {
  let reminders = 0;
  const open = await db
    .select()
    .from(complaints)
    .where(
      and(
        inArray(complaints.status, ['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING']),
        or(
          and(
            isNull(complaints.acknowledgedAt),
            lte(complaints.acknowledgeDueAt, new Date(now.getTime() + REMINDER_DAYS_BEFORE * DAY)),
          ),
          and(
            isNull(complaints.respondedAt),
            lte(complaints.responseDueAt, new Date(now.getTime() + REMINDER_DAYS_BEFORE * DAY)),
          ),
        ),
      ),
    );
  for (const c of open) {
    const recipients = c.assignedToId ? [c.assignedToId] : await directorIds(c.facilityId);
    const checks: { kind: string; due: Date | null; title: string }[] = [
      {
        kind: 'acknowledge',
        due: c.acknowledgedAt ? null : c.acknowledgeDueAt,
        title: 'Complaint {reference}: acknowledgement due {due}',
      },
      {
        kind: 'response',
        due: c.respondedAt ? null : c.responseDueAt,
        title: 'Complaint {reference}: response due {due}',
      },
    ];
    for (const check of checks) {
      if (!check.due) continue;
      const stages: { stage: string; at: Date; title: string }[] = [
        {
          stage: 'soon',
          at: new Date(check.due.getTime() - REMINDER_DAYS_BEFORE * DAY),
          title: check.title,
        },
        {
          stage: 'due',
          at: check.due,
          title:
            check.kind === 'acknowledge'
              ? 'Complaint {reference}: the acknowledgement deadline has been reached'
              : 'Complaint {reference}: the response deadline has been reached',
        },
      ];
      for (const s of stages) {
        if (now.getTime() < s.at.getTime()) continue;
        const link = reminderLink(c.id, `${check.kind}-${s.stage}`);
        if (await alreadySent(link)) continue;
        await notifyUsers(recipients, {
          type: 'complaint.deadline',
          title: s.title,
          vars: { reference: c.reference, due: check.due },
          link,
          important: s.stage === 'due',
        });
        reminders++;
      }
    }
  }

  // Invitations to rate visits that ended in the last 24–48 hours.
  let invitations = 0;
  const windowStart = new Date(now.getTime() - 2 * DAY);
  const windowEnd = new Date(now.getTime() - DAY);
  const candidates = await db.execute<{ patient_id: string }>(sql`
    SELECT DISTINCT patient_id FROM appointments WHERE status = 'COMPLETED'
      AND scheduled_at >= ${windowStart} AND scheduled_at < ${windowEnd}
    UNION SELECT patient_id FROM admissions WHERE status = 'DISCHARGED'
      AND discharged_at >= ${windowStart} AND discharged_at < ${windowEnd}
    UNION SELECT patient_id FROM ed_visits WHERE departed_at >= ${windowStart} AND departed_at < ${windowEnd}`);
  const ids = candidates.rows.map((r) => r.patient_id);
  if (ids.length) {
    const accounts = await db
      .select({ id: patients.id, userId: patients.userId, deceasedAt: patients.deceasedAt })
      .from(patients)
      .where(and(inArray(patients.id, ids), isNotNull(patients.userId)));
    for (const p of accounts) {
      if (p.deceasedAt || !p.userId) continue;
      const visits = await recentVisits(p.id, {
        now,
        endedAfter: windowStart,
        endedBefore: windowEnd,
      });
      for (const v of visits) {
        const link = `/portal/complaints?tab=feedback&invite=${inviteTokenFor(v.setting, v.visitId)}`;
        if (await alreadySent(link)) continue;
        await notifyUsers([p.userId], {
          type: 'feedback.invite',
          title: 'How was your visit to {facility}? Tell us anonymously',
          vars: { facility: v.facilityName },
          link,
        });
        invitations++;
      }
    }
  }
  return { reminders, invitations };
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runComplaintsWorker().then(
    (r) =>
      (r.reminders || r.invitations) &&
      logger.info(r, 'Complaint reminders and feedback invitations sent'),
    (err: unknown) => logger.error({ err }, 'Complaints worker failed'),
  );
}

/** Daily (first run three minutes after start). Not in tests. */
export function startComplaintsWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 180_000);
  first.unref();
  timer = setInterval(runSafely, DAY);
  timer.unref();
}

export function stopComplaintsWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}
