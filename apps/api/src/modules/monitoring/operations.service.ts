import { eq, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { opsHeartbeats } from '../../db/schema.js';
import {
  maskIdentifiers,
  registeredWorkers,
  storedErrorText,
  WORKER_NAMES,
  type WorkerName,
} from '../../lib/worker-runs.js';

/**
 * Whether the background workers and the jobs outside the API (backups) still do their work, for
 * System health, /metrics and the watchdog. Times, counts and short errors only.
 */

/**
 * Text from a worker or a mail server shown to the operator, without anything that identifies a
 * record or a person: record ids (a database error names the row it failed on), e-mail addresses
 * and long numbers such as personal or phone numbers.
 */
export function withoutIdentifiers(text: string): string {
  return maskIdentifiers(text);
}

/** A worker is stale after this many of its intervals without a successful run… */
export const STALE_FACTOR = 3;
/**
 * …and never sooner than this. The e-mail and SMS workers run every 5 seconds, but one batch (20
 * messages, each over its own SMTP connection, invoices with their PDF) can take longer than three
 * of those, and the run is recorded only when the batch ends.
 */
export const STALE_MIN_MS = 5 * 60_000;
/** How long a worker may go without a successful run before it is stalled. */
export const staleAfterMs = (intervalMs: number) =>
  Math.max(STALE_FACTOR * intervalMs, STALE_MIN_MS);
/** The nightly backup is late after this long (a day plus the timer's random delay and slack). */
export const BACKUP_MAX_AGE_MS = 26 * 60 * 60_000;

/**
 * When this process started its workers (they are registered while it starts). Staleness is
 * counted from here when that is later than the last success, so a restart after a stop or an
 * outage is not reported as a stall before the workers had their chance to run. Exported as
 * pacient_process_start_time_seconds, so that the Prometheus rule judges the same way.
 */
export const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

export interface WorkerStatus {
  name: WorkerName;
  /** Started by this API process (switched-off workers and other instances' workers are not). */
  running: boolean;
  /** How often it should succeed (null when not running here). */
  intervalSeconds: number | null;
  /** How long without a successful run it may go before it is stalled (null when not running here). */
  staleAfterSeconds: number | null;
  lastRunAt: Date | null;
  lastRunOk: boolean | null;
  lastOkAt: Date | null;
  /**
   * The most recent failure in the last 7 days: the error's class and cause, never the data it
   * failed on (worker-runs.ts, errorText), without e-mail addresses, numbers or record ids.
   */
  lastError: { at: Date; text: string | null } | null;
  /**
   * Running here, and no successful run for staleAfterSeconds. Null for a worker this process does
   * not run: it cannot judge it (another instance may run it, or it is switched off).
   */
  stale: boolean | null;
}

const ERROR_WINDOW_DAYS = 7;

/** The reference for staleness: the last success, or the start of this process if later. */
export const successReference = (lastOkAt: Date | null) =>
  new Date(Math.max(lastOkAt?.getTime() ?? 0, PROCESS_STARTED_AT.getTime()));

export function isStale(lastOkAt: Date | null, intervalMs: number, now = new Date()): boolean {
  return now.getTime() - successReference(lastOkAt).getTime() > staleAfterMs(intervalMs);
}

type Row = {
  name: string;
  last_started: Date | null;
  last_ok: boolean | null;
  last_ok_at: Date | null;
  error_at: Date | null;
  error_text: string | null;
};

const CACHE_MS = 15_000;
/** The rows, and when they were read (the time their staleness is judged at). */
let cache: { at: number; rows: Row[] } | null = null;

/**
 * Last run, last success and last failure of every known worker: three index look-ups each. The
 * ORDER BY matches the indexes exactly – (worker, started_at DESC NULLS LAST), and the partial
 * one WHERE ok = false for the failure, so that a healthy worker's successful runs are not walked
 * (migrations 0028, 0029) – because a plain DESC (nulls first) cannot use them and sorts every
 * run of the worker instead. The failure look-up is limited to the last 7 days.
 */
export const lastRunsQuery = () => sql`
    SELECT w.name,
           last.started_at AS last_started, last.ok AS last_ok,
           good.finished_at AS last_ok_at,
           bad.started_at AS error_at, bad.error AS error_text
      FROM unnest(ARRAY[${sql.join(
        WORKER_NAMES.map((n) => sql`${n}`),
        sql`, `,
      )}]::text[]) AS w(name)
      LEFT JOIN LATERAL (
        SELECT started_at, ok FROM worker_runs WHERE worker = w.name
         ORDER BY started_at DESC NULLS LAST LIMIT 1) last ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(finished_at, started_at) AS finished_at FROM worker_runs
         WHERE worker = w.name AND ok ORDER BY started_at DESC NULLS LAST LIMIT 1) good ON true
      LEFT JOIN LATERAL (
        SELECT started_at, error FROM worker_runs
         WHERE worker = w.name AND ok = false
           AND started_at > now() - make_interval(days => ${ERROR_WINDOW_DAYS})
         ORDER BY started_at DESC NULLS LAST LIMIT 1) bad ON true`;

/**
 * The rows of lastRunsQuery, cached for 15 seconds: System health refreshes every 30 seconds and
 * Prometheus scrapes every 15.
 */
async function lastRuns(fresh: boolean): Promise<{ at: number; rows: Row[] }> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  // The statement sees the runs as they were when it started.
  const at = Date.now();
  const result = await db.execute<Row>(lastRunsQuery());
  const rows = result.rows.map((r) => ({
    ...r,
    last_started: r.last_started ? new Date(r.last_started) : null,
    last_ok_at: r.last_ok_at ? new Date(r.last_ok_at) : null,
    error_at: r.error_at ? new Date(r.error_at) : null,
  }));
  cache = { at, rows };
  return cache;
}

