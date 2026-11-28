import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Executor } from '../../db/client.js';
import {
  facilities,
  operatorRequestCategoryEnum,
  operatorRequestMessages,
  operatorRequests,
  operatorRequestStatusEnum,
  users,
} from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { toLocale } from '../../i18n/index.js';
import { enqueueEmail } from '../email/outbox.js';
import {
  notifyUsers,
  renderTitle,
  type NotificationInput,
} from '../notifications/notifications.service.js';

/**
 * Requests from a facility's directors and IT support to the operator of the service. They are
 * about the service – billing, accounts, technical problems, data protection, security incidents –
 * never about a patient. Round 2, builder G.
 */

export const REQUEST_CATEGORIES = operatorRequestCategoryEnum.enumValues;
export const REQUEST_STATUSES = operatorRequestStatusEnum.enumValues;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type OperatorRequest = typeof operatorRequests.$inferSelect;

export const SUBJECT_MAX = 200;
export const BODY_MAX = 4000;

/**
 * Ten digits in a row, not part of a longer number: what a Kosovo personal number looks like.
 * Phone numbers (9 digits, or 11 and more with the country code) and IBANs (written in groups of
 * four, or 18 digits in a row) do not match.
 */
const PERSONAL_NUMBER_RE = /(?<!\d)\d{10}(?!\d)/;

export const looksLikePersonalNumber = (text: string) => PERSONAL_NUMBER_RE.test(text);

export const PATIENT_DATA_REFUSED =
  'Do not include patient information. This text contains a 10-digit number that looks like a personal number: remove it and send again.';

/**
 * Refuses subjects and messages that look like they name a patient (400). The forms say "do not
 * include patient information"; this is the check behind it, so that a personal number never
 * reaches the operator, its e-mails or the audit trail.
 */
export function assertNoPatientData(fields: Record<string, string | undefined>) {
  const details = Object.entries(fields)
    .filter(([, v]) => v !== undefined && looksLikePersonalNumber(v))
    .map(([path]) => ({ path, message: PATIENT_DATA_REFUSED }));
  if (details.length) throw badRequest(PATIENT_DATA_REFUSED, details);
}

/**
 * Next reference of the Kosovo calendar year, REQ-2026-00001: gapless, the counter row stays
 * locked until the transaction ends.
 */
export async function nextReference(executor: Executor): Promise<string> {
  const { rows } = await executor.execute<{ year: number; last: number }>(sql`
    INSERT INTO operator_request_counters (year, last)
    VALUES (extract(year FROM now() AT TIME ZONE 'Europe/Belgrade')::int, 1)
    ON CONFLICT (year) DO UPDATE SET last = operator_request_counters.last + 1
    RETURNING year, last`);
  const row = rows[0]!;
  return `REQ-${row.year}-${String(row.last).padStart(5, '0')}`;
}

/** Active, activated administrators of the operator: they answer the requests. */
export async function activeAdmins(executor: Executor = db) {
  return executor
    .select({ id: users.id, email: users.email, fullName: users.fullName, locale: users.locale })
    .from(users)
    .where(and(eq(users.role, 'ADMIN'), eq(users.isActive, true), isNotNull(users.passwordHash)));
}

export const adminLink = (id: string) => `/admin/requests/${id}`;
export const facilityLink = (id: string) => `/operator-requests/${id}`;

/**
 * Tells every administrator about a request. A security incident is important and is e-mailed to
 * every administrator at once, also to those who turned e-mail notifications off: notifyUsers()
 * e-mails those whose preference covers important notifications, the others get it here, so each
 * gets exactly one e-mail. The title names the request and the facility, never its subject or
 * text (they are the facility's words and could say more than they should).
 */
export async function notifyAdmins(
  executor: Executor,
  n: Omit<NotificationInput, 'type'>,
  opts: { emailEveryone?: boolean } = {},
) {
  const admins = await activeAdmins(executor);
  if (!admins.length) return;
  const notification: NotificationInput = { type: 'operator_request', ...n };
  await notifyUsers(
    admins.map((a) => a.id),
    notification,
    executor,
  );
  if (!opts.emailEveryone) return;
  const optedOut = await executor
    .select({ id: users.id, email: users.email, fullName: users.fullName, locale: users.locale })
    .from(users)
    .where(
      and(
        inArray(
          users.id,
          admins.map((a) => a.id),
        ),
        eq(users.emailNotifications, 'OFF'),
      ),
    );
  for (const a of optedOut) {
    const locale = toLocale(a.locale);
    await enqueueEmail(executor, {
      to: a.email,
      userId: a.id,
      template: 'notification',
      locale,
      name: a.fullName,
      title: renderTitle(notification, locale),
      link: n.link ?? null,
    });
  }
}

