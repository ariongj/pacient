import { beforeEach, describe, expect, it, vi } from 'vitest';

// Staff two-step sign-in is enforced in this file, as in production.
vi.hoisted(() => {
  process.env.REQUIRE_STAFF_MFA = 'true';
});

// The cryptographic checks are the library's job; these tests cover the flow around them.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

const webauthn = await import('@simplewebauthn/server');
const { eq, and } = await import('drizzle-orm');
const { db } = await import('../src/db/client.js');
const { authChallenges, notifications, webauthnCredentials } = await import('../src/db/schema.js');
const { api, bearer, createFacility, createUser, PASSWORD } = await import('./helpers.js');

const verifyReg = vi.mocked(webauthn.verifyRegistrationResponse);
const verifyAuth = vi.mocked(webauthn.verifyAuthenticationResponse);

const UA_LAPTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const UA_PHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

async function signIn(email: string, ua = UA_LAPTOP) {
  const res = await api()
    .post('/api/v1/auth/login')
    .set('User-Agent', ua)
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('pacient_rt='),
  )!;
  return { res, token: res.body.accessToken as string | undefined, cookie: cookie.split(';')[0]! };
}

const clientData = (challenge: string) =>
  Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost:5173' }),
  ).toString('base64url');
const fakeResponse = (challenge: string, id = 'cred-1') => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: clientData(challenge), authenticatorData: 'x', signature: 'y' },
  clientExtensionResults: {},
});

