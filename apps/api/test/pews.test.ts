import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  beds,
  careUnits,
  earlyWarningScores,
  notifications,
  patients,
  unitStaff,
  vitalSigns,
} from '../src/db/schema.js';
import {
  ageBandFor,
  ageInMonths,
  isChild,
  pewsConsciousnessPoints,
  pewsObservationIntervalMinutes,
  pewsPulsePoints,
  pewsRespirationPoints,
  pewsSpo2Points,
  pewsSystolicPoints,
  pewsTemperaturePoints,
  scorePews,
  type PewsAgeBand,
} from '../src/modules/news/pews.js';
import { scoreNewVitalsOnce, setSpo2Scale } from '../src/modules/news/news.service.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

const cases = (fn: (v: number) => number, table: [number, number][]) =>
  table.forEach(([v, points]) => expect(fn(v), `value ${v}`).toBe(points));

/** Date of birth `months` months before now (UTC, ISO date). */
const bornMonthsAgo = (months: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

describe('PEWS age bands', () => {
  it('maps age in months to the four bands', () => {
    expect(ageBandFor(0)).toBe('INFANT');
    expect(ageBandFor(11)).toBe('INFANT');
    expect(ageBandFor(12)).toBe('TODDLER');
    expect(ageBandFor(59)).toBe('TODDLER');
    expect(ageBandFor(60)).toBe('CHILD');
    expect(ageBandFor(143)).toBe('CHILD');
    expect(ageBandFor(144)).toBe('ADOLESCENT');
    expect(ageBandFor(215)).toBe('ADOLESCENT');
  });

  it('counts whole months at the time of the observation; under 18 is a child', () => {
    const at = new Date('2026-06-15T10:00:00Z');
    expect(ageInMonths('2026-03-15', at)).toBe(3);
    expect(ageInMonths('2026-03-16', at)).toBe(2);
    expect(isChild('2008-06-16', at)).toBe(true); // 17 years 11 months
    expect(isChild('2008-06-15', at)).toBe(false); // 18th birthday
  });
});

describe('PEWS band boundaries (illustrative chart)', () => {
  const rr: Record<PewsAgeBand, [number, number][]> = {
    INFANT: [
      [19, 3],
      [20, 2],
      [24, 2],
      [25, 1],
      [29, 1],
      [30, 0],
      [50, 0],
      [51, 1],
      [60, 1],
      [61, 2],
      [70, 2],
      [71, 3],
    ],
    TODDLER: [
      [11, 3],
      [12, 2],
      [16, 1],
      [20, 0],
      [40, 0],
      [41, 1],
      [51, 2],
      [61, 3],
    ],
    CHILD: [
      [9, 3],
      [10, 2],
      [12, 1],
      [15, 0],
      [30, 0],
      [31, 1],
      [41, 2],
      [51, 3],
    ],
    ADOLESCENT: [
      [7, 3],
      [8, 2],
      [10, 1],
      [12, 0],
      [25, 0],
      [26, 1],
      [31, 2],
      [41, 3],
    ],
  };
  const hr: Record<PewsAgeBand, [number, number][]> = {
    INFANT: [
      [89, 3],
      [90, 2],
      [99, 2],
      [100, 1],
      [109, 1],
      [110, 0],
      [160, 0],
      [161, 1],
      [170, 1],
      [171, 2],
      [180, 2],
      [181, 3],
    ],
    TODDLER: [
      [69, 3],
      [70, 2],
      [80, 1],
      [90, 0],
      [140, 0],
      [141, 1],
      [151, 2],
      [170, 2],
      [171, 3],
    ],
    CHILD: [
      [54, 3],
      [55, 2],
      [65, 1],
      [75, 0],
      [120, 0],
      [121, 1],
      [131, 2],
      [151, 3],
    ],
    ADOLESCENT: [
      [44, 3],
      [45, 2],
      [50, 1],
      [60, 0],
      [100, 0],
      [101, 1],
      [111, 2],
      [130, 2],
      [131, 3],
    ],
  };
  const sbp: Record<PewsAgeBand, [number, number][]> = {
    INFANT: [
      [49, 3],
      [50, 2],
      [60, 1],
      [70, 0],
      [100, 0],
      [101, 1],
      [111, 2],
      [200, 2],
    ],
    TODDLER: [
      [59, 3],
      [60, 2],
      [70, 1],
      [80, 0],
      [110, 0],
      [111, 1],
      [121, 2],
    ],
    CHILD: [
      [69, 3],
      [70, 2],
      [80, 1],
      [90, 0],
      [120, 0],
      [121, 1],
      [131, 2],
    ],
    ADOLESCENT: [
      [79, 3],
      [80, 2],
      [90, 1],
      [100, 0],
      [130, 0],
      [131, 1],
      [141, 2],
      [220, 2],
    ],
  };
  for (const band of ['INFANT', 'TODDLER', 'CHILD', 'ADOLESCENT'] as const) {
    it(`respiration rate – ${band}`, () => cases((v) => pewsRespirationPoints(v, band), rr[band]));
    it(`heart rate – ${band}`, () => cases((v) => pewsPulsePoints(v, band), hr[band]));
    it(`systolic – ${band}`, () => cases((v) => pewsSystolicPoints(v, band), sbp[band]));
  }

  it('SpO2 (all ages)', () =>
    cases(pewsSpo2Points, [
      [89, 3],
      [90, 2],
      [91, 2],
      [92, 1],
      [94, 1],
      [95, 0],
      [100, 0],
    ]));

  it('consciousness (ACVPU)', () => {
    expect(pewsConsciousnessPoints('A')).toBe(0);
    expect(pewsConsciousnessPoints('C')).toBe(2);
    expect(pewsConsciousnessPoints('V')).toBe(2);
    expect(pewsConsciousnessPoints('P')).toBe(3);
    expect(pewsConsciousnessPoints('U')).toBe(3);
  });

  it('temperature, with fever in an infant under 3 months as a red flag', () => {
    cases(
      (v) => pewsTemperaturePoints(v, 60),
      [
        [35.0, 3],
        [35.1, 1],
        [36.0, 1],
        [36.1, 0],
        [37.9, 0],
        [38.0, 1],
        [38.9, 1],
        [39.0, 2],
      ],
    );
    expect(pewsTemperaturePoints(38.0, 2)).toBe(3);
    expect(pewsTemperaturePoints(38.0, 3)).toBe(1);
    expect(pewsTemperaturePoints(37.9, 1)).toBe(0);
  });
});

describe('PEWS aggregate', () => {
  const NORMAL_CHILD = {
    respiratoryRate: 22,
    oxygenSaturation: 98,
    onSupplementalOxygen: false,
    systolic: 100,
    heartRate: 95,
    consciousness: 'A',
    temperatureC: 37.0,
  };

  it('the same heart rate scores differently for a 3-month-old and a 15-year-old', () => {
    const infant = scorePews(
      { ...NORMAL_CHILD, respiratoryRate: 40, systolic: 80, heartRate: 150 },
      3,
    );
    const teen = scorePews(
      { ...NORMAL_CHILD, respiratoryRate: 16, systolic: 115, heartRate: 150 },
      180,
    );
    expect(infant.ageBand).toBe('INFANT');
    expect(infant.points.pulse).toBe(0);
    expect(teen.ageBand).toBe('ADOLESCENT');
    expect(teen.points.pulse).toBe(3);
    expect(teen.risk).toBe('LOW_MEDIUM');
  });

  it('risk: LOW, single 3, MEDIUM (4–6), HIGH (≥7), and lists what is not recorded', () => {
    const base = scorePews(NORMAL_CHILD, 96);
    expect(base).toMatchObject({ score: 0, risk: 'LOW', complete: true, ageBand: 'CHILD' });
    expect(base.notRecorded).toEqual(['capillaryRefill', 'respiratoryEffort']);
    expect(scorePews({ ...NORMAL_CHILD, heartRate: 125 }, 96)).toMatchObject({
      score: 1,
      risk: 'LOW',
    });
    expect(scorePews({ ...NORMAL_CHILD, consciousness: 'P' }, 96)).toMatchObject({
      score: 3,
      risk: 'LOW_MEDIUM',
    });
    expect(
      scorePews(
        { ...NORMAL_CHILD, onSupplementalOxygen: true, oxygenSaturation: 94, heartRate: 125 },
        96,
      ),
    ).toMatchObject({ score: 4, risk: 'MEDIUM' });
    expect(
      scorePews(
        {
          ...NORMAL_CHILD,
          respiratoryRate: 45,
          oxygenSaturation: 91,
          heartRate: 140,
          temperatureC: 39.2,
        },
        96,
      ),
    ).toMatchObject({ score: 8, risk: 'HIGH' });
    expect(scorePews({ heartRate: 95 }, 96)).toMatchObject({ complete: false, score: 0 });
  });

  it('observation frequency', () => {
    expect(pewsObservationIntervalMinutes(0, 'LOW')).toBe(240);
    expect(pewsObservationIntervalMinutes(2, 'LOW')).toBe(120);
    expect(pewsObservationIntervalMinutes(3, 'LOW_MEDIUM')).toBe(60);
    expect(pewsObservationIntervalMinutes(5, 'MEDIUM')).toBe(60);
    expect(pewsObservationIntervalMinutes(8, 'HIGH')).toBe(15);
  });
});

/* ------------------------------------------------------------------ integration */

let w: Awaited<ReturnType<typeof createWorld>>;
let unit: typeof careUnits.$inferSelect;
let toddler: typeof patients.$inferSelect;
let adult: typeof patients.$inferSelect;

/** Toddler band: RR 44 (1) + HR 152 (2) + SpO2 94 (1) + 38.4 °C (1) = PEWS 5. For an adult: NEWS2 3 + 1 + 2 + 3 + 1 = 10. */
const SICK = {
  respiratoryRate: 44,
  oxygenSaturation: 94,
  onSupplementalOxygen: false,
  systolic: 95,
  heartRate: 152,
  consciousness: 'A',
  temperatureC: 38.4,
};

const escalations = (userId: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'news.escalation')));

