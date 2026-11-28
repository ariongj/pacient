import cookieParser from 'cookie-parser';
import { and, eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, refreshTokens, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { authenticate } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requireRecentAuth } from '../src/middleware/recent-auth.js';
import { api, bearer, createUser, PASSWORD } from './helpers.js';

/**
 * requireRecentAuth() on its own, behind the real authentication: the routes that use it belong to
 * other modules. A small app keeps the test independent of them.
 */
const probe = express();
probe.use(cookieParser());
probe.post('/sensitive', authenticate, requireRecentAuth(), (_req, res) => {
  res.json({ done: true });
});
probe.use(errorHandler);

/** The password as X-Reauth-Password carries it: b64: and the base64 of its UTF-8 bytes. */
const encoded = (password: string) => `b64:${Buffer.from(password, 'utf8').toString('base64')}`;

async function signIn(email: string, password = PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('pacient_rt='),
  )!;
  return { token: res.body.accessToken as string, cookie: cookie.split(';')[0]! };
}

const sensitive = (token: string) => request(probe).post('/sensitive').set(bearer(token));

describe('requireRecentAuth', () => {
  it('refuses a session without proof with 401 REAUTH_REQUIRED, and needs a signed-in user', async () => {
    const u = await createUser('PATIENT');
    const { token } = await signIn(u.email);
    const res = await sensitive(token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
    const anonymous = await request(probe).post('/sensitive');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a sign-in of the last 10 minutes (refresh cookie) but not an older session', async () => {
    const u = await createUser('PATIENT');
    const { token, cookie } = await signIn(u.email);
    const fresh = await sensitive(token).set('Cookie', cookie);
    expect(fresh.status).toBe(200);

    // The same session, signed in 11 minutes ago.
    await db
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(refreshTokens.userId, u.id));
    const old = await sensitive(token).set('Cookie', cookie);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('does not count the cookie of a session that was signed out, revoked or has expired', async () => {
    const u = await createUser('PATIENT');
    // Signed out: the access token still works for its 15 minutes, the cookie proves nothing.
    const out = await signIn(u.email);
    expect((await sensitive(out.token).set('Cookie', out.cookie)).status).toBe(200);
    expect((await api().post('/api/v1/auth/logout').set('Cookie', out.cookie)).status).toBe(204);
    const afterLogout = await sensitive(out.token).set('Cookie', out.cookie);
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.code).toBe('REAUTH_REQUIRED');

    // Revoked ("Sign out everywhere", or an administrator's revoke-sessions).
    const revoked = await signIn(u.email);
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.userId, u.id));
    expectReauth(await sensitive(revoked.token).set('Cookie', revoked.cookie));

    // Expired (signed in a minute ago, but the token's time is up).
    const expired = await signIn(u.email);
    await db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(refreshTokens.userId, u.id));
    expectReauth(await sensitive(expired.token).set('Cookie', expired.cookie));
  });

  it('lets the password header through, refuses a wrong one, and audits both', async () => {
    const u = await createUser('PATIENT');
    const { token } = await signIn(u.email);
    const ok = await sensitive(token).set('X-Reauth-Password', encoded(PASSWORD));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ done: true });

    const wrong = await sensitive(token).set('X-Reauth-Password', encoded('not-the-password'));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatchObject({
      code: 'REAUTH_REQUIRED',
      message: 'Password is incorrect',
    });

    const rows = await db
      .select({ outcome: auditLogs.outcome, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.actorUserId, u.id), eq(auditLogs.action, 'auth.reauthenticated')));
    expect(rows.map((r) => r.outcome).sort()).toEqual(['FAILURE', 'SUCCESS']);
    // The password itself is never written anywhere, encoded or not.
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain(encoded(PASSWORD).slice(4));
  });

  it('takes any password the account may have: Serbian letters, Cyrillic, spaces at either end', async () => {
    for (const password of [
      'Lozinka-čćđšž-2026',
      'Лозинка-за-Пацијент-2026',
      ' correct horse battery staple ',
    ]) {
      const u = await createUser('PATIENT', null, { passwordHash: await hashPassword(password) });
      const { token } = await signIn(u.email, password);
      const ok = await sensitive(token).set('X-Reauth-Password', encoded(password));
      expect(ok.status).toBe(200);
      // Without the spaces it is another password.
      if (password !== password.trim()) {
        const trimmed = await sensitive(token).set('X-Reauth-Password', encoded(password.trim()));
        expect(trimmed.body.error.message).toBe('Password is incorrect');
      }
    }
  });

  it('refuses a password sent as it is (400) without counting it as a wrong one', async () => {
    const u = await createUser('PATIENT');
    const { token } = await signIn(u.email);
    for (const value of [
      PASSWORD,
      'b64:',
      'b64:not base64!',
      `b64:${'A'.repeat(800)}`,
      'b64:/w==',
    ]) {
      const res = await sensitive(token).set('X-Reauth-Password', value);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(
        'Send the password as b64: followed by the base64 of its UTF-8 bytes',
      );
    }
    const [account] = await db
      .select({ failed: users.failedLoginAttempts, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, u.id));
    expect(account).toEqual({ failed: 0, lockedUntil: null });
  });

  it('counts every one of 20 wrong passwords sent at once, and locks the account', async () => {
    const u = await createUser('PATIENT');
    const { token } = await signIn(u.email);
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sensitive(token).set('X-Reauth-Password', encoded(`wrong-guess-${i}`)),
      ),
    );
    // Each was checked (or refused once the lock was there), none got through.
    for (const res of answers) expect([401, 429]).toContain(res.status);
    const [account] = await db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, u.id));
    expect(account!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // The right password now waits for the lock, here and at sign-in.
    const right = await sensitive(token).set('X-Reauth-Password', encoded(PASSWORD));
    expect(right.status).toBe(429);
    expect(
      (await api().post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD })).status,
    ).toBe(401);
  });

  it('refuses the right password sent among wrong ones once they locked the account', async () => {
    const u = await createUser('PATIENT');
    const { token } = await signIn(u.email);
    const answers = await Promise.all([
      ...Array.from({ length: 12 }, (_, i) =>
        sensitive(token).set('X-Reauth-Password', encoded(`wrong-guess-${i}`)),
      ),
      sensitive(token).set('X-Reauth-Password', encoded(PASSWORD)),
    ]);
    const right = answers.at(-1)!;
    const [account] = await db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, u.id));
    // Locked in the end whatever the order; the right one either came first or was refused.
    expect(account!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect([200, 429]).toContain(right.status);
  });
});

describe('signing in', () => {
  it('counts every one of 20 wrong passwords sent at once, and locks the account', async () => {
    const u = await createUser('PATIENT');
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api()
          .post('/api/v1/auth/login')
          .send({ email: u.email, password: `wrong-guess-${i}` }),
      ),
    );
    for (const res of answers) expect(res.status).toBe(401);
    const [account] = await db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, u.id));
    expect(account!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(
      (await api().post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD })).status,
    ).toBe(401);
  });
});

function expectReauth(res: { status: number; body: { error?: { code?: string } } }) {
  expect(res.status).toBe(401);
  expect(res.body.error?.code).toBe('REAUTH_REQUIRED');
}
