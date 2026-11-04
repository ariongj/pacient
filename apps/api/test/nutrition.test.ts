import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  allergies,
  beds,
  careUnits,
  notifications,
  patients,
  surgicalCases,
  unitStaff,
} from '../src/db/schema.js';
import { npoAt, scoreScreening } from '../src/modules/nutrition/nutrition.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let ward: string;
let kitchenUnit: string;
let admissionId: string;
let wardNurse: string;
let kitchen: string;

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Interna A', code: 'INT-A', type: 'GENERAL_WARD' })
    .returning();
  ward = unit!.id;
  const [k] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Kitchen', code: 'KITCHEN', type: 'NUTRITION' })
    .returning();
  kitchenUnit = k!.id;
  const [bed] = await db.insert(beds).values({ unitId: ward, label: 'A1', status: 'OCCUPIED' }).returning();
  const [adm] = await db
    .insert(admissions)
    .values({
      patientId: w.patient.id,
      facilityId: w.facility.id,
      unitId: ward,
      bedId: bed!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'ELECTIVE',
      reason: 'Observation',
      admittedAt: new Date(Date.now() - 3 * 86_400_000),
    })
    .returning();
  admissionId = adm!.id;
  const nurse = await createUser('NURSE', w.facility.id);
  await db.insert(unitStaff).values({ unitId: ward, userId: nurse.id });
  wardNurse = await login(nurse.email);
  const cook = await createUser('NURSE', w.facility.id);
  await db.insert(unitStaff).values({ unitId: kitchenUnit, userId: cook.id });
  kitchen = await login(cook.email);
  await db.insert(allergies).values([
    {
      patientId: w.patient.id,
      substance: 'Peanuts',
      severity: 'SEVERE',
      verificationStatus: 'CONFIRMED',
      recordedById: w.users.doctor.id,
    },
    {
      patientId: w.patient.id,
      substance: 'Penicillin',
      severity: 'MODERATE',
      verificationStatus: 'CONFIRMED',
      recordedById: w.users.doctor.id,
    },
  ]);
});

const order = (body: Record<string, unknown>, token = w.tokens.doctor, id = admissionId) =>
  api().post(`/api/v1/nutrition/admissions/${id}/diet`).set(bearer(token)).send(body);

describe('diet orders', () => {
  it('lets the care team order a diet and keeps the history', async () => {
    const first = await order({ dietType: 'DIABETIC', restrictions: ['no added sugar'] });
    expect(first.status).toBe(201);
    const second = await order({ dietType: 'SOFT', reason: 'Dental pain' }, wardNurse);
    expect(second.status).toBe(201);
    const view = await api()
      .get(`/api/v1/nutrition/patients/${w.patient.id}`)
      .set(bearer(w.tokens.doctor));
    expect(view.status).toBe(200);
    expect(view.body.current.dietType).toBe('SOFT');
    expect(view.body.history).toHaveLength(2);
    expect(view.body.history.find((h: { dietType: string }) => h.dietType === 'DIABETIC').endsAt).toBeTruthy();
    expect(view.body.foodAllergies).toEqual(['peanuts']);
  });

  it('refuses people outside the care team and patients who are not admitted', async () => {
    expect((await order({ dietType: 'NORMAL' }, w.tokens.outsideDoctor)).status).toBe(403);
    expect((await order({ dietType: 'NORMAL' }, w.tokens.reception)).status).toBe(403);
    expect((await order({ dietType: 'NORMAL' }, kitchen)).status).toBe(403);
    const other = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const [past] = await db
      .insert(admissions)
      .values({
        patientId: other.id,
        facilityId: w.facility.id,
        unitId: ward,
        admittingDoctorId: w.users.doctor.id,
        attendingDoctorId: w.users.doctor.id,
        source: 'ELECTIVE',
        reason: 'Old stay',
        status: 'DISCHARGED',
        dischargedAt: new Date(),
        disposition: 'HOME',
      })
      .returning();
    expect((await order({ dietType: 'NORMAL' }, w.tokens.doctor, past!.id)).status).toBe(409);
  });
});

