import { and, eq, like } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  accessReviewItems,
  auditLogs,
  emergencyAccessGrants,
  notifications,
  refreshTokens,
  users,
} from '../src/db/schema.js';
import {
  openReview,
  quarterOf,
  runAccessReviewsWorkerOnce,
  type AccountSnapshot,
} from '../src/modules/accessreviews/accessreviews.service.js';
import {
  api,
  bearer,
  createFacility,
  createPatient,
  createUser,
  createWorld,
  login,
  PASSWORD,
} from './helpers.js';

const DAY = 86_400_000;
let w: Awaited<ReturnType<typeof createWorld>>;
let reviewId: string;
let dormant: Awaited<ReturnType<typeof createUser>>;
let unused: Awaited<ReturnType<typeof createUser>>;
const director = () => bearer(w.tokens.director);
const ministry = () => bearer(w.tokens.ministry);

type Item = {
  id: string;
  userId: string;
  snapshot: AccountSnapshot;
  decision: string | null;
  isMe: boolean;
};
const itemOf = async (userId: string, auth = director()) => {
  const res = await api().get(`/api/v1/access-reviews/${reviewId}`).set(auth);
  return (res.body.items as Item[]).find((i) => i.userId === userId);
};
const decide = (itemId: string, body: Record<string, unknown>, auth = director()) =>
  api().post(`/api/v1/access-reviews/${reviewId}/items/${itemId}/decision`).set(auth).send(body);

beforeAll(async () => {
  w = await createWorld();
  dormant = await createUser('RECEPTION', w.facility.id, {
    lastLoginAt: new Date(Date.now() - 120 * DAY),
    createdAt: new Date(Date.now() - 400 * DAY),
  });
  unused = await createUser('RECEPTION', w.facility.id, {
    createdAt: new Date(Date.now() - 60 * DAY),
  });
  await db.insert(emergencyAccessGrants).values(
    Array.from({ length: 5 }, () => ({
      patientId: w.otherPatient.id,
      doctorId: w.users.colleague.id,
      reason: 'Pacient pa vetëdije në urgjencë',
      expiresAt: new Date(Date.now() + 3_600_000),
    })),
  );
});

describe('quarters', () => {
  it('uses the Kosovo calendar and a due date 30 days after the quarter starts', () => {
    expect(quarterOf(new Date('2026-11-09T10:00:00Z'))).toEqual({
      period: '2026-Q4',
      start: '2026-10-01',
      dueDate: '2026-10-31',
    });
    // 23:30 UTC on 31 December is already 1 January in Kosovo.
    expect(quarterOf(new Date('2026-12-31T23:30:00Z')).period).toBe('2027-Q1');
  });
});

