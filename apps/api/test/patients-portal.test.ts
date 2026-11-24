import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  emailOutbox,
  mfaRecoveryCodes,
  notifications,
  oneTimeTokens,
  patients,
  refreshTokens,
  users,
} from '../src/db/schema.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

/**
 * A patient whose invitation link expired, or who lost their authenticator and recovery codes,
 * goes to their facility: reception or a director verifies their identity in person and sends
 * the invitation again or resets their two-step sign-in (the administrator cannot).
 */
let w: Awaited<ReturnType<typeof createWorld>>;
const PASSWORD = 'Activated-Passw0rd-2026!';
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
const invite = (patientId: string, token: string) =>
  api().post(`/api/v1/patients/${patientId}/portal-invitation`).set(bearer(token));
const resetTwoStep = (patientId: string, token: string, body: object = {}) =>
  api()
    .post(`/api/v1/patients/${patientId}/portal-account/two-step-reset`)
    .set(bearer(token))
    .send(body);
const activate = (url: string) =>
  api()
    .post('/api/v1/auth/activate')
    .send({ token: tokenOf(url), password: PASSWORD });

beforeAll(async () => {
  w = await createWorld();
});

async function patientWithEmail() {
  const p = await createPatient(w.facility.id);
  const email = `portal-${randomUUID().slice(0, 8)}@example.test`;
  await db.update(patients).set({ email }).where(eq(patients.id, p.id));
  return { ...p, email };
}

const accountOf = async (patientId: string) => {
  const [row] = await db
    .select({ userId: patients.userId })
    .from(patients)
    .where(eq(patients.id, patientId));
  return row!.userId!;
};

describe('a portal invitation that was not accepted', () => {
  it('is sent again by the facility; earlier links stop working', async () => {
    const p = await patientWithEmail();
    const first = await invite(p.id, w.tokens.reception);
    expect(first.status).toBe(201);
    const userId = await accountOf(p.id);

    // The link expired unused: a new one, in the name of the staff member, audited.
    const again = await invite(p.id, w.tokens.reception);
    expect(again.status).toBe(201);
    expect(again.body.renewed).toBe(true);
    expect(again.body.activationUrl).toBeTruthy();
    expect(again.body.activationUrl).not.toBe(first.body.activationUrl);
    const tokens = await db
      .select()
      .from(oneTimeTokens)
      .where(
        and(eq(oneTimeTokens.userId, userId), eq(oneTimeTokens.purpose, 'ACCOUNT_ACTIVATION')),
      );
    expect(tokens).toHaveLength(2);
    expect(tokens.filter((tk) => tk.usedAt === null)).toHaveLength(1);
    expect(tokens.every((tk) => tk.createdById === w.users.reception.id)).toBe(true);
    const mails = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, userId), eq(emailOutbox.template, 'activation')));
    expect(mails).toHaveLength(2);
    const entries = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'user.invited'), eq(auditLogs.resourceId, userId)));
    expect(entries).toHaveLength(2);
    const renewal = entries.find((e) => (e.metadata as { renewed?: boolean }).renewed);
    expect(renewal).toMatchObject({ actorUserId: w.users.reception.id, patientId: p.id });

    // Only the newest link activates the account; then the invitation is done.
    expect((await activate(first.body.activationUrl)).status).toBe(400);
    expect((await activate(again.body.activationUrl)).status).toBe(204);
    const done = await invite(p.id, w.tokens.director);
    expect(done.status).toBe(409);
    expect(done.body.error.message).toBe('This patient already has a portal account');
  });

  it('goes to the e-mail address on file, also when it was corrected', async () => {
    const p = await patientWithEmail();
    expect((await invite(p.id, w.tokens.director)).status).toBe(201);
    const userId = await accountOf(p.id);
    const corrected = `corrected-${randomUUID().slice(0, 8)}@example.test`;
    const patched = await api()
      .patch(`/api/v1/patients/${p.id}`)
      .set(bearer(w.tokens.reception))
      .send({ email: corrected });
    expect(patched.status).toBe(200);
    expect((await invite(p.id, w.tokens.reception)).status).toBe(201);
    const [account] = await db.select().from(users).where(eq(users.id, userId));
    expect(account!.email).toBe(corrected);
    const [latest] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.userId, userId))
      .orderBy(sql`${emailOutbox.createdAt} DESC`)
      .limit(1);
    expect(latest!.toEmail).toBe(corrected);

    // Not to an address another account already uses.
    const other = await createUser('NURSE', w.facility.id);
    await db.update(patients).set({ email: other.email }).where(eq(patients.id, p.id));
    const taken = await invite(p.id, w.tokens.reception);
    expect(taken.status).toBe(409);
    expect((await db.select().from(users).where(eq(users.id, userId)))[0]!.email).toBe(corrected);
  });

  it('is not sent again for a closed account or by another facility', async () => {
    const p = await patientWithEmail();
    expect((await invite(p.id, w.tokens.reception)).status).toBe(201);
    const userId = await accountOf(p.id);
    expect((await invite(p.id, w.tokens.otherDirector)).status).toBe(403);
    // Clinicians send the first invitation only: a new link needs the desk's identity check.
    const byNurse = await invite(p.id, w.tokens.nurse);
    expect(byNurse.status).toBe(403);
    expect(byNurse.body.error.message).toBe(
      'The invitation is sent again by reception or a director, who verify the patient’s identity in person',
    );
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
    const closed = await invite(p.id, w.tokens.reception);
    expect(closed.status).toBe(409);
    expect(closed.body.error.message).toBe('This patient’s portal account is closed');
    const open = await db
      .select()
      .from(oneTimeTokens)
      .where(and(eq(oneTimeTokens.userId, userId), isNull(oneTimeTokens.usedAt)));
    expect(open).toHaveLength(1);
  });
});

