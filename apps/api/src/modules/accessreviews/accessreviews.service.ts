import { and, asc, count, eq, gte, inArray, isNull, like, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  accessReviewItems,
  accessReviews,
  careUnits,
  emergencyAccessGrants,
  facilities,
  notifications,
  unitStaff,
  users,
  webauthnCredentials,
  type Role,
} from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { LICENSED_ROLES, licencesOfUsers, todayIso } from '../licences/licences.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Periodic access recertification. Every calendar quarter each facility reviews its staff
 * accounts (directors review the facility team; a director never reviews their own account), and
 * the Ministry reviews Ministry officials and all facility directors (chain of command). Each
 * account is kept, flagged for a change (made on the staff page) or revoked at once.
 */

/** Days from the start of the quarter until the review is due. */
export const REVIEW_DAYS = 30;
/** No sign-in for this many days: the account is dormant. */
export const DORMANT_DAYS = 90;
/** Accounts never used this many days after creation are flagged. */
export const NEVER_USED_DAYS = 30;
/** Emergency (break-glass) uses in the last 90 days that call for a closer look (illustrative). */
export const BREAK_GLASS_ATTENTION = 5;

/** Roles reviewed in a facility review. */
export const FACILITY_ROLES: Role[] = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
];

export type ReviewFlag =
  'DORMANT' | 'NEVER_SIGNED_IN' | 'LICENCE_INVALID' | 'NO_TWO_STEP' | 'FREQUENT_EMERGENCY_ACCESS';

export interface AccountSnapshot {
  fullName: string;
  email: string;
  role: Role;
  facilityId: string | null;
  facilityName: string | null;
  specialty: string | null;
  units: string[];
  createdAt: string;
  lastLoginAt: string | null;
  twoStep: boolean;
  /** VALID, EXPIRED, SUSPENDED, REVOKED or MISSING; null for roles without a licence. */
  licence: string | null;
  /** Emergency (break-glass) accesses in the 90 days before the review opened. */
  emergencyAccessCount: number;
  flags: ReviewFlag[];
}

export type Decision = 'KEEP' | 'CHANGE' | 'REVOKE';

/* ------------------------------------------------------------------------------ periods ---- */