describe('a facility review', () => {
  it('opens once per quarter with the facility team, without the sole director', async () => {
    const first = await api().post('/api/v1/access-reviews/open').set(director());
    expect(first.status).toBe(201);
    reviewId = first.body.id;
    expect(first.body).toMatchObject({ scope: 'FACILITY', status: 'OPEN', decided: 0 });
    const again = await api().post('/api/v1/access-reviews/open').set(director());
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(reviewId);

    const res = await api().get(`/api/v1/access-reviews/${reviewId}`).set(director());
    expect(res.status).toBe(200);
    const ids = (res.body.items as Item[]).map((i) => i.userId);
    for (const u of [
      w.users.doctor,
      w.users.colleague,
      w.users.nurse,
      w.users.pharmacist,
      w.users.reception,
      dormant,
      unused,
    ]) {
      expect(ids).toContain(u.id);
    }
    expect(ids).not.toContain(w.users.director.id);
    expect(ids).not.toContain(w.users.outsideDoctor.id);
    expect(ids).not.toContain(w.users.patientUser.id);
    expect(res.body.canDecide).toBe(true);

    const [opened] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, reviewId), eq(auditLogs.action, 'access_review.opened')));
    expect(opened).toMatchObject({ actorUserId: w.users.director.id });
  });

  it('flags dormant, unused, unlicensed and frequent emergency-access accounts', async () => {
    expect((await itemOf(dormant.id))!.snapshot.flags).toEqual(
      expect.arrayContaining(['DORMANT', 'NO_TWO_STEP']),
    );
    expect((await itemOf(unused.id))!.snapshot.flags).toContain('NEVER_SIGNED_IN');
    const colleague = (await itemOf(w.users.colleague.id))!.snapshot;
    expect(colleague).toMatchObject({
      role: 'DOCTOR',
      licence: 'MISSING',
      emergencyAccessCount: 5,
    });
    expect(colleague.flags).toEqual(
      expect.arrayContaining(['LICENCE_INVALID', 'FREQUENT_EMERGENCY_ACCESS']),
    );
    // Signed in just now, no licence needed: no flag other than two-step sign-in.
    expect((await itemOf(w.users.reception.id))!.snapshot.flags).toEqual(['NO_TWO_STEP']);
    expect((await itemOf(unused.id))!.snapshot.licence).toBeNull();
  });

  it('needs a note to change or revoke; revoking ends the sessions and blocks sign-in', async () => {
    const reception = (await itemOf(w.users.reception.id))!;
    expect((await decide(reception.id, { decision: 'REVOKE' })).status).toBe(400);
    expect((await decide(reception.id, { decision: 'CHANGE', note: '' })).status).toBe(400);
    expect((await api().get('/api/v1/auth/me').set(bearer(w.tokens.reception))).status).toBe(200);
    const revoked = await decide(reception.id, {
      decision: 'REVOKE',
      note: 'Ka lënë institucionin në shtator',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ decision: 'REVOKE', deactivated: true });
    const [u] = await db.select().from(users).where(eq(users.id, w.users.reception.id));
    expect(u!.isActive).toBe(false);
    const live = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, w.users.reception.id));
    expect(live.every((t) => t.revokedAt !== null)).toBe(true);
    expect((await api().get('/api/v1/auth/me').set(bearer(w.tokens.reception))).status).toBe(401);
    expect(
      (
        await api()
          .post('/api/v1/auth/login')
          .send({ email: w.users.reception.email, password: PASSWORD })
      ).status,
    ).toBe(401);
    // A revocation is final here; reactivation is done on the staff page.
    expect((await decide(reception.id, { decision: 'KEEP' })).status).toBe(409);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, w.users.reception.id));
    expect(audits.find((a) => a.action === 'user.deactivated')?.metadata).toMatchObject({
      source: 'access_review',
      reviewId,
    });
  });

  it('completes only when every account is decided, then exports the attestation', async () => {
    expect(
      (await api().post(`/api/v1/access-reviews/${reviewId}/complete`).set(director())).status,
    ).toBe(400);
    expect(
      (await api().get(`/api/v1/access-reviews/${reviewId}/export.csv`).set(director())).status,
    ).toBe(409);
    const res = await api().get(`/api/v1/access-reviews/${reviewId}`).set(director());
    for (const item of res.body.items as Item[]) {
      if (item.decision) continue;
      const body =
        item.userId === dormant.id
          ? { decision: 'CHANGE', note: 'Hiqe nga reparti i urgjencës' }
          : { decision: 'KEEP' };
      expect((await decide(item.id, body)).status).toBe(200);
    }
    const done = await api().post(`/api/v1/access-reviews/${reviewId}/complete`).set(director());
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', revoked: 1 });
    expect(done.body.decided).toBe(done.body.total);
    const late = await decide((await itemOf(w.users.doctor.id))!.id, { decision: 'KEEP' });
    expect(late.status).toBe(409);

    const csv = await api().get(`/api/v1/access-reviews/${reviewId}/export.csv`).set(director());
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(w.users.reception.email);
    expect(csv.text).toContain('REVOKE');
    expect(csv.text).toContain('Review completed');
    const [exported] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, reviewId), eq(auditLogs.action, 'report.exported')));
    expect(exported).toBeTruthy();
    const completed = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.resourceId, reviewId), eq(auditLogs.action, 'access_review.completed')),
      );
    expect(completed).toHaveLength(1);
  });
});

