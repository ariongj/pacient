import { and, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { auditLogs, platformSettings, users } from '../../db/schema.js';
import { toLocale } from '../../i18n/index.js';
import { AuditAction } from '../audit/audit.service.js';
import { enqueueEmail } from '../email/outbox.js';
import {
  notifyUsers,
  renderTitle,
  type NotificationInput,
} from '../notifications/notifications.service.js';
import type { Settings } from './platform.service.js';

/**
 * Operator settings that decide where customers pay and what every invoice says from now on.
 * Changing one asks for the administrator's password again (PUT /admin/settings): a stolen or
 * unattended session must not be able to send the customers' money elsewhere.
 */
export const REAUTH_SETTINGS = [
  'operatorIban',
  'operatorBank',
  'vatRateBp',
  'operatorVatNumber',
  'invoicePrefix',
] as const satisfies readonly (keyof Settings)[];

/** The bank details printed on invoices: a change is announced to the other administrators. */
export const BANK_SETTINGS = [
  'operatorIban',
  'operatorBank',
] as const satisfies readonly (keyof Settings)[];

/** How long the platform overview shows "Bank details changed on …". */
export const BANK_CHANGE_NOTICE_DAYS = 14;

const differs = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null);

/**
 * Which of `fields` the request would change. The settings page sends every field back, so a
 * value sent unchanged is not a change (and asks for nothing).
 */
export function changedAmong(
  fields: readonly (keyof Settings)[],
  input: Partial<Record<keyof Settings, unknown>>,
  current: Settings,
): (keyof Settings)[] {
  return fields.filter((k) => input[k] !== undefined && differs(input[k], current[k]));
}

/**
 * Tells every other active administrator, in the app and by e-mail, that the bank details on
 * invoices were changed, by whom and when. A security notice: e-mailed to each of them whatever
 * their e-mail preference (notifyUsers() e-mails those whose preference covers important
 * notifications, the others get it here, so each gets exactly one e-mail). In the transaction of
 * the change: no change without the notice. Diverting payments by changing the IBAN is the
 * obvious misuse of a stolen administrator session, and the colleagues are the ones who would
 * notice.
 */
export async function notifyBankDetailsChanged(tx: Executor, actor: { userId: string }, at: Date) {
  const [me] = await tx
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, actor.userId));
  const others = await tx
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      locale: users.locale,
      emailNotifications: users.emailNotifications,
    })
    .from(users)
    .where(
      and(
        eq(users.role, 'ADMIN'),
        eq(users.isActive, true),
        isNotNull(users.passwordHash),
        ne(users.id, actor.userId),
      ),
    );
  const notice: NotificationInput = {
    type: 'security',
    title: 'The bank details on invoices were changed by {name} at {time}',
    body: 'Check the IBAN and bank under Operator settings. If nobody expected this change, correct them before the next invoice is issued.',
    vars: { name: me?.name ?? '—', time: at },
    link: '/admin/settings',
    important: true,
  };
  await notifyUsers(
    others.map((u) => u.id),
    notice,
    tx,
  );
  for (const u of others.filter((o) => o.emailNotifications === 'OFF')) {
    const locale = toLocale(u.locale);
    await enqueueEmail(tx, {
      to: u.email,
      userId: u.id,
      template: 'notification',
      locale,
      name: u.fullName,
      title: renderTitle(notice, locale),
      link: notice.link ?? null,
    });
  }
  return others.length;
}

export interface BankChange {
  changedAt: Date;
  changedById: string | null;
  changedByName: string | null;
  /** Which of the bank details changed (operatorIban, operatorBank). */
  fields: string[];
  /** The bank details now, to check at a glance. */
  operatorIban: string | null;
  operatorBank: string | null;
}

/**
 * The latest change of the bank details in the last 14 days (before `now`), or null. Read from the
 * audit entry written with the change. The audit trail is large, so the search starts from what
 * is cheap: nothing changed in the settings at all in that time (most days), and otherwise only
 * the entries of administrators (the actor index), who are the only ones who change settings.
 */
export async function recentBankChange(now = new Date()): Promise<BankChange | null> {
  const since = new Date(now.getTime() - BANK_CHANGE_NOTICE_DAYS * 86_400_000);
  const [settings] = await db
    .select({
      updatedAt: platformSettings.updatedAt,
      operatorIban: platformSettings.operatorIban,
      operatorBank: platformSettings.operatorBank,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1));
  if (!settings || settings.updatedAt <= since) return null;
  const [row] = await db
    .select({
      occurredAt: auditLogs.occurredAt,
      actorUserId: auditLogs.actorUserId,
      actorName: users.fullName,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(
      and(
        inArray(
          auditLogs.actorUserId,
          db.select({ id: users.id }).from(users).where(eq(users.role, 'ADMIN')),
        ),
        eq(auditLogs.action, AuditAction.PLATFORM_SETTINGS_UPDATED),
        gt(auditLogs.occurredAt, since),
        lte(auditLogs.occurredAt, now),
        sql`${auditLogs.metadata} -> 'fields' ?| array['operatorIban', 'operatorBank']`,
      ),
    )
    .orderBy(desc(auditLogs.occurredAt))
    .limit(1);
  if (!row) return null;
  const fields = Array.isArray(row.metadata?.fields) ? (row.metadata.fields as unknown[]) : [];
  return {
    changedAt: row.occurredAt,
    changedById: row.actorUserId,
    changedByName: row.actorName,
    fields: fields.map(String).filter((f) => (BANK_SETTINGS as readonly string[]).includes(f)),
    operatorIban: settings.operatorIban,
    operatorBank: settings.operatorBank,
  };
}
