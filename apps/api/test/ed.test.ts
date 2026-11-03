import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careUnits,
  edVisits,
  notifications,
  unitStaff,
  vitalSigns,
} from '../src/db/schema.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let unitId: string;
let edDoctor: Awaited<ReturnType<typeof createUser>>;
let edDoctorToken: string;
let edNurse: Awaited<ReturnType<typeof createUser>>;
let edNurseToken: string;

const MIN = 60_000;

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Emergency', code: 'ED', type: 'EMERGENCY' })
    .returning();
  unitId = unit!.id;
  edDoctor = await createUser('DOCTOR', w.facility.id);
  edNurse = await createUser('NURSE', w.facility.id);
  await db.insert(unitStaff).values([
    { unitId, userId: edDoctor.id },
    { unitId, userId: edNurse.id },
  ]);
  [edDoctorToken, edNurseToken] = await Promise.all([login(edDoctor.email), login(edNurse.email)]);
});

async function arrive(token: string, patientId: string, extra: Record<string, unknown> = {}) {
  return api()
    .post('/api/v1/ed/arrivals')
    .set(bearer(token))
    .send({ patientId, arrivalMode: 'WALK_IN', chiefComplaint: 'Chest pain', ...extra });
}

async function board(token: string) {
  const res = await api().get('/api/v1/ed/board').set(bearer(token));
  expect(res.status).toBe(200);
  return res.body;
}

describe('emergency department roles', () => {
  it('lets reception register arrivals but not triage', async () => {
    const p = await createPatient(w.facility.id);
    const res = await arrive(w.tokens.reception, p.id, { arrivalMode: 'AMBULANCE' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('WAITING');
    const triage = await api()
      .post(`/api/v1/ed/visits/${res.body.id}/triage`)
      .set(bearer(w.tokens.reception))
      .send({ level: 3 });
    expect(triage.status).toBe(403);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.resourceId, res.body.id), eq(auditLogs.action, 'ed.arrival_registered')),
      );
    expect(audit).toHaveLength(1);
  });

  it('refuses nurses and doctors who do not work in the emergency department', async () => {
    const p = await createPatient(w.facility.id);
    expect((await arrive(w.tokens.nurse, p.id)).status).toBe(403);
    const visit = (await arrive(edNurseToken, p.id)).body;
    for (const token of [w.tokens.nurse, w.tokens.doctor]) {
      const res = await api()
        .post(`/api/v1/ed/visits/${visit.id}/triage`)
        .set(bearer(token))
        .send({ level: 4 });
      expect(res.status).toBe(403);
    }
    expect((await api().get('/api/v1/ed/board').set(bearer(w.tokens.pharmacist))).status).toBe(403);
    expect((await api().get('/api/v1/ed/board').set(bearer(w.tokens.patient))).status).toBe(403);
  });

  it('allows only one open visit per patient', async () => {
    const p = await createPatient(w.facility.id);
    expect((await arrive(edNurseToken, p.id)).status).toBe(201);
    expect((await arrive(w.tokens.reception, p.id)).status).toBe(409);
  });

  it('does not see visits of another facility', async () => {
    const p = await createPatient(w.facility.id);
    const visit = (await arrive(edNurseToken, p.id)).body;
    const res = await api()
      .post(`/api/v1/ed/visits/${visit.id}/triage`)
      .set(bearer(w.tokens.outsideDoctor))
      .send({ level: 3 });
    expect([403, 404]).toContain(res.status);
  });
});

describe('triage', () => {
  it('validates the level, stores vital signs and alerts doctors for very urgent patients', async () => {
    const p = await createPatient(w.facility.id);
    const visit = (await arrive(w.tokens.reception, p.id)).body;
    for (const level of [0, 6]) {
      const bad = await api()
        .post(`/api/v1/ed/visits/${visit.id}/triage`)
        .set(bearer(edNurseToken))
        .send({ level });
      expect(bad.status).toBe(400);
    }
    const res = await api()
      .post(`/api/v1/ed/visits/${visit.id}/triage`)
      .set(bearer(edNurseToken))
      .send({
        level: 2,
        note: 'Crushing chest pain',
        vitals: {
          systolic: 92,
          diastolic: 60,
          heartRate: 118,
          spo2: 91,
          temperature: 36.8,
          painScore: 8,
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      triageLevel: 2,
      triageNote: 'Crushing chest pain · VAS 8/10',
    });
    const vitals = await db.select().from(vitalSigns).where(eq(vitalSigns.patientId, p.id));
    expect(vitals[0]).toMatchObject({ systolic: 92, heartRate: 118, oxygenSaturation: 91 });
    const alerts = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, edDoctor.id), eq(notifications.type, 'ed.urgent')));
    expect(alerts.some((n) => n.title.includes('level 2'))).toBe(true);

    // Re-triage is allowed and audited with the previous level.
    const again = await api()
      .post(`/api/v1/ed/visits/${visit.id}/triage`)
      .set(bearer(edNurseToken))
      .send({ level: 3 });
    expect(again.status).toBe(200);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, visit.id), eq(auditLogs.action, 'ed.triaged')));
    expect(
      audits.map((a) => (a.metadata as { previousLevel: number | null }).previousLevel),
    ).toEqual(expect.arrayContaining([null, 2]));
  });
});

