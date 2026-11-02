import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopListening, subscribe, type LiveEvent } from '../src/lib/events.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await stopListening();
});

describe('team channels', () => {
  it('each role sees the right facility channels', async () => {
    const names = async (token: string) =>
      (await api().get('/api/v1/channels').set(bearer(token))).body.items.map(
        (c: { name: string }) => c.name,
      ) as string[];
    expect(await names(w.tokens.nurse)).toEqual(
      expect.arrayContaining(['all-staff', 'clinical', 'pharmacy', 'front-desk']),
    );
    const reception = await names(w.tokens.reception);
    expect(reception).toEqual(expect.arrayContaining(['all-staff', 'front-desk']));
    expect(reception).not.toContain('clinical');
    expect(await names(w.tokens.director)).toContain('ministry-directors');
    expect(await names(w.tokens.doctor)).not.toContain('ministry-directors');
    expect(await names(w.tokens.ministry)).toEqual(['ministry-directors']);
    expect((await api().get('/api/v1/channels').set(bearer(w.tokens.patient))).status).toBe(403);
  });

  it('messages are delivered with unread counts, and stay inside the facility', async () => {
    const list = await api().get('/api/v1/channels').set(bearer(w.tokens.doctor));
    const clinical = list.body.items.find((c: { name: string }) => c.name === 'clinical');
    await api()
      .post(`/api/v1/channels/${clinical.id}/messages`)
      .set(bearer(w.tokens.doctor))
      .send({ body: 'Ward round moved to 10:00', isUrgent: true })
      .expect(201);

    const nurseView = await api().get('/api/v1/channels').set(bearer(w.tokens.nurse));
    expect(nurseView.body.items.find((c: { id: string }) => c.id === clinical.id).unreadCount).toBe(
      1,
    );
    const nn = await api().get('/api/v1/notifications').set(bearer(w.tokens.nurse));
    expect(nn.body.items.some((n: { title: string }) => n.title.includes('#clinical'))).toBe(true);

    const history = await api()
      .get(`/api/v1/channels/${clinical.id}/messages`)
      .set(bearer(w.tokens.nurse));
    expect(history.body.items[0]).toMatchObject({
      body: 'Ward round moved to 10:00',
      isUrgent: true,
    });
    await api()
      .post(`/api/v1/channels/${clinical.id}/read`)
      .set(bearer(w.tokens.nurse))
      .expect(204);
    const after = await api().get('/api/v1/channels').set(bearer(w.tokens.nurse));
    expect(after.body.items.find((c: { id: string }) => c.id === clinical.id).unreadCount).toBe(0);

    expect(
      (
        await api()
          .get(`/api/v1/channels/${clinical.id}/messages`)
          .set(bearer(w.tokens.outsideDoctor))
      ).status,
    ).toBe(404);
    expect(
      (await api().get(`/api/v1/channels/${clinical.id}/messages`).set(bearer(w.tokens.reception)))
        .status,
    ).toBe(404);
  });

  it('directors create facility channels; the ministry creates national ones', async () => {
    const own = await api()
      .post('/api/v1/channels')
      .set(bearer(w.tokens.director))
      .send({ name: 'Night-Shift', allowedRoles: ['NURSE', 'DOCTOR'] });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({
      name: 'night-shift',
      scope: 'FACILITY',
      facilityId: w.facility.id,
    });
    expect(
      (
        await api()
          .post('/api/v1/channels')
          .set(bearer(w.tokens.director))
          .send({ name: 'bad', allowedRoles: ['MINISTRY'] })
      ).status,
    ).toBe(400);
    const nat = await api()
      .post('/api/v1/channels')
      .set(bearer(w.tokens.ministry))
      .send({ name: `pharmacists-${Date.now()}`, allowedRoles: ['PHARMACIST'] });
    expect(nat.body.scope).toBe('NATIONAL');
    const pharm = await api().get('/api/v1/channels').set(bearer(w.tokens.outsidePharmacist));
    expect(pharm.body.items.map((c: { id: string }) => c.id)).toContain(nat.body.id);
    expect(
      (
        await api()
          .post('/api/v1/channels')
          .set(bearer(w.tokens.nurse))
          .send({ name: 'x1', allowedRoles: ['NURSE'] })
      ).status,
    ).toBe(403);
  });
});

