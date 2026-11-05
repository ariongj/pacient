import { and, eq, sql, type SQL } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { waitingListEntries, waitingListEvents } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';

/**
 * Elective waiting lists. A patient waits for a planned procedure or a first specialist
 * appointment; the waiting time runs from the day they were added and pauses while the patient has
 * asked to postpone (SUSPENDED). Each priority has a maximum waiting time; an entry waiting longer
 * is a breach. Every change is recorded in waiting_list_events (append-only).
 */

export const SPECIALTIES = [
  'CARDIOLOGY',
  'DERMATOLOGY',
  'ENDOCRINOLOGY',
  'ENT',
  'GASTROENTEROLOGY',
  'GENERAL_SURGERY',
  'GYNAECOLOGY',
  'NEUROLOGY',
  'NEUROSURGERY',
  'OPHTHALMOLOGY',
  'ORTHOPAEDICS',
  'PAEDIATRIC_SURGERY',
  'PSYCHIATRY',
  'RHEUMATOLOGY',
  'UROLOGY',
  'VASCULAR_SURGERY',
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

/** English labels (translated in the web app and in notifications). */
export const SPECIALTY_LABELS: Record<Specialty, string> = {
  CARDIOLOGY: 'Cardiology',
  DERMATOLOGY: 'Dermatology',
  ENDOCRINOLOGY: 'Endocrinology',
  ENT: 'Ear, nose and throat',
  GASTROENTEROLOGY: 'Gastroenterology',
  GENERAL_SURGERY: 'General surgery',
  GYNAECOLOGY: 'Gynaecology',
  NEUROLOGY: 'Neurology',
  NEUROSURGERY: 'Neurosurgery',
  OPHTHALMOLOGY: 'Ophthalmology',
  ORTHOPAEDICS: 'Orthopaedics',
  PAEDIATRIC_SURGERY: 'Paediatric surgery',
  PSYCHIATRY: 'Psychiatry',
  RHEUMATOLOGY: 'Rheumatology',
  UROLOGY: 'Urology',
  VASCULAR_SURGERY: 'Vascular surgery',
};

export const PRIORITIES = ['URGENT', 'PRIORITY', 'ROUTINE'] as const;
export type Priority = (typeof PRIORITIES)[number];
/** Maximum waiting time in days per priority. */
export const MAX_WAIT_DAYS: Record<Priority, number> = { URGENT: 30, PRIORITY: 90, ROUTINE: 180 };
/** The adding doctor is warned when an unscheduled entry has used this share of its maximum. */
export const BREACH_WARNING_SHARE = 0.8;

export const ACTIVE_STATUSES = ['WAITING', 'SCHEDULED', 'SUSPENDED'] as const;
export const STATUSES = [...ACTIVE_STATUSES, 'COMPLETED', 'REMOVED'] as const;
export type WaitingStatus = (typeof STATUSES)[number];

export const REMOVAL_REASONS = [
  'TREATED_ELSEWHERE',
  'NO_LONGER_NEEDED',
  'PATIENT_DECLINED',
  'DECEASED',
  'DUPLICATE',
  'OTHER',
] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];
/** Reasons that are clinical decisions – only a doctor may remove an entry for these. */
export const CLINICAL_REMOVAL_REASONS: ReadonlySet<RemovalReason> = new Set([
  'NO_LONGER_NEEDED',
  'OTHER',
]);

const DAY_MS = 86_400_000;

/** YYYY-MM-DD in Kosovo for a moment. */
export function kosovoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Target date: added + maximum for the priority + days the patient postponed. */
export function targetDateFor(addedAt: Date, priority: Priority, suspendedDays: number): string {
  return kosovoDate(
    new Date(addedAt.getTime() + (MAX_WAIT_DAYS[priority] + suspendedDays) * DAY_MS),
  );
}

interface WaitInput {
  addedAt: Date;
  status: string;
  suspendedDays: number;
  suspendedSince: Date | null;
  completedAt: Date | null;
  updatedAt?: Date;
}

/** Whole days currently in a suspension (counted from suspendedSince). */
export const openSuspensionDays = (since: Date | null, now: Date) =>
  since ? Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS)) : 0;

/** Waiting time in days: since added (until completed), minus days postponed at the patient's request. */
export function waitingDays(e: WaitInput, now = new Date()): number {
  const end =
    e.status === 'COMPLETED' && e.completedAt
      ? e.completedAt
      : e.status === 'REMOVED' && e.updatedAt
        ? e.updatedAt
        : now;
  const total = Math.floor((end.getTime() - e.addedAt.getTime()) / DAY_MS);
  const paused =
    e.suspendedDays + (e.status === 'SUSPENDED' ? openSuspensionDays(e.suspendedSince, end) : 0);
  return Math.max(0, total - paused);
}

export function isBreached(e: WaitInput & { priority: string }, now = new Date()): boolean {
  const max = MAX_WAIT_DAYS[e.priority as Priority] ?? MAX_WAIT_DAYS.ROUTINE;
  return waitingDays(e, now) > max;
}

/* ---------------------------------------------------------------------- SQL expressions -- */

const MAX_DAYS_SQL = sql`(CASE ${waitingListEntries.priority} WHEN 'URGENT' THEN 30 WHEN 'PRIORITY' THEN 90 ELSE 180 END)`;