describe('board', () => {
  it('orders by triage level and flags breached waiting times; hides notes from reception', async () => {
    const facility = w.facility.id;
    const mk = async (minutesAgo: number, level: number | null) => {
      const p = await createPatient(facility);
      const [v] = await db
        .insert(edVisits)
        .values({
          patientId: p.id,
          facilityId: facility,
          unitId,
          arrivalMode: 'WALK_IN',
          chiefComplaint: 'Test',
          arrivedAt: new Date(Date.now() - minutesAgo * MIN),
          registeredById: edNurse.id,
          triageLevel: level,
          triageNote: level ? 'secret note' : null,
          triagedAt: level ? new Date() : null,
        })
        .returning();
      return v!;
    };
    const green = await mk(130, 4); // over the 120-minute target
    const yellow = await mk(30, 3); // within 60 minutes
    const red = await mk(1, 1);
    const untriaged = await mk(20, null); // over the 15-minute triage target

    const b = await board(edNurseToken);
    const ids = b.items.map((i: { id: string }) => i.id);
    const pos = (id: string) => ids.indexOf(id);
    expect(pos(untriaged.id)).toBeLessThan(pos(red.id));
    expect(pos(red.id)).toBeLessThan(pos(yellow.id));
    expect(pos(yellow.id)).toBeLessThan(pos(green.id));
    const item = (id: string) => b.items.find((i: { id: string }) => i.id === id);
    expect(item(green.id)).toMatchObject({ breached: true, targetMinutes: 120 });
    expect(item(yellow.id)).toMatchObject({ breached: false, targetMinutes: 60 });
    expect(item(red.id)).toMatchObject({ breached: true, targetMinutes: 0 });
    expect(item(untriaged.id).breached).toBe(true);
    expect(item(green.id).triageNote).toBe('secret note');
    expect(b.canTreat).toBe(true);

    const r = await board(w.tokens.reception);
    expect(r.canTreat).toBe(false);
    expect(r.items.find((i: { id: string }) => i.id === green.id).triageNote).toBeNull();
    expect(JSON.stringify(r)).not.toContain('secret note');
  });
});

describe('treatment, departure and record access', () => {
  it('gives emergency staff access to the record while the visit is open and for 24 hours after', async () => {
    const p = await createPatient(w.facility.id);
    const summary = () => api().get(`/api/v1/patients/${p.id}/summary`).set(bearer(edNurseToken));
    expect((await summary()).status).toBe(403);

    const visit = (await arrive(w.tokens.reception, p.id)).body;
    expect((await summary()).status).toBe(200);

    const start = await api()
      .post(`/api/v1/ed/visits/${visit.id}/start`)
      .set(bearer(edDoctorToken))
      .send({});
    expect(start.body).toMatchObject({ status: 'IN_TREATMENT', assignedDoctorId: edDoctor.id });

    // Nurses cannot discharge; doctors can.
    const nurseDischarge = await api()
      .post(`/api/v1/ed/visits/${visit.id}/depart`)
      .set(bearer(edNurseToken))
      .send({ status: 'DISCHARGED' });
    expect(nurseDischarge.status).toBe(400);
    const discharged = await api()
      .post(`/api/v1/ed/visits/${visit.id}/depart`)
      .set(bearer(edDoctorToken))
      .send({ status: 'DISCHARGED', note: 'Home with advice' });
    expect(discharged.body).toMatchObject({ status: 'DISCHARGED' });
    expect(discharged.body.departedAt).toBeTruthy();
    expect((await summary()).status).toBe(200);

    const twice = await api()
      .post(`/api/v1/ed/visits/${visit.id}/depart`)
      .set(bearer(edDoctorToken))
      .send({ status: 'TRANSFERRED' });
    expect(twice.status).toBe(409);

    await db
      .update(edVisits)
      .set({ departedAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(edVisits.id, visit.id));
    expect((await summary()).status).toBe(403);

    const history = await api()
      .get(`/api/v1/ed/patients/${p.id}/visits`)
      .set(bearer(edDoctorToken));
    // The doctor no longer has unit access either (the visit ended over 24 hours ago).
    expect(history.status).toBe(403);
  });

  it('records patients who leave without being seen and shows them as departed', async () => {
    const p = await createPatient(w.facility.id);
    const visit = (await arrive(w.tokens.reception, p.id)).body;
    const left = await api()
      .post(`/api/v1/ed/visits/${visit.id}/depart`)
      .set(bearer(edNurseToken))
      .send({ status: 'LEFT_WITHOUT_BEING_SEEN' });
    expect(left.body.status).toBe('LEFT_WITHOUT_BEING_SEEN');
    const b = await board(w.tokens.reception);
    expect(b.departed.some((d: { id: string }) => d.id === visit.id)).toBe(true);
    expect(b.items.some((d: { id: string }) => d.id === visit.id)).toBe(false);
  });

  it('shows the patient’s emergency history in the chart to the care team', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await arrive(w.tokens.reception, p.id, { chiefComplaint: 'Fall from a ladder' });
    const res = await api().get(`/api/v1/ed/patients/${p.id}/visits`).set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      chiefComplaint: 'Fall from a ladder',
      status: 'WAITING',
    });
    const other = await api()
      .get(`/api/v1/ed/patients/${p.id}/visits`)
      .set(bearer(w.tokens.colleague));
    expect(other.status).toBe(403);
  });

  it('only assigns doctors who work in the emergency department', async () => {
    const p = await createPatient(w.facility.id);
    const visit = (await arrive(w.tokens.reception, p.id)).body;
    const res = await api()
      .post(`/api/v1/ed/visits/${visit.id}/start`)
      .set(bearer(edNurseToken))
      .send({ doctorId: w.users.doctor.id });
    expect(res.status).toBe(400);
    const ok = await api()
      .post(`/api/v1/ed/visits/${visit.id}/start`)
      .set(bearer(edNurseToken))
      .send({ doctorId: edDoctor.id });
    expect(ok.status).toBe(200);
    const note = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, edDoctor.id), eq(notifications.type, 'ed.assigned')));
    expect(note.length).toBeGreaterThan(0);
  });
});
