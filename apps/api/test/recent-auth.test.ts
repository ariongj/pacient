import cookieParser from 'cookie-parser';
import { and, eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, refreshTokens } from '../src/db/schema.js';
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

async function signIn(email: string) {
  const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('pacient_rt='),
  )!;
  return { token: res.body.accessToken as string, cookie: cookie.split(';')[0]! };
}

describe('requireRecentAuth', () => {
  it('refuses a session without proof with 401 REAUTH_REQUIRED, and needs a signed-in user', async () => {
    const u = await createUser('PATIENT');
    const { token } = await signIn(u.email);
    const res = await request(probe).post('/sensitive').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
    const anonymous = await request(probe).post('/sensitive');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a sign-in of the last 10 minutes (refresh cookie) but not an older session', async () => {
    const u = await createUser('PATIENT');
    const { token, cookie } = await signIn(u.email);
    const fresh = await request(probe).post('/sensitive').set(bearer(token)).set('Cookie', cookie);
    expect(fresh.status).toBe(200);

    // The same session, signed in 11 minutes ago.
    await db
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(refreshTokens.userId, u.id));
    const old = await request(probe).post('/sensitive').set(bearer(token)).set('Cookie', cookie);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('lets the password header through, refuses a wrong one, and audits both', async () => {
    const u = await createUser('PATIENT');
    const { token } = await signIn(u.email);
    const ok = await request(probe)
      .post('/sensitive')
      .set(bearer(token))
      .set('X-Reauth-Password', PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ done: true });

    const wrong = await request(probe)
      .post('/sensitive')
      .set(bearer(token))
      .set('X-Reauth-Password', 'not-the-password');
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
    // The password itself is never written anywhere.
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });
});
