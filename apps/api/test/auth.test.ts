import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { MAX_FAILED_ATTEMPTS } from '../src/modules/auth/auth.service.js';
import { api, bearer, createFacility, createUser, login, PASSWORD } from './helpers.js';

function refreshCookie(res: { headers: Record<string, unknown> }) {
  const cookies = res.headers['set-cookie'] as string[] | undefined;
  const c = cookies?.find((x) => x.startsWith('pacient_rt='));
  if (!c) throw new Error('No refresh cookie');
  return c.split(';')[0]!;
}

describe('authentication', () => {
  it('logs in and returns an access token plus an httpOnly, SameSite=Strict refresh cookie', async () => {
    const user = await createUser('MINISTRY');
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);

    const me = await api().get('/api/v1/auth/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: user.email, role: 'MINISTRY' });
    expect(me.body).not.toHaveProperty('passwordHash');
  });

  it('is case-insensitive on email', async () => {
    const user = await createUser('MINISTRY');
    await expect(login(user.email.toUpperCase())).resolves.toBeTypeOf('string');
  });

  it('returns the same generic error for unknown users and wrong passwords', async () => {
    const user = await createUser('MINISTRY');
    const wrong = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'nope' });
    const unknown = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it(`locks the account after ${MAX_FAILED_ATTEMPTS} failed attempts`, async () => {
    const user = await createUser('MINISTRY');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await api()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'wrong-password' });
    }
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects requests without a valid token', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set(bearer('garbage'))).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the whole family when a used token is replayed', async () => {
    const user = await createUser('MINISTRY');
    const loginRes = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    const first = refreshCookie(loginRes);

    const r1 = await api().post('/api/v1/auth/refresh').set('Cookie', first);
    expect(r1.status).toBe(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);

    // Replaying the consumed token is treated as theft…
    const replay = await api().post('/api/v1/auth/refresh').set('Cookie', first);
    expect(replay.status).toBe(401);
    // …and the legitimate successor is revoked too.
    const after = await api().post('/api/v1/auth/refresh').set('Cookie', second);
    expect(after.status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const user = await createUser('MINISTRY');
    const loginRes = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    const cookie = refreshCookie(loginRes);
    expect((await api().post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });

  it('a deactivated account loses access immediately, even with an unexpired token', async () => {
    const facility = await createFacility();
    const doctor = await createUser('DOCTOR', facility.id);
    const token = await login(doctor.email);
    await db.update(users).set({ isActive: false }).where(eq(users.id, doctor.id));
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });

  it('change-password requires the current password and revokes existing sessions', async () => {
    const user = await createUser('MINISTRY');
    const loginRes = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    const token = loginRes.body.accessToken;
    const cookie = refreshCookie(loginRes);

    const bad = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: 'wrong', newPassword: 'a-brand-new-passphrase' });
    expect(bad.status).toBe(400);

    const ok = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase' });
    expect(ok.status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    await expect(login(user.email, 'a-brand-new-passphrase')).resolves.toBeTypeOf('string');
  });
});

describe('account activation', () => {
  it('invited users set their own password through a single-use link', async () => {
    const facility = await createFacility();
    const director = await createUser('DIRECTOR', facility.id);
    const token = await login(director.email);
    const invite = await api().post('/api/v1/staff/invitations').set(bearer(token)).send({
      email: 'new.doctor@test.local',
      fullName: 'Dr. New',
      role: 'DOCTOR',
      licenseNumber: 'L-9',
    });
    expect(invite.status).toBe(201);
    const activationToken = new URL(invite.body.activationUrl).searchParams.get('token')!;

    // Cannot log in before activation.
    expect(
      (
        await api()
          .post('/api/v1/auth/login')
          .send({ email: 'new.doctor@test.local', password: 'x' })
      ).status,
    ).toBe(401);

    const weak = await api()
      .post('/api/v1/auth/activate')
      .send({ token: activationToken, password: 'short' });
    expect(weak.status).toBe(400);

    const ok = await api()
      .post('/api/v1/auth/activate')
      .send({ token: activationToken, password: 'my-own-secure-passphrase' });
    expect(ok.status).toBe(204);
    await expect(login('new.doctor@test.local', 'my-own-secure-passphrase')).resolves.toBeTypeOf(
      'string',
    );

    const reuse = await api()
      .post('/api/v1/auth/activate')
      .send({ token: activationToken, password: 'another-secure-passphrase' });
    expect(reuse.status).toBe(400);
  });
});