describe('a patient’s two-step sign-in', () => {
  async function withTwoStep() {
    const patientUser = await createUser('PATIENT');
    const p = await createPatient(w.facility.id, { userId: patientUser.id });
    // Signed in on a device before losing the phone.
    await login(patientUser.email);
    await db
      .update(users)
      .set({ mfaEnabledAt: new Date(), mfaSecretEncrypted: 'sealed-test-secret' })
      .where(eq(users.id, patientUser.id));
    await db.insert(mfaRecoveryCodes).values({ userId: patientUser.id, codeHash: 'test-hash' });
    return { p, patientUser };
  }

  it('is reset by reception or a director of the facility, who sign the patient out and tell them', async () => {
    const { p, patientUser } = await withTwoStep();
    const reason = 'Lost phone; identity checked with ID card at the desk';
    // Not by clinicians, not by another facility, not without a reason.
    expect((await resetTwoStep(p.id, w.tokens.doctor, { reason })).status).toBe(403);
    expect((await resetTwoStep(p.id, w.tokens.nurse, { reason })).status).toBe(403);
    expect((await resetTwoStep(p.id, w.tokens.otherDirector, { reason })).status).toBe(403);
    expect((await resetTwoStep(p.id, w.tokens.reception, {})).status).toBe(400);

    const res = await resetTwoStep(p.id, w.tokens.reception, { reason });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reset: true, sessionsRevoked: 1 });
    const [u] = await db.select().from(users).where(eq(users.id, patientUser.id));
    expect(u).toMatchObject({ mfaEnabledAt: null, mfaSecretEncrypted: null });
    expect(
      await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, patientUser.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, patientUser.id), isNull(refreshTokens.revokedAt))),
    ).toHaveLength(0);
    const told = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, patientUser.id));
    expect(told.map((n) => n.title)).toContain('Your two-step sign-in was reset by your facility');
    const [entry, ...more] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'user.mfa_reset'), eq(auditLogs.resourceId, patientUser.id)));
    expect(more).toHaveLength(0);
    expect(entry).toMatchObject({ actorUserId: w.users.reception.id, patientId: p.id });
    expect(entry!.metadata).toMatchObject({ reason, sessionsRevoked: 1 });

    // Nothing left to reset; a patient without a portal account has nothing to reset either.
    const again = await resetTwoStep(p.id, w.tokens.director, { reason });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('Two-step sign-in is not set up for this account');
    const none = await createPatient(w.facility.id);
    expect((await resetTwoStep(none.id, w.tokens.director, { reason })).status).toBe(409);
  });

  it('is reset only together with its audit entry (one transaction)', async () => {
    const { p, patientUser } = await withTwoStep();
    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION test_fail_patient_mfa_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'user.mfa_reset' AND NEW.resource_id = '${patientUser.id}' THEN
            RAISE EXCEPTION 'audit unavailable';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql`),
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER test_fail_patient_mfa_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_fail_patient_mfa_audit()`),
    );
    try {
      const res = await resetTwoStep(p.id, w.tokens.director, { reason: 'Identity checked' });
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER test_fail_patient_mfa_audit ON audit_logs'));
      await db.execute(sql.raw('DROP FUNCTION test_fail_patient_mfa_audit()'));
    }
    const [u] = await db.select().from(users).where(eq(users.id, patientUser.id));
    expect(u!.mfaEnabledAt).not.toBeNull();
    expect(
      await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, patientUser.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, patientUser.id), isNull(refreshTokens.revokedAt))),
    ).toHaveLength(1);
  });
});

