import { describe, expect, it } from 'vitest';
import { testOutbox } from '../src/modules/notifications/notifier.js';
import { currentStep, totpAt } from '../src/lib/totp.js';
import { api, bearer, createUser, login, PASSWORD } from './helpers.js';

async function enrol(token: string) {
  const setup = await api().post('/api/v1/auth/mfa/setup').set(bearer(token));
  expect(setup.status).toBe(200);
  expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
  const secret: string = setup.body.secret;
  const enable = await api()
    .post('/api/v1/auth/mfa/enable')
    .set(bearer(token))
    .send({ code: totpAt(secret, currentStep()) });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.recoveryCodes as string[] };
}

describe('two-step sign-in (TOTP)', () => {
  it('requires the second factor after enrollment and rejects replayed codes', async () => {
    const user = await createUser('PATIENT');
    const token = await login(user.email);
    const { secret, recoveryCodes } = await enrol(token);
    expect(recoveryCodes).toHaveLength(10);

    const first = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(first.body.accessToken).toBeUndefined();
    expect(first.headers['set-cookie']).toBeUndefined();

    // The code used during enrollment cannot be replayed.
    const replay = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: first.body.mfaToken, code: totpAt(secret, currentStep()) });
    expect(replay.status).toBe(401);

    const ok = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: first.body.mfaToken, code: totpAt(secret, currentStep() + 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTypeOf('string');

    const me = await api().get('/api/v1/auth/me').set(bearer(ok.body.accessToken));
    expect(me.body.mfaEnabled).toBe(true);
  });

  it('accepts each recovery code exactly once', async () => {
    const user = await createUser('PATIENT');
    const { recoveryCodes } = await enrol(await login(user.email));
    const challenge = async () =>
      (await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).body
        .mfaToken as string;

    const ok = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: await challenge(), recoveryCode: recoveryCodes[0]!.toUpperCase() });
    expect(ok.status).toBe(200);
    const again = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: await challenge(), recoveryCode: recoveryCodes[0] });
    expect(again.status).toBe(401);
  });

  it('rejects forged or expired challenge tokens', async () => {
    const res = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: 'x'.repeat(40), code: '123456' });
    expect(res.status).toBe(401);
  });

  it('a password-only access token cannot be used as an MFA challenge', async () => {
    const user = await createUser('PATIENT');
    const token = await login(user.email);
    const res = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: token, code: '123456' });
    expect(res.status).toBe(401);
  });

  it('patients may turn two-step sign-in off with password and code', async () => {
    const user = await createUser('PATIENT');
    const token = await login(user.email);
    const { secret } = await enrol(token);
    const off = await api()
      .post('/api/v1/auth/mfa/disable')
      .set(bearer(token))
      .send({ password: PASSWORD, code: totpAt(secret, currentStep() + 1) });
    expect(off.status).toBe(204);
    await expect(login(user.email)).resolves.toBeTypeOf('string');
  });
});

describe('password reset', () => {
  it('does not reveal whether an account exists', async () => {
    const unknown = await api()
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@test.local' });
    const user = await createUser('PATIENT');
    const known = await api().post('/api/v1/auth/forgot-password').send({ email: user.email });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
  });

  it('resets the password with a single-use link and ends existing sessions', async () => {
    const user = await createUser('PATIENT');
    const loginRes = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    const cookie = (loginRes.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    await api().post('/api/v1/auth/forgot-password').send({ email: user.email });
    const mail = testOutbox
      .filter((m) => m.to === user.email && m.kind === 'PASSWORD_RESET')
      .at(-1);
    expect(mail).toBeDefined();
    const token = new URL(mail!.url).searchParams.get('token')!;

    const reset = await api()
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'a-completely-new-passphrase' });
    expect(reset.status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    await expect(login(user.email, 'a-completely-new-passphrase')).resolves.toBeTypeOf('string');

    const reuse = await api()
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'yet-another-passphrase-1' });
    expect(reuse.status).toBe(400);
  });
});