describe('directors and the Ministry', () => {
  it('lets co-directors review each other but never their own account', async () => {
    const f = await createFacility();
    const a = await createUser('DIRECTOR', f.id);
    const b = await createUser('DIRECTOR', f.id);
    await createUser('NURSE', f.id);
    const { review } = await openReview(f.id);
    const items = await db
      .select()
      .from(accessReviewItems)
      .where(eq(accessReviewItems.reviewId, review.id));
    expect(items).toHaveLength(3);
    const token = bearer(await login(a.email));
    const own = items.find((i) => i.userId === a.id)!;
    const other = items.find((i) => i.userId === b.id)!;
    const path = (id: string) => `/api/v1/access-reviews/${review.id}/items/${id}/decision`;
    expect((await api().post(path(own.id)).set(token).send({ decision: 'KEEP' })).status).toBe(403);
    expect((await api().post(path(other.id)).set(token).send({ decision: 'KEEP' })).status).toBe(
      200,
    );
    const view = await api().get(`/api/v1/access-reviews/${review.id}`).set(token);
    expect((view.body.items as Item[]).find((i) => i.userId === a.id)!.isMe).toBe(true);
  });

  it('puts Ministry officials and every director in the Ministry review', async () => {
    // Two officials review each other (a sole official could not be reviewed by anyone).
    const official = await createUser('MINISTRY');
    // A quarter of its own, so the review is opened by this test run.
    const year = 2400 + Math.floor(Math.random() * 500);
    const { review, created } = await openReview(null, {
      now: new Date(`${year}-05-15T10:00:00Z`),
    });
    expect(created).toBe(true);
    expect(review.period).toBe(`${year}-Q2`);
    const items = await db
      .select({ userId: accessReviewItems.userId, snapshot: accessReviewItems.snapshot })
      .from(accessReviewItems)
      .where(eq(accessReviewItems.reviewId, review.id));
    const ids = items.map((i) => i.userId);
    expect(ids).toContain(w.users.director.id);
    expect(ids).toContain(w.users.otherDirector.id);
    expect(ids).toContain(w.users.ministry.id);
    expect(ids).toContain(official.id);
    expect(ids).not.toContain(w.users.doctor.id);
    expect(new Set(items.map((i) => (i.snapshot as unknown as AccountSnapshot).role))).toEqual(
      new Set(['MINISTRY', 'DIRECTOR']),
    );
    // The Ministry decides there; a director may not even see it.
    expect(
      (await api().get(`/api/v1/access-reviews/${review.id}`).set(ministry())).body,
    ).toMatchObject({ scope: 'MINISTRY', canDecide: true });
    expect((await api().get(`/api/v1/access-reviews/${review.id}`).set(director())).status).toBe(
      404,
    );
  });

  it('shows the Ministry each facility’s progress, read-only', async () => {
    const res = await api().get('/api/v1/access-reviews/compliance').set(ministry());
    expect(res.status).toBe(200);
    expect(res.body.period).toBe(quarterOf().period);
    const row = res.body.items.find((r: { facilityId: string }) => r.facilityId === w.facility.id);
    expect(row).toMatchObject({ reviewId, status: 'COMPLETED', revoked: 1, overdue: false });
    expect(JSON.stringify(res.body)).not.toContain(w.users.reception.email);

    const read = await api().get(`/api/v1/access-reviews/${reviewId}`).set(ministry());
    expect(read.status).toBe(200);
    expect(read.body.canDecide).toBe(false);
    const item = (read.body.items as Item[])[0]!;
    expect((await decide(item.id, { decision: 'KEEP' }, ministry())).status).toBe(403);
  });

  it('refuses other roles and other facilities', async () => {
    for (const token of [w.tokens.doctor, w.tokens.nurse, w.tokens.patient, w.tokens.pharmacist]) {
      expect((await api().get('/api/v1/access-reviews').set(bearer(token))).status).toBe(403);
    }
    const other = bearer(w.tokens.otherDirector);
    expect((await api().get(`/api/v1/access-reviews/${reviewId}`).set(other)).status).toBe(404);
    expect(
      (await api().get(`/api/v1/access-reviews/${reviewId}/export.csv`).set(other)).status,
    ).toBe(404);
    expect((await api().get('/api/v1/access-reviews/compliance').set(director())).status).toBe(403);
    const mine = await api().get('/api/v1/access-reviews').set(director());
    expect(mine.body.items.map((r: { id: string }) => r.id)).toContain(reviewId);
    expect(
      (await api().get('/api/v1/access-reviews').set(other)).body.items.map(
        (r: { id: string }) => r.id,
      ),
    ).not.toContain(reviewId);
  });
});

describe('the worker', () => {
  it('opens the quarter once and reminds the directors of an overdue review once', async () => {
    const f = await createFacility();
    const head = await createUser('DIRECTOR', f.id);
    await createUser('DOCTOR', f.id);
    await createPatient(f.id);
    // A review from an earlier quarter that was never completed.
    const { review: old } = await openReview(f.id, { now: new Date('2025-01-01T08:00:00Z') });
    expect(old.dueDate).toBe('2025-01-31');
    // Opened late in a quarter, the reviewers still get 30 days.
    const late = await openReview(f.id, { now: new Date('2025-06-20T08:00:00Z') });
    expect(late.review.dueDate).toBe('2025-07-20');

    const first = await runAccessReviewsWorkerOnce(new Date(), { facilityIds: [f.id] });
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const second = await runAccessReviewsWorkerOnce(new Date(), { facilityIds: [f.id] });
    expect(second.opened).toBe(0);

    const mine = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, head.id), eq(notifications.type, 'access_review')));
    const overdue = mine.filter((n) => n.link?.includes(`ard=${old.id}`));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.title).toBe('The access review 2025-Q1 is overdue');
    // The current quarter's review was opened and announced once.
    const announced = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, head.id), like(notifications.link, '%aro=%')));
    expect(announced).toHaveLength(1);
  });
});