/** The quarter a moment falls in (Kosovo calendar), e.g. 2026-Q4, with its first day and due date. */
export function quarterOf(now = new Date()) {
  const today = todayIso(now);
  const year = Number(today.slice(0, 4));
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  const start = `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
  const due = new Date(Date.parse(`${start}T00:00:00Z`) + REVIEW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { period: `${year}-Q${q}`, start, dueDate: due };
}

/* ----------------------------------------------------------------------------- scope ------- */

const daysAgo = (iso: string | Date | null, now: Date) =>
  iso ? (now.getTime() - new Date(iso).getTime()) / 86_400_000 : null;

/** Active accounts a review covers (see the module comment). */
async function accountsInScope(facilityId: string | null, executor: Executor) {
  if (facilityId) {
    const rows = await executor
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(
        and(
          eq(users.facilityId, facilityId),
          eq(users.isActive, true),
          inArray(users.role, FACILITY_ROLES),
        ),
      );
    // A sole director cannot be reviewed by a colleague: their account is in the Ministry review.
    const directors = rows.filter((r) => r.role === 'DIRECTOR');
    return rows.filter((r) => r.role !== 'DIRECTOR' || directors.length > 1).map((r) => r.id);
  }
  const rows = await executor
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.isActive, true), inArray(users.role, ['MINISTRY', 'DIRECTOR'])));
  // A sole Ministry official cannot be reviewed by anyone else in the Ministry review.
  const officials = rows.filter((r) => r.role === 'MINISTRY');
  return rows.filter((r) => r.role !== 'MINISTRY' || officials.length > 1).map((r) => r.id);
}

/** What the reviewer sees about each account at the time the review opens. */
export async function snapshotsOf(
  userIds: string[],
  now = new Date(),
  executor: Executor = db,
): Promise<Map<string, AccountSnapshot>> {
  if (!userIds.length) return new Map();
  const since = new Date(now.getTime() - 90 * 86_400_000);
  // One query at a time: the executor may be a transaction (a single connection).
  const rows = await executor
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      role: users.role,
      facilityId: users.facilityId,
      facilityName: facilities.name,
      specialty: users.specialty,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      mfaEnabledAt: users.mfaEnabledAt,
    })
    .from(users)
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .where(inArray(users.id, userIds));
  const units = await executor
    .select({ userId: unitStaff.userId, name: careUnits.name })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .where(inArray(unitStaff.userId, userIds))
    .orderBy(asc(careUnits.name));
  const passkeys = await executor
    .select({ userId: webauthnCredentials.userId })
    .from(webauthnCredentials)
    .where(inArray(webauthnCredentials.userId, userIds));
  const grants = await executor
    .select({ userId: emergencyAccessGrants.doctorId, n: count() })
    .from(emergencyAccessGrants)
    .where(
      and(
        inArray(emergencyAccessGrants.doctorId, userIds),
        gte(emergencyAccessGrants.createdAt, since),
      ),
    )
    .groupBy(emergencyAccessGrants.doctorId);
  const licences = await licencesOfUsers(userIds);
  const unitsBy = new Map<string, string[]>();
  for (const u of units) unitsBy.set(u.userId, [...(unitsBy.get(u.userId) ?? []), u.name]);
  const withPasskey = new Set(passkeys.map((p) => p.userId));
  const grantsBy = new Map(grants.map((g) => [g.userId, Number(g.n)]));
  const out = new Map<string, AccountSnapshot>();
  for (const r of rows) {
    const licensed = Boolean(LICENSED_ROLES[r.role]);
    const l = licences.get(r.id);
    const licence = licensed ? (l ? l.effectiveStatus : 'MISSING') : null;
    const twoStep = Boolean(r.mfaEnabledAt) || withPasskey.has(r.id);
    const emergencyAccessCount = grantsBy.get(r.id) ?? 0;
    const flags: ReviewFlag[] = [];
    const idle = daysAgo(r.lastLoginAt, now);
    if (idle !== null && idle > DORMANT_DAYS) flags.push('DORMANT');
    if (idle === null && (daysAgo(r.createdAt, now) ?? 0) > NEVER_USED_DAYS) {
      flags.push('NEVER_SIGNED_IN');
    }
    if (licence !== null && licence !== 'VALID') flags.push('LICENCE_INVALID');
    if (!twoStep) flags.push('NO_TWO_STEP');
    if (emergencyAccessCount >= BREAK_GLASS_ATTENTION) flags.push('FREQUENT_EMERGENCY_ACCESS');
    out.set(r.id, {
      fullName: r.fullName,
      email: r.email,
      role: r.role,
      facilityId: r.facilityId,
      facilityName: r.facilityName ?? null,
      specialty: r.specialty,
      units: unitsBy.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      twoStep,
      licence,
      emergencyAccessCount,
      flags,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------ opening ---- */

export type Review = typeof accessReviews.$inferSelect;

/**
 * Opens the review of a facility (or the Ministry review, facilityId null) for the quarter of
 * `now`. Idempotent: an existing review of that quarter is returned unchanged.
 */
export async function openReview(
  facilityId: string | null,
  opts: { now?: Date; actor?: AuthContext; meta?: RequestMeta } = {},
): Promise<{ review: Review; created: boolean }> {
  const now = opts.now ?? new Date();
  const { period, dueDate: quarterDue } = quarterOf(now);
  // Opened late in the quarter (e.g. by hand), the reviewers still get REVIEW_DAYS.
  const fromOpening = new Date(Date.parse(`${todayIso(now)}T00:00:00Z`) + REVIEW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const dueDate = fromOpening > quarterDue ? fromOpening : quarterDue;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`access-review:${facilityId ?? 'ministry'}:${period}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(accessReviews)
      .where(
        and(
          facilityId ? eq(accessReviews.facilityId, facilityId) : isNull(accessReviews.facilityId),
          eq(accessReviews.period, period),
        ),
      );
    if (existing) return { review: existing, created: false };
    const [review] = await tx
      .insert(accessReviews)
      .values({ facilityId, period, dueDate, openedAt: now })
      .returning();
    const ids = await accountsInScope(facilityId, tx);
    const snapshots = await snapshotsOf(ids, now, tx);
    if (snapshots.size) {
      await tx.insert(accessReviewItems).values(
        [...snapshots].map(([userId, snapshot]) => ({
          reviewId: review!.id,
          userId,
          snapshot: snapshot as unknown as Record<string, unknown>,
        })),
      );
    }
    await audit(
      {
        action: AuditAction.ACCESS_REVIEW_OPENED,
        actor: opts.actor,
        resourceType: 'access_review',
        resourceId: review!.id,
        meta: opts.meta,
        metadata: { period, facilityId, accounts: snapshots.size },
      },
      tx,
    );
    return { review: review!, created: true };
  });
}

/* ------------------------------------------------------------------------------ access ----- */