let credSeq = 0;
async function addPasskey(token: string, cookie: string, credentialId = `cred-${++credSeq}`) {
  const options = await api()
    .post('/api/v1/auth/security/passkeys/options')
    .set(bearer(token))
    .set('Cookie', cookie)
    .send({});
  expect(options.status).toBe(200);
  verifyReg.mockResolvedValueOnce({
    verified: true,
    registrationInfo: {
      credential: {
        id: credentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
      credentialBackedUp: true,
      userVerified: true,
    },
  } as never);
  const res = await api()
    .post('/api/v1/auth/security/passkeys')
    .set(bearer(token))
    .set('Cookie', cookie)
    .send({ response: fakeResponse(options.body.challenge, credentialId), deviceName: 'Laptop' });
  return { res, challenge: options.body.challenge as string, credentialId };
}

function assertion(newCounter: number) {
  verifyAuth.mockResolvedValueOnce({
    verified: true,
    authenticationInfo: {
      newCounter,
      userVerified: true,
      credentialID: 'x',
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: 'http://localhost:5173',
      rpID: 'localhost',
    },
  } as never);
}

async function passkeyLogin(credentialId: string, newCounter: number) {
  const options = await api().post('/api/v1/auth/security/passkeys/login/options').send({});
  assertion(newCounter);
  return api()
    .post('/api/v1/auth/security/passkeys/login')
    .set('User-Agent', UA_LAPTOP)
    .send({ response: fakeResponse(options.body.challenge, credentialId) });
}

beforeEach(() => {
  verifyReg.mockReset();
  verifyAuth.mockReset();
});

describe('passkeys', () => {
  it('registers a passkey with a single-use challenge, which turns on two-step sign-in', async () => {
    const patient = await createUser('PATIENT');
    const { token, cookie } = await signIn(patient.email);
    const { res, challenge, credentialId } = await addPasskey(token!, cookie);
    expect(res.status).toBe(201);
    const list = await api().get('/api/v1/auth/security/passkeys').set(bearer(token!));
    expect(list.body.items).toHaveLength(1);
    const me = await api().get('/api/v1/auth/me').set(bearer(token!));
    expect(me.body).toMatchObject({ mfaEnabled: true, totpEnabled: false, passkeyCount: 1 });

    // The same challenge cannot be used twice.
    verifyReg.mockResolvedValueOnce({ verified: true, registrationInfo: {} } as never);
    const again = await api()
      .post('/api/v1/auth/security/passkeys')
      .set(bearer(token!))
      .set('Cookie', cookie)
      .send({ response: fakeResponse(challenge, `${credentialId}-b`), deviceName: 'Again' });
    expect(again.status).toBe(400);

    // The owner is told a passkey was added.
    const notes = await db.select().from(notifications).where(eq(notifications.userId, patient.id));
    expect(notes.some((n) => n.title === 'A passkey was added to your account')).toBe(true);
  });

  it('requires recent authentication to add a passkey and refuses expired challenges', async () => {
    const patient = await createUser('PATIENT');
    const { token, cookie } = await signIn(patient.email);
    const noCookie = await api()
      .post('/api/v1/auth/security/passkeys/options')
      .set(bearer(token!))
      .send({});
    expect(noCookie.status).toBe(403);
    expect(noCookie.body.error.code).toBe('REAUTH_REQUIRED');
    const withPassword = await api()
      .post('/api/v1/auth/security/passkeys/options')
      .set(bearer(token!))
      .send({ password: PASSWORD });
    expect(withPassword.status).toBe(200);

    await db
      .update(authChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authChallenges.challenge, withPassword.body.challenge));
    verifyReg.mockResolvedValueOnce({ verified: true, registrationInfo: {} } as never);
    const expired = await api()
      .post('/api/v1/auth/security/passkeys')
      .set(bearer(token!))
      .set('Cookie', cookie)
      .send({ response: fakeResponse(withPassword.body.challenge), deviceName: 'Late' });
    expect(expired.status).toBe(400);
    expect(verifyReg).not.toHaveBeenCalled();
  });

  it('signs in with a passkey, enforces the signature counter and rejects unknown credentials', async () => {
    const patient = await createUser('PATIENT');
    const { token, cookie } = await signIn(patient.email);
    const { credentialId } = await addPasskey(token!, cookie);

    const ok = await passkeyLogin(credentialId, 5);
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(
      (ok.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('pacient_rt=')),
    ).toBe(true);
    const [stored] = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId));
    expect(stored!.counter).toBe(5);
    expect(stored!.lastUsedAt).not.toBeNull();

    expect((await passkeyLogin(credentialId, 3)).status).toBe(401); // counter went backwards
    expect((await passkeyLogin('no-such-credential', 9)).status).toBe(401);
  });

  it('satisfies the staff two-step requirement and works as the second step after the password', async () => {
    const facility = await createFacility();
    const doctor = await createUser('DOCTOR', facility.id);
    const first = await signIn(doctor.email);
    const blocked = await api().get('/api/v1/patients').set(bearer(first.token!));
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const { credentialId } = await addPasskey(first.token!, first.cookie);
    expect((await api().get('/api/v1/patients').set(bearer(first.token!))).status).toBe(200);

    // Password sign-in now asks for the passkey as the second step.
    const pw = await api()
      .post('/api/v1/auth/login')
      .send({ email: doctor.email, password: PASSWORD });
    expect(pw.body).toMatchObject({ mfaRequired: true, methods: ['passkey'] });
    const options = await api()
      .post('/api/v1/auth/security/passkeys/mfa/options')
      .send({ mfaToken: pw.body.mfaToken });
    expect(options.body.allowCredentials.map((c: { id: string }) => c.id)).toEqual([credentialId]);
    assertion(1);
    const second = await api()
      .post('/api/v1/auth/security/passkeys/mfa')
      .send({
        mfaToken: pw.body.mfaToken,
        response: fakeResponse(options.body.challenge, credentialId),
      });
    expect(second.status).toBe(200);

    // Another user's passkey cannot complete this user's second step.
    const other = await createUser('PATIENT');
    const o = await signIn(other.email);
    const foreign = await addPasskey(o.token!, o.cookie);
    const pw2 = await api()
      .post('/api/v1/auth/login')
      .send({ email: doctor.email, password: PASSWORD });
    const options2 = await api()
      .post('/api/v1/auth/security/passkeys/mfa/options')
      .send({ mfaToken: pw2.body.mfaToken });
    assertion(2);
    const wrong = await api()
      .post('/api/v1/auth/security/passkeys/mfa')
      .send({
        mfaToken: pw2.body.mfaToken,
        response: fakeResponse(options2.body.challenge, foreign.credentialId),
      });
    expect(wrong.status).toBe(401);

    // Staff cannot remove their only second factor.
    const [cred] = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId));
    const fresh = await signIn(doctor.email).catch(() => null);
    expect(fresh).toBeNull(); // password alone no longer issues a session
    const remove = await api()
      .delete(`/api/v1/auth/security/passkeys/${cred!.id}`)
      .set(bearer(second.body.accessToken))
      .send({ password: PASSWORD });
    expect(remove.status).toBe(409);
  });

  it('lets patients remove a passkey after re-authentication, which turns two-step off again', async () => {
    const patient = await createUser('PATIENT');
    const { token, cookie } = await signIn(patient.email);
    const { credentialId } = await addPasskey(token!, cookie);
    const [cred] = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId));
    const noReauth = await api()
      .delete(`/api/v1/auth/security/passkeys/${cred!.id}`)
      .set(bearer(token!))
      .send({});
    expect(noReauth.status).toBe(403);
    const ok = await api()
      .delete(`/api/v1/auth/security/passkeys/${cred!.id}`)
      .set(bearer(token!))
      .set('Cookie', cookie)
      .send({});
    expect(ok.status).toBe(204);
    const me = await api().get('/api/v1/auth/me').set(bearer(token!));
    expect(me.body).toMatchObject({ mfaEnabled: false, passkeyCount: 0 });
  });
});

