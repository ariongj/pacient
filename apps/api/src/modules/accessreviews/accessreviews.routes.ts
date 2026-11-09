import { Router } from 'express';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { accessReviewItems, accessReviews, facilities, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { toCsv } from '../reports/reports.routes.js';
import {
  accessTo,
  FACILITY_ROLES,
  isOverdue,
  openReview,
  progressOf,
  quarterOf,
  REVIEW_DAYS,
  type AccountSnapshot,
} from './accessreviews.service.js';

/** Access reviews: periodic recertification of staff accounts by directors and the Ministry. */
export const accessReviewsRouter = Router();
accessReviewsRouter.use(authenticate, requireRole('DIRECTOR', 'MINISTRY'));

const IdParam = z.object({ id: z.string().uuid() });
const ItemParam = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const PeriodQuery = z.object({
  period: z
    .string()
    .regex(/^\d{4}-Q[1-4]$/)
    .optional(),
});
const DecisionInput = z
  .object({
    decision: z.enum(['KEEP', 'CHANGE', 'REVOKE']),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision === 'KEEP' || (v.note?.length ?? 0) >= 3, {
    message: 'Explain the change or the revocation in a note',
    path: ['note'],
  });

async function loadReview(id: string) {
  const [row] = await db
    .select({ review: accessReviews, facilityName: facilities.name })
    .from(accessReviews)
    .leftJoin(facilities, eq(facilities.id, accessReviews.facilityId))
    .where(eq(accessReviews.id, id));
  if (!row) throw notFound('Access review not found');
  return row;
}

function present(
  review: typeof accessReviews.$inferSelect,
  facilityName: string | null,
  progress: { total: number; decided: number; revoked: number } | undefined,
) {
  return {
    id: review.id,
    facilityId: review.facilityId,
    facilityName,
    scope: review.facilityId ? ('FACILITY' as const) : ('MINISTRY' as const),
    period: review.period,
    status: review.status,
    dueDate: review.dueDate,
    openedAt: review.openedAt,
    completedAt: review.completedAt,
    overdue: isOverdue(review),
    total: progress?.total ?? 0,
    decided: progress?.decided ?? 0,
    revoked: progress?.revoked ?? 0,
  };
}

/** The current quarter and the rules shown on the page. */
accessReviewsRouter.get('/meta', (req, res) => {
  const ctx = requireAuth(req);
  const q = quarterOf();
  res.json({
    currentPeriod: q.period,
    currentDueDate: q.dueDate,
    reviewDays: REVIEW_DAYS,
    scope: ctx.role === 'MINISTRY' ? 'MINISTRY' : 'FACILITY',
    facilityRoles: FACILITY_ROLES,
  });
});

/** Reviews of my facility (director) or the Ministry's own reviews, newest first. */
accessReviewsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select({ review: accessReviews, facilityName: facilities.name })
    .from(accessReviews)
    .leftJoin(facilities, eq(facilities.id, accessReviews.facilityId))
    .where(
      ctx.role === 'MINISTRY'
        ? isNull(accessReviews.facilityId)
        : eq(accessReviews.facilityId, ctx.facilityId!),
    )
    .orderBy(desc(accessReviews.period))
    .limit(40);
  const progress = await progressOf(rows.map((r) => r.review.id));
  res.json({
    items: rows.map((r) => present(r.review, r.facilityName, progress.get(r.review.id))),
  });
});

/** Opens the current quarter's review now (otherwise the worker opens it). */
accessReviewsRouter.post('/open', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = ctx.role === 'MINISTRY' ? null : ctx.facilityId;
  if (ctx.role === 'DIRECTOR' && !facilityId) throw forbidden();
  const { review, created } = await openReview(facilityId, { actor: ctx, meta: requestMeta(req) });
  const [facility] = facilityId
    ? await db
        .select({ name: facilities.name })
        .from(facilities)
        .where(eq(facilities.id, facilityId))
    : [];
  const progress = await progressOf([review.id]);
  res
    .status(created ? 201 : 200)
    .json(present(review, facility?.name ?? null, progress.get(review.id)));
});

