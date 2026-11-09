import { and, eq, isNull } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import { openReview, quarterOf } from '../modules/accessreviews/accessreviews.service.js';
import { db } from './client.js';
import { accessReviewItems, accessReviews, users } from './schema.js';

const DAY = 86_400_000;
const DORMANT_EMAIL = 'arben.kelmendi@pacient.local';

/**
 * Synthetic demo data for access reviews (development only): last quarter's review of the demo
 * facility completed, this quarter's open with a few decisions made and a dormant reception
 * account to find, and this quarter's Ministry review.
 */
export async function seedAccessreviews(opts: {
  facilityId: string;
  demoDoctorId: string;
}): Promise<void> {
  const now = new Date();
  const directors = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.facilityId, opts.facilityId),
        eq(users.role, 'DIRECTOR'),
        eq(users.isActive, true),
      ),
    );
  if (!directors.length) return;
  const reviewerFor = (userId: string) => directors.find((d) => d.id !== userId)?.id ?? null;

  // Last quarter: completed on time, everyone kept.
  const lastQuarter = new Date(Date.parse(`${quarterOf(now).start}T12:00:00Z`) - 40 * DAY);
  const { review: previous, created } = await openReview(opts.facilityId, { now: lastQuarter });
  if (created) {
    const completedAt = new Date(Date.parse(`${previous.dueDate}T09:00:00Z`) - 3 * DAY);
    const items = await db
      .select()
      .from(accessReviewItems)
      .where(eq(accessReviewItems.reviewId, previous.id));
    for (const item of items) {
      const by = reviewerFor(item.userId);
      if (!by) continue;
      await db
        .update(accessReviewItems)
        .set({ decision: 'KEEP', decidedById: by, decidedAt: completedAt })
        .where(eq(accessReviewItems.id, item.id));
    }
    const undecided = await db
      .select({ id: accessReviewItems.id })
      .from(accessReviewItems)
      .where(and(eq(accessReviewItems.reviewId, previous.id), isNull(accessReviewItems.decision)));
    if (!undecided.length) {
      await db
        .update(accessReviews)
        .set({ status: 'COMPLETED', completedAt, completedById: directors[0]!.id })
        .where(eq(accessReviews.id, previous.id));
    }
  }

  // A reception account nobody has used for months (the review should catch it).
  const [existing] = await db.select().from(users).where(eq(users.email, DORMANT_EMAIL));
  if (!existing) {
    await db.insert(users).values({
      email: DORMANT_EMAIL,
      fullName: 'Arben Kelmendi',
      role: 'RECEPTION',
      facilityId: opts.facilityId,
      passwordHash: await hashPassword(`dormant-${now.getTime()}-${Math.random()}`),
      passwordChangedAt: new Date(now.getTime() - 500 * DAY),
      lastLoginAt: new Date(now.getTime() - 134 * DAY),
      createdAt: new Date(now.getTime() - 520 * DAY),
    });
  }

  // This quarter: open, a few accounts already kept.
  const { review: current, created: currentCreated } = await openReview(opts.facilityId, { now });
  if (currentCreated) {
    const items = await db
      .select()
      .from(accessReviewItems)
      .where(eq(accessReviewItems.reviewId, current.id));
    const clean = items
      .filter((i) => {
        const flags = (i.snapshot as { flags?: string[] }).flags ?? [];
        return flags.every((f) => f === 'NO_TWO_STEP');
      })
      .slice(0, 4);
    for (const item of clean) {
      const by = reviewerFor(item.userId);
      if (!by) continue;
      await db
        .update(accessReviewItems)
        .set({ decision: 'KEEP', decidedById: by, decidedAt: new Date(now.getTime() - DAY) })
        .where(eq(accessReviewItems.id, item.id));
    }
  }

  await openReview(null, { now });
}