describe('kitchen list', () => {
  it('shows ward, bed, diet and food allergies – but no other allergies – to the kitchen', async () => {
    const res = await api().get('/api/v1/nutrition/kitchen?meal=LUNCH').set(bearer(kitchen));
    expect(res.status).toBe(200);
    const line = res.body.wards
      .flatMap((x: { patients: unknown[] }) => x.patients)
      .find((p: { patientId: string }) => p.patientId === w.patient.id);
    expect(line).toMatchObject({ bedLabel: 'A1', dietType: 'SOFT', foodAllergies: ['peanuts'] });
    expect(JSON.stringify(res.body)).not.toMatch(/Penicillin|Observation|Dental pain/);
    expect(res.body.totals.SOFT).toBeGreaterThanOrEqual(1);
  });

  it('gives kitchen staff no access to the clinical record', async () => {
    const res = await api().get(`/api/v1/patients/${w.patient.id}/summary`).set(bearer(kitchen));
    expect(res.status).toBe(403);
    const nutrition = await api()
      .get(`/api/v1/nutrition/patients/${w.patient.id}`)
      .set(bearer(kitchen));
    expect(nutrition.status).toBe(403);
  });

  it('is not available to staff without a ward or kitchen assignment', async () => {
    expect((await api().get('/api/v1/nutrition/kitchen').set(bearer(w.tokens.nurse))).status).toBe(403);
    expect((await api().get('/api/v1/nutrition/kitchen').set(bearer(w.tokens.reception))).status).toBe(
      403,
    );
    expect(
      (await api().get(`/api/v1/nutrition/wards/${ward}`).set(bearer(w.tokens.nurse))).status,
    ).toBe(403);
    expect((await api().get(`/api/v1/nutrition/wards/${ward}`).set(bearer(wardNurse))).status).toBe(200);
  });
});

describe('nil by mouth before surgery', () => {
  it('computes the fasting window from a scheduled operation', () => {
    const start = new Date('2026-11-10T10:00:00Z');
    const cases = [
      {
        id: 'c1',
        patientId: 'p',
        procedure: 'Hernia repair',
        status: 'SCHEDULED',
        scheduledStart: start,
        estimatedMinutes: 60,
      },
    ];
    expect(npoAt(cases, new Date('2026-11-10T03:00:00Z'))).toBeNull();
    expect(npoAt(cases, new Date('2026-11-10T05:00:00Z'))?.level).toBe('SOLIDS');
    expect(npoAt(cases, new Date('2026-11-10T08:30:00Z'))?.level).toBe('FULL');
    expect(npoAt(cases, new Date('2026-11-10T05:00:00Z'), new Set(['c1']))).toBeNull();
    expect(npoAt([{ ...cases[0]!, status: 'IN_THEATRE' }], new Date('2026-11-09T05:00:00Z'))?.level).toBe(
      'FULL',
    );
  });

  it('puts the patient on NPO in the kitchen list and resumes the diet after the operation', async () => {
    // Operation tomorrow at 13:00 local – lunch (12:30) falls inside the 2-hour no-fluids window.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const [c] = await db
      .insert(surgicalCases)
      .values({
        patientId: w.patient.id,
        facilityId: w.facility.id,
        procedure: 'Laparoscopic cholecystectomy',
        laterality: 'NOT_APPLICABLE',
        indication: 'Gallstones',
        primarySurgeonId: w.users.doctor.id,
        status: 'SCHEDULED',
        theatreUnitId: ward,
        scheduledStart: new Date(`${tomorrow}T12:00:00Z`),
        createdById: w.users.doctor.id,
      })
      .returning();
    const lunch = await api()
      .get(`/api/v1/nutrition/kitchen?meal=LUNCH&date=${tomorrow}`)
      .set(bearer(kitchen));
    const line = lunch.body.wards
      .flatMap((x: { patients: unknown[] }) => x.patients)
      .find((p: { patientId: string }) => p.patientId === w.patient.id);
    expect(line.dietType).toBe('NIL_BY_MOUTH');
    expect(line.npo.level).toBe('FULL');
    expect(JSON.stringify(lunch.body)).not.toContain('Gallstones');

    await db.update(surgicalCases).set({ status: 'COMPLETED' }).where(eq(surgicalCases.id, c!.id));
    const after = await api()
      .get(`/api/v1/nutrition/kitchen?meal=LUNCH&date=${tomorrow}`)
      .set(bearer(kitchen));
    const resumed = after.body.wards
      .flatMap((x: { patients: unknown[] }) => x.patients)
      .find((p: { patientId: string }) => p.patientId === w.patient.id);
    expect(resumed.dietType).toBe('SOFT');
    expect(resumed.npo).toBeNull();
  });
});

