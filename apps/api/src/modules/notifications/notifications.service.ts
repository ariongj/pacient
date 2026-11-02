import { and, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { publish } from '../../lib/events.js';
import { enqueueEmail } from '../email/outbox.js';
import { enqueueSms } from '../sms/outbox.js';
import { DEFAULT_LOCALE, toLocale, tr, type Locale, type TrVars } from '../../i18n/index.js';
import {
  careAssignments,
  guardianships,
  notifications,
  patients,
  users,
  type Role,
} from '../../db/schema.js';

export interface NotificationInput {
  type: string;
  /**
   * English source text, translated into each recipient's language (see src/i18n). Put values in
   * {placeholders} and pass them in `vars`. Keep generic: never include diagnoses, results or other
   * clinical detail.
   */
  title: string;
  body?: string;
  /** Values for {placeholders} in title/body; Dates are formatted for the recipient's language. */
  vars?: TrVars;
  /**
   * Templates wrapped around the translated title, innermost first, e.g.
   * `{ text: '{title} (covering for {doctor})', vars: { doctor } }`.
   */
  wrap?: { text: string; vars?: TrVars }[];
  link?: string;
  /** Important notifications are also emailed to users whose preference is "important only". */
  important?: boolean;
}

/** The notification title in one language. */
export function renderTitle(n: NotificationInput, locale: Locale): string {
  let title = tr(locale, n.title, n.vars);
  for (const w of n.wrap ?? []) title = tr(locale, w.text, { ...w.vars, title });
  return title.slice(0, 200);
}

export async function notifyUsers(
  userIds: (string | null | undefined)[],
  n: NotificationInput,
  executor: Executor = db,
) {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return;
  // Every recipient gets the notification in their own language.
  const locales = new Map(
    (
      await executor
        .select({ id: users.id, locale: users.locale })
        .from(users)
        .where(inArray(users.id, ids))
    ).map((u) => [u.id, toLocale(u.locale)]),
  );
  const localeOf = (id: string) => locales.get(id) ?? DEFAULT_LOCALE;
  await executor.insert(notifications).values(
    ids.map((userId) => ({
      userId,
      type: n.type,
      title: renderTitle(n, localeOf(userId)),
      body: n.body ? tr(localeOf(userId), n.body, n.vars) : null,
      link: n.link ?? null,
    })),
  );
  // Delivered live (after commit when inside a transaction).
  await publish(ids, { type: 'notification' }, executor);

  // Email copies, per each user's preference. Only activated, active accounts are emailed.
  const recipients = await executor
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      pref: users.emailNotifications,
      phone: users.phone,
      phoneVerifiedAt: users.phoneVerifiedAt,
      smsPref: users.smsNotifications,
    })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.isActive, true), isNotNull(users.passwordHash)));
  for (const r of recipients) {
    const locale = localeOf(r.id);
    const title = renderTitle(n, locale);
    // SMS: opt-in, verified numbers only, important notifications only, generic text.
    if (n.important && r.smsPref === 'IMPORTANT' && r.phone && r.phoneVerifiedAt) {
      await enqueueSms(executor, {
        to: r.phone,
        userId: r.id,
        template: 'notification',
        body: tr(locale, 'Pacient: {title}. Sign in to view.', { title }),
      });
    }
    if (r.pref === 'ALL' || (r.pref === 'IMPORTANT' && n.important)) {
      await enqueueEmail(executor, {
        to: r.email,
        userId: r.id,
        template: 'notification',
        locale,
        name: r.fullName,
        title,
        link: n.link ?? null,
      });
    }
  }
}

export interface PatientNotifyOptions {
  /**
   * Which guardians are also notified: 'full' (default) – guardians with full scope; 'all' – also
   * appointments-only guardians (used for appointment notices); 'none' – e.g. for anything linked
   * to a visit that is confidential from guardians.
   */
  guardians?: 'full' | 'all' | 'none';
}

/** Notifies the patient's own portal account (if any) and their active guardians. */
export async function notifyPatient(
  patientId: string,
  n: NotificationInput,
  executor: Executor = db,
  options: PatientNotifyOptions = {},
) {
  const [row] = await executor
    .select({ userId: patients.userId })
    .from(patients)
    .where(eq(patients.id, patientId));
  await notifyUsers([row?.userId], n, executor);

  const mode = options.guardians ?? (n.type === 'appointment' ? 'all' : 'full');
  if (mode === 'none') return;
  const now = new Date();
  const guardians = await executor
    .select({ userId: guardianships.guardianUserId })
    .from(guardianships)
    .where(
      and(
        eq(guardianships.patientId, patientId),
        isNull(guardianships.revokedAt),
        lte(guardianships.validFrom, now),
        gt(guardianships.validUntil, now),
        mode === 'full' ? eq(guardianships.scope, 'FULL') : undefined,
      ),
    );
  if (guardians.length) {
    // Guardians' links open the portal acting for the child.
    const link = n.link
      ? `${n.link}${n.link.includes('?') ? '&' : '?'}for=${patientId}`
      : undefined;
    await notifyUsers(
      guardians.map((g) => g.userId).filter((id) => id !== row?.userId),
      { ...n, wrap: [...(n.wrap ?? []), { text: '{title} (family member)' }], link },
      executor,
    );
  }
}

export async function notifyCareTeam(
  patientId: string,
  n: NotificationInput,
  executor: Executor = db,
  exceptUserId?: string,
) {
  const rows = await executor
    .select({ doctorId: careAssignments.doctorId })
    .from(careAssignments)
    .where(and(eq(careAssignments.patientId, patientId), isNull(careAssignments.endedAt)));
  await notifyUsers(
    rows.map((r) => r.doctorId).filter((id) => id !== exceptUserId),
    n,
    executor,
  );
}

/** Notifies care-team members of the patient who have the given role (e.g. all nurses). */
export async function notifyCareTeamRole(
  patientId: string,
  role: Role,
  n: NotificationInput,
  executor: Executor = db,
  exceptUserId?: string,
) {
  const rows = await executor
    .select({ id: users.id })
    .from(careAssignments)
    .innerJoin(users, eq(users.id, careAssignments.doctorId))
    .where(
      and(
        eq(careAssignments.patientId, patientId),
        isNull(careAssignments.endedAt),
        eq(users.role, role),
        eq(users.isActive, true),
      ),
    );
  await notifyUsers(
    rows.map((r) => r.id).filter((id) => id !== exceptUserId),
    n,
    executor,
  );
}

/** Notifies all active users with one of the given roles at a facility (e.g. its directors). */
export async function notifyFacilityRole(
  facilityId: string,
  roles: Role[],
  n: NotificationInput,
  executor: Executor = db,
) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), inArray(users.role, roles), eq(users.isActive, true)),
    );
  await notifyUsers(
    rows.map((r) => r.id),
    n,
    executor,
  );
}
