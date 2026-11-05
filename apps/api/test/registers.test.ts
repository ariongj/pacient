import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careAssignments,
  careProcessRecords,
  diagnoses,
  guardianships,
  labResults,
  notifications,
  patients,
  registerEnrolments,
  vitalSigns,
} from '../src/db/schema.js';
import { REGISTERS, registersForIcd10 } from '../src/modules/registers/definitions.js';
import {
  ageAt,
  bpMet,
  egfrFromCreatinine,
  evaluateRegister,
  hba1cMet,
  type PatientData,
} from '../src/modules/registers/evaluate.js';
import { computeIndicators } from '../src/modules/registers/indicators.js';
import {
  backfillEnrolments,
  enrolPatient,
  loadPatientData,
  runRegisterRecallsOnce,
} from '../src/modules/registers/registers.service.js';
import { SMALL_CELL_THRESHOLD } from '../src/modules/stats/stats.service.js';
import {
  api,
  bearer,
  createFacility,
  createPatient,
  createUser,
  createWorld,
  login,
} from './helpers.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
let w: Awaited<ReturnType<typeof createWorld>>;
const base = () => `/api/v1/registers/patients/${w.patient.id}`;

async function lab(
  patientId: string,
  testName: string,
  value: string,
  unit: string,
  at: Date,
  code?: string,
) {
  await db.insert(labResults).values({
    patientId,
    orderedById: w.users.doctor.id,
    testName,
    testCode: code ?? null,
    value,
    unit,
    collectedAt: at,
  });
}
async function bp(patientId: string, systolic: number, diastolic: number, at: Date) {
  await db.insert(vitalSigns).values({
    patientId,
    systolic,
    diastolic,
    recordedById: w.users.nurse.id,
    recordedAt: at,
  });
}
const enrolments = (patientId: string) =>
  db.select().from(registerEnrolments).where(eq(registerEnrolments.patientId, patientId));

beforeAll(async () => {
  w = await createWorld();
  // The nurse works with the doctor's patient.
  await db.insert(careAssignments).values({ patientId: w.patient.id, doctorId: w.users.nurse.id });
});

/* ------------------------------------------------------------------------------- rules -- */

