import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { db } from '../src/db/client.js';
import { appointments, auditLogs, guardianships, patients } from '../src/db/schema.js';
import { iceServersFor } from '../src/modules/telemedicine/ice.js';
import { resetSignalsForTests } from '../src/modules/telemedicine/signals.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});
afterEach(() => resetSignalsForTests());

async function videoAppointment(
  opts: {
    minutesFromNow?: number;
    mode?: 'VIDEO' | 'IN_PERSON';
    status?: 'CONFIRMED' | 'REQUESTED';
    patientId?: string;
  } = {},
) {
  const [row] = await db
    .insert(appointments)
    .values({
      patientId: opts.patientId ?? w.patient.id,
      doctorId: w.users.doctor.id,
      facilityId: w.facility.id,
      scheduledAt: new Date(Date.now() + (opts.minutesFromNow ?? 5) * 60_000),
      durationMinutes: 20,
      reason: 'Video follow-up',
      status: opts.status ?? 'CONFIRMED',
      mode: opts.mode ?? 'VIDEO',
    })
    .returning();
  return row!;
}

const join = (token: string, id: string, headers: Record<string, string> = {}) =>
  api().post(`/api/v1/video/appointments/${id}/join`).set(bearer(token)).set(headers);

describe('joining a video visit', () => {
  it('lets the doctor and the patient join within the window and reports presence', async () => {
    const appt = await videoAppointment();
    const info = await api()
      .get(`/api/v1/video/appointments/${appt.id}`)
      .set(bearer(w.tokens.patient));
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ side: 'patient', window: { open: true }, session: null });

    const p = await join(w.tokens.patient, appt.id);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ role: 'patient', peerPresent: false, status: 'WAITING' });
    expect(p.body.iceServers[0].urls[0]).toMatch(/^stun:/);

    const waiting = await api().get('/api/v1/video/waiting').set(bearer(w.tokens.doctor));
    expect(waiting.body.items.map((i: { appointmentId: string }) => i.appointmentId)).toContain(
      appt.id,
    );

    const d = await join(w.tokens.doctor, appt.id);
    expect(d.body).toMatchObject({ role: 'doctor', peerPresent: true, status: 'ACTIVE' });
    expect(d.body.sessionId).toBe(p.body.sessionId);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, p.body.sessionId));
    expect(audits.filter((a) => a.action === 'video.joined')).toHaveLength(2);
    expect(audits.every((a) => a.patientId === w.patient.id)).toBe(true);
  });

  it('refuses other people, in-person visits and times outside the window', async () => {
    const appt = await videoAppointment();
    expect((await join(w.tokens.colleague, appt.id)).status).toBe(403);
    expect((await join(w.tokens.otherPatient, appt.id)).status).toBe(403);
    expect((await join(w.tokens.nurse, appt.id)).status).toBe(403);

    const inPerson = await videoAppointment({ mode: 'IN_PERSON' });
    expect((await join(w.tokens.patient, inPerson.id)).status).toBe(400);

    const requested = await videoAppointment({ status: 'REQUESTED' });
    expect((await join(w.tokens.patient, requested.id)).status).toBe(409);

    const early = await videoAppointment({ minutesFromNow: 60 });
    const tooEarly = await join(w.tokens.patient, early.id);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('TOO_EARLY');

    const late = await videoAppointment({ minutesFromNow: -150 });
    expect((await join(w.tokens.patient, late.id)).body.error.code).toBe('TOO_LATE');
  });

  it('lets a guardian join for a child, even with appointments-only access', async () => {
    const [child] = await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Ana',
        lastName: 'Video',
        dateOfBirth: '2019-03-01',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning();
    const parent = await createUser('PATIENT');
    await db.insert(guardianships).values({
      patientId: child!.id,
      guardianUserId: parent.id,
      relationship: 'PARENT',
      scope: 'APPOINTMENTS',
      evidence: 'Birth certificate 3/2019',
      verifiedById: w.users.reception.id,
      validUntil: new Date('2037-03-01T00:00:00Z'),
    });
    const token = await login(parent.email);
    const appt = await videoAppointment({ patientId: child!.id });
    expect((await join(token, appt.id)).status).toBe(403);
    const res = await join(token, appt.id, { 'X-Acting-For': child!.id });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('patient');
  });
});

