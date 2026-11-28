import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  emailOutbox,
  mfaRecoveryCodes,
  notifications,
  oneTimeTokens,
  platformSettings,
  refreshTokens,
  users,
} from '../src/db/schema.js';
import { hashToken } from '../src/lib/tokens.js';
import { recentBankChange } from '../src/modules/platform/bank-change.js';
import { recoverAdmin, RecoveryRefused } from '../src/ops/recover-admin.js';
import { api, bearer, createUser, createWorld, login, PASSWORD } from './helpers.js';

/**
 * Administrator security (round 2, S1): the password again for what would hand someone the
 * operator's powers or its customers' money, the other administrators told when the bank details
 * change, administrator sessions that end 12 hours after signing in, and the recovery of an
 * administrator on the server. Every test makes its own accounts; the operator settings, which
 * all files share, are put back at the end.
 */

/** The password as X-Reauth-Password carries it: b64: and the base64 of its UTF-8 bytes. */
const encoded = (password: string) => `b64:${Buffer.from(password, 'utf8').toString('base64')}`;
const REAUTH = { 'X-Reauth-Password': encoded(PASSWORD) };
const tag = `s1${randomUUID().slice(0, 6)}`;
const NEW_PASSWORD = 'Recovered-Passw0rd-2026!';

let w: Awaited<ReturnType<typeof createWorld>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let adminToken: string;
let settingsBefore: typeof platformSettings.$inferSelect | undefined;

beforeAll(async () => {
  w = await createWorld();
  admin = await createUser('ADMIN', null, { fullName: `${tag} Admin` });
  adminToken = await login(admin.email);
  [settingsBefore] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
});

afterAll(async () => {
  if (settingsBefore) {
    const { id: _id, ...rest } = settingsBefore;
    await db.update(platformSettings).set(rest).where(eq(platformSettings.id, 1));
  }
});

/** Signs in with the password, returning the access token and the refresh cookie. */
async function signIn(email: string, password = PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('pacient_rt='),
  )!;
  return {
    token: res.body.accessToken as string,
    expiresIn: res.body.expiresIn as number,
    cookie: cookie.split(';')[0]!,
    setCookie: cookie,
  };
}

const refresh = (cookie: string) => api().post('/api/v1/auth/refresh').set('Cookie', cookie);

const expectReauth = (res: { status: number; body: { error?: { code?: string } } }) => {
  expect(res.status).toBe(401);
  expect(res.body.error?.code).toBe('REAUTH_REQUIRED');
};

async function auditOf(action: string, resourceId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)));
}

async function reauthAudit(actorId: string) {
  return db
    .select({ outcome: auditLogs.outcome, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.actorUserId, actorId), eq(auditLogs.action, 'auth.reauthenticated')));
}

const usersApi = '/api/v1/admin/users';

/* ------------------------------------------------------------------ administrator accounts -- */

