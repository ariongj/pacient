import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  beds,
  careUnits,
  earlyWarningScores,
  notifications,
  unitStaff,
  vitalSigns,
} from '../src/db/schema.js';
import {
  consciousnessPoints,
  observationIntervalMinutes,
  pulsePoints,
  respirationPoints,
  scoreNews2,
  spo2Scale1Points,
  spo2Scale2Points,
  systolicPoints,
  temperaturePoints,
} from '../src/modules/news/news2.js';
import { reescalateOnce, scoreNewVitalsOnce } from '../src/modules/news/news.service.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

const cases = (fn: (v: number) => number, table: [number, number][]) =>
  table.forEach(([v, points]) => expect(fn(v), `value ${v}`).toBe(points));

describe('NEWS2 scoring (RCP 2017 chart boundaries)', () => {
  it('respiration rate', () =>
    cases(respirationPoints, [
      [5, 3],
      [8, 3],
      [9, 1],
      [11, 1],
      [12, 0],
      [20, 0],
      [21, 2],
      [24, 2],
      [25, 3],
      [40, 3],
    ]));
  it('SpO2 scale 1', () =>
    cases(spo2Scale1Points, [
      [85, 3],
      [91, 3],
      [92, 2],
      [93, 2],
      [94, 1],
      [95, 1],
      [96, 0],
      [100, 0],
    ]));
  it('SpO2 scale 2 (hypercapnic respiratory failure)', () => {
    cases(
      (v) => spo2Scale2Points(v, false),
      [
        [83, 3],
        [84, 2],
        [85, 2],
        [86, 1],
        [87, 1],
        [88, 0],
        [92, 0],
        [93, 0],
        [99, 0],
      ],
    );
    cases(
      (v) => spo2Scale2Points(v, true),
      [
        [88, 0],
        [92, 0],
        [93, 1],
        [94, 1],
        [95, 2],
        [96, 2],
        [97, 3],
        [100, 3],
      ],
    );
  });
  it('systolic blood pressure', () =>
    cases(systolicPoints, [
      [80, 3],
      [90, 3],
      [91, 2],
      [100, 2],
      [101, 1],
      [110, 1],
      [111, 0],
      [219, 0],
      [220, 3],
    ]));
  it('pulse', () =>
    cases(pulsePoints, [
      [35, 3],
      [40, 3],
      [41, 1],
      [50, 1],
      [51, 0],
      [90, 0],
      [91, 1],
      [110, 1],
      [111, 2],
      [130, 2],
      [131, 3],
    ]));
  it('consciousness (ACVPU)', () => {
    expect(consciousnessPoints('A')).toBe(0);
    for (const l of ['C', 'V', 'P', 'U']) expect(consciousnessPoints(l)).toBe(3);
  });
  it('temperature', () =>
    cases(temperaturePoints, [
      [34.5, 3],
      [35.0, 3],
      [35.1, 1],
      [36.0, 1],
      [36.1, 0],
      [38.0, 0],
      [38.1, 1],
      [39.0, 1],
      [39.1, 2],
      [41, 2],
    ]));
  it('aggregate risk: low, single-parameter 3, medium, high', () => {
    const normal = {
      respiratoryRate: 16,
      oxygenSaturation: 97,
      onSupplementalOxygen: false,
      systolic: 125,
      heartRate: 72,
      consciousness: 'A',
      temperatureC: 36.8,
    };
    expect(scoreNews2(normal)).toMatchObject({ score: 0, risk: 'LOW', complete: true });
    expect(scoreNews2({ ...normal, heartRate: 95, temperatureC: 38.4 })).toMatchObject({
      score: 2,
      risk: 'LOW',
    });
    // A single parameter scoring 3 → urgent ward-based response even with a low aggregate.
    expect(scoreNews2({ ...normal, consciousness: 'C' })).toMatchObject({
      score: 3,
      risk: 'LOW_MEDIUM',
      singleThree: true,
    });
    expect(
      scoreNews2({ ...normal, onSupplementalOxygen: true, oxygenSaturation: 94, heartRate: 112 }),
    ).toMatchObject({ score: 5, risk: 'MEDIUM' });
    expect(
      scoreNews2({
        ...normal,
        respiratoryRate: 26,
        systolic: 88,
        heartRate: 128,
        temperatureC: 39.4,
      }),
    ).toMatchObject({ score: 10, risk: 'HIGH' });
  });
  it('incomplete sets are scored on what was measured and flagged', () => {
    const r = scoreNews2({ heartRate: 135, systolic: 120 });
    expect(r).toMatchObject({ score: 3, risk: 'LOW_MEDIUM', complete: false });
    expect(r.missing).toEqual(['respiration', 'spo2', 'air', 'consciousness', 'temperature']);
    expect(r.points.pulse).toBe(3);
    expect(r.points.spo2).toBeNull();
  });
  it('observation frequency follows the score', () => {
    expect(observationIntervalMinutes(0, 'LOW')).toBe(720);
    expect(observationIntervalMinutes(3, 'LOW')).toBe(240);
    expect(observationIntervalMinutes(3, 'LOW_MEDIUM')).toBe(60);
    expect(observationIntervalMinutes(6, 'MEDIUM')).toBe(60);
    expect(observationIntervalMinutes(8, 'HIGH')).toBe(15);
  });
});

