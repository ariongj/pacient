import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createWorld } from './helpers.js';

type World = Awaited<ReturnType<typeof createWorld>>;
let w: World;

beforeAll(async () => {
  w = await createWorld();
});

const summary = (patientId: string, token: string) =>
  api().get(`/api/v1/patients/${patientId}/summary`).set(bearer(token));

describe('clinical record access by tier', () => {
  it('patients can read their own record', async () => {
    const res = await summary(w.patient.id, w.tokens.patient);
    expect(res.status).toBe(200);
    expect(res.body.accessBasis).toBe('SELF');
  });

  it('patients cannot read another patient’s record', async () => {
    expect((await summary(w.otherPatient.id, w.tokens.patient)).status).toBe(403);
  });

  it('doctors in the care team can read the record', async () => {
    const res = await summary(w.patient.id, w.tokens.doctor);
    expect(res.status).toBe(200);
    expect(res.body.accessBasis).toBe('CARE_TEAM');
  });

  it('doctors outside the care team are denied, even in the same facility', async () => {
    expect((await summary(w.patient.id, w.tokens.colleague)).status).toBe(403);
  });

  it('directors and the ministry never see identifiable clinical data', async () => {
    expect((await summary(w.patient.id, w.tokens.director)).status).toBe(403);
    expect((await summary(w.patient.id, w.tokens.ministry)).status).toBe(403);
  });

  it('patients cannot author clinical entries', async () => {
    const res = await api()
      .post(`/api/v1/patients/${w.patient.id}/allergies`)
      .set(bearer(w.tokens.patient))
      .send({ substance: 'Penicillin', severity: 'SEVERE' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown patients and 400 for malformed ids', async () => {
    expect((await summary('00000000-0000-4000-8000-000000000000', w.tokens.doctor)).status).toBe(
      404,
    );
    expect((await summary('not-a-uuid', w.tokens.doctor)).status).toBe(400);
  });
});

describe('care team management', () => {
  it('a doctor can join the care team of a patient registered at their facility', async () => {
    const join = await api()
      .post(`/api/v1/patients/${w.otherPatient.id}/care-team`)
      .set(bearer(w.tokens.colleague))
      .send({});
    expect(join.status).toBe(201);
    expect((await summary(w.otherPatient.id, w.tokens.colleague)).status).toBe(200);

    const leave = await api()
      .delete(`/api/v1/patients/${w.otherPatient.id}/care-team/${w.users.colleague.id}`)
      .set(bearer(w.tokens.colleague));
    expect(leave.status).toBe(204);
    expect((await summary(w.otherPatient.id, w.tokens.colleague)).status).toBe(403);
  });

  it('a doctor from another facility cannot self-assign', async () => {
    const res = await api()
      .post(`/api/v1/patients/${w.patient.id}/care-team`)
      .set(bearer(w.tokens.outsideDoctor))
      .send({});
    expect(res.status).toBe(403);
  });

  it('a director can assign doctors of their own facility only', async () => {
    const ok = await api()
      .post(`/api/v1/patients/${w.otherPatient.id}/care-team`)
      .set(bearer(w.tokens.director))
      .send({ doctorId: w.users.colleague.id });
    expect(ok.status).toBe(201);

    const foreignDoctor = await api()
      .post(`/api/v1/patients/${w.patient.id}/care-team`)
      .set(bearer(w.tokens.director))
      .send({ doctorId: w.users.outsideDoctor.id });
    expect(foreignDoctor.status).toBe(400);

    const foreignDirector = await api()
      .post(`/api/v1/patients/${w.patient.id}/care-team`)
      .set(bearer(w.tokens.otherDirector))
      .send({ doctorId: w.users.outsideDoctor.id });
    expect(foreignDirector.status).toBe(403);
  });
});

describe('demographics & search', () => {
  it('directors see demographics of their own facility’s patients only', async () => {
    expect(
      (await api().get(`/api/v1/patients/${w.patient.id}`).set(bearer(w.tokens.director))).status,
    ).toBe(200);
    expect(
      (await api().get(`/api/v1/patients/${w.patient.id}`).set(bearer(w.tokens.otherDirector)))
        .status,
    ).toBe(403);
    expect(
      (await api().get(`/api/v1/patients/${w.patient.id}`).set(bearer(w.tokens.ministry))).status,
    ).toBe(403);
  });

  it('patient listing is unavailable to patients and the ministry', async () => {
    expect((await api().get('/api/v1/patients').set(bearer(w.tokens.patient))).status).toBe(403);
    expect((await api().get('/api/v1/patients').set(bearer(w.tokens.ministry))).status).toBe(403);
  });

  it('a doctor’s default list contains only patients in their care', async () => {
    const res = await api().get('/api/v1/patients').set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(w.patient.id);
    expect(ids).not.toContain(w.otherPatient.id);
    expect(res.body.items.every((p: { inMyCare: boolean }) => p.inMyCare)).toBe(true);
  });

  it('a doctor can find a patient from another facility by exact national ID only', async () => {
    const byId = await api()
      .get(`/api/v1/patients?scope=facility&search=${w.patient.nationalId}`)
      .set(bearer(w.tokens.outsideDoctor));
    expect(byId.body.items.map((p: { id: string }) => p.id)).toEqual([w.patient.id]);

    const byName = await api()
      .get(`/api/v1/patients?scope=facility&search=${w.patient.lastName}`)
      .set(bearer(w.tokens.outsideDoctor));
    expect(byName.body.items).toHaveLength(0);
  });
});

describe('emergency (break-glass) access', () => {
  it('requires a reason, grants time-limited access and is visible to the patient', async () => {
    const noReason = await api()
      .post(`/api/v1/patients/${w.patient.id}/emergency-access`)
      .set(bearer(w.tokens.outsideDoctor))
      .send({ reason: 'x' });
    expect(noReason.status).toBe(400);

    const grant = await api()
      .post(`/api/v1/patients/${w.patient.id}/emergency-access`)
      .set(bearer(w.tokens.outsideDoctor))
      .send({ reason: 'Unconscious patient admitted to emergency department' });
    expect(grant.status).toBe(201);
    expect(new Date(grant.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const read = await summary(w.patient.id, w.tokens.outsideDoctor);
    expect(read.status).toBe(200);
    expect(read.body.accessBasis).toBe('EMERGENCY');

    const log = await api().get('/api/v1/portal/access-log').set(bearer(w.tokens.patient));
    expect(log.status).toBe(200);
    const actions = log.body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain('care.emergency_access.granted');
    expect(actions).toContain('patient.record.viewed');
    const emergency = log.body.items.find(
      (i: { action: string }) => i.action === 'care.emergency_access.granted',
    );
    expect(emergency.emergencyReason).toMatch(/Unconscious/);
    expect(emergency).not.toHaveProperty('ipAddress');
  });

  it('only doctors can break the glass', async () => {
    const res = await api()
      .post(`/api/v1/patients/${w.patient.id}/emergency-access`)
      .set(bearer(w.tokens.director))
      .send({ reason: 'I would like to look at this record please' });
    expect(res.status).toBe(403);
  });
});
