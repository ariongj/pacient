import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  mfaRecoveryCodes,
  notifications,
  oneTimeTokens,
  users,
} from '../src/db/schema.js';
import { newReference } from '../src/modules/support/support.service.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let it1: Awaited<ReturnType<typeof createUser>>;
let itToken: string;
let otherItToken: string;
let director2Token: string;

beforeAll(async () => {
  w = await createWorld();
  it1 = await createUser('IT_SUPPORT', w.facility.id);
  itToken = await login(it1.email);
  otherItToken = await login((await createUser('IT_SUPPORT', w.otherFacility.id)).email);
  director2Token = await login((await createUser('DIRECTOR', w.facility.id)).email);
});

const post = (token: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/support${path}`).set(bearer(token)).send(body);

async function ticket(
  token: string,
  kind: string,
  subjectUserId?: string,
  description = 'I cannot sign in since this morning',
) {
  const res = await post(token, '/tickets', { kind, description, subjectUserId });
  expect(res.status).toBe(201);
  return res.body as { id: string; reference: string; status: string };
}

describe('requests', () => {
  it('lets staff open requests about themselves or a colleague of their facility', async () => {
    expect(newReference(new Date('2026-11-09T10:00:00Z'))).toMatch(/^IT-2611-[A-Z2-9]{6}$/);
    const t = await ticket(w.tokens.nurse, 'PASSWORD_RESET');
    expect(t.status).toBe('OPEN');
    const about = await ticket(w.tokens.doctor, 'ACCOUNT_LOCKED', w.users.colleague.id);
    expect(about.reference).toMatch(/^IT-/);
    // Not about a patient account or someone of another facility.
    expect(
      (
        await post(w.tokens.doctor, '/tickets', {
          kind: 'OTHER',
          description: 'Something else',
          subjectUserId: w.users.patientUser.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(w.tokens.doctor, '/tickets', {
          kind: 'OTHER',
          description: 'Something else',
          subjectUserId: w.users.outsideDoctor.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(w.tokens.patient, '/tickets', { kind: 'OTHER', description: 'Help me' })).status,
    ).toBe(403);
    // IT support is told about new requests.
    const n = await db.select().from(notifications).where(eq(notifications.userId, it1.id));
    expect(n.some((x) => x.title === `New IT support request ${t.reference}`)).toBe(true);
  });

  it('shows the desk the facility’s requests and everyone else only their own', async () => {
    const t = await ticket(w.tokens.pharmacist, 'DEVICE', undefined, 'Label printer is offline');
    const desk = await api().get('/api/v1/support/tickets').set(bearer(itToken));
    const row = desk.body.items.find((i: { id: string }) => i.id === t.id);
    expect(row.subject).toMatchObject({ id: w.users.pharmacist.id, locked: false });
    const otherDesk = await api().get('/api/v1/support/tickets').set(bearer(otherItToken));
    expect(otherDesk.body.items.find((i: { id: string }) => i.id === t.id)).toBeUndefined();
    const nurseList = await api().get('/api/v1/support/tickets').set(bearer(w.tokens.nurse));
    expect(nurseList.body.items.find((i: { id: string }) => i.id === t.id)).toBeUndefined();
    expect(
      (await api().get(`/api/v1/support/tickets/${t.id}`).set(bearer(w.tokens.nurse))).status,
    ).toBe(404);
    const own = await api().get(`/api/v1/support/tickets/${t.id}`).set(bearer(w.tokens.pharmacist));
    expect(own.status).toBe(200);
    expect(own.body.subject).not.toHaveProperty('email');
  });
});

describe('account actions', () => {
  it('unlocks an account and sends a reset link, audited on the account', async () => {
    await db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() + 15 * 60_000), failedLoginAttempts: 5 })
      .where(eq(users.id, w.users.colleague.id));
    const t = await ticket(w.tokens.doctor, 'ACCOUNT_LOCKED', w.users.colleague.id);
    expect((await post(w.tokens.director, `/tickets/${t.id}/unlock`)).status).toBe(403);
    expect((await post(otherItToken, `/tickets/${t.id}/unlock`)).status).toBe(404);
    const unlocked = await post(itToken, `/tickets/${t.id}/unlock`);
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.subject).toMatchObject({ locked: false, failedLoginAttempts: 0 });
    const reset = await post(itToken, `/tickets/${t.id}/password-reset`);
    expect(reset.status).toBe(200);
    const tokens = await db
      .select()
      .from(oneTimeTokens)
      .where(
        and(
          eq(oneTimeTokens.userId, w.users.colleague.id),
          eq(oneTimeTokens.purpose, 'PASSWORD_RESET'),
        ),
      );
    expect(tokens.length).toBeGreaterThan(0);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, w.users.colleague.id),
          eq(auditLogs.action, 'support.account_action'),
        ),
      );
    expect(audits.map((a) => (a.metadata as { action: string }).action).sort()).toEqual([
      'PASSWORD_RESET_LINK',
      'UNLOCK',
    ]);
    const done = await post(itToken, `/tickets/${t.id}/resolve`, { resolution: 'Unlocked' });
    expect(done.body.status).toBe('RESOLVED');
    expect((await post(itToken, `/tickets/${t.id}/unlock`)).status).toBe(409);
    const n = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.doctor.id));
    expect(n.some((x) => x.title === `Your IT support request ${t.reference} was resolved`)).toBe(
      true,
    );
  });

  it('resets two-step sign-in only after a director (not the subject) approved', async () => {
    await db
      .update(users)
      .set({ mfaEnabledAt: new Date(), mfaSecretEncrypted: 'sealed-test-secret' })
      .where(eq(users.id, w.users.nurse.id));
    await db.insert(mfaRecoveryCodes).values({ userId: w.users.nurse.id, codeHash: 'test-hash' });
    const t = await ticket(w.tokens.nurse, 'MFA_RESET', undefined, 'Lost my phone');
    expect((await post(itToken, `/tickets/${t.id}/mfa-reset`)).status).toBe(403);
    expect((await post(w.tokens.director, `/tickets/${t.id}/approve`)).status).toBe(409);
    const asked = await post(itToken, `/tickets/${t.id}/request-approval`);
    expect(asked.body.status).toBe('AWAITING_APPROVAL');
    expect((await post(itToken, `/tickets/${t.id}/approve`)).status).toBe(403);
    expect((await post(itToken, `/tickets/${t.id}/resolve`, { resolution: 'x done' })).status).toBe(
      409,
    );
    const dn = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.director.id));
    expect(dn.some((x) => x.title.includes(t.reference))).toBe(true);
    const approved = await post(w.tokens.director, `/tickets/${t.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('IN_PROGRESS');
    const reset = await post(itToken, `/tickets/${t.id}/mfa-reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.subject.twoStepEnabled).toBe(false);
    const [nurse] = await db.select().from(users).where(eq(users.id, w.users.nurse.id));
    expect(nurse).toMatchObject({ mfaEnabledAt: null, mfaSecretEncrypted: null });
    expect(
      await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, w.users.nurse.id)),
    ).toHaveLength(0);
  });

  it('needs another director for a director’s own account, and a reason to decline', async () => {
    const t = await ticket(w.tokens.director, 'MFA_RESET', undefined, 'New phone, lost the app');
    await post(itToken, `/tickets/${t.id}/request-approval`);
    expect((await post(w.tokens.director, `/tickets/${t.id}/approve`)).status).toBe(403);
    expect((await post(director2Token, `/tickets/${t.id}/reject-approval`, {})).status).toBe(400);
    const declined = await post(director2Token, `/tickets/${t.id}/reject-approval`, {
      note: 'Please come to the IT office with your ID',
    });
    expect(declined.body.status).toBe('REJECTED');
  });

  it('never lets IT support act on their own account or change roles', async () => {
    const own = await ticket(itToken, 'ACCOUNT_LOCKED', undefined, 'My own account');
    expect((await post(itToken, `/tickets/${own.id}/unlock`)).status).toBe(403);
    const access = await ticket(w.tokens.nurse, 'ACCESS_CHANGE', undefined, 'I moved to ICU');
    expect((await post(itToken, `/tickets/${access.id}/mfa-reset`)).status).toBe(400);
    // Role changes stay with the director on the staff page.
    expect((await api().get('/api/v1/staff').set(bearer(itToken))).status).toBe(403);
  });
});

describe('Ministry statistics and patient data', () => {
  it('gives the Ministry counts per facility without content', async () => {
    const stats = await api().get('/api/v1/support/stats').set(bearer(w.tokens.ministry));
    expect(stats.status).toBe(200);
    const mine = stats.body.facilities.find(
      (f: { facilityId: string }) => f.facilityId === w.facility.id,
    );
    expect(mine.resolved30d).toBeGreaterThan(0);
    const text = JSON.stringify(stats.body);
    expect(text).not.toContain('Lost my phone');
    expect(text).not.toContain(w.users.nurse.fullName);
    expect((await api().get('/api/v1/support/stats').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });

  it('keeps IT support away from patient data', async () => {
    const auth = bearer(itToken);
    const id = w.patient.id;
    expect((await api().get(`/api/v1/patients/${id}`).set(auth)).status).toBe(403);
    expect((await api().get(`/api/v1/patients/${id}/summary`).set(auth)).status).toBe(403);
    expect((await api().get(`/api/v1/patients/${id}/documents`).set(auth)).status).toBe(403);
    expect((await api().get('/api/v1/patients').set(auth)).status).toBe(403);
    expect((await api().get(`/api/v1/fhir/Patient/${id}`).set(auth)).status).toBe(403);
    expect((await api().get('/api/v1/lab-work/worklist').set(auth)).status).toBe(403);
    const colleagues = await api().get('/api/v1/support/colleagues').set(auth);
    expect(colleagues.body.items.some((c: { role: string }) => c.role === 'PATIENT')).toBe(false);
  });
});