/* ------------------------------------------------------------------ integration */

let w: Awaited<ReturnType<typeof createWorld>>;
let unit: typeof careUnits.$inferSelect;
let second: { id: string };
const NORMAL = {
  respiratoryRate: 16,
  oxygenSaturation: 97,
  onSupplementalOxygen: false,
  systolic: 125,
  heartRate: 72,
  consciousness: 'A',
  temperatureC: 36.8,
};
const MEDIUM = { ...NORMAL, onSupplementalOxygen: true, oxygenSaturation: 94, heartRate: 112 }; // 5
const HIGH = { ...NORMAL, respiratoryRate: 26, systolic: 88, heartRate: 128, temperatureC: 39.4 }; // 10

const newsNotifications = (userId: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'news.escalation')));

const recordVitals = (token: string, patientId: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/patients/${patientId}/vitals`).set(bearer(token)).send(body);

beforeAll(async () => {
  w = await createWorld();
  const [created] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Interna T', code: 'INT-T', type: 'GENERAL_WARD' })
    .returning();
  unit = created!;
  const [b1, b2] = await db
    .insert(beds)
    .values([
      { unitId: unit.id, label: 'T1', status: 'OCCUPIED' },
      { unitId: unit.id, label: 'T2', status: 'OCCUPIED' },
    ])
    .returning();
  await db.insert(unitStaff).values([
    { unitId: unit.id, userId: w.users.nurse.id },
    { unitId: unit.id, userId: w.users.colleague.id },
  ]);
  second = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  await db.insert(admissions).values([
    {
      patientId: w.patient.id,
      facilityId: w.facility.id,
      unitId: unit.id,
      bedId: b1!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'EMERGENCY',
      reason: 'Pneumoni',
    },
    {
      patientId: second.id,
      facilityId: w.facility.id,
      unitId: unit.id,
      bedId: b2!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'ELECTIVE',
      reason: 'Vëzhgim',
    },
  ]);
});

describe('scoring and escalation of inpatients', () => {
  it('scores vitals when recorded and accepts ACVPU, oxygen and pain', async () => {
    const res = await recordVitals(w.tokens.nurse, w.patient.id, { ...NORMAL, painScore: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      consciousness: 'A',
      onSupplementalOxygen: false,
      painScore: 2,
    });
    expect(res.body.news).toMatchObject({ score: 0, risk: 'LOW', complete: true });
    expect(await newsNotifications(w.users.doctor.id)).toHaveLength(0);
    const bad = await recordVitals(w.tokens.nurse, w.patient.id, { consciousness: 'X' });
    expect(bad.status).toBe(400);
  });

  it('MEDIUM notifies the attending doctor and the unit nurses, once', async () => {
    const res = await recordVitals(w.tokens.nurse, w.patient.id, MEDIUM);
    expect(res.body.news).toMatchObject({ score: 5, risk: 'MEDIUM' });
    const doc = await newsNotifications(w.users.doctor.id);
    expect(doc).toHaveLength(1);
    expect(doc[0]!.title).toBe('NEWS2 5: urgent review needed – Interna T, bed T1');
    // No patient name in the title (it may be emailed or texted).
    expect(doc[0]!.title).not.toContain(w.patient.lastName);
    expect(await newsNotifications(w.users.nurse.id)).toHaveLength(1);
    expect(await newsNotifications(w.users.colleague.id)).toHaveLength(0);
    // The same risk again does not re-alert.
    await recordVitals(w.tokens.nurse, w.patient.id, MEDIUM);
    expect(await newsNotifications(w.users.doctor.id)).toHaveLength(1);
  });

  it('HIGH escalates (risk increased) to the attending and the unit doctors as important', async () => {
    const res = await recordVitals(w.tokens.nurse, w.patient.id, HIGH);
    expect(res.body.news).toMatchObject({ score: 10, risk: 'HIGH' });
    const doc = await newsNotifications(w.users.doctor.id);
    expect(doc).toHaveLength(2);
    expect(doc.find((n) => n.title.startsWith('NEWS2 10'))!.title).toBe(
      'NEWS2 10: emergency assessment – Interna T, bed T1',
    );
    expect(await newsNotifications(w.users.colleague.id)).toHaveLength(1);
  });

  it('re-escalates an unacknowledged HIGH score after an hour, once, and stops after acknowledgement', async () => {
    const later = new Date(Date.now() + 61 * 60_000);
    expect(await reescalateOnce(new Date(Date.now() + 10 * 60_000))).toBe(0);
    expect(await reescalateOnce(later)).toBeGreaterThanOrEqual(1);
    const doc = await newsNotifications(w.users.doctor.id);
    expect(doc.some((n) => n.title.endsWith('(still not acknowledged)'))).toBe(true);
    const count = doc.length;
    expect(await reescalateOnce(later)).toBe(0);
    expect(await newsNotifications(w.users.doctor.id)).toHaveLength(count);

    const history = await api()
      .get(`/api/v1/early-warning/patients/${w.patient.id}`)
      .set(bearer(w.tokens.doctor));
    const latest = history.body.items[0];
    const ack = await api()
      .post(`/api/v1/early-warning/scores/${latest.id}/acknowledge`)
      .set(bearer(w.tokens.doctor))
      .send({ note: 'Antibiotikë dhe lëngje të nisura' });
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledged).toBeGreaterThanOrEqual(1);
    // Other test files may leave unacknowledged scores of their own patients: check that nothing
    // more reaches this patient's doctor.
    const afterAck = (await newsNotifications(w.users.doctor.id)).length;
    await reescalateOnce(new Date(Date.now() + 3 * 3_600_000));
    expect(await newsNotifications(w.users.doctor.id)).toHaveLength(afterAck);
  });

  it('a single-parameter 3 notifies the unit nurses only', async () => {
    const before = (await newsNotifications(w.users.nurse.id)).length;
    const docBefore = (await newsNotifications(w.users.doctor.id)).length;
    const res = await recordVitals(w.tokens.nurse, second.id, { ...NORMAL, consciousness: 'V' });
    expect(res.body.news).toMatchObject({ score: 3, risk: 'LOW_MEDIUM' });
    expect(await newsNotifications(w.users.nurse.id)).toHaveLength(before + 1);
    expect(await newsNotifications(w.users.doctor.id)).toHaveLength(docBefore);
  });
});

describe('worker', () => {
  it('scores vital signs recorded elsewhere (e.g. ED triage) once, without escalating outpatients', async () => {
    const [v] = await db
      .insert(vitalSigns)
      .values({
        patientId: w.otherPatient.id,
        recordedById: w.users.nurse.id,
        ...HIGH,
        temperatureC: '39.4',
      })
      .returning();
    const first = await scoreNewVitalsOnce();
    expect(first.scored).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select()
      .from(earlyWarningScores)
      .where(eq(earlyWarningScores.vitalSignId, v!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      score: 10,
      risk: 'HIGH',
      admissionId: null,
      escalatedAt: null,
    });
    await scoreNewVitalsOnce();
    expect(
      await db.select().from(earlyWarningScores).where(eq(earlyWarningScores.vitalSignId, v!.id)),
    ).toHaveLength(1);
    // Weight-only measurements are not scored.
    await db
      .insert(vitalSigns)
      .values({ patientId: w.otherPatient.id, recordedById: w.users.nurse.id, weightKg: '70.0' });
    const again = await scoreNewVitalsOnce();
    expect(again.scored).toBe(0);
  });
});

describe('board and access', () => {
  it('lists inpatients highest risk first with overdue observations', async () => {
    const board = await api()
      .get(`/api/v1/early-warning/board?unitId=${unit.id}`)
      .set(bearer(w.tokens.nurse));
    expect(board.status).toBe(200);
    const [first, next] = board.body.items;
    expect(first.patientId).toBe(w.patient.id);
    expect(first.latest).toMatchObject({ risk: 'HIGH', score: 10 });
    expect(first.trend.length).toBeLessThanOrEqual(3);
    expect(first.observationIntervalMinutes).toBe(15);
    expect(next.latest.risk).toBe('LOW_MEDIUM');
    expect(board.body.counts).toMatchObject({ HIGH: 1, LOW_MEDIUM: 1, total: 2 });

    // HIGH needs a set every 15 minutes: 30 minutes later it is overdue.
    await db
      .update(vitalSigns)
      .set({ recordedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(vitalSigns.patientId, w.patient.id));
    const later = await api()
      .get(`/api/v1/early-warning/board?unitId=${unit.id}`)
      .set(bearer(w.tokens.nurse));
    expect(later.body.items[0].overdue).toBe(true);
    expect(later.body.items[1].overdue).toBe(false);
  });

  it('is limited to clinical staff with access', async () => {
    for (const t of [
      w.tokens.pharmacist,
      w.tokens.reception,
      w.tokens.director,
      w.tokens.patient,
    ]) {
      expect((await api().get('/api/v1/early-warning/board').set(bearer(t))).status).toBe(403);
    }
    expect(
      (
        await api()
          .get(`/api/v1/early-warning/patients/${w.patient.id}`)
          .set(bearer(w.tokens.outsideDoctor))
      ).status,
    ).toBe(403);
  });

  it('only a doctor switches a patient to SpO2 scale 2, which re-scores the latest set', async () => {
    await recordVitals(w.tokens.nurse, second.id, { ...NORMAL, oxygenSaturation: 89 });
    const nurse = await api()
      .put(`/api/v1/early-warning/patients/${second.id}/spo2-scale`)
      .set(bearer(w.tokens.nurse))
      .send({ scale: 2, reason: 'KOBP me insuficiencë hiperkapnike' });
    expect(nurse.status).toBe(403);
    const doc = await api()
      .put(`/api/v1/early-warning/patients/${second.id}/spo2-scale`)
      .set(bearer(w.tokens.doctor))
      .send({ scale: 2, reason: 'KOBP me insuficiencë hiperkapnike' });
    expect(doc.status).toBe(200);
    expect(doc.body.latest).toMatchObject({ score: 0, risk: 'LOW' });
    const res = await recordVitals(w.tokens.nurse, second.id, { ...NORMAL, oxygenSaturation: 90 });
    expect(res.body.news.score).toBe(0); // scale 2 carried forward
  });
});