/* ------------------------------------------------------------------ reading ------------------ */

const requester = alias(users, 'requester');

/** Columns of a request in lists: who asked, from which facility, and how far it got. */
export const requestColumns = {
  id: operatorRequests.id,
  reference: operatorRequests.reference,
  facilityId: operatorRequests.facilityId,
  facilityName: facilities.name,
  category: operatorRequests.category,
  subject: operatorRequests.subject,
  status: operatorRequests.status,
  priority: operatorRequests.priority,
  requesterId: operatorRequests.requesterId,
  requesterName: requester.fullName,
  createdAt: operatorRequests.createdAt,
  updatedAt: operatorRequests.updatedAt,
  firstResponseAt: operatorRequests.firstResponseAt,
  resolvedAt: operatorRequests.resolvedAt,
  messages: sql<number>`(SELECT count(*)::int FROM ${operatorRequestMessages} m WHERE m.request_id = ${operatorRequests.id})`,
};

export const requestsFrom = () =>
  db
    .select(requestColumns)
    .from(operatorRequests)
    .innerJoin(facilities, eq(facilities.id, operatorRequests.facilityId))
    .innerJoin(requester, eq(requester.id, operatorRequests.requesterId));

const author = alias(users, 'message_author');

/**
 * The conversation of a request, oldest first. Facilities see the operator's answers as from "the
 * operator": the administrator's name stays with the operator, as in the subscription history.
 * Who wrote for the operator is recorded with each message (from_operator), never taken from the
 * author's role today: an administrator who later changes role still answered for the operator,
 * and a facility user who later becomes an administrator still wrote for the facility.
 */
export async function messagesOf(requestId: string, audience: 'admin' | 'facility') {
  const rows = await db
    .select({
      id: operatorRequestMessages.id,
      body: operatorRequestMessages.body,
      createdAt: operatorRequestMessages.createdAt,
      fromOperator: operatorRequestMessages.fromOperator,
      authorId: operatorRequestMessages.authorId,
      authorName: author.fullName,
    })
    .from(operatorRequestMessages)
    .innerJoin(author, eq(author.id, operatorRequestMessages.authorId))
    .where(eq(operatorRequestMessages.requestId, requestId))
    .orderBy(asc(operatorRequestMessages.createdAt), asc(operatorRequestMessages.id));
  return rows.map((m) => ({
    id: m.id,
    body: m.body,
    createdAt: m.createdAt,
    fromOperator: m.fromOperator,
    authorId: audience === 'facility' && m.fromOperator ? null : m.authorId,
    authorName: audience === 'facility' && m.fromOperator ? null : m.authorName,
  }));
}

/** Facilities that have asked something, for the administrator's filter. */
export async function facilitiesWithRequests() {
  return db
    .selectDistinct({ id: facilities.id, name: facilities.name })
    .from(operatorRequests)
    .innerJoin(facilities, eq(facilities.id, operatorRequests.facilityId))
    .orderBy(asc(facilities.name));
}

/** Requests by status over all facilities, and the open ones of high priority. */
export async function requestCounts() {
  const rows = await db
    .select({
      status: operatorRequests.status,
      priority: operatorRequests.priority,
      count: sql<number>`count(*)::int`,
    })
    .from(operatorRequests)
    .groupBy(operatorRequests.status, operatorRequests.priority);
  const sum = (f: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(f).reduce((n, r) => n + r.count, 0);
  return {
    OPEN: sum((r) => r.status === 'OPEN'),
    WAITING_CUSTOMER: sum((r) => r.status === 'WAITING_CUSTOMER'),
    RESOLVED: sum((r) => r.status === 'RESOLVED'),
    highOpen: sum((r) => r.status !== 'RESOLVED' && r.priority === 'HIGH'),
  };
}