describe('screening', () => {
  it('scores NRS-2002 and STRONGkids', () => {
    expect(scoreScreening('NRS2002', { nutritionalStatus: 1, diseaseSeverity: 1 }, 72)).toMatchObject({
      score: 3,
      risk: 'HIGH',
    });
    expect(scoreScreening('NRS2002', { nutritionalStatus: 1, diseaseSeverity: 1 }, 50).risk).toBe('LOW');
    expect(
      scoreScreening(
        'NRS2002',
        {
          initial: {
            bmiBelow20_5: false,
            weightLoss3Months: false,
            reducedIntakeLastWeek: false,
            severelyIll: false,
          },
          nutritionalStatus: 3,
          diseaseSeverity: 3,
        },
        40,
      ).score,
    ).toBe(0);
    const kids = (a: Record<string, boolean>) =>
      scoreScreening(
        'STRONGKIDS',
        { poorNutritionalStatus: false, highRiskDisease: false, intakeOrLosses: false, weightLoss: false, ...a },
        6,
      );
    expect(kids({}).risk).toBe('LOW');
    expect(kids({ highRiskDisease: true }).risk).toBe('MEDIUM');
    expect(kids({ highRiskDisease: true, intakeOrLosses: true, weightLoss: true })).toMatchObject({
      score: 4,
      risk: 'HIGH',
    });
    expect(() => scoreScreening('STRONGKIDS', {}, 40)).toThrow();
    expect(() => scoreScreening('NRS2002', { nutritionalStatus: 4, diseaseSeverity: 0 }, 40)).toThrow();
  });

  it('lists admissions due for screening and clears them once screened; HIGH risk alerts the doctor', async () => {
    const due = await api().get('/api/v1/nutrition/screening-due').set(bearer(wardNurse));
    expect(due.status).toBe(200);
    const mine = due.body.items.find((i: { patientId: string }) => i.patientId === w.patient.id);
    expect(mine.screeningState).toBe('OVERDUE');

    // The patient is 36: age adds nothing, 2 + 1 = 3 → at risk.
    await db.update(patients).set({ dateOfBirth: '1990-01-01' }).where(eq(patients.id, w.patient.id));
    const res = await api()
      .post(`/api/v1/nutrition/patients/${w.patient.id}/screenings`)
      .set(bearer(wardNurse))
      .send({ tool: 'NRS2002', answers: { nutritionalStatus: 2, diseaseSeverity: 1 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ score: 3, risk: 'HIGH' });
    const alerts = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.doctor.id));
    expect(alerts.some((n) => n.title.includes('Nutrition risk'))).toBe(true);

    const after = await api().get('/api/v1/nutrition/screening-due').set(bearer(wardNurse));
    expect(after.body.items.some((i: { patientId: string }) => i.patientId === w.patient.id)).toBe(false);

    const wrongTool = await api()
      .post(`/api/v1/nutrition/patients/${w.patient.id}/screenings`)
      .set(bearer(wardNurse))
      .send({ tool: 'STRONGKIDS', answers: {} });
    expect(wrongTool.status).toBe(400);
    const kitchenTry = await api()
      .post(`/api/v1/nutrition/patients/${w.patient.id}/screenings`)
      .set(bearer(kitchen))
      .send({ tool: 'NRS2002', answers: { nutritionalStatus: 0, diseaseSeverity: 0 } });
    expect(kitchenTry.status).toBe(403);
  });

  it('shows the patient their diet without screenings or notes', async () => {
    const res = await api()
      .get(`/api/v1/nutrition/patients/${w.patient.id}`)
      .set(bearer(w.tokens.patient));
    expect(res.status).toBe(200);
    expect(res.body.screenings).toEqual([]);
    expect(JSON.stringify(res.body.history)).not.toContain('Dental pain');
  });
});