describe('sessions and sign-in history', () => {
  it('lists active sessions, revokes one, and signs out all other devices', async () => {
    const patient = await createUser('PATIENT');
    const laptop = await signIn(patient.email, UA_LAPTOP);
    const phone = await signIn(patient.email, UA_PHONE);

    const list = await api()
      .get('/api/v1/auth/security/sessions')
      .set(bearer(laptop.token!))
      .set('Cookie', laptop.cookie);
    expect(list.body.items).toHaveLength(2);
    const current = list.body.items.find((s: { current: boolean }) => s.current);
    expect(current.device).toBe('Chrome · Windows');
    expect(current.network).toMatch(/\.x$|::x$/);
    const phoneSession = list.body.items.find((s: { current: boolean }) => !s.current);
    expect(phoneSession.device).toBe('Safari · iOS');

    const revoke = await api()
      .post(`/api/v1/auth/security/sessions/${phoneSession.id}/revoke`)
      .set(bearer(laptop.token!));
    expect(revoke.status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', phone.cookie)).status).toBe(401);

    const tablet = await signIn(patient.email, UA_PHONE);
    const others = await api()
      .post('/api/v1/auth/security/sessions/revoke-others')
      .set(bearer(laptop.token!))
      .set('Cookie', laptop.cookie);
    expect(others.body.revoked).toBe(1);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', tablet.cookie)).status).toBe(
      401,
    );
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', laptop.cookie)).status).toBe(
      200,
    );

    // Sessions of another user cannot be revoked.
    const stranger = await createUser('PATIENT');
    const s = await signIn(stranger.email);
    const sList = await api()
      .get('/api/v1/auth/security/sessions')
      .set(bearer(s.token!))
      .set('Cookie', s.cookie);
    const theirs = await api()
      .post(`/api/v1/auth/security/sessions/${sList.body.items[0].id}/revoke`)
      .set(bearer(laptop.token!));
    expect(theirs.status).toBe(404);
  });

  it('shows only the user’s own sign-in events', async () => {
    const a = await createUser('PATIENT');
    const b = await createUser('PATIENT');
    const sa = await signIn(a.email);
    await signIn(b.email);
    await api().post('/api/v1/auth/login').send({ email: a.email, password: 'wrong-password-123' });
    const history = await api().get('/api/v1/auth/security/history').set(bearer(sa.token!));
    expect(history.status).toBe(200);
    const actions = history.body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain('auth.login.success');
    expect(actions).toContain('auth.login.failure');
    expect(history.body.items.every((i: { device: string | null }) => i.device !== undefined)).toBe(
      true,
    );
    const bHistory = await api()
      .get('/api/v1/auth/security/history')
      .set(bearer((await signIn(b.email)).token!));
    expect(
      bHistory.body.items.some((i: { reason: string | null }) => i.reason === 'bad_password'),
    ).toBe(false);
  });
});

describe('new-device alerts', () => {
  it('alerts once per new device, never on the very first sign-in', async () => {
    const patient = await createUser('PATIENT');
    const alerts = async () =>
      (
        await db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, patient.id),
              eq(notifications.title, 'New sign-in to your Pacient account'),
            ),
          )
      ).length;
    await signIn(patient.email, UA_LAPTOP);
    expect(await alerts()).toBe(0);
    await signIn(patient.email, UA_LAPTOP);
    expect(await alerts()).toBe(0);
    await signIn(patient.email, UA_PHONE);
    expect(await alerts()).toBe(1);
    await signIn(patient.email, UA_PHONE);
    expect(await alerts()).toBe(1);
  });
});