/** Same as waitingDays(), in SQL (for filters and aggregates). */
export const WAIT_DAYS_SQL = sql<number>`GREATEST(0,
  floor(extract(epoch FROM (CASE WHEN ${waitingListEntries.status} = 'COMPLETED'
      THEN coalesce(${waitingListEntries.completedAt}, now()) ELSE now() END) - ${waitingListEntries.addedAt}) / 86400)
  - ${waitingListEntries.suspendedDays}
  - CASE WHEN ${waitingListEntries.status} = 'SUSPENDED' AND ${waitingListEntries.suspendedSince} IS NOT NULL
      THEN floor(extract(epoch FROM now() - ${waitingListEntries.suspendedSince}) / 86400) ELSE 0 END)::int`;

export const BREACHED_SQL: SQL = sql`(${WAIT_DAYS_SQL} > ${MAX_DAYS_SQL})`;
export const MAX_DAYS = MAX_DAYS_SQL;

export const PRIORITY_ORDER_SQL = sql`(CASE ${waitingListEntries.priority} WHEN 'URGENT' THEN 0 WHEN 'PRIORITY' THEN 1 ELSE 2 END)`;

/* ------------------------------------------------------------------------------ events -- */

export async function recordEvent(
  executor: Executor,
  entry: { id: string; patientId: string },
  actorId: string | null,
  event: string,
  details: Record<string, unknown> | null = null,
  reason: string | null = null,
) {
  await executor.insert(waitingListEvents).values({
    entryId: entry.id,
    patientId: entry.patientId,
    actorId,
    event,
    details,
    reason,
  });
}

/* -------------------------------------------------------------------------- aggregates -- */

export interface WaitStats {
  count: number | null;
  medianDays: number | null;
  p90Days: number | null;
  breaches: number | null;
  suppressed: boolean;
}

/** Suppresses small groups (count below the threshold): values become null. */
export function suppress<T extends WaitStats>(row: T): T {
  if (row.count !== null && row.count < SMALL_CELL_THRESHOLD) {
    return {
      ...row,
      count: null,
      medianDays: null,
      p90Days: null,
      breaches: null,
      suppressed: true,
    };
  }
  return row;
}

/* ------------------------------------------------------------------------------ worker -- */

/**
 * Warns the adding doctor once per entry when an unscheduled entry has used 80% of its maximum
 * waiting time. The warning is remembered as a BREACH_WARNING event. Rows are locked so that two
 * API instances never warn twice.
 */
export async function runBreachWarningsOnce(): Promise<number> {
  const due = await db.execute<{ id: string }>(sql`
    SELECT e.id FROM ${waitingListEntries} e
    WHERE e.status = 'WAITING'
      AND ${sql.raw(`GREATEST(0,
        floor(extract(epoch FROM now() - e.added_at) / 86400) - e.suspended_days)`)}
          >= ${sql.raw(String(BREACH_WARNING_SHARE))} * (CASE e.priority WHEN 'URGENT' THEN 30 WHEN 'PRIORITY' THEN 90 ELSE 180 END)
      AND NOT EXISTS (SELECT 1 FROM ${waitingListEvents} ev
                      WHERE ev.entry_id = e.id AND ev.event = 'BREACH_WARNING')
    ORDER BY e.added_at
    LIMIT 500`);
  let sent = 0;
  for (const { id } of due.rows) {
    const done = await db.transaction(async (tx) => {
      const locked = await tx.execute<{ id: string }>(
        sql`SELECT id FROM waiting_list_entries WHERE id = ${id} AND status = 'WAITING' FOR UPDATE SKIP LOCKED`,
      );
      if (!locked.rows.length) return false;
      const already = await tx
        .select({ id: waitingListEvents.id })
        .from(waitingListEvents)
        .where(
          and(eq(waitingListEvents.entryId, id), eq(waitingListEvents.event, 'BREACH_WARNING')),
        )
        .limit(1);
      if (already.length) return false;
      const [entry] = await tx
        .select()
        .from(waitingListEntries)
        .where(eq(waitingListEntries.id, id));
      if (!entry) return false;
      const days = waitingDays(entry);
      const max = MAX_WAIT_DAYS[entry.priority as Priority] ?? MAX_WAIT_DAYS.ROUTINE;
      await recordEvent(tx, entry, null, 'BREACH_WARNING', { waitingDays: days, maxDays: max });
      // No patient name in the notification; the link opens the entry.
      await notifyUsers(
        [entry.addedById],
        {
          type: 'waiting_list',
          title:
            'A patient on your waiting list is close to the maximum waiting time ({days} of {max} days)',
          vars: { days, max },
          link: `/waiting-lists?entry=${entry.id}`,
          important: true,
        },
        tx,
      );
      return true;
    });
    if (done) sent++;
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;
const SIX_HOURS = 6 * 3_600_000;

function runSafely() {
  runBreachWarningsOnce().then(
    (n) => n && logger.info({ warnings: n }, 'Waiting-list breach warnings sent'),
    (err: unknown) => logger.error({ err }, 'Waiting-list breach warnings failed'),
  );
}

/** Every 6 hours (first run two minutes after start); each entry is warned once. Not in tests. */
export function startWaitingWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 120_000);
  first.unref();
  timer = setInterval(runSafely, SIX_HOURS);
  timer.unref();
}

export function stopWaitingWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}
