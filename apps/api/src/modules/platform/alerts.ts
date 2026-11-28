import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { operatorAlerts, users } from '../../db/schema.js';
import { toLocale } from '../../i18n/index.js';
import { logger } from '../../lib/logger.js';
import type { WorkerName } from '../../lib/worker-runs.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { enqueueEmail } from '../email/outbox.js';
import { withoutIdentifiers } from '../monitoring/operations.service.js';
import {
  notifyUsers,
  renderTitle,
  type NotificationInput,
} from '../notifications/notifications.service.js';

/**
 * Operator alerts: conditions the operator of the service must look at, one per condition key
 * (operator_alerts). Declared by the round 2 scaffold so that every module can raise them; the
 * watchdog (watchdog.ts) raises most of them. The contracts below are binding.
 *
 * Known keys: 'billing.settings_incomplete' (raised by the subscription worker when it cannot
 * invoice), 'worker.stale:<worker name>', 'email.failing', 'email.backlog', 'sms.failing',
 * 'sms.backlog', 'backup.stale', 'tls.expiring'. A key is a stable, short identifier (≤ 120
 * characters) of the condition, never of a person or a record.
 */

export type OperatorAlertSeverity = 'WARNING' | 'CRITICAL';

export interface OperatorAlertInput {
  severity: OperatorAlertSeverity;
  /**
   * What is wrong and what to do, in plain English (≤ 500 characters), for the operator. Never
   * patient data, names of patients or record contents; counts, worker names and settings
   * field names are fine.
   */
  message: string;
}

/** Administrators are told about the same condition at most this often. */
export const ALERT_NOTIFY_EVERY_MS = 6 * 60 * 60_000;
const KEY_MAX = 120;
const MESSAGE_MAX = 500;

/**
 * The message as stored and sent: one line, at most 500 characters, and no identifiers (see
 * withoutIdentifiers) even if a caller slipped one in – alerts reach every administrator's mailbox.
 */
export function alertMessage(message: string): string {
  return withoutIdentifiers(message.replace(/\s+/g, ' ')).trim().slice(0, MESSAGE_MAX);
}

/**
 * What each background job does, as on System health (the web app's WORKER_LABELS), translated
 * in the administrators' notifications and e-mails (src/i18n). The watchdog never reports itself.
 */
const WORKER_LABELS: Record<Exclude<WorkerName, 'watchdog'>, string> = {
  email: 'E-mail delivery',
  sms: 'SMS delivery',
  'cover-escalation': 'Escalation of unanswered results',
  'appointment-reminders': 'Appointment reminders',
  'vaccination-reminders': 'Vaccination reminders',
  'early-warning': 'Early warning scores',
  retention: 'Data retention',
  'downtime-packs': 'Downtime packs',
  'waiting-lists': 'Waiting list warnings',
  registers: 'Disease registers',
  complaints: 'Complaint deadlines',
  licences: 'Licence expiry',
  subscriptions: 'Subscriptions and invoices',
  maternity: 'Antenatal reminders',
  screening: 'Screening invitations',
  sepsis: 'Sepsis escalation',
  equipment: 'Equipment maintenance',
  infection: 'Infection control',
  'remote-monitoring': 'Remote monitoring digests',
  dialysis: 'Dialysis sessions',
  'mental-health': 'Mental health deadlines',
  proms: 'Questionnaire reminders',
  'access-reviews': 'Access reviews',
  'charge-capture': 'Charge capture',
  surveillance: 'Disease surveillance',
};

/**
 * The notification title of a condition, translated for each administrator (src/i18n). For a
 * stalled worker the title is the job's label (translated like every title) wrapped in "The
 * background job “…” has stopped", so that the job is named in the reader's language and not by
 * its id. The details stay in the message, which is in English like the rest of the operator's
 * technical texts.
 */
export function alertTitle(key: string): Pick<NotificationInput, 'title' | 'wrap'> {
  if (key.startsWith('worker.stale:')) {
    const worker = key.slice('worker.stale:'.length);
    return {
      title: WORKER_LABELS[worker as keyof typeof WORKER_LABELS] ?? worker,
      wrap: [{ text: 'The background job “{title}” has stopped' }],
    };
  }
  const titles: Record<string, string> = {
    'email.failing': 'E-mails could not be delivered',
    'email.backlog': 'E-mails are waiting to be sent',
    'sms.failing': 'Text messages could not be delivered',
    'sms.backlog': 'Text messages are waiting to be sent',
    'backup.stale': 'No recent database backup',
    'billing.settings_incomplete': 'Invoices cannot be issued: operator settings are incomplete',
    'tls.expiring': 'The HTTPS certificate expires soon',
  };
  return { title: titles[key] ?? 'Pacient needs the operator’s attention' };
}

/** Every administrator who can sign in. */
async function activeAdministrators(executor: Executor): Promise<string[]> {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'ADMIN'), eq(users.isActive, true), isNotNull(users.passwordHash)));
  return rows.map((r) => r.id);
}

/**
 * Notifies every active administrator of an alert, and e-mails each of them. Alerts are security
 * and operations notices, so also those who turned e-mail notifications off get the e-mail:
 * notifyUsers() e-mails those whose preference covers important notifications, the others get it
 * here, so each gets exactly one (as for a security incident, requests.service notifyAdmins).
 */
