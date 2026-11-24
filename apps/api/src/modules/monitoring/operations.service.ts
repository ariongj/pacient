import { eq, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { opsHeartbeats } from '../../db/schema.js';
import { registeredWorkers, WORKER_NAMES, type WorkerName } from '../../lib/worker-runs.js';

/**
 * Whether the background workers and the jobs outside the API (backups) still do their work, for
 * System health, /metrics and the watchdog. Times, counts and short errors only.
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Text from a worker or a mail server shown to the operator, without anything that identifies a
 * record or a person: record ids (a database error names the row it failed on), e-mail addresses
 * and long numbers such as personal or phone numbers.
 */
export function withoutIdentifiers(text: string): string {
  return text
    .replace(UUID, '…')
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+/g, '…@…')
    .replace(/\d{8,}/g, '…');
}

/** A worker is stale after this many of its intervals without a successful run. */
export const STALE_FACTOR = 3;
/** The nightly backup is late after this long (a day plus the timer's random delay and slack). */
export const BACKUP_MAX_AGE_MS = 26 * 60 * 60_000;

/**
 * When this process started its workers (they are registered while it starts). Staleness is
 * counted from here when that is later than the last success, so a restart after a stop or an
 * outage is not reported as a stall before the workers had their chance to run.
 */
export const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

export interface WorkerStatus {
  name: WorkerName;
  /** Started by this API process (switched-off workers and other instances' workers are not). */
  running: boolean;
  /** How often it should succeed (null when not running here). */
  intervalSeconds: number | null;
  lastRunAt: Date | null;
  lastRunOk: boolean | null;
  lastOkAt: Date | null;
  /** The most recent failure in the last 7 days, without e-mail addresses, numbers or record ids. */
  lastError: { at: Date; text: string | null } | null;
  /** Running here, and no successful run for three of its intervals. */
  stale: boolean;
}

const ERROR_WINDOW_DAYS = 7;

/**
 * The reference for staleness: the last success, or the start of this process if later. Exposed
 * as pacient_worker_last_success_timestamp_seconds so the Prometheus rule judges like the
 * watchdog does.
 */
export const successReference = (lastOkAt: Date | null) =>
  new Date(Math.max(lastOkAt?.getTime() ?? 0, PROCESS_STARTED_AT.getTime()));

export function isStale(lastOkAt: Date | null, intervalMs: number, now = new Date()): boolean {
  return now.getTime() - successReference(lastOkAt).getTime() > STALE_FACTOR * intervalMs;
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
let cache: { at: number; rows: Row[] } | null = null;

/**
 * Last run, last success and last failure of every known worker, three index look-ups each on
 * (worker, started_at desc). Cached for 15 seconds: System health refreshes every 30 seconds and
 * Prometheus scrapes every 15. The email and SMS workers run every few seconds, so the failure
 * look-up is limited to the last 7 days.
 */
async function lastRuns(fresh: boolean): Promise<Row[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const names = sql.join(
    WORKER_NAMES.map((n) => sql`${n}`),
    sql`, `,
  );
  const result = await db.execute<Row>(sql`
    SELECT w.name,
           last.started_at AS last_started, last.ok AS last_ok,
           good.finished_at AS last_ok_at,
           bad.started_at AS error_at, bad.error AS error_text
      FROM unnest(ARRAY[${names}]::text[]) AS w(name)
      LEFT JOIN LATERAL (
        SELECT started_at, ok FROM worker_runs WHERE worker = w.name
         ORDER BY started_at DESC LIMIT 1) last ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(finished_at, started_at) AS finished_at FROM worker_runs
         WHERE worker = w.name AND ok ORDER BY started_at DESC LIMIT 1) good ON true
      LEFT JOIN LATERAL (
        SELECT started_at, error FROM worker_runs
         WHERE worker = w.name AND ok = false
           AND started_at > now() - make_interval(days => ${ERROR_WINDOW_DAYS})
         ORDER BY started_at DESC LIMIT 1) bad ON true`);
  const rows = result.rows.map((r) => ({
    ...r,
    last_started: r.last_started ? new Date(r.last_started) : null,
    last_ok_at: r.last_ok_at ? new Date(r.last_ok_at) : null,
    error_at: r.error_at ? new Date(r.error_at) : null,
  }));
  cache = { at: Date.now(), rows };
  return rows;
}

/** Clears the cache (tests, and the watchdog wants fresh data). */
export function clearWorkerStatusCache() {
  cache = null;
}

/**
 * Every worker started by this process, and every other one that recorded a run in the last 30
 * days (another API instance's, or one switched off since), in the order of WORKER_NAMES.
 */
export async function workerStatuses(
  opts: { now?: Date; fresh?: boolean } = {},
): Promise<WorkerStatus[]> {
  const now = opts.now ?? new Date();
  const intervals = new Map(registeredWorkers().map((w) => [w.name, w.intervalMs]));
  const rows = await lastRuns(Boolean(opts.fresh));
  return rows
    .filter((r) => intervals.has(r.name as WorkerName) || r.last_started)
    .map((r) => {
      const intervalMs = intervals.get(r.name as WorkerName) ?? null;
      return {
        name: r.name as WorkerName,
        running: intervalMs !== null,
        intervalSeconds: intervalMs === null ? null : Math.round(intervalMs / 1000),
        lastRunAt: r.last_started,
        lastRunOk: r.last_started ? Boolean(r.last_ok) : null,
        lastOkAt: r.last_ok_at,
        lastError: r.error_at
          ? { at: r.error_at, text: r.error_text && withoutIdentifiers(r.error_text) }
          : null,
        stale: intervalMs !== null && isStale(r.last_ok_at, intervalMs, now),
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