/** Ministry: how every facility stands in a quarter's review. */
accessReviewsRouter.get('/compliance', requireRole('MINISTRY'), async (req, res) => {
  const q = parse(PeriodQuery, req.query);
  const period = q.period ?? quarterOf().period;
  const [facilityRows, reviews, directors] = await Promise.all([
    db
      .select({ id: facilities.id, name: facilities.name, municipality: facilities.municipality })
      .from(facilities)
      .where(eq(facilities.isActive, true))
      .orderBy(asc(facilities.name)),
    db.select().from(accessReviews).where(eq(accessReviews.period, period)),
    db
      .select({ facilityId: users.facilityId })
      .from(users)
      .where(and(eq(users.role, 'DIRECTOR'), eq(users.isActive, true))),
  ]);
  const progress = await progressOf(reviews.map((r) => r.id));
  const byFacility = new Map(reviews.map((r) => [r.facilityId, r]));
  const directorCount = new Map<string, number>();
  for (const d of directors) {
    if (d.facilityId) directorCount.set(d.facilityId, (directorCount.get(d.facilityId) ?? 0) + 1);
  }
  const ministry = byFacility.get(null);
  const rows = facilityRows
    .map((f) => {
      const r = byFacility.get(f.id);
      const p = r ? progress.get(r.id) : undefined;
      return {
        facilityId: f.id,
        facilityName: f.name,
        municipality: f.municipality,
        directors: directorCount.get(f.id) ?? 0,
        reviewId: r?.id ?? null,
        status: r ? r.status : ('NOT_OPENED' as const),
        dueDate: r?.dueDate ?? null,
        overdue: r ? isOverdue(r) : false,
        total: p?.total ?? 0,
        decided: p?.decided ?? 0,
        revoked: p?.revoked ?? 0,
      };
    })
    // Facilities without any review and without directors have no staff to review.
    .filter((r) => r.reviewId !== null || r.directors > 0);
  res.json({
    period,
    ministry: ministry ? present(ministry, null, progress.get(ministry.id)) : null,
    summary: {
      facilities: rows.length,
      completed: rows.filter((r) => r.status === 'COMPLETED').length,
      overdue: rows.filter((r) => r.overdue).length,
      notOpened: rows.filter((r) => r.status === 'NOT_OPENED').length,
      revoked: rows.reduce((a, r) => a + r.revoked, 0),
    },
    items: rows,
  });
});

/** A review with every account in it. The Ministry may read facility reviews. */
accessReviewsRouter.get('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { review, facilityName } = await loadReview(id);
  const access = accessTo(ctx, review);
  if (!access) throw notFound('Access review not found');
  const items = await db
    .select({
      item: accessReviewItems,
      isActive: users.isActive,
      currentRole: users.role,
      currentFacilityId: users.facilityId,
    })
    .from(accessReviewItems)
    .innerJoin(users, eq(users.id, accessReviewItems.userId))
    .where(eq(accessReviewItems.reviewId, id));
  const deciders = [
    ...new Set(items.map((i) => i.item.decidedById).filter((x): x is string => Boolean(x))),
  ];
  const deciderNames = new Map(
    deciders.length
      ? (
          await db
            .select({ id: users.id, name: users.fullName })
            .from(users)
            .where(inArray(users.id, deciders))
        ).map((u) => [u.id, u.name])
      : [],
  );
  const progress = await progressOf([id]);
  const open = review.status === 'OPEN';
  res.json({
    ...present(review, facilityName, progress.get(id)),
    canDecide: access === 'REVIEW' && open,
    canComplete:
      access === 'REVIEW' &&
      open &&
      (progress.get(id)?.decided ?? 0) === (progress.get(id)?.total ?? 0),
    items: items
      .map((i) => {
        const snapshot = i.item.snapshot as unknown as AccountSnapshot;
        return {
          id: i.item.id,
          userId: i.item.userId,
          snapshot,
          decision: i.item.decision,
          note: i.item.note,
          decidedAt: i.item.decidedAt,
          decidedByName: i.item.decidedById ? (deciderNames.get(i.item.decidedById) ?? null) : null,
          /** The account as it is now (it may have changed since the review opened). */
          current: {
            isActive: i.isActive,
            role: i.currentRole,
            facilityId: i.currentFacilityId,
          },
          isMe: i.item.userId === ctx.userId,
        };
      })
      .sort(
        (a, b) =>
          b.snapshot.flags.length - a.snapshot.flags.length ||
          a.snapshot.fullName.localeCompare(b.snapshot.fullName),
      ),
  });
});

/** Keep, change or revoke one account. Revoking deactivates it at once and ends its sessions. */
accessReviewsRouter.post('/:id/items/:itemId/decision', async (req, res) => {
  const ctx = requireAuth(req);
  const { id, itemId } = parse(ItemParam, req.params);
  const input = parse(DecisionInput, req.body);
  const { review } = await loadReview(id);
  const access = accessTo(ctx, review);
  if (!access) throw notFound('Access review not found');
  if (access !== 'REVIEW') throw forbidden('You can read this review but not decide in it');
  if (review.status !== 'OPEN') throw conflict('The review is already completed');
  const meta = requestMeta(req);
  const result = await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(accessReviewItems)
      .where(and(eq(accessReviewItems.id, itemId), eq(accessReviewItems.reviewId, id)))
      .for('update');
    if (!item) throw notFound('Account not found in this review');
    if (item.userId === ctx.userId) throw forbidden('You cannot review your own account');
    if (item.decision === 'REVOKE') {
      throw conflict('The account was revoked; reactivate it on the staff page if needed');
    }
    const [row] = await tx
      .update(accessReviewItems)
      .set({
        decision: input.decision,
        note: input.note || null,
        decidedById: ctx.userId,
        decidedAt: new Date(),
      })
      .where(eq(accessReviewItems.id, itemId))
      .returning();
    let deactivated = false;
    if (input.decision === 'REVOKE') {
      const [target] = await tx
        .update(users)
        .set({ isActive: false })
        .where(and(eq(users.id, item.userId), eq(users.isActive, true)))
        .returning({ id: users.id });
      deactivated = Boolean(target);
      if (deactivated) {
        await audit(
          {
            action: AuditAction.USER_DEACTIVATED,
            actor: ctx,
            resourceType: 'user',
            resourceId: item.userId,
            meta,
            metadata: { source: 'access_review', reviewId: id },
          },
          tx,
        );
      }
    }
    await audit(
      {
        action: AuditAction.ACCESS_REVIEW_DECIDED,
        actor: ctx,
        resourceType: 'access_review',
        resourceId: id,
        meta,
        metadata: { userId: item.userId, decision: input.decision, previous: item.decision },
      },
      tx,
    );
    return { row: row!, deactivated };
  });
  // Same effect as deactivation on the staff page: every session of the account ends now.
  if (result.deactivated) await revokeAllSessions(result.row.userId);
  res.json({
    id: result.row.id,
    decision: result.row.decision,
    note: result.row.note,
    decidedAt: result.row.decidedAt,
    deactivated: result.deactivated,
  });
});