describe('the password again for administrator accounts', () => {
  it('asks before inviting an administrator, and not for other roles', async () => {
    const email = `${tag}-new-admin@example.test`;
    const body = { email, fullName: `${tag} New Admin`, role: 'ADMIN' };
    expectReauth(await api().post(usersApi).set(bearer(adminToken)).send(body));

    const wrong = await api()
      .post(usersApi)
      .set(bearer(adminToken))
      .set('X-Reauth-Password', encoded('not-the-password'))
      .send(body);
    expectReauth(wrong);
    expect(wrong.body.error.message).toBe('Password is incorrect');
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);

    const ok = await api().post(usersApi).set(bearer(adminToken)).set(REAUTH).send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.user.role).toBe('ADMIN');
    expect(await auditOf('admin.user.invited', ok.body.user.id)).toHaveLength(1);
    // The confirmation is audited (and the wrong password as a failure), never the password.
    const confirmations = await reauthAudit(admin.id);
    expect(confirmations.map((r) => r.outcome)).toEqual(
      expect.arrayContaining(['SUCCESS', 'FAILURE']),
    );
    expect(JSON.stringify(confirmations)).not.toContain(PASSWORD);

    // A Ministry official is invited without it.
    const ministry = await api()
      .post(usersApi)
      .set(bearer(adminToken))
      .send({
        email: `${tag}-official@example.test`,
        fullName: `${tag} Official`,
        role: 'MINISTRY',
      });
    expect(ministry.status).toBe(201);
  });

  it('asks before making someone an administrator, changing one or demoting one', async () => {
    const official = await createUser('MINISTRY', null, { fullName: `${tag} Official two` });
    const promote = { role: 'ADMIN', reason: 'Joins the operator team' };
    expectReauth(
      await api().patch(`${usersApi}/${official.id}`).set(bearer(adminToken)).send(promote),
    );
    const [still] = await db.select().from(users).where(eq(users.id, official.id));
    expect(still!.role).toBe('MINISTRY');
    expect(await auditOf('admin.user.updated', official.id)).toHaveLength(0);

    const promoted = await api()
      .patch(`${usersApi}/${official.id}`)
      .set(bearer(adminToken))
      .set(REAUTH)
      .send(promote);
    expect(promoted.status).toBe(200);
    expect(promoted.body.user.role).toBe('ADMIN');

    // Any change to an administrator's account, a rename included.
    const rename = { fullName: `${tag} Renamed Admin` };
    expectReauth(
      await api().patch(`${usersApi}/${official.id}`).set(bearer(adminToken)).send(rename),
    );
    expect(
      (
        await api()
          .patch(`${usersApi}/${official.id}`)
          .set(bearer(adminToken))
          .set(REAUTH)
          .send(rename)
      ).status,
    ).toBe(200);

    const demote = { role: 'MINISTRY', reason: 'Back to the Ministry' };
    expectReauth(
      await api().patch(`${usersApi}/${official.id}`).set(bearer(adminToken)).send(demote),
    );
    const demoted = await api()
      .patch(`${usersApi}/${official.id}`)
      .set(bearer(adminToken))
      .set(REAUTH)
      .send(demote);
    expect(demoted.status).toBe(200);
    expect(demoted.body.user.role).toBe('MINISTRY');

    // Changing someone who is not and does not become an administrator asks for nothing.
    expect(
      (
        await api()
          .patch(`${usersApi}/${official.id}`)
          .set(bearer(adminToken))
          .send({ fullName: `${tag} Official again` })
      ).status,
    ).toBe(200);
  });

  it('asks before resetting two-step sign-in, disabling or signing out, and changes nothing without it', async () => {
    const director = await createUser('DIRECTOR', w.facility.id, {
      mfaEnabledAt: new Date(),
      mfaSecretEncrypted: 'sealed-secret',
      mfaLastUsedStep: 1,
    });
    // A signed-in device (the director signs in with two steps; the session itself is enough).
    await db.insert(refreshTokens).values({
      userId: director.id,
      tokenHash: hashToken(`${tag}-director-session`),
      familyId: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const reason = { reason: 'Lost the phone' };

    for (const action of ['mfa-reset', 'disable', 'revoke-sessions']) {
      expectReauth(
        await api()
          .post(`${usersApi}/${director.id}/${action}`)
          .set(bearer(adminToken))
          .send(reason),
      );
    }
    const [unchanged] = await db.select().from(users).where(eq(users.id, director.id));
    expect(unchanged!.isActive).toBe(true);
    expect(unchanged!.mfaEnabledAt).not.toBeNull();
    const live = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, director.id), sql`${refreshTokens.revokedAt} IS NULL`));
    expect(live).toHaveLength(1);
    for (const action of [
      'admin.user.mfa_reset',
      'admin.user.disabled',
      'admin.user.sessions_revoked',
    ]) {
      expect(await auditOf(action, director.id)).toHaveLength(0);
    }

    // Asked first, before anything else is checked: a stolen session learns nothing either.
    expectReauth(
      await api().post(`${usersApi}/${admin.id}/disable`).set(bearer(adminToken)).send(reason),
    );

    for (const action of ['mfa-reset', 'revoke-sessions', 'disable']) {
      const res = await api()
        .post(`${usersApi}/${director.id}/${action}`)
        .set(bearer(adminToken))
        .set(REAUTH)
        .send(reason);
      expect(res.status).toBe(200);
    }
    const [after] = await db.select().from(users).where(eq(users.id, director.id));
    expect(after!.isActive).toBe(false);
    expect(after!.mfaEnabledAt).toBeNull();
    expect(await auditOf('admin.user.disabled', director.id)).toHaveLength(1);

    // Enabling, unlocking and password reset e-mails do not ask for a director (they do for an
    // administrator: below).
    expect(
      (
        await api()
          .post(`${usersApi}/${director.id}/enable`)
          .set(bearer(adminToken))
          .send({ reason: 'Back from leave' })
      ).status,
    ).toBe(200);
  });

  it('counts a sign-in within the last 10 minutes instead of the password', async () => {
    const operator = await createUser('ADMIN', null, { fullName: `${tag} Fresh Admin` });
    const { token, cookie } = await signIn(operator.email);
    const target = await createUser('MINISTRY', null);
    const res = await api()
      .post(`${usersApi}/${target.id}/revoke-sessions`)
      .set(bearer(token))
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    await db
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(refreshTokens.userId, operator.id));
    expectReauth(
      await api()
        .post(`${usersApi}/${target.id}/revoke-sessions`)
        .set(bearer(token))
        .set('Cookie', cookie),
    );
  });

  it('locks after five wrong passwords, as signing in does', async () => {
    const guesser = await createUser('ADMIN', null);
    const token = await login(guesser.email);
    const target = await createUser('MINISTRY', null);
    const attempt = (password: string) =>
      api()
        .post(`${usersApi}/${target.id}/revoke-sessions`)
        .set(bearer(token))
        .set('X-Reauth-Password', encoded(password));

    // A confirmed password clears earlier mistakes.
    for (let i = 0; i < 4; i++) expectReauth(await attempt(`wrong-${i}`));
    expect((await attempt(PASSWORD)).status).toBe(200);
    const [cleared] = await db.select().from(users).where(eq(users.id, guesser.id));
    expect(cleared!.failedLoginAttempts).toBe(0);

    for (let i = 0; i < 5; i++) expectReauth(await attempt(`wrong-${i}`));
    // Locked: even the right password is refused for now, here and at sign-in.
    const locked = await attempt(PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toBe('Too many wrong passwords. Try again in 15 minutes.');
    expect(
      (await api().post('/api/v1/auth/login').send({ email: guesser.email, password: PASSWORD }))
        .status,
    ).toBe(401);
    const denied = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, guesser.id),
          eq(auditLogs.action, 'auth.reauthenticated'),
          eq(auditLogs.outcome, 'DENIED'),
        ),
      );
    expect(denied).toHaveLength(1);
  });

  it('never lets a session lift its own lockout: unlocking yourself is refused', async () => {
    const guesser = await createUser('ADMIN', null);
    const token = await login(guesser.email);
    const target = await createUser('MINISTRY', null);
    const guess = (password: string) =>
      api()
        .post(`${usersApi}/${target.id}/revoke-sessions`)
        .set(bearer(token))
        .set('X-Reauth-Password', encoded(password));
    for (let i = 0; i < 5; i++) expectReauth(await guess(`wrong-${i}`));

    // Before anything is looked at, with or without the password.
    for (const headers of [{}, REAUTH]) {
      const self = await api()
        .post(`${usersApi}/${guesser.id}/unlock`)
        .set(bearer(token))
        .set(headers)
        .send({});
      expect(self.status).toBe(403);
      expect(self.body.error.message).toBe('Ask another administrator to unlock your account');
    }
    const [still] = await db.select().from(users).where(eq(users.id, guesser.id));
    expect(still!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await auditOf('admin.user.unlocked', guesser.id)).toHaveLength(0);
    expect((await guess(PASSWORD)).status).toBe(429);

    // Another administrator unlocks it, with their own password: the account is an administrator's.
    expectReauth(
      await api().post(`${usersApi}/${guesser.id}/unlock`).set(bearer(adminToken)).send({}),
    );
    const unlocked = await api()
      .post(`${usersApi}/${guesser.id}/unlock`)
      .set(bearer(adminToken))
      .set(REAUTH)
      .send({});
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.user.locked).toBe(false);
    expect((await guess(PASSWORD)).status).toBe(200);
  });

  it('asks before enabling or unlocking an administrator, not for other accounts', async () => {
    const away = await createUser('ADMIN', null, { isActive: false });
    expectReauth(
      await api()
        .post(`${usersApi}/${away.id}/enable`)
        .set(bearer(adminToken))
        .send({ reason: 'Back to work' }),
    );
    expect((await db.select().from(users).where(eq(users.id, away.id)))[0]!.isActive).toBe(false);
    expect(await auditOf('admin.user.enabled', away.id)).toHaveLength(0);
    const enabled = await api()
      .post(`${usersApi}/${away.id}/enable`)
      .set(bearer(adminToken))
      .set(REAUTH)
      .send({ reason: 'Back to work' });
    expect(enabled.status).toBe(200);
    expect(enabled.body.user.isActive).toBe(true);

    const lockedAdmin = await createUser('ADMIN', null, {
      lockedUntil: new Date(Date.now() + 10 * 60_000),
      failedLoginAttempts: 0,
    });
    expectReauth(
      await api().post(`${usersApi}/${lockedAdmin.id}/unlock`).set(bearer(adminToken)).send({}),
    );
    expect(await auditOf('admin.user.unlocked', lockedAdmin.id)).toHaveLength(0);

    // A Ministry official: neither asks.
    const official = await createUser('MINISTRY', null, {
      isActive: false,
      lockedUntil: new Date(Date.now() + 10 * 60_000),
    });
    expect(
      (await api().post(`${usersApi}/${official.id}/unlock`).set(bearer(adminToken)).send({}))
        .status,
    ).toBe(200);
    expect(
      (
        await api()
          .post(`${usersApi}/${official.id}/enable`)
          .set(bearer(adminToken))
          .send({ reason: 'Back to work' })
      ).status,
    ).toBe(200);
  });

  it('keeps the endpoints to the platform administrator', async () => {
    for (const token of [w.tokens.director, w.tokens.ministry]) {
      const res = await api()
        .post(`${usersApi}/${w.users.doctor.id}/disable`)
        .set(bearer(token))
        .set(REAUTH)
        .send({ reason: 'Not allowed here' });
      expect(res.status).toBe(403);
    }
  });
});

