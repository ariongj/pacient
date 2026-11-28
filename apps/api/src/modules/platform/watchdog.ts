import { sql } from 'drizzle-orm';
import { env, isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { errorClassOf, recordRun, registerWorker, type WorkerName } from '../../lib/worker-runs.js';
import {
  backupStatus,
  BACKUP_MAX_AGE_MS,
  clearWorkerStatusCache,
  workerStatuses,
} from '../monitoring/operations.service.js';
import { missingBillingSettings, settingsOf } from '../subscriptions/subscriptions.service.js';
import {
  openOperatorAlerts,
  raiseOperatorAlert,
  resolveOperatorAlert,
  type OperatorAlertInput,
} from './alerts.js';

/**
 * The watchdog: every 10 minutes it looks at what the operator would otherwise only notice when a
 * customer complains – a background worker that stopped, e-mail or SMS that does not go out, a
 * backup that was not reported – and raises or resolves an operator alert per condition
 * (alerts.ts notifies the administrators). Counts, times, worker names and error classes only.
 *
 * 'billing.settings_incomplete' is raised by the subscription worker, which knows when it could
 * not invoice; the watchdog only resolves it once the settings are complete. TLS certificate
 * expiry is not checked: the API does not know the certificate (the proxy in front of it holds
 * it), so the external uptime check watches it (GO-LIVE.md).
 */

export const WATCHDOG_INTERVAL_MS = 10 * 60_000;
/** A due message that has waited this long means the queue is not moving. */
export const BACKLOG_AFTER_MINUTES = 30;
/** Permanent delivery failures are counted over this window. */
export const FAILURES_WINDOW_HOURS = 24;

/** Workers whose stop endangers patients or locks people out (alerts, escalations, sign-in mail). */
const CRITICAL_WORKERS = new Set<WorkerName>([
  'email',
  'sms',
  'cover-escalation',
  'early-warning',
  'sepsis',
]);

type Decision = { key: string; alert: OperatorAlertInput | null };

const hours = (ms: number) => Math.max(1, Math.round(ms / 3_600_000));
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const duration = (ms: number) =>
  ms < 60_000
    ? plural(Math.max(1, Math.round(ms / 1000)), 'second')
    : ms < 2 * 3_600_000
      ? plural(Math.round(ms / 60_000), 'minute')
      : plural(hours(ms), 'hour');

/**
 * The workers started by this process: raised when stale, resolved otherwise. A worker this
 * process does not run (switched off here, or run by another API instance only) is not decided
 * on at all: it cannot judge it, and resolving another instance's alert at every pass would make
 * the alert come and go (only an alert nobody raises any more is resolved, abandonedWorkerAlerts).
 */
export async function checkWorkers(now = new Date()): Promise<Decision[]> {
  clearWorkerStatusCache();
  const statuses = await workerStatuses({ now, fresh: true });
  return statuses
    .filter((s) => s.running && s.name !== 'watchdog')
    .map((s) => {
      const key = `worker.stale:${s.name}`;
      if (!s.stale || s.intervalSeconds === null || s.staleAfterSeconds === null) {
        return { key, alert: null };
      }
      const since = s.lastOkAt ? `since ${s.lastOkAt.toISOString()}` : 'since the API started';
      // Only the class and code of a failure since the last success: the text stays on System
      // health, the alert goes to every administrator's notifications.
      const failed =
        s.lastError && (!s.lastOkAt || s.lastError.at > s.lastOkAt)
          ? errorClassOf(s.lastError.text)
          : null;
      const error = failed ? ` Last error: ${failed} (System health › Background jobs).` : '';
      return {
        key,
        alert: {
          severity: CRITICAL_WORKERS.has(s.name) ? 'CRITICAL' : 'WARNING',
          message:
            `The background job "${s.name}" has had no successful run ${since} (expected every ` +
            `${duration(s.intervalSeconds * 1000)}; stalled after ` +
            `${duration(s.staleAfterSeconds * 1000)} without one).` +
            `${error} Check the API log and restart the API if it does not recover.`,
        },
      };
    });
}

/**
 * An instance that runs a stalled job raises its alert again at every pass (every 10 minutes),
 * which moves the alert's last-seen time. An open alert that no instance has raised for this long
 * is therefore not judged stale by any instance that runs the job: the job was switched off
 * everywhere (or renamed). checkWorkers leaves it alone in a process that does not run the job,
 * so without this it would stay open for good.
 */
export const ABANDONED_WORKER_ALERT_MS = 6 * WATCHDOG_INTERVAL_MS;

/**
 * Resolves the open stalled-job alerts that this process did not decide on (it does not run the
 * job) and that nobody has raised for ABANDONED_WORKER_ALERT_MS. An alert another instance keeps
 * raising is never touched, so it cannot come and go.
 */
export function abandonedWorkerAlerts(
  open: { conditionKey: string; lastSeenAt: Date }[],
  decided: Decision[],
  now = new Date(),
): Decision[] {
  const keys = new Set(decided.map((d) => d.key));
  return open
    .filter(
      (a) =>
        a.conditionKey.startsWith('worker.stale:') &&
        !keys.has(a.conditionKey) &&
        now.getTime() - a.lastSeenAt.getTime() > ABANDONED_WORKER_ALERT_MS,
    )
    .map((a) => ({ key: a.conditionKey, alert: null }));
}

const BILLING_SETTINGS_ALERT = 'billing.settings_incomplete';

/**
 * Resolves 'billing.settings_incomplete' once the operator settings are complete, so that the
 * alert goes within 10 minutes instead of at the subscription worker's next run (every 6 hours).
 * Raising it stays with that worker, which knows whether invoices wait.
 */
export async function checkBillingSettings(): Promise<Decision[]> {
  const missing = missingBillingSettings(await settingsOf());
  return missing.length ? [] : [{ key: BILLING_SETTINGS_ALERT, alert: null }];
}

/**
 * E-mail or SMS: permanent failures in the last 24 hours ('<channel>.failing'), and a message due
 * for more than 30 minutes that has not gone out ('<channel>.backlog'). Due time, not creation
 * time: SMS held over quiet hours and messages waiting for their next retry are not late.
 */
export async function checkOutbox(channel: 'email' | 'sms', now = new Date()): Promise<Decision[]> {
  const table = sql.identifier(channel === 'email' ? 'email_outbox' : 'sms_outbox');
  const at = now.toISOString();
  const { rows } = await db.execute<{ failed: number; late: number; oldest: number | null }>(sql`
    SELECT
      (SELECT count(*)::int FROM ${table} WHERE status = 'FAILED'
          AND next_attempt_at > ${at}::timestamptz - make_interval(hours => ${FAILURES_WINDOW_HOURS})
          AND next_attempt_at <= ${at}::timestamptz) AS failed,
      (SELECT count(*)::int FROM ${table} WHERE status IN ('PENDING', 'SENDING')
          AND next_attempt_at <= ${at}::timestamptz - make_interval(mins => ${BACKLOG_AFTER_MINUTES})) AS late,
      (SELECT extract(epoch FROM ${at}::timestamptz - min(next_attempt_at))::float8 FROM ${table}
        WHERE status IN ('PENDING', 'SENDING') AND next_attempt_at <= ${at}::timestamptz) AS oldest`);
  const r = rows[0] ?? { failed: 0, late: 0, oldest: null };
  const email = channel === 'email';
  const what = email ? 'e-mail' : 'text message';
  const held = email ? env.EMAIL_TRANSPORT === 'held' : env.SMS_PROVIDER === 'held';
  const failing: Decision = {
    key: `${channel}.failing`,
    alert:
      r.failed > 0
        ? {
            severity: 'WARNING',
            message:
              `${r.failed} ${what}(s) could not be delivered in the last ${FAILURES_WINDOW_HOURS} hours ` +
              `and were given up. ` +
              (email
                ? 'See System health › Recent e-mail failures for the errors (wrong addresses, a refusing mail server).'
                : 'Check the SMS provider account and its delivery log.'),
          }
        : null,
  };
  const backlog: Decision = {
    key: `${channel}.backlog`,
    alert:
      r.late > 0
        ? {
            // Without e-mail nobody can be invited or reset a password; SMS carry urgent notices.
            // An installation that never set up SMS is told, not woken.
            severity: email || !held ? 'CRITICAL' : 'WARNING',
            message:
              `${r.late} ${what}(s) have waited more than ${BACKLOG_AFTER_MINUTES} minutes to be sent ` +
              `(the oldest for ${duration((r.oldest ?? 0) * 1000)}). ` +
              (held
                ? email
                  ? 'E-mail delivery is not configured: set SMTP_URL (GO-LIVE.md, E-mail).'
                  : 'No SMS provider is configured: set the Twilio settings or stop asking users for phone numbers (deploy/README.md).'
                : `Check that the ${email ? 'e-mail' : 'SMS'} worker runs and that the provider accepts messages.`),
          }
        : null,
  };
  return [failing, backlog];
}

/** The nightly backup, only when the heartbeat is configured (OPS_HEARTBEAT_TOKEN). */
export async function checkBackup(now = new Date()): Promise<Decision[]> {
  const b = await backupStatus(now);
  if (!b.stale) return [{ key: 'backup.stale', alert: null }];
  return [
    {
      key: 'backup.stale',
      alert: {
        severity: 'CRITICAL',
        message: b.lastOkAt
          ? `No successful database backup has been reported for ${hours(now.getTime() - b.lastOkAt.getTime())} hours ` +
            `(the last at ${b.lastOkAt.toISOString()}; expected at least every ${hours(BACKUP_MAX_AGE_MS)} hours). ` +
            'Check the backup timer: systemctl status pacienti-backup.timer and journalctl -u pacienti-backup.'
          : `No database backup has been reported since the API started more than ${hours(BACKUP_MAX_AGE_MS)} hours ago. ` +
            'Set up the nightly backup with the heartbeat (GO-LIVE.md, Backups).',
      },
    },
  ];
}

/**
 * One pass: every check, then the alerts raised or resolved. Only alerts that are open are
 * resolved, so a quiet pass writes nothing. Returns counts for the worker trail.
 */
export async function runWatchdogOnce(now = new Date()) {
  const decisions = [
    ...(await checkWorkers(now)),
    ...(await checkOutbox('email', now)),
    ...(await checkOutbox('sms', now)),
    ...(await checkBackup(now)),
    ...(await checkBillingSettings()),
  ];
  const openAlerts = await openOperatorAlerts();
  decisions.push(...abandonedWorkerAlerts(openAlerts, decisions, now));
  const open = new Set(openAlerts.map((a) => a.conditionKey));
  let raised = 0;
  let resolved = 0;
  for (const d of decisions) {
    if (d.alert) {
      await raiseOperatorAlert(d.key, d.alert);
      raised++;
    } else if (open.has(d.key)) {
      await resolveOperatorAlert(d.key);
      resolved++;
    }
  }
  return { checked: decisions.length, raised, resolved };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Every 10 minutes, the first time 10 minutes after the start, so that the workers have had their
 * first run (not in tests).
 */
export function startWatchdog() {
  if (timer || isTest) return;
  registerWorker('watchdog', WATCHDOG_INTERVAL_MS);
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void recordRun('watchdog', () => runWatchdogOnce()).finally(() => {
      running = false;
    });
  }, WATCHDOG_INTERVAL_MS);
  timer.unref();
  logger.info('Watchdog started');
}

export function stopWatchdog() {
  if (timer) clearInterval(timer);
  timer = null;
}