const recordVitals = (token: string, patientId: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/patients/${patientId}/vitals`).set(bearer(token)).send(body);

const latestScore = async (patientId: string) => {
  const res = await api()
    .get(`/api/v1/early-warning/patients/${patientId}`)
    .set(bearer(w.tokens.doctor));
  return res.body.items[0];
};

beforeAll(async () => {
  w = await createWorld();
  const [created] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Pediatria T', code: 'PED-T', type: 'PAEDIATRIC' })
    .returning();
  unit = created!;
  const [b1, b2] = await db
    .insert(beds)
    .values([
      { unitId: unit.id, label: 'P1', status: 'OCCUPIED' },
      { unitId: unit.id, label: 'P2', status: 'OCCUPIED' },
    ])
    .returning();
  await db.insert(unitStaff).values({ unitId: unit.id, userId: w.users.nurse.id });
  const created2 = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  const [aged] = await db
    .update(patients)
    .set({ dateOfBirth: bornMonthsAgo(30) })
    .where(eq(patients.id, created2.id))
    .returning();
  toddler = aged!;
  adult = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  await db.insert(admissions).values([
    {
      patientId: toddler.id,
      facilityId: w.facility.id,
      unitId: unit.id,
      bedId: b1!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'EMERGENCY',
      reason: 'Bronkiolit',
    },
    {
      patientId: adult.id,
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

describe('children are scored with PEWS, adults with NEWS2', () => {
  it('a child under 18 gets a PEWS score with the age band; escalation titles say PEWS', async () => {
    const res = await recordVitals(w.tokens.nurse, toddler.id, SICK);
    expect(res.status).toBe(201);
    expect(res.body.news).toMatchObject({ score: 5, risk: 'MEDIUM' });
    const latest = await latestScore(toddler.id);
    expect(latest).toMatchObject({ scale: 'PEWS', score: 5, risk: 'MEDIUM' });
    expect(latest.components).toMatchObject({
      scale: 'PEWS',
      ageBand: 'TODDLER',
      pulse: 2,
      respiration: 1,
      notRecorded: ['capillaryRefill', 'respiratoryEffort'],
    });
    const doc = await escalations(w.users.doctor.id);
    expect(doc).toHaveLength(1);
    expect(doc[0]!.title).toBe('PEWS 5: urgent review needed – Pediatria T, bed P1');
    expect(doc[0]!.title).not.toContain(toddler.lastName);
    expect(await escalations(w.users.nurse.id)).toHaveLength(1);
  });

  it('the same observations in an adult are scored with NEWS2', async () => {
    const res = await recordVitals(w.tokens.nurse, adult.id, SICK);
    expect(res.body.news).toMatchObject({ score: 10, risk: 'HIGH' });
    const latest = await latestScore(adult.id);
    expect(latest).toMatchObject({ scale: 'NEWS2', score: 10, risk: 'HIGH' });
    expect(latest.components.ageBand).toBeUndefined();
    const doc = await escalations(w.users.doctor.id);
    expect(
      doc.some((n) => n.title === 'NEWS2 10: emergency assessment – Pediatria T, bed P2'),
    ).toBe(true);
  });

  it('the worker scores a child’s vitals recorded elsewhere with PEWS', async () => {
    const infant = await createPatient(w.facility.id);
    await db
      .update(patients)
      .set({ dateOfBirth: bornMonthsAgo(3) })
      .where(eq(patients.id, infant.id));
    const [v] = await db
      .insert(vitalSigns)
      .values({
        patientId: infant.id,
        recordedById: w.users.nurse.id,
        ...SICK,
        respiratoryRate: 40,
        systolic: 80,
        heartRate: 150,
        temperatureC: '37.0',
      })
      .returning();
    await scoreNewVitalsOnce();
    const [row] = await db
      .select()
      .from(earlyWarningScores)
      .where(eq(earlyWarningScores.vitalSignId, v!.id));
    expect(row).toMatchObject({ scale: 'PEWS', score: 1, risk: 'LOW', admissionId: null });
    expect(row!.components).toMatchObject({ ageBand: 'INFANT', pulse: 0 });
  });

  it('the SpO2 scale (a NEWS2 concept) does not re-score a child', async () => {
    const before = await latestScore(toddler.id);
    const after = await setSpo2Scale(toddler.id, 2, w.users.doctor.id);
    expect(after).toMatchObject({ id: before.id, scale: 'PEWS', score: before.score });
  });
});

describe('board', () => {
  it('shows the scale of every score and the PEWS observation interval', async () => {
    const board = await api()
      .get(`/api/v1/early-warning/board?unitId=${unit.id}`)
      .set(bearer(w.tokens.nurse));
    expect(board.status).toBe(200);
    type Item = {
      patientId: string;
      latest: Record<string, unknown>;
      trend: Record<string, unknown>[];
      observationIntervalMinutes: number;
    };
    const items = board.body.items as Item[];
    const byPatient = new Map(items.map((i) => [i.patientId, i]));
    const child = byPatient.get(toddler.id)!;
    expect(child.latest).toMatchObject({ scale: 'PEWS', score: 5, risk: 'MEDIUM' });
    expect(child.trend[0]).toMatchObject({ scale: 'PEWS', score: 5 });
    expect(child.observationIntervalMinutes).toBe(60);
    const grown = byPatient.get(adult.id)!;
    expect(grown.latest).toMatchObject({ scale: 'NEWS2', score: 10 });
    expect(grown.observationIntervalMinutes).toBe(15);
    // Highest risk first regardless of scale.
    expect(board.body.items[0].patientId).toBe(adult.id);
  });
});

// Leave no open escalations behind: re-escalation scans every admitted patient of the database.
afterAll(async () => {
  await db
    .update(earlyWarningScores)
    .set({ acknowledgedAt: new Date(), acknowledgedById: w.users.doctor.id })
    .where(inArray(earlyWarningScores.patientId, [toddler.id, adult.id]));
});