/* ------------------------------------------------------------------ operator settings ------- */

const IBAN_A = 'XK05 1212 0123 4567 8906';
const IBAN_B = 'XK98 1212 0123 4500 0075';
const putSettings = (body: Record<string, unknown>, token = adminToken) =>
  api().put('/api/v1/admin/settings').set(bearer(token)).send(body);

/** The bank-change notices a user received. */
async function bankNotices(userId: string) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, 'security'),
        eq(notifications.link, '/admin/settings'),
      ),
    );
}

describe('bank details, VAT and invoice numbering', () => {
  beforeAll(async () => {
    const base = await putSettings({
      operatorIban: IBAN_A,
      operatorBank: `${tag} Bank`,
      operatorVatNumber: '330000001',
      vatRateBp: 0,
      invoicePrefix: 'PAC',
    }).set(REAUTH);
    expect(base.status).toBe(200);
  });

  it('asks for the password only when one of them changes', async () => {
    const [before] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    const changes: Record<string, unknown>[] = [
      { operatorIban: IBAN_B },
      { operatorBank: `${tag} Other Bank` },
      { vatRateBp: 1800 },
      { operatorVatNumber: '330000002' },
      { invoicePrefix: 'TST' },
    ];
    for (const change of changes) expectReauth(await putSettings(change));
    expectReauth(
      await putSettings(changes[0]!).set('X-Reauth-Password', encoded('not-the-password')),
    );
    const [after] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    expect(after).toEqual(before);

    // The page sends every field back: unchanged bank details with a new notice ask for nothing.
    const page = (await api().get('/api/v1/admin/settings').set(bearer(adminToken))).body;
    const fields = Object.fromEntries(
      [
        'operatorName',
        'operatorAddress',
        'operatorFiscalNumber',
        'operatorVatNumber',
        'operatorIban',
        'operatorBank',
        'supportEmail',
        'supportPhone',
        'privacyEmail',
        'invoicePrefix',
        'paymentTermsDays',
        'vatRateBp',
        'trialDays',
        'graceDays',
        'noticeTone',
      ].map((k) => [k, page[k]]),
    );
    const notice = await putSettings({ ...fields, noticeText: `${tag} maintenance tonight` });
    expect(notice.status).toBe(200);
    expect(notice.body.noticeText).toBe(`${tag} maintenance tonight`);
    await putSettings({ noticeText: null });

    for (const change of changes) {
      const res = await putSettings(change).set(REAUTH);
      expect(res.status).toBe(200);
    }
    const [changed] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    expect(changed).toMatchObject({
      operatorIban: IBAN_B,
      operatorBank: `${tag} Other Bank`,
      vatRateBp: 1800,
      operatorVatNumber: '330000002',
      invoicePrefix: 'TST',
    });
  });

  it('tells every other active administrator when the IBAN or bank changes', async () => {
    const actor = await createUser('ADMIN', null, { fullName: `${tag} Bank Changer` });
    const actorToken = await login(actor.email);
    const colleague = await createUser('ADMIN', null, { fullName: `${tag} Colleague` });
    const quiet = await createUser('ADMIN', null, {
      fullName: `${tag} Quiet Colleague`,
      emailNotifications: 'OFF',
    });
    const disabled = await createUser('ADMIN', null, { isActive: false });
    const invited = await createUser('ADMIN', null, { passwordHash: null });
    const official = await createUser('MINISTRY', null);

    const res = await putSettings({ operatorIban: IBAN_A }, actorToken).set(REAUTH);
    expect(res.status).toBe(200);

    const [notice] = await bankNotices(colleague.id);
    expect(notice!.title).toMatch(
      new RegExp(`^The bank details on invoices were changed by ${actor.fullName} at `),
    );
    expect(notice!.body).toContain('Operator settings');
    // A security notice: e-mailed too, once, whatever the colleague's e-mail preference (the
    // default one, or e-mail switched off altogether).
    for (const u of [colleague, quiet]) {
      const mails = await db
        .select()
        .from(emailOutbox)
        .where(and(eq(emailOutbox.userId, u.id), eq(emailOutbox.template, 'notification')));
      expect(mails).toHaveLength(1);
    }
    expect(await bankNotices(quiet.id)).toHaveLength(1);
    for (const u of [actor, disabled, invited, official]) {
      expect(await bankNotices(u.id)).toHaveLength(0);
      expect(await db.select().from(emailOutbox).where(eq(emailOutbox.userId, u.id))).toHaveLength(
        0,
      );
    }
    const [audited] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.actorUserId, actor.id), eq(auditLogs.action, 'platform.settings.updated')),
      );
    expect(audited!.metadata).toEqual({ fields: ['operatorIban'] });

    // The bank name too; VAT, the prefix or the notice alone tell nobody.
    expect(
      (await putSettings({ operatorBank: `${tag} Third Bank` }, actorToken).set(REAUTH)).status,
    ).toBe(200);
    expect(await bankNotices(colleague.id)).toHaveLength(2);
    expect(
      (await putSettings({ vatRateBp: 0, invoicePrefix: 'PAC' }, actorToken).set(REAUTH)).status,
    ).toBe(200);
    expect((await putSettings({ noticeText: null }, actorToken)).status).toBe(200);
    expect(await bankNotices(colleague.id)).toHaveLength(2);
  });

  it('changes nothing when the notice cannot be written (one transaction)', async () => {
    const colleague = await createUser('ADMIN', null, { fullName: `${tag} Colleague two` });
    const [before] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    // Make the notice fail inside the database, as a full disk or a lost connection would.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION s1_test_refuse_bank_notice() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'notice refused by the test'; END $$ LANGUAGE plpgsql`);
    await db.execute(sql`
      CREATE TRIGGER s1_test_refuse_bank_notice BEFORE INSERT ON notifications
      FOR EACH ROW WHEN (NEW.type = 'security' AND NEW.link = '/admin/settings')
      EXECUTE FUNCTION s1_test_refuse_bank_notice()`);
    try {
      const res = await putSettings({ operatorIban: IBAN_B }).set(REAUTH);
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql`DROP TRIGGER s1_test_refuse_bank_notice ON notifications`);
      await db.execute(sql`DROP FUNCTION s1_test_refuse_bank_notice()`);
    }
    const [after] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    expect(after!.operatorIban).toBe(before!.operatorIban);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
    expect(await bankNotices(colleague.id)).toHaveLength(0);
  });

  it('shows the latest bank change of the last 14 days on the platform overview', async () => {
    const actor = await createUser('ADMIN', null, { fullName: `${tag} Latest Changer` });
    const actorToken = await login(actor.email);
    const res = await putSettings({ operatorIban: IBAN_B }, actorToken).set(REAUTH);
    expect(res.status).toBe(200);
    // A later change of something else does not hide it.
    expect((await putSettings({ noticeText: `${tag} later notice` }, actorToken)).status).toBe(200);
    await putSettings({ noticeText: null }, actorToken);

    const card = await api().get('/api/v1/admin/settings/bank-change').set(bearer(adminToken));
    expect(card.status).toBe(200);
    expect(card.body.change).toMatchObject({
      changedById: actor.id,
      changedByName: actor.fullName,
      fields: ['operatorIban'],
      operatorIban: IBAN_B,
    });
    expect(Date.now() - new Date(card.body.change.changedAt).getTime()).toBeLessThan(60_000);

    // Shown for 14 days, then gone.
    const day = 86_400_000;
    expect(await recentBankChange(new Date(Date.now() + 13 * day))).not.toBeNull();
    expect(await recentBankChange(new Date(Date.now() + 15 * day))).toBeNull();

    for (const token of [w.tokens.director, w.tokens.ministry]) {
      expect(
        (await api().get('/api/v1/admin/settings/bank-change').set(bearer(token))).status,
      ).toBe(403);
    }
  });
});