describe('register rules', () => {
  it('maps ICD-10 codes to registers', () => {
    expect(registersForIcd10('E11.9')).toEqual(['DIABETES']);
    expect(registersForIcd10('e10')).toEqual(['DIABETES']);
    expect(registersForIcd10('I10')).toEqual(['HYPERTENSION']);
    expect(registersForIcd10('I13.0')).toEqual(['HYPERTENSION']);
    expect(registersForIcd10('J45.9')).toEqual(['ASTHMA']);
    expect(registersForIcd10('J44.1')).toEqual(['COPD']);
    expect(registersForIcd10('N18.3')).toEqual(['CKD']);
    expect(registersForIcd10('I50.0')).toEqual(['HEART_FAILURE']);
    expect(registersForIcd10('J06.9')).toEqual([]);
    expect(registersForIcd10('E78.5')).toEqual([]);
    expect(registersForIcd10('I21.9')).toEqual([]);
  });

  it('judges targets and computes eGFR', () => {
    expect(hba1cMet('7.5', '%')).toBe(true);
    expect(hba1cMet('7,6', '%')).toBe(false);
    expect(hba1cMet('58', 'mmol/mol')).toBe(true);
    expect(hba1cMet('64', null)).toBe(false); // > 20 → IFCC
    expect(hba1cMet('pending', '%')).toBeNull();
    expect(bpMet(139, 89, 60)).toBe(true);
    expect(bpMet(140, 80, 60)).toBe(false);
    expect(bpMet(145, 85, 82)).toBe(true);
    expect(bpMet(145, 90, 82)).toBe(false);
    const e = egfrFromCreatinine(80, 50, 'MALE')!;
    expect(e).toBeGreaterThan(95);
    expect(e).toBeLessThan(110);
    expect(egfrFromCreatinine(80, 50, 'FEMALE')!).toBeLessThan(e);
    expect(egfrFromCreatinine(80, 12, 'MALE')).toBeNull();
    expect(ageAt('1946-06-15', new Date('2026-06-14T00:00:00Z'))).toBe(79);
    expect(ageAt('1946-06-15', new Date('2026-06-15T00:00:00Z'))).toBe(80);
  });

  it('works out due, due-soon and overdue per review item', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const data: PatientData = {
      dateOfBirth: '1960-01-01',
      sex: 'MALE',
      labs: [
        {
          testName: 'HbA1c',
          testCode: null,
          value: '8.4',
          unit: '%',
          collectedAt: new Date('2026-09-01T00:00:00Z'),
        },
        {
          testName: 'Hemoglobina A1c',
          testCode: '4548-4',
          value: '9.1',
          unit: '%',
          collectedAt: new Date('2026-03-01T00:00:00Z'),
        },
        // Urine creatinine must not count as kidney function (serum creatinine).
        {
          testName: 'Urine creatinine',
          testCode: null,
          value: '9',
          unit: 'mmol/L',
          collectedAt: new Date('2026-10-01T00:00:00Z'),
        },
        {
          testName: 'Creatinine',
          testCode: null,
          value: '95',
          unit: 'µmol/L',
          collectedAt: new Date('2025-12-01T00:00:00Z'),
        },
      ],
      vitals: [
        {
          systolic: 150,
          diastolic: 85,
          weightKg: '92',
          heightCm: '175',
          recordedAt: new Date('2026-04-15T00:00:00Z'),
        },
      ],
      records: [
        {
          register: 'DIABETES',
          process: 'FOOT_EXAM',
          result: 'NORMAL',
          notes: null,
          performedAt: new Date('2026-10-20T00:00:00Z'),
        },
        // Declined does not count as done.
        {
          register: 'DIABETES',
          process: 'RETINAL_SCREENING',
          result: 'DECLINED',
          notes: null,
          performedAt: new Date('2026-10-20T00:00:00Z'),
        },
        // Recorded for another register: not counted for diabetes.
        {
          register: 'HYPERTENSION',
          process: 'SMOKING_STATUS',
          result: 'NON_SMOKER',
          notes: null,
          performedAt: new Date('2026-10-20T00:00:00Z'),
        },
      ],
      immunizations: [
        { vaccine: 'Influenza (sezonale)', administeredAt: new Date('2025-10-15T00:00:00Z') },
      ],
    };
    const byCode = Object.fromEntries(
      evaluateRegister('DIABETES', new Date('2024-01-01T00:00:00Z'), data, now).map((p) => [
        p.code,
        p,
      ]),
    );
    expect(byCode.HBA1C!.state).toBe('UP_TO_DATE'); // 2 months ago, every 6 months
    expect(byCode.HBA1C!.target!.met).toBe(false);
    expect(byCode.HBA1C!.trend.map((t) => t.value)).toEqual([9.1, 8.4]);
    expect(byCode.BLOOD_PRESSURE!.state).toBe('OVERDUE'); // > 6 months ago
    expect(byCode.BLOOD_PRESSURE!.target!.met).toBe(false);
    expect(byCode.CREATININE!.state).toBe('DUE_SOON'); // due 2026-12-01
    expect(byCode.CREATININE!.last!.detail).toMatch(/^eGFR ≈ \d+/);
    expect(byCode.WEIGHT!.last!.detail).toBe('BMI 30');
    expect(byCode.FOOT_EXAM!.state).toBe('UP_TO_DATE');
    expect(byCode.RETINAL_SCREENING!.state).toBe('OVERDUE');
    expect(byCode.SMOKING_STATUS!.state).toBe('OVERDUE');
    expect(byCode.INFLUENZA_VACCINATION!.state).toBe('OVERDUE');
    expect(byCode.URINE_ACR!.last).toBeNull();

    // A new member has a grace period before never-done items become overdue.
    const fresh = evaluateRegister(
      'ASTHMA',
      new Date('2026-10-01T00:00:00Z'),
      { ...data, records: [] },
      now,
    );
    expect(fresh.find((p) => p.code === 'ACTION_PLAN')!.state).toBe('DUE');
  });
});

/* -------------------------------------------------------------------------- enrolment -- */

