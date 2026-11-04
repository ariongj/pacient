import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  bloodUnits,
  careAssignments,
  careUnits,
  notifications,
  transfusionRequests,
  transfusions,
  unitStaff,
} from '../src/db/schema.js';
import { checkCompatibility } from '../src/modules/bloodbank/bloodbank.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let bb: { id: string; token: string };
let bbDoctor: { id: string; token: string };
let seq = 0;

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Blood bank', code: 'BB', type: 'BLOOD_BANK' })
    .returning();
  const n = await createUser('NURSE', w.facility.id);
  const d = await createUser('DOCTOR', w.facility.id, { specialty: 'Transfusion medicine' });
  await db.insert(unitStaff).values([
    { unitId: unit!.id, userId: n.id },
    { unitId: unit!.id, userId: d.id },
  ]);
  bb = { id: n.id, token: await login(n.email) };
  bbDoctor = { id: d.id, token: await login(d.email) };
  // The ward nurse who gives the transfusion is on the patient's care team.
  await db.insert(careAssignments).values({ patientId: w.patient.id, doctorId: w.users.nurse.id });
});

const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/blood-bank${path}`).set(bearer(token)).send(body);
const get = (path: string, token: string) =>
  api().get(`/api/v1/blood-bank${path}`).set(bearer(token));

async function addUnit(product: string, abo: string, rhD: string, expiresInDays = 20) {
  const res = await post('/units', bb.token, {
    unitNumber: `T${Date.now()}${seq++}`,
    product,
    abo,
    rhD,
    volumeMl: product === 'PLATELETS' ? 250 : 300,
    collectedAt: new Date(Date.now() - 2 * 86_400_000),
    expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; unitNumber: string };
}

async function group(patientId: string, abo: string, rhD: string) {
  const res = await post(`/patients/${patientId}/blood-group`, bb.token, { abo, rhD });
  expect(res.status).toBe(201);
  return res.body;
}

async function request(body: Record<string, unknown> = {}, patientId = w.patient.id) {
  return post('/requests', w.tokens.doctor, {
    patientId,
    product: 'RED_CELLS',
    units: 1,
    urgency: 'URGENT',
    indication: 'Symptomatic anaemia after bleeding',
    haemoglobinGl: 72,
    ...body,
  });
}

const titles = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
    (x) => x.title,
  );

describe('compatibility rules', () => {
  const A_POS = { abo: 'A', rhD: 'POS' } as const;
  const O_NEG = { abo: 'O', rhD: 'NEG' } as const;
  it('follows ABO and RhD rules for red cells', () => {
    expect(checkCompatibility('RED_CELLS', A_POS, { abo: 'O', rhD: 'NEG' }).ok).toBe(true);
    expect(checkCompatibility('RED_CELLS', A_POS, { abo: 'A', rhD: 'POS' }).ok).toBe(true);
    expect(checkCompatibility('RED_CELLS', A_POS, { abo: 'B', rhD: 'POS' }).ok).toBe(false);
    expect(
      checkCompatibility('RED_CELLS', { abo: 'AB', rhD: 'POS' }, { abo: 'B', rhD: 'POS' }).ok,
    ).toBe(true);
    expect(checkCompatibility('RED_CELLS', O_NEG, { abo: 'A', rhD: 'NEG' }).ok).toBe(false);
    expect(checkCompatibility('RED_CELLS', O_NEG, { abo: 'O', rhD: 'POS' }).ok).toBe(false);
    const emergency = checkCompatibility(
      'RED_CELLS',
      O_NEG,
      { abo: 'O', rhD: 'POS' },
      { emergencyReason: 'Massive haemorrhage, no RhD-negative units left' },
    );
    expect(emergency.ok).toBe(true);
    expect(emergency.warnings.length).toBeGreaterThan(0);
  });

  it('allows only universal units while the group is not confirmed', () => {
    expect(checkCompatibility('RED_CELLS', null, { abo: 'O', rhD: 'NEG' }).ok).toBe(true);
    expect(checkCompatibility('RED_CELLS', null, { abo: 'A', rhD: 'NEG' }).ok).toBe(false);
    expect(checkCompatibility('PLASMA', null, { abo: 'AB', rhD: 'POS' }).ok).toBe(true);
    expect(checkCompatibility('PLASMA', null, { abo: 'O', rhD: 'POS' }).ok).toBe(false);
  });

  it('reverses the rule for plasma and only warns for platelets', () => {
    expect(
      checkCompatibility('PLASMA', { abo: 'O', rhD: 'POS' }, { abo: 'A', rhD: 'POS' }).ok,
    ).toBe(true);
    expect(checkCompatibility('PLASMA', A_POS, { abo: 'O', rhD: 'POS' }).ok).toBe(false);
    const plt = checkCompatibility('PLATELETS', A_POS, { abo: 'O', rhD: 'POS' });
    expect(plt.ok).toBe(true);
    expect(plt.warnings).toHaveLength(1);
  });

  it('prefers RhD-negative red cells for women of childbearing age with an unknown RhD', () => {
    expect(
      checkCompatibility('RED_CELLS', null, { abo: 'O', rhD: 'POS' }, { preferRhNegative: true })
        .ok,
    ).toBe(false);
  });
});

describe('blood groups', () => {
  it('lets only blood bank staff record results, and confirms after two concordant tests', async () => {
    expect(
      (
        await post(`/patients/${w.patient.id}/blood-group`, w.tokens.doctor, {
          abo: 'A',
          rhD: 'POS',
        })
      ).status,
    ).toBe(403);
    const first = await group(w.patient.id, 'A', 'POS');
    expect(first.current.confirmed).toBe(false);
    const second = await group(w.patient.id, 'A', 'POS');
    expect(second.current.confirmed).toBe(true);
    const view = await get(`/patients/${w.patient.id}`, w.tokens.doctor);
    expect(view.status).toBe(200);
    expect(view.body.bloodGroup).toMatchObject({ confirmed: true, concordantTests: 2 });
    expect((await get(`/patients/${w.patient.id}`, w.tokens.outsideDoctor)).status).toBe(403);
  });

  it('flags discordant results', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await group(p.id, 'B', 'POS');
    const res = await group(p.id, 'O', 'POS');
    expect(res.warnings).toHaveLength(1);
    expect(res.current.discordant).toBe(true);
    const r = await request({}, p.id);
    await post(`/requests/${r.body.id}/sample`, bb.token);
    const unit = await addUnit('RED_CELLS', 'O', 'NEG');
    const x = await post(`/requests/${r.body.id}/crossmatch`, bb.token, { unitIds: [unit.id] });
    expect(x.status).toBe(409);
    expect(x.body.error.code).toBe('GROUP_DISCORDANT');
  });
});

describe('requests', () => {
  it('is for treating doctors only and alerts the blood bank', async () => {
    expect((await post('/requests', w.tokens.nurse, { patientId: w.patient.id })).status).toBe(403);
    const outsider = await post('/requests', w.tokens.outsideDoctor, {
      patientId: w.patient.id,
      product: 'RED_CELLS',
      units: 1,
      urgency: 'ROUTINE',
      indication: 'Anaemia',
    });
    expect(outsider.status).toBe(403);
    const high = await request({ haemoglobinGl: 95 });
    expect(high.status).toBe(201);
    expect(high.body.warnings).toHaveLength(1);
    expect(await titles(bb.id)).toContain('New urgent transfusion request');
    const emergency = await request({ urgency: 'EMERGENCY' });
    expect(emergency.status).toBe(201);
    expect(await titles(bbDoctor.id)).toContain('EMERGENCY transfusion request – act now');
    const queue = await get('/requests', bb.token);
    expect(queue.status).toBe(200);
    expect(queue.body.items[0].urgency).toBe('EMERGENCY');
    expect((await get('/requests', w.tokens.doctor)).status).toBe(403);
  });
});

describe('crossmatch, issue and bedside transfusion', () => {
  let requestId = '';
  let transfusionId = '';
  let unitNumber = '';

  it('reserves only compatible, unexpired units', async () => {
    const r = await request();
    requestId = r.body.id;
    expect(
      (await post(`/requests/${requestId}/crossmatch`, bb.token, { unitIds: [] })).status,
    ).toBe(400);
    const notSampled = await addUnit('RED_CELLS', 'A', 'POS');
    expect(
      (await post(`/requests/${requestId}/crossmatch`, bb.token, { unitIds: [notSampled.id] }))
        .status,
    ).toBe(409);
    expect((await post(`/requests/${requestId}/sample`, bb.token)).status).toBe(200);
    const wrong = await addUnit('RED_CELLS', 'B', 'POS');
    const bad = await post(`/requests/${requestId}/crossmatch`, bb.token, { unitIds: [wrong.id] });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('INCOMPATIBLE');
    const [expired] = await db
      .insert(bloodUnits)
      .values({
        facilityId: w.facility.id,
        unitNumber: `EXP${Date.now()}`,
        product: 'RED_CELLS',
        abo: 'A',
        rhD: 'POS',
        volumeMl: 300,
        collectedAt: new Date(Date.now() - 50 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
        receivedById: bb.id,
      })
      .returning();
    const old = await post(`/requests/${requestId}/crossmatch`, bb.token, {
      unitIds: [expired!.id],
    });
    expect(old.body.error.code).toBe('UNIT_EXPIRED');
    const ok = await post(`/requests/${requestId}/crossmatch`, bb.token, {
      unitIds: [notSampled.id],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('CROSSMATCHED');
    unitNumber = notSampled.unitNumber;
    const issued = await post(`/requests/${requestId}/issue`, bb.token, { unitId: notSampled.id });
    expect(issued.status).toBe(201);
    transfusionId = issued.body.id;
    expect(await titles(w.users.doctor.id)).toContain(
      'Blood unit issued – start the bedside check',
    );
  });

  it('enforces the two-person bedside check', async () => {
    const base = {
      nationalId: w.patient.nationalId,
      dateOfBirth: w.patient.dateOfBirth,
      unitNumber,
      secondCheckerId: w.users.colleague.id,
      vitals: { systolic: 118, diastolic: 70, heartRate: 84, temperature: 36.8 },
    };
    const start = async (body: Record<string, unknown>) => {
      const r = await post(`/transfusions/${transfusionId}/start`, w.tokens.nurse, { ...base, ...body });
      console.log('DBG', r.status, JSON.stringify(r.body).slice(0, 300));
      return r;
    };
    expect((await start({ unitNumber: 'WRONG-1' })).body.error.code).toBe('UNIT_MISMATCH');
    expect((await start({ dateOfBirth: '1991-02-02' })).body.error.code).toBe('IDENTITY_MISMATCH');
    expect((await start({ secondCheckerId: w.users.nurse.id })).status).toBe(400);
    expect(
      (await post(`/transfusions/${transfusionId}/start`, w.tokens.outsideDoctor, base)).status,
    ).toBe(403);
    expect((await start({})).status).toBe(200);
    expect(await titles(w.users.colleague.id)).toContain(
      'Please confirm the bedside check for a blood transfusion',
    );
    expect(
      (await post(`/transfusions/${transfusionId}/confirm-check`, w.tokens.doctor)).status,
    ).toBe(403);
    // A check older than 10 minutes must be repeated.
    const [row] = await db.select().from(transfusions).where(eq(transfusions.id, transfusionId));
    const stale = (row!.observations as { at: string }[]).map((o) => ({
      ...o,
      at: new Date(Date.now() - 11 * 60_000).toISOString(),
    }));
    await db
      .update(transfusions)
      .set({ observations: stale })
      .where(eq(transfusions.id, transfusionId));
    const expired = await post(`/transfusions/${transfusionId}/confirm-check`, w.tokens.colleague);
    expect(expired.body.error.code).toBe('CHECK_EXPIRED');
    expect((await start({})).status).toBe(200);
    const confirmed = await post(
      `/transfusions/${transfusionId}/confirm-check`,
      w.tokens.colleague,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('IN_PROGRESS');
  });

  it('records observations and completes the transfusion', async () => {
    expect(
      (
        await post(`/transfusions/${transfusionId}/observation`, w.tokens.nurse, {
          phase: 'T15',
          vitals: { heartRate: 86, temperature: 36.9 },
        })
      ).status,
    ).toBe(200);
    const done = await post(`/transfusions/${transfusionId}/complete`, w.tokens.nurse, {
      volumeGivenMl: 290,
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('COMPLETED');
    expect((done.body.observations as { phase: string }[]).map((o) => o.phase)).toEqual([
      'PRE',
      'T15',
      'END',
    ]);
    const [r] = await db
      .select()
      .from(transfusionRequests)
      .where(eq(transfusionRequests.id, requestId));
    expect(r!.status).toBe('COMPLETED');
    const [u] = await db.select().from(bloodUnits).where(eq(bloodUnits.unitNumber, unitNumber));
    expect(u!.status).toBe('TRANSFUSED');
  });
});

describe('emergencies, reactions and cancellation', () => {
  it('issues uncrossmatched O RhD-negative red cells only with a reason', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const r = await request({ urgency: 'EMERGENCY', units: 2 }, p.id);
    const oneg = await addUnit('RED_CELLS', 'O', 'NEG');
    const apos = await addUnit('RED_CELLS', 'A', 'POS');
    expect(
      (await post(`/requests/${r.body.id}/emergency-issue`, bb.token, { unitId: oneg.id })).status,
    ).toBe(400);
    expect(
      (
        await post(`/requests/${r.body.id}/emergency-issue`, bb.token, {
          unitId: apos.id,
          reason: 'Massive haemorrhage in the emergency department',
        })
      ).status,
    ).toBe(400);
    const ok = await post(`/requests/${r.body.id}/emergency-issue`, bb.token, {
      unitId: oneg.id,
      reason: 'Massive haemorrhage in the emergency department',
    });
    expect(ok.status).toBe(201);
    const routine = await request({}, p.id);
    expect(
      (
        await post(`/requests/${routine.body.id}/emergency-issue`, bb.token, {
          unitId: apos.id,
          reason: 'Not an emergency at all, should fail',
        })
      ).status,
    ).toBe(409);
  });

  it('stops the transfusion on a reaction and alerts doctor and blood bank', async () => {
    const r = await request();
    await post(`/requests/${r.body.id}/sample`, bb.token);
    const unit = await addUnit('RED_CELLS', 'O', 'NEG');
    await post(`/requests/${r.body.id}/crossmatch`, bb.token, { unitIds: [unit.id] });
    const t = (await post(`/requests/${r.body.id}/issue`, bb.token, { unitId: unit.id })).body;
    await post(`/transfusions/${t.id}/start`, w.tokens.nurse, {
      nationalId: w.patient.nationalId,
      dateOfBirth: w.patient.dateOfBirth,
      unitNumber: unit.unitNumber,
      secondCheckerId: w.users.colleague.id,
      vitals: { temperature: 36.7 },
    });
    await post(`/transfusions/${t.id}/confirm-check`, w.tokens.colleague);
    const reaction = await post(`/transfusions/${t.id}/reaction`, w.tokens.nurse, {
      type: 'FEBRILE',
      severity: 'MILD',
      details: 'Temperature rose to 38.4 °C with chills after 40 minutes',
      actionsTaken: 'Transfusion stopped, doctor informed, paracetamol given',
      vitals: { temperature: 38.4 },
    });
    expect(reaction.status).toBe(200);
    expect(reaction.body).toMatchObject({
      status: 'STOPPED',
      reaction: true,
      reactionType: 'FEBRILE',
    });
    expect(await titles(w.users.doctor.id)).toContain('Transfusion reaction reported – review now');
    expect(await titles(bb.id)).toContain('Transfusion reaction reported – review now');
    const list = await get('/reactions', bb.token);
    expect(list.body.items.some((i: { id: string }) => i.id === t.id)).toBe(true);
    const director = await get('/reactions', w.tokens.director);
    expect(director.status).toBe(200);
    expect(director.body.items).toEqual([]);
    expect(director.body.counts[0]).toMatchObject({ suppressed: true, count: null });
  });

  it('releases reserved units when a request is cancelled', async () => {
    const r = await request();
    await post(`/requests/${r.body.id}/sample`, bb.token);
    const unit = await addUnit('RED_CELLS', 'A', 'NEG');
    await post(`/requests/${r.body.id}/crossmatch`, bb.token, { unitIds: [unit.id] });
    expect(
      (await post(`/requests/${r.body.id}/cancel`, w.tokens.colleague, { reason: 'x' })).status,
    ).toBe(400);
    expect(
      (await post(`/requests/${r.body.id}/cancel`, w.tokens.colleague, { reason: 'Not needed' }))
        .status,
    ).toBe(403);
    expect(
      (await post(`/requests/${r.body.id}/cancel`, w.tokens.doctor, { reason: 'Bleeding stopped' }))
        .status,
    ).toBe(204);
    const [u] = await db
      .select()
      .from(bloodUnits)
      .where(and(eq(bloodUnits.id, unit.id), eq(bloodUnits.status, 'AVAILABLE')));
    expect(u).toBeDefined();
  });
});

describe('stock', () => {
  it('counts units by product and group; unit details for blood bank staff only', async () => {
    await addUnit('PLASMA', 'AB', 'POS');
    await addUnit('PLATELETS', 'O', 'POS', 2);
    const staff = await get('/stock', bb.token);
    expect(staff.status).toBe(200);
    expect(staff.body.matrix.PLASMA['AB+'].available).toBeGreaterThanOrEqual(1);
    expect(staff.body.expiringCount).toBeGreaterThanOrEqual(1);
    expect(staff.body.expiredCount).toBeGreaterThanOrEqual(1);
    expect(staff.body.units.some((u: { expired: boolean }) => u.expired)).toBe(true);
    const director = await get('/stock', w.tokens.director);
    expect(director.status).toBe(200);
    expect(director.body.units).toEqual([]);
    expect((await get('/stock', w.tokens.patient)).status).toBe(403);
    const duplicate = await post('/units', bb.token, {
      unitNumber: (await addUnit('RED_CELLS', 'O', 'POS')).unitNumber,
      product: 'RED_CELLS',
      abo: 'O',
      rhD: 'POS',
      volumeMl: 300,
      collectedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(duplicate.status).toBe(409);
  });
});