describe('signalling', () => {
  it('delivers messages only to the other participant, once', async () => {
    const appt = await videoAppointment();
    const { sessionId } = (await join(w.tokens.patient, appt.id)).body;
    await join(w.tokens.doctor, appt.id);

    const offer = await api()
      .post(`/api/v1/video/sessions/${sessionId}/signal`)
      .set(bearer(w.tokens.doctor))
      .send({ kind: 'offer', payload: { type: 'offer', sdp: 'v=0…' } });
    expect(offer.status).toBe(202);
    await api()
      .post(`/api/v1/video/sessions/${sessionId}/signal`)
      .set(bearer(w.tokens.doctor))
      .send({ kind: 'candidate', payload: { candidate: 'candidate:1 1 udp …' } });

    // The doctor's own queue does not contain their messages.
    const mine = await api()
      .get(`/api/v1/video/sessions/${sessionId}/signals`)
      .set(bearer(w.tokens.doctor));
    expect(mine.body.items).toEqual([]);

    const got = await api()
      .get(`/api/v1/video/sessions/${sessionId}/signals`)
      .set(bearer(w.tokens.patient));
    expect(got.body.items.map((m: { kind: string }) => m.kind)).toEqual(['offer', 'candidate']);
    expect(got.body.peerPresent).toBe(true);
    const last = got.body.items.at(-1).id;
    const again = await api()
      .get(`/api/v1/video/sessions/${sessionId}/signals?after=${last}`)
      .set(bearer(w.tokens.patient));
    expect(again.body.items).toEqual([]);

    // Outsiders cannot read or write.
    expect(
      (
        await api()
          .get(`/api/v1/video/sessions/${sessionId}/signals`)
          .set(bearer(w.tokens.colleague))
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/video/sessions/${sessionId}/signal`)
          .set(bearer(w.tokens.otherPatient))
          .send({ kind: 'offer', payload: {} })
      ).status,
    ).toBe(403);

    const big = await api()
      .post(`/api/v1/video/sessions/${sessionId}/signal`)
      .set(bearer(w.tokens.patient))
      .send({ kind: 'answer', payload: { sdp: 'x'.repeat(30_000) } });
    expect(big.status).toBe(400);
  });

  it('ends the visit for both sides', async () => {
    const appt = await videoAppointment();
    const { sessionId } = (await join(w.tokens.patient, appt.id)).body;
    await join(w.tokens.doctor, appt.id);
    const end = await api()
      .post(`/api/v1/video/sessions/${sessionId}/end`)
      .set(bearer(w.tokens.doctor));
    expect(end.body).toMatchObject({
      status: 'ENDED',
      chartPath: `/doctor/patients/${w.patient.id}?tab=visits`,
    });
    const p = await api()
      .get(`/api/v1/video/sessions/${sessionId}/signals`)
      .set(bearer(w.tokens.patient));
    expect(p.body.status).toBe('ENDED');
    expect(p.body.items.map((m: { kind: string }) => m.kind)).toContain('bye');
    expect((await join(w.tokens.patient, appt.id)).status).toBe(409);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, sessionId));
    expect(audits.some((a) => a.action === 'video.ended')).toBe(true);
  });
});

describe('ICE servers and mode', () => {
  it('issues short-lived TURN credentials when a TURN secret is configured', () => {
    const saved = {
      url: env.WEBRTC_TURN_URL,
      secret: env.WEBRTC_TURN_SECRET,
      user: env.WEBRTC_TURN_USERNAME,
    };
    try {
      env.WEBRTC_TURN_URL = 'turn:turn.example.org:3478,turns:turn.example.org:5349';
      env.WEBRTC_TURN_SECRET = 'shared-secret';
      env.WEBRTC_TURN_USERNAME = undefined;
      const now = Date.UTC(2026, 10, 4, 12, 0, 0);
      const servers = iceServersFor('user-1', now);
      const turn = servers.find((s) => s.urls[0]!.startsWith('turn:'))!;
      expect(turn.urls).toHaveLength(2);
      const expiry = Math.floor(now / 1000) + 3600;
      expect(turn.username).toBe(`${expiry}:user-1`);
      expect(turn.credential).toBe(
        createHmac('sha1', 'shared-secret').update(`${expiry}:user-1`).digest('base64'),
      );
    } finally {
      env.WEBRTC_TURN_URL = saved.url;
      env.WEBRTC_TURN_SECRET = saved.secret;
      env.WEBRTC_TURN_USERNAME = saved.user;
    }
    expect(iceServersFor('user-1').some((s) => s.urls[0]!.startsWith('turn'))).toBe(false);
  });

  it('books, lists and switches video appointments', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const created = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.doctor))
      .send({ patientId: w.patient.id, scheduledAt: start, reason: 'Kontroll', mode: 'VIDEO' });
    expect(created.status).toBe(201);
    expect(created.body.mode).toBe('VIDEO');
    const list = await api().get('/api/v1/appointments').set(bearer(w.tokens.patient));
    expect(list.body.items.find((a: { id: string }) => a.id === created.body.id).mode).toBe(
      'VIDEO',
    );

    const sw = await api()
      .patch(`/api/v1/appointments/${created.body.id}/mode`)
      .set(bearer(w.tokens.reception))
      .send({ mode: 'IN_PERSON' });
    expect(sw.status).toBe(200);
    expect(sw.body.mode).toBe('IN_PERSON');
    expect(
      (
        await api()
          .patch(`/api/v1/appointments/${created.body.id}/mode`)
          .set(bearer(w.tokens.patient))
          .send({ mode: 'VIDEO' })
      ).status,
    ).toBe(403);
  });
});