describe('enrolment', () => {
  const diagnose = (icd10Code: string, status?: string) =>
    api()
      .post(`/api/v1/patients/${w.patient.id}/diagnoses`)
      .set(bearer(w.tokens.doctor))
      .send({ icd10Code, description: `Diagnosis ${icd10Code}`, ...(status ? { status } : {}) });

  it('enrols from a matching diagnosis, once, and ignores other codes', async () => {
    expect((await diagnose('J06.9')).status).toBe(201);
    expect(await enrolments(w.patient.id)).toHaveLength(0);
    expect((await diagnose('E11.9', 'CHRONIC')).status).toBe(201);
    expect((await diagnose('E11.65')).status).toBe(201);
    expect((await diagnose('I10', 'CHRONIC')).status).toBe(201);
    expect((await diagnose('J45.9', 'RESOLVED')).status).toBe(201);
    const rows = await enrolments(w.patient.id);
    expect(rows.map((r) => r.register).sort()).toEqual(['DIABETES', 'HYPERTENSION']);
    expect(rows.every((r) => r.source === 'DIAGNOSIS' && r.status === 'ACTIVE')).toBe(true);
    expect(rows[0]!.facilityId).toBe(w.facility.id);
    const audited = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'register.enrolled')));
    expect(audited).toHaveLength(2);
  });

  it('backfills from diagnoses recorded elsewhere and skips merged records', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const merged = await createPatient(w.facility.id);
    await db
      .update(patients)
      .set({ mergedIntoId: p.id, mergedAt: new Date() })
      .where(eq(patients.id, merged.id));
    for (const patientId of [p.id, merged.id]) {
      await db.insert(diagnoses).values({
        patientId,
        doctorId: w.users.doctor.id,
        icd10Code: 'N18.3',
        description: 'CKD stage 3',
        status: 'CHRONIC',
      });
    }
    expect(await backfillEnrolments()).toBeGreaterThanOrEqual(1);
    expect((await enrolments(p.id)).map((r) => r.register)).toEqual(['CKD']);
    expect(await enrolments(merged.id)).toHaveLength(0);
    // Running again changes nothing.
    await backfillEnrolments();
    expect(await enrolments(p.id)).toHaveLength(1);
  });

  it('lets doctors add and remove patients by hand', async () => {
    const add = (token: string, register = 'ASTHMA') =>
      api()
        .post(`${base()}/enrolments`)
        .set(bearer(token))
        .send({ register, reason: 'Spirometry confirmed' });
    expect((await add(w.tokens.nurse)).status).toBe(403);
    expect((await add(w.tokens.outsideDoctor)).status).toBe(403);
    const created = await add(w.tokens.doctor);
    expect(created.status).toBe(201);
    expect(created.body.source).toBe('MANUAL');
    expect((await add(w.tokens.doctor)).status).toBe(409);
    expect((await add(w.tokens.doctor, 'GOUT')).status).toBe(400);

    const leave = (token: string, reason = 'Diagnosis revised after review') =>
      api()
        .post(`/api/v1/registers/enrolments/${created.body.id}/leave`)
        .set(bearer(token))
        .send({ reason });
    expect((await leave(w.tokens.nurse)).status).toBe(403);
    expect((await leave(w.tokens.doctor, 'x')).status).toBe(400);
    const left = await leave(w.tokens.doctor);
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({
      status: 'LEFT',
      leftReason: 'Diagnosis revised after review',
    });
    expect((await leave(w.tokens.doctor)).status).toBe(409);
    // Leaving keeps the history, and the patient can join again later.
    expect((await add(w.tokens.doctor)).status).toBe(201);
    const asthma = (await enrolments(w.patient.id)).filter((r) => r.register === 'ASTHMA');
    expect(asthma.map((r) => r.status).sort()).toEqual(['ACTIVE', 'LEFT']);
  });
});

/* ------------------------------------------------------------------------ patient view -- */