/** Whether the caller reviews (decides in) this review, or may only read it. */
export function accessTo(
  ctx: Pick<AuthContext, 'role' | 'facilityId'>,
  review: Pick<Review, 'facilityId'>,
): 'REVIEW' | 'READ' | null {
  if (review.facilityId === null) return ctx.role === 'MINISTRY' ? 'REVIEW' : null;
  if (ctx.role === 'DIRECTOR' && ctx.facilityId === review.facilityId) return 'REVIEW';
  if (ctx.role === 'MINISTRY') return 'READ';
  return null;
}

export const isOverdue = (review: Pick<Review, 'status' | 'dueDate'>, now = new Date()) =>
  review.status === 'OPEN' && review.dueDate < todayIso(now);

/** Progress of reviews: decided / total and revoked counts. */
export async function progressOf(reviewIds: string[], executor: Executor = db) {
  if (!reviewIds.length)
    return new Map<string, { total: number; decided: number; revoked: number }>();
  const rows = await executor
    .select({
      reviewId: accessReviewItems.reviewId,
      total: sql<number>`count(*)::int`,
      decided: sql<number>`count(${accessReviewItems.decision})::int`,
      revoked: sql<number>`count(*) FILTER (WHERE ${accessReviewItems.decision} = 'REVOKE')::int`,
    })
    .from(accessReviewItems)
    .where(inArray(accessReviewItems.reviewId, reviewIds))
    .groupBy(accessReviewItems.reviewId);
  return new Map(rows.map((r) => [r.reviewId, r]));
}

/* ------------------------------------------------------------------------------ worker ----- */

const WORKER_TYPE = 'access_review';

/** Reviewers of a review: the facility's directors, or the Ministry's officials. */
export async function reviewersOf(facilityId: string | null, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        facilityId
          ? and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'))
          : eq(users.role, 'MINISTRY'),
      ),
    );
  return rows.map((r) => r.id);
}

/** Sends a notification to the reviewers once; the dedupe key travels in the link. */
async function notifyReviewersOnce(
  review: Review,
  key: string,
  title: string,
  vars: Record<string, string>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    const [already] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.type, WORKER_TYPE), like(notifications.link, `%${key}%`)))
      .limit(1);
    if (already) return false;
    const recipients = await reviewersOf(review.facilityId, tx);
    if (!recipients.length) return false;
    await notifyUsers(
      recipients,
      { type: WORKER_TYPE, title, vars, link: `/access-reviews?review=${review.id}&${key}` },
      tx,
    );
    return true;
  });
}

/**
 * Opens the quarter's reviews (every active facility with staff, and the Ministry review),
 * announces new ones to the reviewers, and reminds them once when a review is overdue. Safe to run
 * on several instances at once (advisory locks; unique reviews per quarter).
 */
export async function runAccessReviewsWorkerOnce(
  now = new Date(),
  opts: { facilityIds?: string[] } = {},
) {
  let opened = 0;
  let reminded = 0;
  const facilityRows = await db
    .selectDistinct({ id: facilities.id })
    .from(facilities)
    .innerJoin(users, eq(users.facilityId, facilities.id))
    .where(
      and(
        eq(facilities.isActive, true),
        eq(users.isActive, true),
        inArray(users.role, FACILITY_ROLES),
        opts.facilityIds ? inArray(facilities.id, opts.facilityIds) : undefined,
      ),
    );
  for (const scope of [null, ...facilityRows.map((f) => f.id)]) {
    const { review, created } = await openReview(scope, { now });
    if (created) {
      opened++;
      await notifyReviewersOnce(
        review,
        `aro=${review.id}`,
        'The access review {period} is open – please complete it by {due}',
        { period: review.period, due: review.dueDate },
      );
    }
  }
  const open = await db
    .select()
    .from(accessReviews)
    .where(
      and(
        eq(accessReviews.status, 'OPEN'),
        sql`${accessReviews.dueDate} < ${todayIso(now)}::date`,
        opts.facilityIds
          ? sql`(${accessReviews.facilityId} IS NULL OR ${inArray(accessReviews.facilityId, opts.facilityIds)})`
          : undefined,
      ),
    );
  for (const review of open) {
    if (
      await notifyReviewersOnce(
        review,
        `ard=${review.id}`,
        'The access review {period} is overdue',
        { period: review.period },
      )
    ) {
      reminded++;
    }
  }
  return { opened, reminded };
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runAccessReviewsWorkerOnce().then(
    (r) => (r.opened || r.reminded) && logger.info(r, 'Access reviews opened or reminders sent'),
    (err: unknown) => logger.error({ err }, 'Access reviews worker failed'),
  );
}

/** Every 6 hours (first run 10 minutes after start). Not started in tests. */
export function startAccessReviewsWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 10 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 6 * 60 * 60_000);
  timer.unref();
}

export function stopAccessReviewsWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}
