import { describe, expect, it, vi } from 'vitest';

// This file runs with staff MFA enforcement on, as in production.
vi.hoisted(() => {
  process.env.REQUIRE_STAFF_MFA = 'true';
});

const { currentStep, totpAt } = await import('../src/lib/totp.js');
const { api, bearer, createFacility, createUser, login, PASSWORD } = await import('./helpers.js');

describe('mandatory two-step sign-in for staff', () => {
  it('blocks staff workspaces until enrollment, then requires the second factor', async () => {
    const facility = await createFacility();
    const doctor = await createUser('DOCTOR', facility.id);
    const token = await login(doctor.email);

    const blocked = await api().get('/api/v1/patients').set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const me = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ mfaRequired: true, mfaEnabled: false });

    const setup = await api().post('/api/v1/auth/mfa/setup').set(bearer(token));
    const secret = setup.body.secret as string;
    await api()
      .post('/api/v1/auth/mfa/enable')
      .set(bearer(token))
      .send({ code: totpAt(secret, currentStep()) })
      .expect(200);

    expect((await api().get('/api/v1/patients').set(bearer(token))).status).toBe(200);

    // Staff cannot switch it off.
    const off = await api()
      .post('/api/v1/auth/mfa/disable')
      .set(bearer(token))
      .send({ password: PASSWORD, code: totpAt(secret, currentStep() + 1) });
    expect(off.status).toBe(403);
  });

  it('does not force patients to enrol', async () => {
    const patient = await createUser('PATIENT');
    const token = await login(patient.email);
    const me = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(me.body.mfaRequired).toBe(false);
    expect((await api().get('/api/v1/appointments').set(bearer(token))).status).toBe(200);
  });
});