describe('patient view and review items', () => {
  beforeAll(async () => {
    await lab(w.patient.id, 'HbA1c', '6.9', '%', daysAgo(20));
    await lab(w.patient.id, 'HbA1c', '8.2', '%', daysAgo(200));
    await bp(w.patient.id, 132, 84, daysAgo(10));
  });

  it('shows each register with the state of every review item', async () => {
    const res = await api().get(base()).set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const diabetes = res.body.registers.find(
      (r: { register: string }) => r.register === 'DIABETES',
    );
    expect(diabetes.label).toBe('Diabetes');
    const hba1c = diabetes.processes.find((p: { code: string }) => p.code === 'HBA1C');
    expect(hba1c).toMatchObject({ state: 'UP_TO_DATE', target: { met: true } });
    expect(hba1c.last.display).toBe('6.9 %');
    expect(hba1c.trend).toHaveLength(2);
    const bpItem = diabetes.processes.find((p: { code: string }) => p.code === 'BLOOD_PRESSURE');
    expect(bpItem).toMatchObject({ state: 'UP_TO_DATE', target: { met: true } });
    expect(diabetes.processes.find((p: { code: string }) => p.code === 'FOOT_EXAM').state).toBe(
      'DUE',
    );
    expect(res.body.canEnrol).toBe(true);
    expect(res.body.history.some((h: { register: string }) => h.register === 'ASTHMA')).toBe(true);
    // The view is recorded in the patient's access log.
    const viewed = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'patient.record_viewed')),
      );
    expect(viewed.some((v) => (v.metadata as { section?: string })?.section === 'registers')).toBe(
      true,
    );
  });

  it('suggests registers for diagnoses the patient is not in', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await db.insert(diagnoses).values({
      patientId: p.id,
      doctorId: w.users.doctor.id,
      icd10Code: 'J44.1',
      description: 'COPD',
      status: 'CHRONIC',
    });
    const res = await api().get(`/api/v1/registers/patients/${p.id}`).set(bearer(w.tokens.doctor));
    expect(res.body.registers).toHaveLength(0);
    expect(res.body.suggested).toEqual([
      { register: 'COPD', label: 'COPD', diagnosis: 'J44.1 COPD' },
    ]);
  });

  it('records review items with allowed results only', async () => {
    const record = (token: string, body: Record<string, unknown>) =>
      api().post(`${base()}/care-processes`).set(bearer(token)).send(body);
    const ok = await record(w.tokens.nurse, {
      register: 'DIABETES',
      process: 'FOOT_EXAM',
      result: 'NORMAL',
      notes: 'Monofilament normal both feet',
    });
    expect(ok.status).toBe(201);
    expect(
      (
        await record(w.tokens.nurse, {
          register: 'DIABETES',
          process: 'FOOT_EXAM',
          result: 'GREAT',
        })
      ).status,
    ).toBe(400);
    // HbA1c comes from the laboratory, not by hand.
    expect(
      (await record(w.tokens.doctor, { register: 'DIABETES', process: 'HBA1C', result: 'DONE' }))
        .status,
    ).toBe(400);
    expect(
      (await record(w.tokens.doctor, { register: 'COPD', process: 'SPIROMETRY', result: 'NORMAL' }))
        .status,
    ).toBe(409);
    expect(
      (
        await record(w.tokens.doctor, {
          register: 'DIABETES',
          process: 'RETINAL_SCREENING',
          result: 'NORMAL',
          performedAt: new Date(Date.now() + 2 * DAY).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await record(w.tokens.reception, {
          register: 'DIABETES',
          process: 'FOOT_EXAM',
          result: 'NORMAL',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await record(w.tokens.outsideDoctor, {
          register: 'DIABETES',
          process: 'FOOT_EXAM',
          result: 'NORMAL',
        })
      ).status,
    ).toBe(403);

    const res = await api().get(base()).set(bearer(w.tokens.nurse));
    const diabetes = res.body.registers.find(
      (r: { register: string }) => r.register === 'DIABETES',
    );
    const foot = diabetes.processes.find((p: { code: string }) => p.code === 'FOOT_EXAM');
    expect(foot).toMatchObject({
      state: 'UP_TO_DATE',
      last: { display: 'NORMAL', detail: 'Monofilament normal both feet' },
    });
    expect(res.body.canEnrol).toBe(false);
    expect(res.body.canRecord).toBe(true);
    expect(res.body.records[0]).toMatchObject({ process: 'FOOT_EXAM', result: 'NORMAL' });
  });

  it('is only for the care team', async () => {
    for (const token of [
      w.tokens.colleague,
      w.tokens.outsideDoctor,
      w.tokens.director,
      w.tokens.reception,
      w.tokens.pharmacist,
      w.tokens.patient,
      w.tokens.ministry,
    ]) {
      expect((await api().get(base()).set(bearer(token))).status).toBe(403);
    }
  });
});

/* ------------------------------------------------------------------------- recall list -- */

describe('recall list', () => {
  it('lists overdue reviews of patients in my care only', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await enrolPatient(p.id, ['HYPERTENSION'], { source: 'MANUAL' });
    await db
      .update(registerEnrolments)
      .set({ enrolledAt: daysAgo(400) })
      .where(eq(registerEnrolments.patientId, p.id));
    await bp(p.id, 150, 95, daysAgo(300));

    const mine = await api()
      .get('/api/v1/registers/recalls?register=HYPERTENSION')
      .set(bearer(w.tokens.doctor));
    expect(mine.status).toBe(200);
    const entry = mine.body.items.find((i: { patient: { id: string } }) => i.patient.id === p.id);
    expect(entry.registers[0].items.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['BLOOD_PRESSURE', 'CREATININE', 'SMOKING_STATUS']),
    );
    expect(entry.registers[0].items.every((i: { state: string }) => i.state === 'OVERDUE')).toBe(
      true,
    );
    expect(entry.registers[0].targetsNotMet).toEqual([]); // the BP is older than 12 months? no: 300 days
    expect(mine.body.counts.overdueItems).toBeGreaterThanOrEqual(3);

    const colleague = await api().get('/api/v1/registers/recalls').set(bearer(w.tokens.colleague));
    expect(
      colleague.body.items.some((i: { patient: { id: string } }) => i.patient.id === p.id),
    ).toBe(false);
    expect(
      (await api().get('/api/v1/registers/recalls').set(bearer(w.tokens.director))).status,
    ).toBe(403);
    expect(
      (await api().get('/api/v1/registers/recalls').set(bearer(w.tokens.reception))).status,
    ).toBe(403);
  });
});