/** Completes the review once every account is decided. */
accessReviewsRouter.post('/:id/complete', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { review, facilityName } = await loadReview(id);
  const access = accessTo(ctx, review);
  if (!access) throw notFound('Access review not found');
  if (access !== 'REVIEW') throw forbidden('You can read this review but not complete it');
  const done = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(accessReviews)
      .where(eq(accessReviews.id, id))
      .for('update');
    if (locked!.status !== 'OPEN') throw conflict('The review is already completed');
    const [open] = await tx
      .select({ id: accessReviewItems.id })
      .from(accessReviewItems)
      .where(and(eq(accessReviewItems.reviewId, id), isNull(accessReviewItems.decision)))
      .limit(1);
    if (open) throw badRequest('Decide on every account before completing the review');
    const [row] = await tx
      .update(accessReviews)
      .set({ status: 'COMPLETED', completedAt: new Date(), completedById: ctx.userId })
      .where(eq(accessReviews.id, id))
      .returning();
    const progress = await progressOf([id], tx);
    await audit(
      {
        action: AuditAction.ACCESS_REVIEW_COMPLETED,
        actor: ctx,
        resourceType: 'access_review',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { period: row!.period, ...progress.get(id) },
      },
      tx,
    );
    return { row: row!, progress: progress.get(id) };
  });
  res.json(present(done.row, facilityName, done.progress));
});

/** Attestation of a completed review as CSV (audited). */
accessReviewsRouter.get('/:id/export.csv', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { review, facilityName } = await loadReview(id);
  if (!accessTo(ctx, review)) throw notFound('Access review not found');
  if (review.status !== 'COMPLETED') throw conflict('Only a completed review can be exported');
  const items = await db
    .select({ item: accessReviewItems })
    .from(accessReviewItems)
    .where(eq(accessReviewItems.reviewId, id));
  const deciderIds = [
    ...new Set(
      [...items.map((i) => i.item.decidedById), review.completedById].filter((x): x is string =>
        Boolean(x),
      ),
    ),
  ];
  const names = new Map(
    deciderIds.length
      ? (
          await db
            .select({ id: users.id, name: users.fullName })
            .from(users)
            .where(inArray(users.id, deciderIds))
        ).map((u) => [u.id, u.name])
      : [],
  );
  const rows: Record<string, unknown>[] = items
    .map(({ item }) => {
      const s = item.snapshot as unknown as AccountSnapshot;
      return {
        period: review.period,
        facility: facilityName ?? 'Ministry of Health',
        name: s.fullName,
        email: s.email,
        role: s.role,
        account_facility: s.facilityName ?? '',
        last_sign_in: s.lastLoginAt ?? '',
        two_step: s.twoStep ? 'yes' : 'no',
        licence: s.licence ?? '',
        emergency_access_90_days: s.emergencyAccessCount,
        flags: s.flags.join(' '),
        decision: item.decision,
        note: item.note ?? '',
        decided_by: item.decidedById ? (names.get(item.decidedById) ?? '') : '',
        decided_at: item.decidedAt?.toISOString() ?? '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  // The last line attests who completed the review and when.
  rows.push({
    period: review.period,
    facility: facilityName ?? 'Ministry of Health',
    name: 'Review completed',
    email: '',
    role: '',
    account_facility: '',
    last_sign_in: '',
    two_step: '',
    licence: '',
    emergency_access_90_days: '',
    flags: '',
    decision: null,
    note: '',
    decided_by: review.completedById ? (names.get(review.completedById) ?? '') : '',
    decided_at: review.completedAt?.toISOString() ?? '',
  });
  await audit({
    action: AuditAction.REPORT_EXPORTED,
    actor: ctx,
    resourceType: 'access_review',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { report: 'access_review', period: review.period, rows: items.length },
  });
  const columns = Object.keys(rows[0]!);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pacient-access-review-${review.period}.csv"`,
  );
  res.send(toCsv(columns, rows));
});