/* ------------------------------------------------------------------ legal texts ------------- */

describe('publishing a legal text', () => {
  // No document is created here: legal texts and their audit entries cannot be removed again,
  // and the legal tests (platform.test.ts) count them. They publish with the password.
  it('asks for the password before anything is looked at', async () => {
    const publish = () =>
      api().post(`/api/v1/admin/legal/${randomUUID()}/publish`).set(bearer(adminToken)).send({});
    expectReauth(await publish());
    expectReauth(await publish().set('X-Reauth-Password', encoded('not-the-password')));
    // With the password the request reaches the document (none with this id).
    const confirmed = await publish().set(REAUTH);
    expect(confirmed.status).toBe(404);
    expect(confirmed.body.error.message).toBe('Document not found');
  });
});

/* ------------------------------------------------------------------ admin sessions ---------- */

describe('administrator sessions', () => {
  const HOUR = 3_600_000;

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    (res.headers['set-cookie'] as string[])
      .find((c) => c.startsWith('pacient_rt='))!
      .split(';')[0]!;

  async function familyOf(userId: string) {
    return db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId))
      .orderBy(refreshTokens.createdAt);
  }

  it('end 12 hours after signing in, however active', async () => {
    const operator = await createUser('ADMIN', null);
    const before = Date.now();
    const first = await signIn(operator.email);
    const [token] = await familyOf(operator.id);
    expect(token!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 12 * HOUR - 5_000);
    expect(token!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 12 * HOUR + 5_000);
    expect(first.expiresIn).toBe(900);
    // The browser drops the cookie at the same moment.
    const expires = /Expires=([^;]+)/.exec(first.setCookie)![1]!;
    expect(Math.abs(new Date(expires).getTime() - token!.expiresAt.getTime())).toBeLessThan(2_000);

    // Signed in 11 h 50 min ago and in use since (the sign-in's token was refreshed a minute
    // ago): refreshing keeps the end of the session where it was.
    await db
      .update(refreshTokens)
      .set({
        createdAt: new Date(Date.now() - 12 * HOUR + 10 * 60_000),
        revokedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(refreshTokens.userId, operator.id));
    const latest = `${tag}-latest-${randomUUID()}`;
    await db.insert(refreshTokens).values({
      userId: operator.id,
      tokenHash: hashToken(latest),
      familyId: token!.familyId,
      expiresAt: token!.expiresAt,
      createdAt: new Date(Date.now() - 60_000),
    });
    const second = await refresh(`pacient_rt=${latest}`);
    expect(second.status).toBe(200);
    const deadline = Date.now() + 10 * 60_000;
    const tokens = await familyOf(operator.id);
    const newest = tokens.find((t) => t.revokedAt === null)!;
    expect(Math.abs(newest.expiresAt.getTime() - deadline)).toBeLessThan(5_000);
    // Nor does the access token outlive it.
    expect(second.body.expiresIn).toBeLessThanOrEqual(600);
    expect(second.body.expiresIn).toBeGreaterThan(590);
    const { exp } = jwt.decode(second.body.accessToken) as { exp: number };
    expect(exp * 1000).toBeLessThanOrEqual(deadline + 5_000);

    // Past 12 hours: refused, even with a token that has not expired itself (and was issued
    // just now, so the session is not idle).
    await db
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 13 * HOUR) })
      .where(and(eq(refreshTokens.userId, operator.id), ne(refreshTokens.id, newest.id)));
    const third = await refresh(cookieOf(second));
    expect(third.status).toBe(401);
    expect(third.body.error.message).toBe('Session expired');
    // Nothing of the session is left that could be refreshed.
    expect(
      await db
        .select()
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, operator.id),
            sql`${refreshTokens.revokedAt} IS NULL`,
            gt(refreshTokens.expiresAt, new Date()),
          ),
        ),
    ).toHaveLength(0);
  });

  it('end when nobody used them for 30 minutes (ADMIN_IDLE_MINUTES), a closed browser too', async () => {
    const operator = await createUser('ADMIN', null);
    const first = await signIn(operator.email);
    // The last refresh (here: the sign-in) 29 minutes ago: still in use.
    await db
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 29 * 60_000) })
      .where(eq(refreshTokens.userId, operator.id));
    const second = await refresh(first.cookie);
    expect(second.status).toBe(200);

    // Then 31 minutes without one – the browser was closed and opened again: refused, and the
    // session is over (the cookie would have worked until the 12-hour deadline).
    await db
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
      .where(and(eq(refreshTokens.userId, operator.id), isNull(refreshTokens.revokedAt)));
    const third = await refresh(cookieOf(second));
    expect(third.status).toBe(401);
    expect(third.body.error.message).toBe('Session expired');
    expect(
      await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, operator.id), isNull(refreshTokens.revokedAt))),
    ).toHaveLength(0);
    // Signing in again starts a new session.
    expect((await refresh((await signIn(operator.email)).cookie)).status).toBe(200);
  });

  it('leave other roles as they were (7 days, extended by each refresh, no idle limit)', async () => {
    const director = await createUser('DIRECTOR', w.facility.id);
    const first = await signIn(director.email);
    expect(first.expiresIn).toBe(900);
    const [token] = await familyOf(director.id);
    expect(token!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * 24 * HOUR - 60_000);

    await db
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 13 * HOUR) })
      .where(eq(refreshTokens.userId, director.id));
    const next = await refresh(first.cookie);
    expect(next.status).toBe(200);
    expect(next.body.expiresIn).toBe(900);
    const newest = (await familyOf(director.id)).find((t) => t.revokedAt === null)!;
    expect(newest.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * 24 * HOUR - 60_000);
  });
});