/* -------------------------------------------------------------------------- indicators -- */

describe('quality indicators', () => {
  let fac: Awaited<ReturnType<typeof createFacility>>;
  let directorToken: string;
  const ids: string[] = [];

  beforeAll(async () => {
    fac = await createFacility({ municipality: 'Gjakovë' });
    const director = await createUser('DIRECTOR', fac.id);
    directorToken = await login(director.email);
    // 8 diabetics: 6 with HbA1c in the last year (4 at target), 2 never tested.
    for (let i = 0; i < 8; i++) {
      const p = await createPatient(fac.id);
      ids.push(p.id);
      await enrolPatient(p.id, ['DIABETES'], { source: 'MANUAL' });
      if (i < 6)
        await lab(
          p.id,
          i % 2 ? 'Hemoglobina A1c' : 'HbA1c',
          i < 4 ? '6.8' : '9.4',
          '%',
          daysAgo(30 + i),
        );
      if (i < 6) await bp(p.id, 130, 80, daysAgo(40));
    }
    // An old result outside the 12-month window does not count.
    await lab(ids[6]!, 'HbA1c', '6.5', '%', daysAgo(500));
    // Only 3 with COPD: too few to show.
    for (let i = 0; i < 3; i++) {
      const p = await createPatient(fac.id);
      await enrolPatient(p.id, ['COPD'], { source: 'MANUAL' });
    }
  });

  it('gives directors their facility’s figures without names', async () => {
    const res = await api().get('/api/v1/registers/indicators').set(bearer(directorToken));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('FACILITY');
    const diabetes = res.body.total.find((r: { register: string }) => r.register === 'DIABETES');
    expect(diabetes.enrolled).toBe(8);
    expect(diabetes.processes.find((p: { code: string }) => p.code === 'HBA1C')).toMatchObject({
      count: 6,
      percent: 75,
    });
    expect(diabetes.targets.find((t: { code: string }) => t.code === 'HBA1C')).toMatchObject({
      count: null,
      suppressed: true,
    }); // 4 < 5
    expect(diabetes.targets.find((t: { code: string }) => t.code === 'BP')).toMatchObject({
      count: 6,
      percent: 75,
    });
    expect(diabetes.prevalencePer1000).toBeGreaterThan(0);
    const copd = res.body.total.find((r: { register: string }) => r.register === 'COPD');
    expect(copd).toMatchObject({ enrolled: null, suppressed: true });
    expect(copd.processes.every((p: { count: null }) => p.count === null)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/firstName|nationalId|Patient/);

    expect(
      (
        await api()
          .get(`/api/v1/registers/indicators?facilityId=${w.facility.id}`)
          .set(bearer(directorToken))
      ).status,
    ).toBe(403);
    expect(
      (await api().get('/api/v1/registers/indicators').set(bearer(w.tokens.doctor))).status,
    ).toBe(403);
  });

  it('gives the Ministry national figures by facility and municipality', async () => {
    const res = await api()
      .get('/api/v1/registers/indicators?groupBy=MUNICIPALITY&register=DIABETES')
      .set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('NATIONAL');
    expect(res.body.threshold).toBe(SMALL_CELL_THRESHOLD);
    const gjakove = res.body.rows.find((r: { key: string }) => r.key === 'Gjakovë');
    expect(gjakove.registers[0].enrolled).toBeGreaterThanOrEqual(8);
    const byFacility = await api()
      .get(`/api/v1/registers/indicators?groupBy=FACILITY&facilityId=${fac.id}`)
      .set(bearer(w.tokens.ministry));
    expect(byFacility.body.rows).toHaveLength(1);
    expect(byFacility.body.rows[0]).toMatchObject({ key: fac.id, name: fac.name });
  });

  it('agrees with the per-patient rules', async () => {
    const [row] = await computeIndicators({
      facilityId: fac.id,
      register: 'DIABETES',
      groupBy: 'NONE',
    });
    const sqlInd = row!.registers[0]!;
    const data = await loadPatientData(ids);
    const rows = await db
      .select()
      .from(registerEnrolments)
      .where(eq(registerEnrolments.facilityId, fac.id));
    const yearAgo = Date.now() - 365 * DAY;
    for (const def of REGISTERS.DIABETES.processes) {
      let doneCount = 0;
      let met = 0;
      for (const e of rows.filter((r) => r.register === 'DIABETES')) {
        const s = evaluateRegister('DIABETES', e.enrolledAt, data.get(e.patientId)!).find(
          (p) => p.code === def.code,
        )!;
        if (s.last && new Date(s.last.at).getTime() >= yearAgo) doneCount++;
        if (s.target?.met) met++;
      }
      const p = sqlInd.processes.find((x) => x.code === def.code)!;
      expect(p.suppressed ? 'suppressed' : p.count).toBe(
        doneCount > 0 && doneCount < SMALL_CELL_THRESHOLD ? 'suppressed' : doneCount,
      );
      if (def.target) {
        const t = sqlInd.targets.find((x) => x.code === def.target)!;
        expect(t.suppressed ? 'suppressed' : t.count).toBe(
          met > 0 && met < SMALL_CELL_THRESHOLD ? 'suppressed' : met,
        );
      }
    }
  });
});

