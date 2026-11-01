import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

const inDays = (d: number, hour = 9) => {
  const t = new Date(Date.now() + d * 86_400_000);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};

describe('appointments', () => {
  it('patients request appointments with their care team; doctors confirm', async () => {
    const req = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.patient))
      .send({
        doctorId: w.users.doctor.id,
        scheduledAt: inDays(3),
        reason: 'Blood pressure check',
      });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('REQUESTED');

    const selfConfirm = await api()
      .patch(`/api/v1/appointments/${req.body.id}/status`)
      .set(bearer(w.tokens.patient))
      .send({ status: 'CONFIRMED' });
    expect(selfConfirm.status).toBe(400);

    const confirm = await api()
      .patch(`/api/v1/appointments/${req.body.id}/status`)
      .set(bearer(w.tokens.doctor))
      .send({ status: 'CONFIRMED' });
    expect(confirm.status).toBe(200);

    const mine = await api().get('/api/v1/appointments').set(bearer(w.tokens.patient));
    expect(mine.body.items.map((a: { id: string }) => a.id)).toContain(req.body.id);
    const others = await api().get('/api/v1/appointments').set(bearer(w.tokens.otherPatient));
    expect(others.body.items.map((a: { id: string }) => a.id)).not.toContain(req.body.id);
  });

  it('patients cannot book doctors outside their care team', async () => {
    const res = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.patient))
      .send({ doctorId: w.users.colleague.id, scheduledAt: inDays(4), reason: 'Second opinion' });
    expect(res.status).toBe(403);
  });

  it('rejects past dates and double-booking a doctor', async () => {
    const past = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.doctor))
      .send({ patientId: w.patient.id, scheduledAt: inDays(-1), reason: 'Too late' });
    expect(past.status).toBe(400);

    const first = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.doctor))
      .send({
        patientId: w.patient.id,
        scheduledAt: inDays(5, 10),
        durationMinutes: 30,
        reason: 'Review',
      });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('CONFIRMED');

    const overlap = new Date(new Date(inDays(5, 10)).getTime() + 15 * 60_000).toISOString();
    const clash = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.doctor))
      .send({ patientId: w.patient.id, scheduledAt: overlap, reason: 'Clash' });
    expect(clash.status).toBe(409);
  });

  it('doctors can only schedule patients whose record they can access', async () => {
    const res = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.doctor))
      .send({ patientId: w.otherPatient.id, scheduledAt: inDays(6), reason: 'Unrelated' });
    expect(res.status).toBe(403);
  });

  it('directors see their facility schedule but cannot change it', async () => {
    const list = await api().get('/api/v1/appointments').set(bearer(w.tokens.director));
    expect(list.status).toBe(200);
    expect(
      list.body.items.every((a: { facilityId: string }) => a.facilityId === w.facility.id),
    ).toBe(true);
    const id = list.body.items[0].id;
    const res = await api()
      .patch(`/api/v1/appointments/${id}/status`)
      .set(bearer(w.tokens.director))
      .send({ status: 'CANCELLED' });
    expect(res.status).toBe(403);
  });
});