describe('live events', () => {
  it('delivers notifications to subscribers after the transaction commits', async () => {
    const received: LiveEvent[] = [];
    const unsubscribe = await subscribe(w.users.patientUser.id, (e) => received.push(e));
    const r = await api()
      .post(`/api/v1/patients/${w.patient.id}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'Ferritin', value: '40' });
    await api()
      .post(`/api/v1/patients/${w.patient.id}/lab-results/${r.body.id}/acknowledge`)
      .set(bearer(w.tokens.doctor));
    await api()
      .post(`/api/v1/patients/${w.patient.id}/lab-results/${r.body.id}/release`)
      .set(bearer(w.tokens.doctor));
    for (let i = 0; i < 40 && received.length === 0; i++)
      await new Promise((res) => setTimeout(res, 50));
    unsubscribe();
    expect(received).toContainEqual({ type: 'notification' });
  });

  it('streams require a single-use ticket', async () => {
    expect((await api().get('/api/v1/events?ticket=' + 'x'.repeat(30))).status).toBe(401);
    const t = await api().post('/api/v1/events/ticket').set(bearer(w.tokens.patient));
    expect(t.status).toBe(200);
    expect(t.body.ticket).toBeTypeOf('string');
    expect((await api().post('/api/v1/events/ticket')).status).toBe(401);
  });
});

describe('HL7 FHIR R4', () => {
  it('publishes a CapabilityStatement', async () => {
    const res = await api().get('/api/v1/fhir/metadata');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/fhir\+json/);
    expect(JSON.parse(res.text)).toMatchObject({
      resourceType: 'CapabilityStatement',
      fhirVersion: '4.0.1',
    });
  });

  it('exports the record as a Patient/$everything bundle with standard codes', async () => {
    const base = `/api/v1/patients/${w.patient.id}`;
    await api()
      .post(`${base}/diagnoses`)
      .set(bearer(w.tokens.doctor))
      .send({ icd10Code: 'E11.9', description: 'Type 2 diabetes' });
    await api()
      .post(`${base}/vitals`)
      .set(bearer(w.tokens.doctor))
      .send({ systolic: 135, diastolic: 85, heartRate: 72 });
    const unreleased = await api()
      .post(`${base}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'HbA1c', value: '7.9', unit: '%' });

    const res = await api()
      .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
      .set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const bundle = JSON.parse(res.text);
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'searchset' });
    const resources = bundle.entry.map((e: { resource: { resourceType: string } }) => e.resource);
    const patient = resources.find((r: { resourceType: string }) => r.resourceType === 'Patient');
    expect(patient.identifier[0].value).toBe(w.patient.nationalId);
    const condition = resources.find(
      (r: { resourceType: string }) => r.resourceType === 'Condition',
    );
    expect(condition.code.coding[0]).toMatchObject({
      system: 'http://hl7.org/fhir/sid/icd-10',
      code: 'E11.9',
    });
    const bp = resources.find(
      (r: { code?: { coding?: { code: string }[] } }) => r.code?.coding?.[0]?.code === '85354-9',
    );
    expect(bp.component).toHaveLength(2);
    expect(resources.some((r: { id: string }) => r.id === unreleased.body.id)).toBe(true);

    // The patient's own export omits results not yet released.
    const own = JSON.parse(
      (
        await api()
          .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
          .set(bearer(w.tokens.patient))
      ).text,
    );
    expect(
      own.entry.some((e: { resource: { id: string } }) => e.resource.id === unreleased.body.id),
    ).toBe(false);

    expect(
      (
        await api()
          .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
          .set(bearer(w.tokens.director))
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
          .set(bearer(w.tokens.pharmacist))
      ).status,
    ).toBe(403);
  });
});

describe('expanded reports', () => {
  it.each(['medications', 'pharmacy', 'vaccinations', 'referrals', 'appointments', 'workforce'])(
    '%s report works for the ministry and scopes for directors',
    async (report) => {
      const m = await api().get(`/api/v1/reports/${report}`).set(bearer(w.tokens.ministry));
      expect(m.status).toBe(200);
      expect(m.body.columns.length).toBeGreaterThan(2);
      const d = await api().get(`/api/v1/reports/${report}`).set(bearer(w.tokens.director));
      expect(d.status).toBe(200);
      const csv = await api()
        .get(`/api/v1/reports/${report}/export`)
        .set(bearer(w.tokens.director));
      expect(csv.status).toBe(200);
    },
  );

  it('workforce counts the new roles', async () => {
    const d = await api().get('/api/v1/reports/workforce').set(bearer(w.tokens.director));
    expect(d.body.rows[0]).toMatchObject({ nurses: 1, pharmacists: 1, reception: 1 });
  });
});