/* ------------------------------------------------------------------------------ recalls -- */

describe('recall notifications', () => {
  it('tells the patient and guardians once, without clinical details', async () => {
    const patientUser = await createUser('PATIENT');
    const guardian = await createUser('PATIENT');
    const p = await createPatient(w.facility.id, { userId: patientUser.id });
    await db.insert(guardianships).values({
      patientId: p.id,
      guardianUserId: guardian.id,
      relationship: 'PARENT',
      evidence: 'Court order 12/2026',
      verifiedById: w.users.reception.id,
      validUntil: new Date(Date.now() + 365 * DAY),
    });
    await enrolPatient(p.id, ['ASTHMA'], { source: 'MANUAL' });
    await db
      .update(registerEnrolments)
      .set({ enrolledAt: daysAgo(200) })
      .where(eq(registerEnrolments.patientId, p.id));
    // No account and no guardian: nobody to tell.
    const silent = await createPatient(w.facility.id);
    await enrolPatient(silent.id, ['ASTHMA'], { source: 'MANUAL' });
    await db
      .update(registerEnrolments)
      .set({ enrolledAt: daysAgo(200) })
      .where(eq(registerEnrolments.patientId, silent.id));

    expect(await runRegisterRecallsOnce()).toBeGreaterThanOrEqual(1);
    const mine = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, patientUser.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: 'register_recall', title: 'A routine check-up is due' });
    expect(mine[0]!.title + (mine[0]!.body ?? '')).not.toMatch(/asthma|inhaler/i);
    expect(mine[0]!.link).toContain('ASTHMA.INHALER_TECHNIQUE');
    const theirs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, guardian.id));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.link).toContain(`for=${p.id}`);

    // Nothing new: no second message within 90 days.
    await runRegisterRecallsOnce();
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, patientUser.id)),
    ).toHaveLength(1);

    // A newly overdue item later is recalled on its own.
    await db.insert(careProcessRecords).values({
      patientId: p.id,
      register: 'ASTHMA',
      process: 'SMOKING_STATUS',
      result: 'NON_SMOKER',
      performedAt: daysAgo(400),
      recordedById: w.users.nurse.id,
    });
    await runRegisterRecallsOnce();
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, patientUser.id)),
    ).toHaveLength(1);
  });
});
