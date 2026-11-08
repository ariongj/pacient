import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  ambulanceUnits,
  auditLogs,
  careUnits,
  edVisits,
  emsCareRecords,
  emsIncidents,
  notifications,
  patients,
  unitStaff,
} from '../src/db/schema.js';
import { acvpuFromGcs, earlyWarningFor, priorityFor } from '../src/modules/ems/ems.service.js';
import {
  api,
  bearer,
  createFacility,
  createPatient,
  createUser,
  createWorld,
  login,
} from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let serviceId: string;
let crew: string;
let crewNurse: string;
let edNurse: string;
let edNurseId: string;
let otherEdNurse: string;
const vehicles: string[] = [];

const call = (token: string, body: Record<string, unknown> = {}) =>
  api()
    .post('/api/v1/ems/incidents')
    .set(bearer(token))
    .send({
      address: 'Rr. Agim Ramadani 12',
      municipality: 'Prishtinë',
      complaint: 'Dhimbje gjoksi',
      answers: { conscious: true, breathingNormally: true, chestPain: true },
      ...body,
    });
const post = (token: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/ems/incidents/${path}`).set(bearer(token)).send(body);

async function freeVehicle() {
  const [v] = await db
    .insert(ambulanceUnits)
    .values({
      stationUnitId: serviceId,
      callSign: `T-${Math.random().toString(36).slice(2, 8)}`,
      level: 'ALS',
    })
    .returning();
  vehicles.push(v!.id);
  return v!.id;
}

/** A call taken to the point of transporting to the demo ED (facility of the world). */
async function transporting(extra: Record<string, unknown> = {}) {
  const c = await call(crew, extra);
  const id = c.body.id as string;
  expect(
    (await post(crew, `${id}/dispatch`, { ambulanceUnitId: await freeVehicle() })).status,
  ).toBe(200);
  expect((await post(crew, `${id}/status`, { status: 'ON_SCENE' })).status).toBe(200);
  const t = await post(crew, `${id}/status`, {
    status: 'TRANSPORTING',
    destinationFacilityId: w.facility.id,
    etaMinutes: 12,
  });
  expect(t.status).toBe(200);
  return id;
}

beforeAll(async () => {
  w = await createWorld();
  const [service] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Emergjenca Parahospitalore',
      code: `QEP${Date.now() % 1000}`,
      type: 'AMBULANCE_SERVICE',
    })
    .returning();
  serviceId = service!.id;
  const [ed] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Emergjenca', code: 'ED', type: 'EMERGENCY' })
    .returning();
  const [otherEd] = await db
    .insert(careUnits)
    .values({ facilityId: w.otherFacility.id, name: 'Emergjenca', code: 'ED2', type: 'EMERGENCY' })
    .returning();
  const crewDoctor = await createUser('DOCTOR', w.facility.id);
  const crewN = await createUser('NURSE', w.facility.id);
  const edN = await createUser('NURSE', w.facility.id);
  const otherEdN = await createUser('NURSE', w.otherFacility.id);
  edNurseId = edN.id;
  await db.insert(unitStaff).values([
    { unitId: serviceId, userId: crewDoctor.id },
    { unitId: serviceId, userId: crewN.id },
    { unitId: ed!.id, userId: edN.id },
    { unitId: otherEd!.id, userId: otherEdN.id },
  ]);
  [crew, crewNurse, edNurse, otherEdNurse] = await Promise.all([
    login(crewDoctor.email),
    login(crewN.email),
    login(edN.email),
    login(otherEdN.email),
  ]);
});

describe('call categories and early warning', () => {
  it('derives the illustrative category from the answers', () => {
    expect(priorityFor({ conscious: false, breathingNormally: true })).toBe('P1');
    expect(priorityFor({ conscious: true, breathingNormally: false })).toBe('P1');
    expect(priorityFor({ conscious: true, breathingNormally: true, strokeSigns: true })).toBe('P1');
    expect(priorityFor({ conscious: true, breathingNormally: true, seriousInjury: true })).toBe(
      'P2',
    );
    expect(priorityFor({ conscious: true, breathingNormally: true })).toBe('P3');
  });

  it('scores NEWS2 for adults and PEWS for children from the latest observation', () => {
    expect([15, 14, 10, 6].map(acvpuFromGcs)).toEqual(['A', 'C', 'V', 'P']);
    const obs = [
      { recordedAt: new Date(Date.now() - 600_000), data: { heartRate: 80 } },
      {
        recordedAt: new Date(),
        data: {
          respiratoryRate: 26,
          spo2: 90,
          systolic: 88,
          heartRate: 132,
          gcs: 13,
          temperature: 39.3,
        },
      },
    ];
    const adult = earlyWarningFor(obs, '1950-01-01');
    expect(adult?.scale).toBe('NEWS2');
    expect(adult?.result.risk).toBe('HIGH');
    const child = earlyWarningFor(
      obs,
      new Date(Date.now() - 4 * 365 * 86_400_000).toISOString().slice(0, 10),
    );
    expect(child?.scale).toBe('PEWS');
    expect(earlyWarningFor(obs, null)?.scale).toBe('NEWS2');
    expect(earlyWarningFor([], null)).toBeNull();
  });
});

describe('calls', () => {
  it('validates calls, needs a reason to change the category and numbers them without gaps', async () => {
    expect((await call(crew, { answers: undefined })).status).toBe(400);
    expect((await call(crew, { latitude: 42.66 })).status).toBe(400);
    const overridden = await call(crew, { priority: 'P2' });
    expect(overridden.status).toBe(400);
    const ok = await call(crew, {
      priority: 'P2',
      priorityReason: 'Caller reports pain has eased',
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ priority: 'P2', computedPriority: 'P1', status: 'RECEIVED' });
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'ems.incident_created'), eq(auditLogs.resourceId, ok.body.id)),
      );
    expect(audit[0]!.metadata).toMatchObject({ priority: 'P2', computedPriority: 'P1' });

    const many = await Promise.all([1, 2, 3, 4, 5].map(() => call(crewNurse)));
    expect(many.every((r) => r.status === 201)).toBe(true);
    const refs = many.map((r) => r.body.reference as string);
    expect(new Set(refs).size).toBe(5);
    const numbers = refs.map((r) => Number(r.slice(-6))).sort((a, b) => a - b);
    expect(numbers[4]! - numbers[0]!).toBe(4);
    expect(refs[0]).toMatch(/^EMS-\d{4}-\d{6}$/);
  });

  it('is only for staff of the ambulance service', async () => {
    expect((await call(w.tokens.doctor)).status).toBe(403);
    expect((await api().get('/api/v1/ems/board').set(bearer(w.tokens.nurse))).status).toBe(403);
    expect((await api().get('/api/v1/ems/board').set(bearer(w.tokens.reception))).status).toBe(403);
    const c = await call(crew);
    expect(
      (await api().get(`/api/v1/ems/incidents/${c.body.id}`).set(bearer(w.tokens.doctor))).status,
    ).toBe(404);
    expect(
      (await post(w.tokens.doctor, `${c.body.id}/cancel`, { reason: 'Duplicate' })).status,
    ).toBe(404);
    const board = await api().get('/api/v1/ems/board').set(bearer(crew));
    expect(board.status).toBe(200);
    expect(board.body.items.some((i: { id: string }) => i.id === c.body.id)).toBe(true);
  });
});

describe('dispatch and progress', () => {
  it('locks the vehicle: two dispatchers, one ambulance', async () => {
    const vehicle = await freeVehicle();
    const [a, b] = await Promise.all([call(crew), call(crewNurse)]);
    const [ra, rb] = await Promise.all([
      post(crew, `${a.body.id}/dispatch`, { ambulanceUnitId: vehicle }),
      post(crewNurse, `${b.body.id}/dispatch`, { ambulanceUnitId: vehicle }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winner = ra.status === 200 ? a.body.id : b.body.id;
    expect(
      (await post(crew, `${winner}/dispatch`, { ambulanceUnitId: await freeVehicle() })).status,
    ).toBe(409);
    const [v] = await db.select().from(ambulanceUnits).where(eq(ambulanceUnits.id, vehicle));
    expect(v!.status).toBe('DISPATCHED');
  });

  it('follows the status sequence, records the times and pre-alerts the destination', async () => {
    const c = await call(crew);
    const id = c.body.id;
    const vehicle = await freeVehicle();
    expect((await post(crew, `${id}/status`, { status: 'ON_SCENE' })).status).toBe(409);
    await post(crew, `${id}/dispatch`, { ambulanceUnitId: vehicle });
    expect((await post(crew, `${id}/status`, { status: 'TRANSPORTING' })).status).toBe(400);
    const scene = await post(crew, `${id}/status`, { status: 'ON_SCENE' });
    expect(scene.body.onSceneAt).toBeTruthy();
    expect(scene.body.responseMinutes).toBe(0);
    expect((await post(crew, `${id}/cancel`, { reason: 'Too late' })).status).toBe(409);
    const leaving = await post(crew, `${id}/status`, {
      status: 'TRANSPORTING',
      destinationFacilityId: w.facility.id,
      etaMinutes: 10,
    });
    expect(leaving.status).toBe(200);
    expect(leaving.body.destination.id).toBe(w.facility.id);
    const [v] = await db.select().from(ambulanceUnits).where(eq(ambulanceUnits.id, vehicle));
    expect(v!.status).toBe('TRANSPORTING');
    const alerts = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, edNurseId), eq(notifications.type, 'ems_prealert')));
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.at(-1)!.title).toContain('P1');
    expect(alerts.at(-1)!.title).not.toContain('Test');
    // No complaint in the title (it can go out by SMS): priority and arrival time only.
    expect(alerts.at(-1)!.title).not.toMatch(/Dhimbje|:/);
    expect((await post(crew, `${id}/status`, { status: 'AT_HOSPITAL' })).status).toBe(200);
    expect((await post(crew, `${id}/status`, { status: 'AT_HOSPITAL' })).status).toBe(409);
  });

  it('refuses a destination without an emergency department', async () => {
    const c = await call(crew);
    await post(crew, `${c.body.id}/dispatch`, { ambulanceUnitId: await freeVehicle() });
    await post(crew, `${c.body.id}/status`, { status: 'ON_SCENE' });
    const noEd = await createFacility();
    const res = await post(crew, `${c.body.id}/status`, {
      status: 'TRANSPORTING',
      destinationFacilityId: noEd.id,
      etaMinutes: 5,
    });
    expect(res.status).toBe(400);
  });

  it('closes on scene with a fitting outcome and frees the vehicle', async () => {
    const c = await call(crew);
    const vehicle = await freeVehicle();
    await post(crew, `${c.body.id}/dispatch`, { ambulanceUnitId: vehicle });
    await post(crew, `${c.body.id}/status`, { status: 'ON_SCENE' });
    expect((await post(crew, `${c.body.id}/close`, { outcome: 'TRANSPORTED' })).status).toBe(409);
    const closed = await post(crew, `${c.body.id}/close`, { outcome: 'TREATED_ON_SCENE' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', outcome: 'TREATED_ON_SCENE' });
    const [v] = await db.select().from(ambulanceUnits).where(eq(ambulanceUnits.id, vehicle));
    expect(v!.status).toBe('AVAILABLE');
  });

  it('cancels a call before arrival on scene', async () => {
    const c = await call(crew);
    const vehicle = await freeVehicle();
    await post(crew, `${c.body.id}/dispatch`, { ambulanceUnitId: vehicle });
    const res = await post(crew, `${c.body.id}/cancel`, { reason: 'Duplicate call' });
    expect(res.body).toMatchObject({ status: 'CANCELLED', outcome: 'CANCELLED' });
    const [v] = await db.select().from(ambulanceUnits).where(eq(ambulanceUnits.id, vehicle));
    expect(v!.status).toBe('AVAILABLE');
  });
});

describe('pre-hospital care record', () => {
  it('links the patient only with national ID and date of birth, records care append-only', async () => {
    const p = await createPatient(w.facility.id);
    const c = await call(crew);
    const id = c.body.id;
    await post(crew, `${id}/dispatch`, { ambulanceUnitId: await freeVehicle() });
    const wrong = await post(crew, `${id}/patient`, {
      nationalId: p.nationalId,
      dateOfBirth: '1991-01-01',
    });
    expect(wrong.status).toBe(404);
    const linked = await post(crew, `${id}/patient`, {
      nationalId: p.nationalId,
      dateOfBirth: p.dateOfBirth,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.patient.id).toBe(p.id);
    expect(
      (await post(crew, `${id}/patient`, { nationalId: p.nationalId, dateOfBirth: p.dateOfBirth }))
        .status,
    ).toBe(409);
    // The crew now reads the patient's record through the open call.
    expect((await api().get(`/api/v1/patients/${p.id}/summary`).set(bearer(crew))).status).toBe(
      200,
    );

    expect(
      (await post(crew, `${id}/care`, { kind: 'OBSERVATION', data: { heartRate: 400 } })).status,
    ).toBe(400);
    expect((await post(crew, `${id}/care`, { kind: 'OBSERVATION', data: {} })).status).toBe(400);
    const obs = await post(crew, `${id}/care`, {
      kind: 'OBSERVATION',
      data: {
        respiratoryRate: 24,
        spo2: 93,
        systolic: 95,
        heartRate: 118,
        gcs: 15,
        temperature: 38.4,
        onOxygen: false,
      },
    });
    expect(obs.status).toBe(201);
    expect(obs.body.earlyWarning).toMatchObject({ scale: 'NEWS2' });
    expect(obs.body.earlyWarning.score).toBeGreaterThan(4);
    const med = await post(crew, `${id}/care`, {
      kind: 'MEDICATION',
      medication: 'Aspirinë',
      dose: '300 mg',
      route: 'oral',
    });
    expect(med.status).toBe(201);
    expect(med.body.record.text).toBe('Aspirinë 300 mg (oral)');
    await expect(
      db
        .update(emsCareRecords)
        .set({ text: 'changed' })
        .where(eq(emsCareRecords.id, med.body.record.id)),
    ).rejects.toThrow();
    const detail = await api().get(`/api/v1/ems/incidents/${id}`).set(bearer(crew));
    expect(detail.body.careRecords).toHaveLength(2);
    expect(detail.body.earlyWarning.scale).toBe('NEWS2');
  });
});

describe('handover to the emergency department', () => {
  it('shows incoming ambulances without names and only at the destination', async () => {
    const p = await createPatient(w.facility.id);
    const id = await transporting();
    await post(crew, `${id}/patient`, { nationalId: p.nationalId, dateOfBirth: p.dateOfBirth });
    const incoming = await api().get('/api/v1/ems/incoming').set(bearer(edNurse));
    expect(incoming.status).toBe(200);
    const item = incoming.body.items.find((i: { id: string }) => i.id === id);
    expect(item).toMatchObject({ priority: 'P1', sex: 'FEMALE', ageBand: 'ADULT' });
    expect(JSON.stringify(item)).not.toContain(p.lastName);
    expect(incoming.body.canTakeHandover).toBe(true);
    const front = await api().get('/api/v1/ems/incoming').set(bearer(w.tokens.reception));
    expect(front.body.canTakeHandover).toBe(false);
    const other = await api().get('/api/v1/ems/incoming').set(bearer(otherEdNurse));
    expect(other.body.items.some((i: { id: string }) => i.id === id)).toBe(false);
    expect((await api().get(`/api/v1/ems/incidents/${id}`).set(bearer(otherEdNurse))).status).toBe(
      404,
    );
    expect((await api().get(`/api/v1/ems/incidents/${id}`).set(bearer(edNurse))).status).toBe(200);
    expect((await post(otherEdNurse, `${id}/handover`)).status).toBe(404);
    expect((await post(crew, `${id}/handover`)).status).toBe(404);
  });

  it('opens the attendance at handover and the crew closes the call', async () => {
    const p = await createPatient(w.facility.id);
    const id = await transporting();
    await post(crew, `${id}/patient`, { nationalId: p.nationalId, dateOfBirth: p.dateOfBirth });
    const res = await post(edNurse, `${id}/handover`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('HANDED_OVER');
    const [visit] = await db.select().from(edVisits).where(eq(edVisits.id, res.body.edVisitId));
    expect(visit).toMatchObject({ patientId: p.id, arrivalMode: 'AMBULANCE', status: 'WAITING' });
    expect((await post(edNurse, `${id}/handover`)).status).toBe(409);
    const closed = await post(crew, `${id}/close`, { outcome: 'TRANSPORTED' });
    expect(closed.body).toMatchObject({ status: 'CLOSED', outcome: 'TRANSPORTED' });
    // The ED still reads the pre-hospital record after the call closed.
    expect((await api().get(`/api/v1/ems/incidents/${id}`).set(bearer(edNurse))).status).toBe(200);
    const handover = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'ems.handover'), eq(auditLogs.resourceId, id)));
    expect(handover).toHaveLength(1);
  });

  it('registers an unidentified patient when the crew linked nobody', async () => {
    const id = await transporting({ patientDescription: 'Burrë rreth 60 vjeç, pa dokumente' });
    expect((await post(edNurse, `${id}/handover`)).status).toBe(400);
    const res = await post(edNurse, `${id}/handover`, { sex: 'MALE', estimatedAge: 60 });
    expect(res.status).toBe(200);
    const [p] = await db.select().from(patients).where(eq(patients.id, res.body.patientId));
    expect(p).toMatchObject({ temporaryIdentity: 'UNIDENTIFIED', sex: 'MALE' });
    expect(p!.identityNote).toContain('Burrë');
  });
});

describe('statistics', () => {
  it('reports response times with small cells suppressed, by facility for directors', async () => {
    // Ten historical P1 calls with known response times (5–14 minutes).
    const base = Date.now() - 10 * 86_400_000;
    const offset = 100_000 + Math.floor(Math.random() * 800_000);
    const inserted = await db
      .insert(emsIncidents)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          reference: `EMS-1999-${String(offset + i).padStart(6, '0')}`,
          serviceUnitId: serviceId,
          receivedAt: new Date(base + i * 3_600_000),
          dispatchedAt: new Date(base + i * 3_600_000 + 60_000),
          onSceneAt: new Date(base + i * 3_600_000 + 60_000 + (5 + i) * 60_000),
          address: 'Rr. Test',
          complaint: 'Test',
          priority: 'P1',
          status: 'CLOSED',
          outcome: 'TREATED_ON_SCENE',
          closedAt: new Date(base + i * 3_600_000 + 3_600_000),
          createdById: w.users.director.id,
        })),
      )
      .returning({ id: emsIncidents.id });
    expect(inserted.length).toBe(10);
    const ministry = await api().get('/api/v1/ems/stats').set(bearer(w.tokens.ministry));
    expect(ministry.status).toBe(200);
    const p1 = ministry.body.byPriority.find((r: { priority: string }) => r.priority === 'P1');
    expect(p1.medianResponseMinutes).toBeGreaterThan(0);
    expect(ministry.body.p1WithinTargetPercent).not.toBeNull();
    const director = await api().get('/api/v1/ems/stats').set(bearer(w.tokens.director));
    expect(director.status).toBe(200);
    expect(director.body.total).toBeGreaterThanOrEqual(10);
    const p2 = director.body.byPriority.find((r: { priority: string }) => r.priority === 'P2');
    // Fewer than five P2 calls at this service: hidden, and no times.
    expect(p2.calls === null || p2.calls === 0 || p2.calls >= 5).toBe(true);
    if (p2.calls === null) expect(p2.medianResponseMinutes).toBeNull();
    const other = await api().get('/api/v1/ems/stats').set(bearer(w.tokens.otherDirector));
    expect(other.body.total).toBe(0);
    expect((await api().get('/api/v1/ems/stats').set(bearer(crew))).status).toBe(403);
    await db.delete(emsIncidents).where(
      inArray(
        emsIncidents.id,
        inserted.map((r) => r.id),
      ),
    );
  });
});
