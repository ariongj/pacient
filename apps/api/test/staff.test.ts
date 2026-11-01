import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

const invite = (token: string, body: Record<string, unknown>) =>
  api().post('/api/v1/staff/invitations').set(bearer(token)).send(body);

let n = 0;
const email = () => `staff-${Date.now()}-${n++}@test.local`;

describe('staff hierarchy', () => {
  it('the ministry appoints facility directors', async () => {
    const res = await invite(w.tokens.ministry, {
      email: email(),
      fullName: 'Dr. Director',
      role: 'DIRECTOR',
      facilityId: w.otherFacility.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'DIRECTOR', facilityId: w.otherFacility.id });
  });

  it('the ministry does not onboard doctors directly', async () => {
    const res = await invite(w.tokens.ministry, {
      email: email(),
      fullName: 'Dr. X',
      role: 'DOCTOR',
      facilityId: w.facility.id,
      licenseNumber: 'L1',
    });
    expect(res.status).toBe(403);
  });

  it('directors onboard doctors for their own facility only, whatever the request says', async () => {
    const res = await invite(w.tokens.director, {
      email: email(),
      fullName: 'Dr. Smuggled',
      role: 'DOCTOR',
      facilityId: w.otherFacility.id,
      licenseNumber: 'L2',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.facilityId).toBe(w.facility.id);
  });

  it('doctors require a license number', async () => {
    const res = await invite(w.tokens.director, {
      email: email(),
      fullName: 'Dr. Y',
      role: 'DOCTOR',
    });
    expect(res.status).toBe(400);
  });

  it('directors cannot appoint ministry officials; doctors and patients cannot invite anyone', async () => {
    expect(
      (await invite(w.tokens.director, { email: email(), fullName: 'Minister', role: 'MINISTRY' }))
        .status,
    ).toBe(403);
    expect(
      (
        await invite(w.tokens.doctor, {
          email: email(),
          fullName: 'Dr. Someone',
          role: 'DOCTOR',
          licenseNumber: 'L',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await invite(w.tokens.patient, {
          email: email(),
          fullName: 'Dr. Someone',
          role: 'DOCTOR',
          licenseNumber: 'L',
        })
      ).status,
    ).toBe(403);
  });

  it('duplicate emails are rejected', async () => {
    const res = await invite(w.tokens.director, {
      email: w.users.doctor.email.toUpperCase(),
      fullName: 'Dup',
      role: 'DOCTOR',
      licenseNumber: 'L3',
    });
    expect(res.status).toBe(409);
  });

  it('directors list and manage only their own facility’s staff', async () => {
    const list = await api().get('/api/v1/staff').set(bearer(w.tokens.director));
    expect(list.status).toBe(200);
    expect(
      list.body.items.every((u: { facilityId: string }) => u.facilityId === w.facility.id),
    ).toBe(true);

    const foreign = await api()
      .patch(`/api/v1/staff/${w.users.outsideDoctor.id}/status`)
      .set(bearer(w.tokens.director))
      .send({ isActive: false });
    expect(foreign.status).toBe(403);

    const self = await api()
      .patch(`/api/v1/staff/${w.users.director.id}/status`)
      .set(bearer(w.tokens.director))
      .send({ isActive: false });
    expect(self.status).toBe(400);
  });

  it('deactivating a doctor blocks their access immediately', async () => {
    const res = await api()
      .patch(`/api/v1/staff/${w.users.colleague.id}/status`)
      .set(bearer(w.tokens.director))
      .send({ isActive: false });
    expect(res.status).toBe(204);
    expect((await api().get('/api/v1/auth/me').set(bearer(w.tokens.colleague))).status).toBe(401);
  });
});

describe('facilities', () => {
  it('only the ministry creates facilities', async () => {
    const body = {
      code: `T-${Date.now()}`,
      name: 'Family Medicine Center Test',
      type: 'FAMILY_MEDICINE_CENTER',
      region: 'Ferizaj',
      municipality: 'Ferizaj',
    };
    expect(
      (await api().post('/api/v1/facilities').set(bearer(w.tokens.director)).send(body)).status,
    ).toBe(403);
    const ok = await api().post('/api/v1/facilities').set(bearer(w.tokens.ministry)).send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.code).toBe(body.code.toUpperCase());
  });
});
