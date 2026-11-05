import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  doseRules,
  medicationCatalog,
  patients,
  prescriptionAlerts,
  vitalSigns,
} from '../src/db/schema.js';
import { seedDoseRules } from '../src/db/seed-dosing.js';
import {
  ageGroupOf,
  doseText,
  formatQuantity,
  ingredientDoses,
  normaliseRoute,
  parseStrength,
  timesPerDay,
} from '../src/modules/safety/dosing.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const catalog: Record<string, string> = {};

async function catalogItem(
  key: string,
  values: { name: string; form: string; strength: string; unit: string; ingredients: string[] },
) {
  const [row] = await db
    .insert(medicationCatalog)
    .values({ ...values, name: `${values.name} (dosing test)` })
    .returning({ id: medicationCatalog.id });
  catalog[key] = row!.id;
}

beforeAll(async () => {
  w = await createWorld();
  await seedDoseRules();
  await catalogItem('paracetamolTab', {
    name: 'Paracetamol',
    form: 'tablet',
    strength: '500 mg',
    unit: 'tablet',
    ingredients: ['paracetamol'],
  });
  await catalogItem('paracetamolIv', {
    name: 'Paracetamol',
    form: 'solution for infusion',
    strength: '10 mg/ml',
    unit: 'bottle 100 ml',
    ingredients: ['paracetamol'],
  });
  await catalogItem('coAmoxiclav', {
    name: 'Amoxicillin/clavulanic acid',
    form: 'tablet',
    strength: '875/125 mg',
    unit: 'tablet',
    ingredients: ['amoxicillin', 'clavulanic acid'],
  });
});

type Alert = {
  code: string;
  kind: string;
  severity: string;
  blocking: boolean;
  message: string;
  management: string;
};