async function notifyAdministrators(executor: Executor, notification: NotificationInput) {
  const admins = await activeAdministrators(executor);
  if (!admins.length) return;
  await notifyUsers(admins, notification, executor);
  const optedOut = await executor
    .select({ id: users.id, email: users.email, fullName: users.fullName, locale: users.locale })
    .from(users)
    .where(and(inArray(users.id, admins), eq(users.emailNotifications, 'OFF')));
  for (const a of optedOut) {
    const locale = toLocale(a.locale);
    await enqueueEmail(executor, {
      to: a.email,
      userId: a.id,
      template: 'notification',
      locale,
      name: a.fullName,
      title: renderTitle(notification, locale),
      link: notification.link ?? null,
    });
  }
}

/**
 * Raises (or keeps raised) the alert for `key`: creates it, or updates its severity, message and
 * last-seen time; reopens it if it was resolved. Every active ADMIN is notified (important
 * notification and e-mail, whatever their e-mail preference) at most once per key per 6 hours.
 * Audited as platform.alert_raised when it is created or reopened. Runs on its own (not in the
 * caller's transaction) and never throws: a failure is logged, so a worker that raises an alert
 * is never broken by it.
 */
export async function raiseOperatorAlert(key: string, alert: OperatorAlertInput): Promise<void> {
  try {
    if (!key || key.length > KEY_MAX) throw new Error(`Invalid alert key (${key.length} chars)`);
    const severity: OperatorAlertSeverity = alert.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
    const message = alertMessage(alert.message);
    await db.transaction(async (tx) => {
      // One condition is raised by several workers (and API instances) at once: serialise per key
      // so that exactly one of them creates or reopens it and notifies.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`operator-alert:${key}`}))`);
      const now = new Date();
      const [existing] = await tx
        .select()
        .from(operatorAlerts)
        .where(eq(operatorAlerts.conditionKey, key));
      let row: typeof operatorAlerts.$inferSelect;
      let opened = false;
      if (!existing) {
        [row] = (await tx
          .insert(operatorAlerts)
          .values({
            conditionKey: key,
            severity,
            message,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .returning()) as [typeof operatorAlerts.$inferSelect];
        opened = true;
      } else {
        opened = existing.resolvedAt !== null;
        [row] = (await tx
          .update(operatorAlerts)
          .set({
            severity,
            message,
            lastSeenAt: now,
            // A reopened alert is a new occurrence: it starts now.
            ...(opened ? { firstSeenAt: now, resolvedAt: null } : {}),
          })
          .where(eq(operatorAlerts.id, existing.id))
          .returning()) as [typeof operatorAlerts.$inferSelect];
      }
      if (opened) {
        await audit(
          {
            action: AuditAction.PLATFORM_ALERT_RAISED,
            actor: null,
            resourceType: 'operator_alert',
            resourceId: row.id,
            metadata: { conditionKey: key, severity, reopened: Boolean(existing) },
          },
          tx,
        );
      }
      // Kept open, the alert is repeated every 6 hours; a condition that comes and goes (resolved
      // and raised again) is not announced more often than that either.
      const due =
        !row.lastNotifiedAt ||
        now.getTime() - row.lastNotifiedAt.getTime() >= ALERT_NOTIFY_EVERY_MS;
      if (!due) return;
      const { title, wrap = [] } = alertTitle(key);
      await notifyAdministrators(tx, {
        type: 'operator_alert',
        title,
        wrap: [
          ...wrap,
          { text: severity === 'CRITICAL' ? 'Critical: {title}' : 'Warning: {title}' },
        ],
        body: message,
        link: '/admin',
        important: true,
      });
      await tx
        .update(operatorAlerts)
        .set({ lastNotifiedAt: now })
        .where(eq(operatorAlerts.id, row.id));
    });
  } catch (err) {
    logger.error({ err, key }, 'Could not raise the operator alert');
  }
}

/**
 * Resolves the open alert for `key` (sets resolved_at; audited as platform.alert_resolved). Does
 * nothing when there is no open alert for it. Never throws, like raiseOperatorAlert.
 */
export async function resolveOperatorAlert(key: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`operator-alert:${key}`}))`);
      const [row] = await tx
        .update(operatorAlerts)
        .set({ resolvedAt: new Date() })
        .where(and(eq(operatorAlerts.conditionKey, key), isNull(operatorAlerts.resolvedAt)))
        .returning({ id: operatorAlerts.id, severity: operatorAlerts.severity });
      if (!row) return;
      await audit(
        {
          action: AuditAction.PLATFORM_ALERT_RESOLVED,
          actor: null,
          resourceType: 'operator_alert',
          resourceId: row.id,
          metadata: { conditionKey: key, severity: row.severity },
        },
        tx,
      );
    });
  } catch (err) {
    logger.error({ err, key }, 'Could not resolve the operator alert');
  }
}

/** Open alerts, critical first, then the most recent. */
export async function openOperatorAlerts(executor: Executor = db) {
  return executor
    .select({
      id: operatorAlerts.id,
      conditionKey: operatorAlerts.conditionKey,
      severity: operatorAlerts.severity,
      message: operatorAlerts.message,
      firstSeenAt: operatorAlerts.firstSeenAt,
      lastSeenAt: operatorAlerts.lastSeenAt,
      lastNotifiedAt: operatorAlerts.lastNotifiedAt,
    })
    .from(operatorAlerts)
    .where(isNull(operatorAlerts.resolvedAt))
    .orderBy(
      asc(sql`CASE ${operatorAlerts.severity} WHEN 'CRITICAL' THEN 0 ELSE 1 END`),
      desc(operatorAlerts.firstSeenAt),
    );
}
