import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});
const base = () => `/api/v1/patients/${w.patient.id}`;

async function notificationsOf(token: string) {
  const res = await api().get('/api/v1/notifications').set(bearer(token));
  expect(res.status).toBe(200);
  return res.body as {
    items: { id: string; type: string; title: string; link: string }[];
    unreadCount: number;
  };
}

describe('notifications', () => {
  it('tell the patient when a result is released, without clinical detail', async () => {
    const r = await api()
      .post(`${base()}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'HIV antibody', value: 'Negative' });
    await api().post(`${base()}/lab-results/${r.body.id}/acknowledge`).set(bearer(w.tokens.doctor));
    await api().post(`${base()}/lab-results/${r.body.id}/release`).set(bearer(w.tokens.doctor));

    const n = await notificationsOf(w.tokens.patient);
    const item = n.items.find((i) => i.type === 'result');
    expect(item).toBeDefined();
    expect(JSON.stringify(item)).not.toMatch(/HIV|Negative/);
    expect(n.unreadCount).toBeGreaterThan(0);

    await api()
      .post(`/api/v1/notifications/${item!.id}/read`)
      .set(bearer(w.tokens.patient))
      .expect(204);
    // Nobody else can mark someone's notification.
    expect(
      (await api().post(`/api/v1/notifications/${item!.id}/read`).set(bearer(w.tokens.doctor)))
        .status,
    ).toBe(404);
    await api().post('/api/v1/notifications/read-all').set(bearer(w.tokens.patient)).expect(204);
    expect(
      (await api().get('/api/v1/notifications/unread-count').set(bearer(w.tokens.patient))).body
        .unreadCount,
    ).toBe(0);
  });

  it('tell the doctor about appointment requests', async () => {
    const at = new Date(Date.now() + 9 * 86_400_000).toISOString();
    await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.patient))
      .send({ doctorId: w.users.doctor.id, scheduledAt: at, reason: 'Check-up' })
      .expect(201);
    const n = await notificationsOf(w.tokens.doctor);
    expect(n.items.some((i) => i.type === 'appointment')).toBe(true);
  });
});

describe('secure messaging', () => {
  it('lets a patient message a doctor in their care team, and the doctor reply', async () => {
    const created = await api()
      .post('/api/v1/messages/threads')
      .set(bearer(w.tokens.patient))
      .send({
        doctorId: w.users.doctor.id,
        subject: 'Side effects',
        body: 'I feel dizzy since the new tablets.',
      });
    expect(created.status).toBe(201);
    const threadId = created.body.id;

    const doctorThreads = await api().get('/api/v1/messages/threads').set(bearer(w.tokens.doctor));
    expect(
      doctorThreads.body.items.find((t: { id: string }) => t.id === threadId).unreadCount,
    ).toBe(1);

    const open = await api()
      .get(`/api/v1/messages/threads/${threadId}`)
      .set(bearer(w.tokens.doctor));
    expect(open.body.messages).toHaveLength(1);
    expect(open.body.canReply).toBe(true);

    await api()
      .post(`/api/v1/messages/threads/${threadId}/messages`)
      .set(bearer(w.tokens.doctor))
      .send({ body: 'Please take it with food and book a review.' })
      .expect(201);

    const patientView = await api()
      .get(`/api/v1/messages/threads/${threadId}`)
      .set(bearer(w.tokens.patient));
    expect(patientView.body.messages).toHaveLength(2);
    expect((await notificationsOf(w.tokens.patient)).items.some((i) => i.type === 'message')).toBe(
      true,
    );

    // Non-participants cannot see the thread at all.
    expect(
      (await api().get(`/api/v1/messages/threads/${threadId}`).set(bearer(w.tokens.colleague)))
        .status,
    ).toBe(404);
    expect(
      (await api().get(`/api/v1/messages/threads/${threadId}`).set(bearer(w.tokens.otherPatient)))
        .status,
    ).toBe(404);

    await api()
      .post(`/api/v1/messages/threads/${threadId}/close`)
      .set(bearer(w.tokens.doctor))
      .expect(204);
    const afterClose = await api()
      .post(`/api/v1/messages/threads/${threadId}/messages`)
      .set(bearer(w.tokens.patient))
      .send({ body: 'One more thing' });
    expect(afterClose.status).toBe(409);
  });

  it('requires an active care relationship', async () => {
    const res = await api()
      .post('/api/v1/messages/threads')
      .set(bearer(w.tokens.patient))
      .send({ doctorId: w.users.outsideDoctor.id, subject: 'Hello', body: 'Can you help?' });
    expect(res.status).toBe(403);
    expect(
      (await api().get('/api/v1/messages/threads').set(bearer(w.tokens.director))).status,
    ).toBe(403);
  });
});

describe('immunizations', () => {
  it('are recorded by the care team and visible to the patient', async () => {
    const created = await api()
      .post(`${base()}/immunizations`)
      .set(bearer(w.tokens.doctor))
      .send({
        vaccine: 'Influenza (seasonal)',
        doseNumber: 1,
        lotNumber: 'FLU-24-A',
        site: 'Left deltoid',
      });
    expect(created.status).toBe(201);
    const list = await api().get(`${base()}/immunizations`).set(bearer(w.tokens.patient));
    expect(list.body.items[0]).toMatchObject({
      vaccine: 'Influenza (seasonal)',
      facilityName: w.facility.name,
    });
    const future = await api()
      .post(`${base()}/immunizations`)
      .set(bearer(w.tokens.doctor))
      .send({ vaccine: 'MMR', administeredAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(future.status).toBe(400);
  });
});

describe('referrals across facilities', () => {
  const referral = () => ({
    patientId: w.patient.id,
    toFacilityId: w.otherFacility.id,
    specialty: 'Cardiology',
    priority: 'URGENT',
    reason: 'Suspected arrhythmia',
    clinicalSummary: 'Palpitations for two weeks, ECG shows irregular rhythm. On amlodipine 5 mg.',
  });

  it('only an accepted referral gives the receiving doctor access to the record', async () => {
    const summaryAsOutside = () =>
      api().get(`${base()}/summary`).set(bearer(w.tokens.outsideDoctor));
    expect((await summaryAsOutside()).status).toBe(403);

    const created = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.doctor))
      .send(referral());
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Pending: the receiving side sees the referral summary but still not the record.
    const incoming = await api()
      .get('/api/v1/referrals?direction=incoming')
      .set(bearer(w.tokens.otherDirector));
    expect(incoming.body.items.map((r: { id: string }) => r.id)).toContain(id);
    expect((await summaryAsOutside()).status).toBe(403);

    // The referring facility's director can see it (outgoing) but cannot accept on the receiver's behalf.
    expect(
      (await api().post(`/api/v1/referrals/${id}/accept`).set(bearer(w.tokens.director)).send({}))
        .status,
    ).toBe(403);

    const accepted = await api()
      .post(`/api/v1/referrals/${id}/accept`)
      .set(bearer(w.tokens.otherDirector))
      .send({ doctorId: w.users.outsideDoctor.id });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      status: 'ACCEPTED',
      toDoctorId: w.users.outsideDoctor.id,
    });

    const now = await summaryAsOutside();
    expect(now.status).toBe(200);
    expect(now.body.accessBasis).toBe('CARE_TEAM');

    expect((await notificationsOf(w.tokens.doctor)).items.some((i) => i.type === 'referral')).toBe(
      true,
    );
    const patientView = await api().get('/api/v1/referrals').set(bearer(w.tokens.patient));
    expect(patientView.body.items[0]).toMatchObject({ id, status: 'ACCEPTED' });

    const done = await api()
      .post(`/api/v1/referrals/${id}/complete`)
      .set(bearer(w.tokens.outsideDoctor))
      .send({ responseNote: 'Holter monitoring arranged; follow-up in 4 weeks.' });
    expect(done.body.status).toBe('COMPLETED');
  });

  it('can be declined or cancelled, and cannot target the same facility', async () => {
    const same = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.doctor))
      .send({ ...referral(), toFacilityId: w.facility.id });
    expect(same.status).toBe(400);

    const a = await api().post('/api/v1/referrals').set(bearer(w.tokens.doctor)).send(referral());
    const declined = await api()
      .post(`/api/v1/referrals/${a.body.id}/decline`)
      .set(bearer(w.tokens.outsideDoctor))
      .send({ responseNote: 'Please refer to the regional cardiology clinic.' });
    expect(declined.body.status).toBe('DECLINED');

    const b = await api().post('/api/v1/referrals').set(bearer(w.tokens.doctor)).send(referral());
    expect(
      (
        await api()
          .post(`/api/v1/referrals/${b.body.id}/cancel`)
          .set(bearer(w.tokens.outsideDoctor))
      ).status,
    ).toBe(403);
    const cancelled = await api()
      .post(`/api/v1/referrals/${b.body.id}/cancel`)
      .set(bearer(w.tokens.doctor));
    expect(cancelled.body.status).toBe('CANCELLED');
  });

  it('requires access to the patient to refer', async () => {
    const res = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.colleague))
      .send({ ...referral(), patientId: w.otherPatient.id });
    expect(res.status).toBe(403);
    expect((await api().get('/api/v1/referrals').set(bearer(w.tokens.ministry))).status).toBe(403);
  });
});

describe('patients without portal accounts', () => {
  it('do not break notification fan-out', async () => {
    const doc = await createUser('DOCTOR', w.facility.id);
    const token = await login(doc.email);
    const p = await api()
      .post('/api/v1/patients')
      .set(bearer(token))
      .send({
        nationalId: '7000000001',
        firstName: 'No',
        lastName: 'Portal',
        dateOfBirth: '1980-01-01',
        sex: 'MALE',
      });
    const r = await api()
      .post(`/api/v1/patients/${p.body.patient.id}/lab-results`)
      .set(bearer(token))
      .send({ testName: 'CRP', value: '3' });
    await api()
      .post(`/api/v1/patients/${p.body.patient.id}/lab-results/${r.body.id}/acknowledge`)
      .set(bearer(token));
    const rel = await api()
      .post(`/api/v1/patients/${p.body.patient.id}/lab-results/${r.body.id}/release`)
      .set(bearer(token));
    expect(rel.status).toBe(200);
  });
});