const isoYearsAgo = (years: number, days = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** A fresh patient of the doctor's, optionally with an age and a recorded weight. */
async function patient(opts: { dob?: string; weightKg?: number; weightDaysAgo?: number } = {}) {
  const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  if (opts.dob) {
    await db.update(patients).set({ dateOfBirth: opts.dob }).where(eq(patients.id, p.id));
  }
  if (opts.weightKg) {
    await db.insert(vitalSigns).values({
      patientId: p.id,
      recordedById: w.users.nurse.id,
      weightKg: String(opts.weightKg),
      recordedAt: new Date(Date.now() - (opts.weightDaysAgo ?? 1) * 86_400_000),
    });
  }
  return p.id;
}

interface Dose {
  doseAmount: number;
  doseUnit: string;
  frequencyCode: string;
  maxDosesPer24h?: number;
  durationDays?: number;
  asNeeded?: boolean;
  route?: string;
}

async function check(
  patientId: string,
  medication: string,
  dose: Dose | null,
  catalogItemId?: string,
) {
  const res = await api()
    .post('/api/v1/safety/check')
    .set(bearer(w.tokens.doctor))
    .send({ patientId, medication, catalogItemId, dose });
  expect(res.status).toBe(200);
  return res.body as {
    alerts: Alert[];
    patient: { ageGroup: string; weightKg: number | null } | null;
    dose: {
      ageGroup: string;
      notComputed: string | null;
      ingredients: {
        ingredient: string;
        singleDose: string | null;
        dailyDose: string | null;
        ruleAgeGroup: string | null;
        maxSingle: string | null;
        maxDaily: string | null;
        checked: boolean;
      }[];
    } | null;
    text: { dosage: string; frequency: string } | null;
  };
}
const doseAlerts = (body: { alerts: Alert[] }) => body.alerts.filter((a) => a.kind === 'DOSE');

/* ------------------------------------------------------------------ pure functions ---------- */

describe('dose arithmetic', () => {
  it('reads catalogue strengths', () => {
    expect(parseStrength('500 mg')).toEqual({
      per: 'unit',
      amounts: [{ value: 500, dim: 'mass' }],
    });
    expect(parseStrength('1 g')?.amounts[0]?.value).toBe(1000);
    expect(parseStrength('10 mg/ml')).toEqual({ per: 'ml', amounts: [{ value: 10, dim: 'mass' }] });
    expect(parseStrength('40 mg/0.4 ml')?.amounts[0]?.value).toBe(100);
    expect(parseStrength('875/125 mg')?.amounts.map((a) => a.value)).toEqual([875, 125]);
    expect(parseStrength('100 mcg/dose')).toEqual({
      per: 'unit',
      amounts: [{ value: 0.1, dim: 'mass' }],
    });
    expect(parseStrength('100 U/ml')).toEqual({
      per: 'ml',
      amounts: [{ value: 100, dim: 'units' }],
    });
    expect(parseStrength('0.9 %')).toEqual({ per: 'ml', amounts: [{ value: 9, dim: 'mass' }] });
    expect(parseStrength('as directed')).toBeNull();
  });

  it('converts doses to milligrams of each ingredient', () => {
    const tab = parseStrength('500 mg');
    expect(
      ingredientDoses({ doseAmount: 2, doseUnit: 'tablet' }, ['paracetamol'], tab, null),
    ).toEqual({ doses: [{ ingredient: 'paracetamol', single: 1000, dim: 'mass' }] });
    expect(
      ingredientDoses({ doseAmount: 1, doseUnit: 'g' }, ['paracetamol'], null, null).doses[0]
        ?.single,
    ).toBe(1000);
    expect(
      ingredientDoses({ doseAmount: 250, doseUnit: 'mcg' }, ['levothyroxine'], null, null).doses[0]
        ?.single,
    ).toBe(0.25);
    expect(
      ingredientDoses(
        { doseAmount: 15, doseUnit: 'ml' },
        ['paracetamol'],
        parseStrength('10 mg/ml'),
        null,
      ).doses[0]?.single,
    ).toBe(150);
    expect(
      ingredientDoses({ doseAmount: 15, doseUnit: 'mg/kg' }, ['paracetamol'], null, 20).doses[0]
        ?.single,
    ).toBe(300);
    // A mass dose of a combination refers to the first ingredient; the rest follow the ratio.
    expect(
      ingredientDoses(
        { doseAmount: 875, doseUnit: 'mg' },
        ['amoxicillin', 'clavulanic acid'],
        parseStrength('875/125 mg'),
        null,
      ).doses.map((d) => d.single),
    ).toEqual([875, 125]);
    expect(
      ingredientDoses({ doseAmount: 15, doseUnit: 'mg/kg' }, ['paracetamol'], null, null)
        .notComputed,
    ).toBe('NEEDS_WEIGHT');
    expect(
      ingredientDoses({ doseAmount: 5, doseUnit: 'ml' }, ['paracetamol'], tab, null).notComputed,
    ).toBe('UNIT_MISMATCH');
    expect(
      ingredientDoses({ doseAmount: 1, doseUnit: 'tablet' }, ['paracetamol'], null, null)
        .notComputed,
    ).toBe('NEEDS_STRENGTH');
  });

  it('turns frequency codes into doses per day', () => {
    expect(timesPerDay({ frequencyCode: 'QD' })).toBe(1);
    expect(timesPerDay({ frequencyCode: 'TID' })).toBe(3);
    expect(timesPerDay({ frequencyCode: 'Q4H' })).toBe(6);
    expect(timesPerDay({ frequencyCode: 'Q8H' })).toBe(3);
    expect(timesPerDay({ frequencyCode: 'QHS' })).toBe(1);
    expect(timesPerDay({ frequencyCode: 'PRN', maxDosesPer24h: 4 })).toBe(4);
    expect(timesPerDay({ frequencyCode: 'Q4H', asNeeded: true, maxDosesPer24h: 3 })).toBe(3);
    expect(timesPerDay({ frequencyCode: 'WEEKLY' })).toBeCloseTo(1 / 7);
  });

  it('works out the age group', () => {
    expect(ageGroupOf(10, 0)).toBe('NEONATE');
    expect(ageGroupOf(400, 1)).toBe('CHILD');
    expect(ageGroupOf(null, 17)).toBe('CHILD');
    expect(ageGroupOf(null, 18)).toBe('ADULT');
    expect(ageGroupOf(null, 65)).toBe('ELDERLY');
    expect(ageGroupOf(null, null)).toBe('ADULT');
  });

  it('normalises routes and formats quantities', () => {
    expect(normaliseRoute('oral')).toBe('ORAL');
    expect(normaliseRoute('PO')).toBe('ORAL');
    expect(normaliseRoute('intravenous')).toBe('IV');
    expect(normaliseRoute('')).toBe('ORAL');
    expect(formatQuantity(4000, 'mass')).toBe('4 g');
    expect(formatQuantity(1500, 'mass')).toBe('1500 mg');
    expect(formatQuantity(0.25, 'mass')).toBe('250 mcg');
  });

  it('generates the dose text in the prescriber’s language', () => {
    const dose = { doseAmount: 500, doseUnit: 'mg', frequencyCode: 'TID' } as const;
    expect(doseText('en', dose)).toEqual({ dosage: '500 mg', frequency: 'three times a day' });
    expect(doseText('sq', dose)).toEqual({ dosage: '500 mg', frequency: 'tri herë në ditë' });
    expect(doseText('sr', dose).frequency).toBe('tri puta dnevno');
    expect(
      doseText('en', { doseAmount: 2, doseUnit: 'tablet', frequencyCode: 'BID', durationDays: 5 }),
    ).toEqual({ dosage: '2 tablets', frequency: 'twice a day, for 5 days' });
    expect(
      doseText('en', { doseAmount: 400, doseUnit: 'mg', frequencyCode: 'PRN', maxDosesPer24h: 3 })
        .frequency,
    ).toBe('as needed, up to 3 times in 24 hours');
    expect(doseText('sq', { doseAmount: 2.5, doseUnit: 'mg', frequencyCode: 'QD' }).dosage).toBe(
      '2,5 mg',
    );
    expect(
      doseText('en', { doseAmount: 15, doseUnit: 'mg/kg', frequencyCode: 'Q6H' }, 20).dosage,
    ).toBe('15 mg/kg (300 mg)');
  });
});

/* ------------------------------------------------------------------ dose-range checks ------- */

describe('dose-range checks', () => {
  it('accepts a dose within the adult limits and checks every ingredient', async () => {
    const p = await patient();
    const body = await check(
      p,
      'Paracetamol 500 mg tablet',
      { doseAmount: 2, doseUnit: 'tablet', frequencyCode: 'QID' },
      catalog.paracetamolTab,
    );
    expect(doseAlerts(body)).toEqual([]);
    expect(body.dose?.ingredients[0]).toMatchObject({
      ingredient: 'paracetamol',
      singleDose: '1 g',
      dailyDose: '4 g',
      maxSingle: '1 g',
      maxDaily: '4 g',
      ruleAgeGroup: 'ADULT',
      checked: true,
    });
    expect(body.text).toEqual({ dosage: '2 tablets', frequency: 'four times a day' });
  });

  it('flags single and daily doses above the maximum, and over twice the maximum', async () => {
    const p = await patient();
    // 3 tablets × 500 mg = 1.5 g per dose, 6 g a day.
    const over = await check(
      p,
      'Paracetamol 500 mg tablet',
      { doseAmount: 3, doseUnit: 'tablet', frequencyCode: 'QID' },
      catalog.paracetamolTab,
    );
    expect(doseAlerts(over).map((a) => [a.code, a.severity, a.blocking])).toEqual([
      ['DOSE:paracetamol:single', 'MAJOR', true],
      ['DOSE:paracetamol:daily', 'MAJOR', true],
    ]);
    expect(doseAlerts(over)[0]!.message).toBe(
      'Single dose of paracetamol is 1500 mg, above the maximum of 1 g per dose.',
    );
    expect(doseAlerts(over)[1]!.message).toBe(
      'Daily dose of paracetamol is 6 g (4 × 1500 mg), above the maximum of 4 g per day.',
    );
    // A tenfold slip (10 g a day by IV, 1 g → 100 ml of 10 mg/ml given 10× as ml).
    const tenfold = await check(
      p,
      'Paracetamol infusion',
      { doseAmount: 250, doseUnit: 'ml', frequencyCode: 'QID', route: 'IV' },
      catalog.paracetamolIv,
    );
    expect(doseAlerts(tenfold).map((a) => [a.code, a.severity])).toEqual([
      ['DOSE:paracetamol:single', 'CONTRAINDICATED'],
      ['DOSE:paracetamol:daily', 'CONTRAINDICATED'],
    ]);
  });

  it('warns about an unusually low dose (decimal or unit slip) without blocking', async () => {
    const p = await patient();
    const body = await check(p, 'Paracetamol', {
      doseAmount: 50,
      doseUnit: 'mg',
      frequencyCode: 'TID',
    });
    expect(doseAlerts(body)).toMatchObject([
      { code: 'DOSE:paracetamol:low', severity: 'MINOR', blocking: false },
    ]);
    // Low-dose regimens (aspirin 100 mg once a day) are not flagged.
    const aspirin = await check(p, 'Aspirin', {
      doseAmount: 100,
      doseUnit: 'mg',
      frequencyCode: 'QD',
    });
    expect(doseAlerts(aspirin)).toEqual([]);
  });

  it('checks combination products per ingredient', async () => {
    const p = await patient();
    const ok = await check(
      p,
      'Co-amoxiclav',
      { doseAmount: 1, doseUnit: 'tablet', frequencyCode: 'BID' },
      catalog.coAmoxiclav,
    );
    expect(doseAlerts(ok)).toEqual([]);
    expect(ok.dose?.ingredients.map((i) => [i.ingredient, i.singleDose])).toEqual([
      ['amoxicillin', '875 mg'],
      ['clavulanic acid', '125 mg'],
    ]);
    const two = await check(
      p,
      'Co-amoxiclav',
      { doseAmount: 2, doseUnit: 'tablet', frequencyCode: 'TID' },
      catalog.coAmoxiclav,
    );
    expect(
      doseAlerts(two)
        .map((a) => a.code)
        .sort(),
    ).toEqual([
      'DOSE:amoxicillin:daily',
      'DOSE:amoxicillin:single',
      'DOSE:clavulanic acid:daily',
      'DOSE:clavulanic acid:single',
    ]);
  });

  it('uses mg/kg limits with the latest weight for a child, capped by the absolute maximum', async () => {
    const child = await patient({ dob: isoYearsAgo(5), weightKg: 20 });
    const ok = await check(child, 'Paracetamol', {
      doseAmount: 15,
      doseUnit: 'mg/kg',
      frequencyCode: 'Q6H',
    });
    expect(ok.patient).toMatchObject({ ageGroup: 'CHILD', weightKg: 20 });
    expect(doseAlerts(ok)).toEqual([]);
    expect(ok.dose?.ingredients[0]).toMatchObject({
      singleDose: '300 mg',
      maxSingle: '300 mg',
      maxDaily: '1200 mg',
      ruleAgeGroup: 'CHILD',
    });
    expect(ok.text?.dosage).toBe('15 mg/kg (300 mg)');

    const over = await check(child, 'Paracetamol', {
      doseAmount: 500,
      doseUnit: 'mg',
      frequencyCode: 'QID',
    });
    expect(doseAlerts(over).map((a) => [a.code, a.severity])).toEqual([
      ['DOSE:paracetamol:single', 'MAJOR'],
      ['DOSE:paracetamol:daily', 'MAJOR'],
    ]);
    expect(doseAlerts(over)[0]!.message).toBe(
      'Single dose of paracetamol is 500 mg, above the maximum of 300 mg per dose (15 mg/kg for 20 kg).',
    );

    // A heavy teenager: 60 mg/kg × 90 kg = 5.4 g, but never more than 4 g a day.
    const teen = await patient({ dob: isoYearsAgo(16), weightKg: 90 });
    const capped = await check(teen, 'Paracetamol', {
      doseAmount: 1000,
      doseUnit: 'mg',
      frequencyCode: 'Q4H',
    });
    expect(doseAlerts(capped)).toMatchObject([
      {
        code: 'DOSE:paracetamol:daily',
        severity: 'MAJOR',
        message:
          'Daily dose of paracetamol is 6 g (6 × 1 g), above the absolute maximum of 4 g per day.',
      },
    ]);
  });

  it('needs a weight for paediatric dosing', async () => {
    const child = await patient({ dob: isoYearsAgo(3) });
    const body = await check(child, 'Ibuprofen', {
      doseAmount: 100,
      doseUnit: 'mg',
      frequencyCode: 'TID',
    });
    expect(body.patient).toMatchObject({ ageGroup: 'CHILD', weightKg: null });
    expect(doseAlerts(body)).toMatchObject([
      {
        code: 'DOSE:weight',
        severity: 'MAJOR',
        blocking: true,
        message: 'No weight recorded: weight is needed for paediatric dosing of ibuprofen.',
      },
    ]);
    // An old weight in a child is flagged as possibly out of date.
    const stale = await patient({ dob: isoYearsAgo(3), weightKg: 14, weightDaysAgo: 90 });
    const s = await check(stale, 'Ibuprofen', {
      doseAmount: 100,
      doseUnit: 'mg',
      frequencyCode: 'TID',
    });
    expect(doseAlerts(s).map((a) => [a.code, a.severity])).toEqual([['DOSE:weight-date', 'MINOR']]);
  });

  it('applies adult limits to older adults without their own rule', async () => {
    const old = await patient({ dob: isoYearsAgo(78) });
    const body = await check(old, 'Paracetamol', {
      doseAmount: 1,
      doseUnit: 'g',
      frequencyCode: 'Q4H',
    });
    expect(body.dose).toMatchObject({ ageGroup: 'ELDERLY' });
    expect(body.dose?.ingredients[0]?.ruleAgeGroup).toBe('ADULT');
    expect(doseAlerts(body).map((a) => a.code)).toEqual(['DOSE:paracetamol:daily']);
    // …and their own rule where there is one (ibuprofen: 1200 mg a day over 65).
    const ibu = await check(old, 'Ibuprofen', {
      doseAmount: 400,
      doseUnit: 'mg',
      frequencyCode: 'QID',
    });
    expect(ibu.dose?.ingredients[0]?.ruleAgeGroup).toBe('ELDERLY');
    expect(doseAlerts(ibu).map((a) => a.code)).toEqual(['DOSE:ibuprofen:daily']);
  });

  it('uses the maximum doses in 24 hours for as-needed prescriptions', async () => {
    const p = await patient();
    const ok = await check(p, 'Ibuprofen', {
      doseAmount: 400,
      doseUnit: 'mg',
      frequencyCode: 'PRN',
      maxDosesPer24h: 6,
    });
    expect(doseAlerts(ok)).toEqual([]);
    const over = await check(p, 'Ibuprofen', {
      doseAmount: 400,
      doseUnit: 'mg',
      frequencyCode: 'PRN',
      maxDosesPer24h: 8,
    });
    expect(doseAlerts(over)).toMatchObject([
      {
        code: 'DOSE:ibuprofen:daily',
        message:
          'Daily dose of ibuprofen is 3200 mg (8 × 400 mg), above the maximum of 2400 mg per day.',
      },
    ]);
    // A PRN without its maximum is rejected.
    const bad = await api()
      .post('/api/v1/safety/check')
      .set(bearer(w.tokens.doctor))
      .send({
        patientId: p,
        medication: 'Ibuprofen',
        dose: { doseAmount: 400, doseUnit: 'mg', frequencyCode: 'PRN' },
      });
    expect(bad.status).toBe(400);
  });

  it('catches a weekly medicine prescribed daily', async () => {
    const p = await patient();
    const weekly = await check(p, 'Methotrexate', {
      doseAmount: 15,
      doseUnit: 'mg',
      frequencyCode: 'WEEKLY',
    });
    expect(doseAlerts(weekly)).toEqual([]);
    const daily = await check(p, 'Methotrexate', {
      doseAmount: 15,
      doseUnit: 'mg',
      frequencyCode: 'QD',
    });
    expect(doseAlerts(daily)).toMatchObject([
      { code: 'DOSE:methotrexate:daily', severity: 'CONTRAINDICATED' },
    ]);
  });

  it('translates dose alerts for the reader', async () => {
    const doctor = await createUser('DOCTOR', w.facility.id, { locale: 'sq' });
    const p = await createPatient(w.facility.id, { doctorId: doctor.id });
    const res = await api()
      .post('/api/v1/safety/check')
      .set(bearer(await login(doctor.email)))
      .send({
        patientId: p.id,
        medication: 'Paracetamol',
        dose: { doseAmount: 1500, doseUnit: 'mg', frequencyCode: 'QID' },
      });
    const single = (res.body.alerts as Alert[]).find((a) => a.code === 'DOSE:paracetamol:single');
    expect(single?.message).toBe(
      'Doza e vetme e paracetamol është 1500 mg, mbi maksimumin prej 1 g për dozë.',
    );
    expect(res.body.text.frequency).toBe('katër herë në ditë');
  });
});

/* ------------------------------------------------------------------ prescribing ------------- */

describe('structured prescribing', () => {
  const base = (id: string) => `/api/v1/patients/${id}/prescriptions`;

  it('blocks a dose above the maximum until a reason is recorded, and stores the alerts', async () => {
    const p = await patient();
    const body = {
      medication: 'Paracetamol 500 mg tablet',
      catalogItemId: catalog.paracetamolTab,
      doseAmount: 4,
      doseUnit: 'tablet',
      frequencyCode: 'QID',
      durationDays: 5,
      route: 'oral',
      startDate: '2026-11-04',
    };
    const blocked = await api().post(base(p)).set(bearer(w.tokens.doctor)).send(body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SAFETY_ALERTS');
    const codes = (blocked.body.error.details.alerts as Alert[]).map((a) => a.code);
    expect(codes).toEqual(['DOSE:paracetamol:single', 'DOSE:paracetamol:daily']);
    // 2 g per dose, 8 g a day: twice the maximum is still "major" (more than twice blocks hard).

    const overrides = codes.map((code) => ({
      code,
      reason: 'Supervised loading dose agreed with the consultant',
    }));
    const ok = await api()
      .post(base(p))
      .set(bearer(w.tokens.doctor))
      .send({ ...body, overrides });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      dosage: '4 tablets',
      frequency: 'four times a day, for 5 days',
      doseAmount: '4.000',
      doseUnit: 'tablet',
      frequencyCode: 'QID',
      durationDays: 5,
      asNeeded: false,
      endDate: '2026-11-08',
    });
    const stored = await db
      .select()
      .from(prescriptionAlerts)
      .where(eq(prescriptionAlerts.prescriptionId, ok.body.id));
    expect(stored.map((s) => [s.kind, s.overrideReason !== null])).toEqual([
      ['DOSE', true],
      ['DOSE', true],
    ]);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'medication.alert_overridden'),
          eq(auditLogs.resourceId, ok.body.id),
        ),
      );
    expect(audit).toBeDefined();

    // The chart lists the structured fields.
    const list = await api()
      .get(`/api/v1/patients/${p}/prescriptions`)
      .set(bearer(w.tokens.doctor));
    expect(list.status).toBe(200);
    const items = (list.body.items ?? list.body) as Record<string, unknown>[];
    expect(items.find((i) => i.id === ok.body.id)).toMatchObject({
      frequencyCode: 'QID',
      doseUnit: 'tablet',
    });
  });

  it('stores as-needed prescriptions with the maximum in the text', async () => {
    const p = await patient();
    const res = await api().post(base(p)).set(bearer(w.tokens.doctor)).send({
      medication: 'Ibuprofen',
      doseAmount: 400,
      doseUnit: 'mg',
      frequencyCode: 'PRN',
      maxDosesPer24h: 3,
      startDate: '2026-11-04',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      dosage: '400 mg',
      frequency: 'as needed, up to 3 times in 24 hours',
      asNeeded: true,
      frequencyCode: 'PRN',
    });
  });

  it('still accepts free-text prescriptions (no dose check) and rejects incomplete ones', async () => {
    const p = await patient();
    const legacy = await api().post(base(p)).set(bearer(w.tokens.doctor)).send({
      medication: 'Paracetamol',
      dosage: '4 g',
      frequency: 'four times daily',
      startDate: '2026-11-04',
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body).toMatchObject({ dosage: '4 g', doseAmount: null, frequencyCode: null });
    expect((legacy.body.alerts as Alert[]).filter((a) => a.kind === 'DOSE')).toEqual([]);

    const incomplete = await api().post(base(p)).set(bearer(w.tokens.doctor)).send({
      medication: 'Paracetamol',
      startDate: '2026-11-04',
    });
    expect(incomplete.status).toBe(400);
    const noFrequency = await api().post(base(p)).set(bearer(w.tokens.doctor)).send({
      medication: 'Paracetamol',
      doseAmount: 500,
      doseUnit: 'mg',
      startDate: '2026-11-04',
    });
    expect(noFrequency.status).toBe(400);
  });

  it('blocks paediatric prescribing without a weight until a reason is given', async () => {
    const child = await patient({ dob: isoYearsAgo(4) });
    const body = {
      medication: 'Amoxicillin',
      doseAmount: 250,
      doseUnit: 'mg',
      frequencyCode: 'TID',
      startDate: '2026-11-04',
    };
    const blocked = await api().post(base(child)).set(bearer(w.tokens.doctor)).send(body);
    expect(blocked.status).toBe(409);
    expect((blocked.body.error.details.alerts as Alert[]).map((a) => a.code)).toContain(
      'DOSE:weight',
    );
  });
});

