import { DrizzleQueryError, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workerRuns } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * A trail of what the background workers do, so the operator can see that they still run (System
 * health, the watchdog): one worker_runs row per run, with when, whether it worked, counts of what
 * it did and a short error (errorText). Never names, texts or record data.
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
 * it has had no successful run for three times this long, and at least 5 minutes (staleAfterMs in
 * operations.service.ts). Workers that are switched off (no SMTP, SMS not configured, tests) are
 * never registered, so this process does not judge them.
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

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Masks what could identify a record or a person in a text shown to the operator: record ids (a
 * database error names the row it failed on), e-mail addresses and long numbers such as personal
 * or phone numbers. Ids first, so that the number mask cannot leave half of one behind.
 */
export function maskIdentifiers(text: string): string {
  return text
    .replace(UUID, '…')
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+/g, '…@…')
    .replace(/\d{8,}/g, '…');
}

/**
 * Quoted text in an error message: the values it echoes, e.g. PostgreSQL's
 * `invalid input syntax for type integer: "…"` or JavaScript's `(reading '…')`. A single quote
 * counts only at a word boundary, so that "can't" is left alone.
 */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»|`[^`\n]*`|(?<!\w)'[^'\n]*'(?!\w)/g;
const unquoted = (text: string) => text.replace(QUOTED, (m) => `${m[0]}…${m[m.length - 1]}`);

/** The class of an error ('DatabaseError', 'TypeError'), never a text of its own. */
function className(err: Error): string {
  // pg's DatabaseError is named after the protocol message ('error'); its class says more.
  const name = err.name && err.name !== 'Error' && err.name !== 'error' ? err.name : undefined;
  const cls = name ?? err.constructor?.name;
  return cls && /^[A-Za-z_$][\w$]{0,59}$/.test(cls) ? cls : 'Error';
}

type PgError = Error & { code: string; constraint?: unknown; table?: unknown; column?: unknown };
/** An error reported by PostgreSQL itself: a SQLSTATE code and a severity. */
const isPgError = (err: unknown): err is PgError =>
  err instanceof Error &&
  typeof (err as Partial<PgError>).code === 'string' &&
  /^[0-9A-Z]{5}$/.test((err as PgError).code) &&
  'severity' in err;
/** A name from the schema (constraint, table, column), never a value. */
const schemaName = (v: unknown) => (typeof v === 'string' && /^[\w$.]{1,63}$/.test(v) ? v : null);
/** Node's code of a system error ('ECONNREFUSED', 'ETIMEDOUT'), which says more than its class. */
const systemCode = (err: Error) => {
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === 'string' && /^E[A-Z_]{2,30}$/.test(code) ? code : null;
};

/** One line, at most 500 characters, without identifiers of people or records. */
const oneLine = (text: string) =>
  maskIdentifiers(text.replace(/\s+/g, ' ').trim()).slice(0, ERROR_MAX);

/**
 * A text with drizzle's "Failed query: <SQL> params: <values>" cut off, replaced by `instead`:
 * for an error whose message repeats a failed query's (a worker that wraps it in its own error),
 * and for runs recorded before errorText() unwrapped failed queries.
 */
const withoutQuery = (text: string, instead: string) => {
  const at = text.indexOf('Failed query:');
  return at === -1 ? text : `${text.slice(0, at)}${instead}`;
};
const QUERY_FAILED = 'DrizzleQueryError: a database query failed';

/**
 * The error of a failed run as stored and shown to the operator (System health, alerts): what
 * failed and why, never the data it failed on.
 *
 * - A failed query (drizzle's DrizzleQueryError, whose message is the SQL and every bound value –
 *   patients' names among them) is replaced by its cause. For PostgreSQL's own error that is the
 *   class, the SQLSTATE code and the message with quoted values and numbers removed (it echoes
 *   values: `invalid input syntax for type integer: "…"`), with the constraint, table and column
 *   names. pg's detail ("Key (email)=(…) already exists"), hint and context are left out.
 * - Any other error: its class (with Node's code of a system error, e.g. ECONNREFUSED) and its
 *   message with quoted text and any failed query it repeats removed.
 *
 * Then, as in every text the operator sees, record ids, e-mail addresses and long numbers are
 * masked (maskIdentifiers).
 */
export function errorText(err: unknown): string {
  if (err instanceof DrizzleQueryError) {
    return err.cause === undefined || err.cause === null ? QUERY_FAILED : errorText(err.cause);
  }
  if (isPgError(err)) {
    const message = unquoted(err.message).replace(/\d+/g, '…');
    const names = (['constraint', 'table', 'column'] as const)
      .map((kind) => {
        const name = schemaName(err[kind]);
        return name && `${kind} ${name}`;
      })
      .filter(Boolean);
    return oneLine(
      `${className(err)} ${err.code}: ${message}${names.length ? ` (${names.join(', ')})` : ''}`,
    );
  }
  if (err instanceof Error) {
    const code = systemCode(err);
    const message = unquoted(withoutQuery(err.message, 'a database query failed'));
    return oneLine(`${className(err)}${code ? ` ${code}` : ''}: ${message}`);
  }
  return oneLine(unquoted(withoutQuery(String(err), 'a database query failed')));
}

/**
 * A stored error as shown to the operator. Runs recorded before errorText() unwrapped failed
 * queries hold the SQL and its values ("Failed query: … params: …"): of those, only the fact that
 * a query failed is shown. Quoted text and identifiers are removed again for the same reason.
 */
export function storedErrorText(text: string): string {
  return oneLine(unquoted(withoutQuery(text, `${QUERY_FAILED} (its cause was not recorded)`)));
}

/**
 * The class (and SQLSTATE or system error code) at the start of a stored error, e.g.
 * 'DatabaseError 40P01', 'Error ECONNREFUSED' or 'TypeError', for texts that travel further than
 * System health (alert messages); null when the text does not start with one.
 */
export function errorClassOf(text: string | null | undefined): string | null {
  return (
    /^([A-Za-z_$][\w$]{0,59}(?: (?:[0-9A-Z]{5}|E[A-Z_]{2,30}))?):/.exec(text ?? '')?.[1] ?? null
  );
}

/** The code locations of an error's stack, without its message (which errorText() replaces). */
const stackFrames = (err: unknown) =>
  err instanceof Error && err.stack
    ? err.stack
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .slice(0, 15)
        .join('\n')
    : undefined;

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
    // Not the error itself: a failed query carries its SQL and every bound value.
    logger.error({ worker: name, error, stack: stackFrames(err) }, 'Worker run failed');
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