/* ------------------------------------------------------------------ recovery ---------------- */

describe('recovering an administrator (deploy/recover-admin.sh)', () => {
  async function privateFile() {
    const dir = await mkdtemp(path.join(tmpdir(), 'pacient-recover-admin-'));
    return { dir, file: path.join(dir, 'recover.txt') };
  }
  const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

  it('resets password and two-step sign-in, ends the sessions and hands a private link over', async () => {
    const lost = await createUser('ADMIN', null, { fullName: `${tag} Lost Admin` });
    const colleague = await createUser('ADMIN', null, { fullName: `${tag} Colleague three` });
    // A session from before, then two-step sign-in with a recovery code and an earlier reset link.
    const session = await signIn(lost.email);
    await db
      .update(users)
      .set({ mfaEnabledAt: new Date(), mfaSecretEncrypted: 'sealed', mfaLastUsedStep: 1 })
      .where(eq(users.id, lost.id));
    await db.insert(mfaRecoveryCodes).values({ userId: lost.id, codeHash: hashToken('RC-1') });
    const earlier = `${tag}-earlier-reset`;
    await db.insert(oneTimeTokens).values({
      userId: lost.id,
      purpose: 'PASSWORD_RESET',
      tokenHash: hashToken(earlier),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const { dir, file } = await privateFile();
    try {
      const result = await recoverAdmin(lost.email.toUpperCase(), file);
      expect(result).toMatchObject({ userId: lost.id, sessionsRevoked: 1 });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const link = (await readFile(file, 'utf8')).trim();
      expect(link).toMatch(/^http:\/\/localhost:5173\/reset-password\?token=/);

      const [account] = await db.select().from(users).where(eq(users.id, lost.id));
      expect(account).toMatchObject({
        isActive: true,
        role: 'ADMIN',
        mfaEnabledAt: null,
        mfaSecretEncrypted: null,
        mfaLastUsedStep: null,
      });
      expect(
        await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, lost.id)),
      ).toHaveLength(0);
      // The old password, the old session and the earlier link stop working at once.
      expect(
        (await api().post('/api/v1/auth/login').send({ email: lost.email, password: PASSWORD }))
          .status,
      ).toBe(401);
      expect((await refresh(session.cookie)).status).toBe(401);
      expect(
        (
          await api()
            .post('/api/v1/auth/reset-password')
            .send({ token: earlier, password: NEW_PASSWORD })
        ).status,
      ).toBe(400);
      const [reset] = await db
        .select()
        .from(oneTimeTokens)
        .where(eq(oneTimeTokens.tokenHash, hashToken(tokenOf(link))));
      expect(reset!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);

      // Audited as an owner-authorized recovery by the system, without the link.
      for (const action of ['admin.user.mfa_reset', 'admin.user.password_reset_sent']) {
        const [row] = await auditOf(action, lost.id);
        expect(row).toMatchObject({ actorUserId: null, resourceType: 'user' });
        expect(row!.metadata).toMatchObject({ source: 'owner-authorized-recovery' });
        expect(JSON.stringify(row)).not.toContain(tokenOf(link));
      }
      const page = await api().get(`${usersApi}/${lost.id}`).set(bearer(adminToken));
      expect(
        page.body.adminHistory.filter(
          (h: { source: string | null }) => h.source === 'owner-authorized-recovery',
        ),
      ).toHaveLength(2);
      const trail = await api()
        .get('/api/v1/admin/audit')
        .query({ category: 'users', pageSize: 100 })
        .set(bearer(adminToken));
      expect(
        trail.body.items.filter(
          (i: { resourceId: string; action: string }) =>
            i.resourceId === lost.id && i.action.startsWith('admin.user.'),
        ),
      ).toHaveLength(2);

      // The other administrators hear of it.
      const told = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, colleague.id), eq(notifications.type, 'security')));
      expect(told.map((n) => n.title)).toContain(
        `The administrator account of ${lost.fullName} was recovered on the server`,
      );

      // The link sets a new password; the next sign-in has no second factor yet (set up again).
      expect(
        (
          await api()
            .post('/api/v1/auth/reset-password')
            .send({ token: tokenOf(link), password: NEW_PASSWORD })
        ).status,
      ).toBe(204);
      const signedIn = await api()
        .post('/api/v1/auth/login')
        .send({ email: lost.email, password: NEW_PASSWORD });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.accessToken).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses anyone but an activated, enabled administrator, and changes nothing then', async () => {
    const disabled = await createUser('ADMIN', null, {
      isActive: false,
      mfaEnabledAt: new Date(),
      mfaSecretEncrypted: 'sealed',
      mfaLastUsedStep: 1,
    });
    const pending = await createUser('ADMIN', null, { passwordHash: null });
    const { dir, file } = await privateFile();
    try {
      const cases: [string, RegExp][] = [
        [`${tag}-nobody@example.test`, /no platform administrator has this e-mail address/],
        [w.users.director.email, /no platform administrator has this e-mail address/],
        [pending.email, /not activated the account yet/],
        [disabled.email, /disabled/],
      ];
      for (const [email, message] of cases) {
        const attempt = recoverAdmin(email, file);
        await expect(attempt).rejects.toBeInstanceOf(RecoveryRefused);
        await expect(attempt).rejects.toThrow(message);
        expect(existsSync(file)).toBe(false);
      }
      await expect(recoverAdmin('not-an-address', file)).rejects.toThrow();
      expect(existsSync(file)).toBe(false);

      const [still] = await db.select().from(users).where(eq(users.id, disabled.id));
      expect(still!.mfaEnabledAt).not.toBeNull();
      expect(still!.passwordHash).toBe(disabled.passwordHash);
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(
            and(
              inArray(auditLogs.resourceId, [disabled.id, pending.id, w.users.director.id]),
              sql`${auditLogs.metadata} ->> 'source' = 'owner-authorized-recovery'`,
            ),
          ),
      ).toHaveLength(0);

      // An earlier link not yet handed over is never overwritten.
      const active = await createUser('ADMIN', null);
      await writeFile(file, 'earlier link\n', { mode: 0o600 });
      await expect(recoverAdmin(active.email, file)).rejects.toThrow(/EEXIST/);
      expect(await readFile(file, 'utf8')).toBe('earlier link\n');
      const [untouched] = await db.select().from(users).where(eq(users.id, active.id));
      expect(untouched!.passwordHash).toBe(active.passwordHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
