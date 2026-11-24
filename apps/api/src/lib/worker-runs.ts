import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workerRuns } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * A trail of what the background workers do, so the operator can see that they still run (System
 * health, the watchdog): one worker_runs row per run, with when, whether it worked, counts of what
 * it did and a short error. Never names, texts or record data.
 */

/** Stable names of the interval workers that server.ts starts (and the watchdog, round 2 S2). */
export const WORKER_NAMES = [
  'email',
  'sms',
  'cover-escalation',
  'appointment-reminders',
  'vaccination-reminders',
  'early-warning',
  'retention',
  'downtime-packs',
  'waiting-lists',
  'registers',
  'complaints',
  'licences',
  'subscriptions',
  'maternity',
  'screening',
  'sepsis',
  'equipment',
  'infection',
  'remote-monitoring',
  'dialysis',
  'mental-health',
  'proms',
  'access-reviews',
  'charge-capture',
  'surveillance',
  'watchdog',
] as const;
export type WorkerName = (typeof WORKER_NAMES)[number];

const DAY_MS = 86_400_000;
/** How long runs are kept. */
export const WORKER_RUNS_KEEP_DAYS = 30;
const ERROR_MAX = 500;

const intervals = new Map<WorkerName, number>();

/**
 * Records that `name` was started in this process and how often it is expected to succeed (for
 * most workers, its interval; for the retention job, once a day). A worker counts as stale when
 * it has had no successful run for three times this long. Workers that are switched off (no SMTP,
 * SMS not configured, tests) are never registered, so they are not reported as stale.
 */
export function registerWorker(name: WorkerName, intervalMs: number): void {
  intervals.set(name, intervalMs);
}

/** The workers started in this process, with their expected interval. */
export function registeredWorkers(): { name: WorkerName; intervalMs: number }[] {
  return [...intervals].map(([name, intervalMs]) => ({ name, intervalMs }));
}

/**
 * Counts from what a worker run returned: a number is a count, an array its length, an object its
 * numeric fields. Anything else (texts, ids) is left out, so no data can reach the trail.
 */
function countsOf(result: unknown): Record<string, number> | null {
  if (typeof result === 'number') return Number.isFinite(result) ? { count: result } : null;
  if (Array.isArray(result)) return { count: result.length };
  if (result && typeof result === 'object') {
    const counts = Object.fromEntries(
      Object.entries(result)
        .filter(([k, v]) => typeof v === 'number' && Number.isFinite(v) && k.length <= 60)
        .slice(0, 20),
    ) as Record<string, number>;
    return Object.keys(counts).length ? counts : null;
  }
  return null;
}

/**
 * The error as a short text: no stack, at most 500 characters, and nothing that looks like an
 * identifier of a person (e-mail addresses, long numbers such as personal or phone numbers).
 */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+/g, '…@…')
    .replace(/\d{8,}/g, '…')
    .slice(0, ERROR_MAX);
}

/** Deletes runs older than 30 days. Returns how many were deleted. */
export async function pruneWorkerRuns(): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM ${workerRuns} WHERE started_at < now() - make_interval(days => ${WORKER_RUNS_KEEP_DAYS})`,
  );
  return result.rowCount ?? 0;
}

let lastPrune = 0;

/**
 * Runs one pass of a worker and records it: started and finished time, ok, the counts it returned
 * (see countsOf) or the error. Never throws: a failed run is logged and recorded, and resolves to
 * undefined, so a timer callback can call it without a catch. Recording itself failing (database
 * down) is logged and does not affect the run. Old runs are pruned at most once a day.
 *
 *   timer = setInterval(() => void recordRun('dialysis', planSessions), DAY);
 */
export async function recordRun<T>(name: WorkerName, fn: () => Promise<T>): Promise<T | undefined> {
  const startedAt = new Date();
  let result: T | undefined;
  let ok = true;
  let error: string | null = null;
  try {
    result = await fn();
  } catch (err) {
    ok = false;
    error = errorText(err);
    logger.error({ err, worker: name }, 'Worker run failed');
  }
  try {
    await db.insert(workerRuns).values({
      worker: name,
      startedAt,
      finishedAt: new Date(),
      ok,
      summary: ok ? countsOf(result) : null,
      error,
    });
    if (Date.now() - lastPrune >= DAY_MS) {
      lastPrune = Date.now();
      await pruneWorkerRuns();
    }
  } catch (err) {
    logger.warn({ err, worker: name }, 'Could not record the worker run');
  }
  return result;
}