describe('a closed portal account', () => {
  it('is neither reset nor offered any portal action', async () => {
    const patientUser = await createUser('PATIENT');
    const p = await createPatient(w.facility.id, { userId: patientUser.id });
    await db
      .update(users)
      .set({ isActive: false, mfaEnabledAt: new Date(), mfaSecretEncrypted: 'sealed-test-secret' })
      .where(eq(users.id, patientUser.id));
    const reset = await resetTwoStep(p.id, w.tokens.reception, { reason: 'Lost phone' });
    expect(reset.status).toBe(409);
    expect(reset.body.error.message).toBe('This patient’s portal account is closed');
    const [still] = await db.select().from(users).where(eq(users.id, patientUser.id));
    expect(still!.mfaEnabledAt).not.toBeNull();
    const entries = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'user.mfa_reset'), eq(auditLogs.resourceId, patientUser.id)));
    expect(entries).toHaveLength(0);

    const list = await api()
      .get('/api/v1/patients')
      .query({ scope: 'facility', search: p.lastName })
      .set(bearer(w.tokens.reception));
    expect(list.status).toBe(200);
    const row = list.body.items.find((r: { id: string }) => r.id === p.id);
    expect(row).toMatchObject({ portalAccount: 'CLOSED', portalTwoStep: false });
  });
});

describe('the facility’s patient list', () => {
  it('shows the account state the portal actions need, and two-step only to the desk', async () => {
    const pending = await patientWithEmail();
    expect((await invite(pending.id, w.tokens.reception)).status).toBe(201);
    const { p: withTwoStepOn } = await (async () => {
      const patientUser = await createUser('PATIENT', null, { mfaEnabledAt: new Date() });
      return { p: await createPatient(w.facility.id, { userId: patientUser.id }) };
    })();
    const none = await createPatient(w.facility.id);
    const row = async (token: string, id: string, lastName: string) => {
      const res = await api()
        .get('/api/v1/patients')
        .query({ scope: 'facility', search: lastName })
        .set(bearer(token));
      expect(res.status).toBe(200);
      return res.body.items.find((i: { id: string }) => i.id === id);
    };
    expect(await row(w.tokens.reception, pending.id, pending.lastName)).toMatchObject({
      hasPortalAccount: true,
      portalAccount: 'PENDING',
      portalTwoStep: false,
    });
    expect(await row(w.tokens.director, withTwoStepOn.id, withTwoStepOn.lastName)).toMatchObject({
      portalAccount: 'ACTIVE',
      portalTwoStep: true,
    });
    expect(await row(w.tokens.reception, none.id, none.lastName)).toMatchObject({
      hasPortalAccount: false,
      portalAccount: null,
      portalTwoStep: false,
    });
    // Clinicians do not need it.
    const forDoctor = await row(w.tokens.doctor, withTwoStepOn.id, withTwoStepOn.lastName);
    expect(forDoctor).toMatchObject({ portalAccount: 'ACTIVE', portalTwoStep: null });
  });
});