/** Clears the cache (tests, and the watchdog wants fresh data). */
export function clearWorkerStatusCache() {
  cache = null;
}

/**
 * Every worker started by this process, and every other one that recorded a run in the last 30
 * days (another API instance's, or one switched off since), in the order of WORKER_NAMES.
 * Staleness is judged at `now`, by default the time the runs were read: a cached answer is as
 * true as when it was read, not stale because it waited in the cache.
 */
export async function workerStatuses(
  opts: { now?: Date; fresh?: boolean } = {},
): Promise<WorkerStatus[]> {
  const intervals = new Map(registeredWorkers().map((w) => [w.name, w.intervalMs]));
  const read = await lastRuns(Boolean(opts.fresh));
  const now = opts.now ?? new Date(read.at);
  return read.rows
    .filter((r) => intervals.has(r.name as WorkerName) || r.last_started)
    .map((r) => {
      const intervalMs = intervals.get(r.name as WorkerName) ?? null;
      return {
        name: r.name as WorkerName,
        running: intervalMs !== null,
        intervalSeconds: intervalMs === null ? null : Math.round(intervalMs / 1000),
        staleAfterSeconds: intervalMs === null ? null : Math.round(staleAfterMs(intervalMs) / 1000),
        lastRunAt: r.last_started,
        lastRunOk: r.last_started ? Boolean(r.last_ok) : null,
        lastOkAt: r.last_ok_at,
        // Cleaned again when shown: runs recorded before the cleaning could hold a query's values.
        lastError: r.error_at
          ? { at: r.error_at, text: r.error_text && storedErrorText(r.error_text) }
          : null,
        stale: intervalMs === null ? null : isStale(r.last_ok_at, intervalMs, now),
      };
    });
}

export interface BackupStatus {
  /** OPS_HEARTBEAT_TOKEN is set: deploy/backup.sh can report, and the watchdog watches. */
  monitored: boolean;
  lastOkAt: Date | null;
  /** What the script reported with it: sizes and durations only. */
  detail: Record<string, number | string> | null;
  /** Monitored, and no backup reported for 26 hours (since this process started, if never). */
  stale: boolean;
  maxAgeHours: number;
}

export async function backupStatus(now = new Date()): Promise<BackupStatus> {
  const [row] = await db.select().from(opsHeartbeats).where(eq(opsHeartbeats.name, 'backup'));
  const monitored = Boolean(env.OPS_HEARTBEAT_TOKEN);
  const lastOkAt = row?.lastOkAt ?? null;
  const since = lastOkAt ?? PROCESS_STARTED_AT;
  return {
    monitored,
    lastOkAt,
    detail: row?.detail ?? null,
    stale: monitored && now.getTime() - since.getTime() > BACKUP_MAX_AGE_MS,
    maxAgeHours: BACKUP_MAX_AGE_MS / 3_600_000,
  };
}