/* ------------------------------------------------------------------ dose rules ------------- */

describe('dose rules database', () => {
  it('lists rules with a filter and the demo disclaimer', async () => {
    const res = await api()
      .get('/api/v1/safety/dose-rules?q=paracet&pageSize=50')
      .set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    expect(res.body.canEdit).toBe(false);
    expect(res.body.disclaimer).toBe('Demo dose limits – verify against a licensed reference');
    expect(res.body.items.length).toBeGreaterThanOrEqual(5);
    expect(
      (res.body.items as { ingredient: string }[]).every((r) => r.ingredient === 'paracetamol'),
    ).toBe(true);
    const child = await api()
      .get('/api/v1/safety/dose-rules?q=paracetamol&ageGroup=CHILD&route=oral')
      .set(bearer(w.tokens.pharmacist));
    expect(child.body.items).toMatchObject([
      { ingredient: 'paracetamol', route: 'ORAL', ageGroup: 'CHILD', perKg: true },
    ]);
  });

  it('only the Ministry edits rules; changes are audited and apply at once', async () => {
    const rule = {
      ingredient: 'Tinidazole',
      route: 'oral',
      ageGroup: 'ADULT',
      unit: 'mg',
      maxSingleDose: 2000,
      maxDailyDose: 2000,
    };
    const denied = await api()
      .post('/api/v1/safety/dose-rules')
      .set(bearer(w.tokens.doctor))
      .send(rule);
    expect(denied.status).toBe(403);

    const created = await api()
      .post('/api/v1/safety/dose-rules')
      .set(bearer(w.tokens.ministry))
      .send(rule);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ingredient: 'tinidazole', route: 'ORAL' });
    const dup = await api()
      .post('/api/v1/safety/dose-rules')
      .set(bearer(w.tokens.ministry))
      .send(rule);
    expect(dup.status).toBe(409);
    const noLimit = await api()
      .post('/api/v1/safety/dose-rules')
      .set(bearer(w.tokens.ministry))
      .send({ ingredient: 'tinidazole', route: 'IV', ageGroup: 'ADULT' });
    expect(noLimit.status).toBe(400);

    const p = await patient();
    const dose = { doseAmount: 1500, doseUnit: 'mg', frequencyCode: 'QD' };
    expect(doseAlerts(await check(p, 'Tinidazole', dose))).toEqual([]);

    const patched = await api()
      .patch(`/api/v1/safety/dose-rules/${created.body.id}`)
      .set(bearer(w.tokens.ministry))
      .send({ maxSingleDose: 1000, note: 'Ministry test note' });
    expect(patched.status).toBe(200);
    const after = doseAlerts(await check(p, 'Tinidazole', dose));
    expect(after.map((a) => a.code)).toEqual(['DOSE:tinidazole:single']);
    expect(after[0]!.management).toBe('Ministry test note');

    const forbiddenPatch = await api()
      .patch(`/api/v1/safety/dose-rules/${created.body.id}`)
      .set(bearer(w.tokens.pharmacist))
      .send({ isActive: false });
    expect(forbiddenPatch.status).toBe(403);
    const off = await api()
      .patch(`/api/v1/safety/dose-rules/${created.body.id}`)
      .set(bearer(w.tokens.ministry))
      .send({ isActive: false });
    expect(off.status).toBe(200);
    expect(doseAlerts(await check(p, 'Tinidazole', dose))).toEqual([]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'medication.dose_rules_changed'),
          eq(auditLogs.resourceId, created.body.id),
        ),
      );
    expect(audits).toHaveLength(3);
    const [row] = await db.select().from(doseRules).where(eq(doseRules.id, created.body.id));
    expect(row).toMatchObject({ maxSingleDose: '1000.000', isActive: false });
  });

  it('seeds about fifty demo rules', async () => {
    const rows = await db.select({ id: doseRules.id }).from(doseRules);
    expect(rows.length).toBeGreaterThanOrEqual(50);
  });
});
