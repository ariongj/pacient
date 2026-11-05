import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  careAssignments,
  careProcessRecords,
  diagnoses,
  labResults,
  patients,
  registerEnrolments,
  users,
  vitalSigns,
} from './schema.js';
import {
  backfillEnrolments,
  runRegisterRecallsOnce,
} from '../modules/registers/registers.service.js';

/**
 * Synthetic demo data for chronic disease registers (development only): enrols the seeded
 * patients from their diagnoses, adds HbA1c results and annual-review items so that the recall
 * lists and quality indicators show a realistic mix (some reviews done, some overdue, some
 * targets missed), and adds a few synthetic COPD and CKD patients.
 */
export async function seedRegisters(opts: { facilityId: string; demoDoctorId: string }) {
  const rand = mulberry32(20261105);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const recorder = nurse?.id ?? opts.demoDoctorId;

  // Synthetic COPD and CKD patients in the demo doctor's care (registers need ≥ 5 to be shown).
  const SYNTHETIC = [
    ['Rrahman', 'Gashi', '1951-03-12', 'MALE', 'J44.1', 'Sëmundje pulmonare obstruktive kronike'],
    ['Hysen', 'Berisha', '1948-09-30', 'MALE', 'J44.9', 'Sëmundje pulmonare obstruktive kronike'],
    [
      'Shpresa',
      'Krasniqi',
      '1956-01-17',
      'FEMALE',
      'J44.9',
      'Sëmundje pulmonare obstruktive kronike',
    ],
    ['Xhemajl', 'Hoxha', '1953-05-04', 'MALE', 'J44.1', 'Sëmundje pulmonare obstruktive kronike'],
    [
      'Nexhmije',
      'Shala',
      '1959-11-22',
      'FEMALE',
      'J44.9',
      'Sëmundje pulmonare obstruktive kronike',
    ],
    ['Bajram', 'Morina', '1950-07-08', 'MALE', 'N18.3', 'Sëmundje kronike e veshkave, faza 3'],
    ['Feride', 'Kelmendi', '1955-02-25', 'FEMALE', 'N18.3', 'Sëmundje kronike e veshkave, faza 3'],
    ['Ismet', 'Bytyqi', '1947-12-14', 'MALE', 'N18.4', 'Sëmundje kronike e veshkave, faza 4'],
    ['Sabrie', 'Rexhepi', '1952-06-03', 'FEMALE', 'N18.3', 'Sëmundje kronike e veshkave, faza 3'],
    ['Halim', 'Zeqiri', '1949-10-19', 'MALE', 'N18.3', 'Sëmundje kronike e veshkave, faza 3'],
    ['Remzi', 'Ahmeti', '1946-04-27', 'MALE', 'I50.0', 'Insuficiencë kongjestive e zemrës'],
  ] as const;
  let nextId = 1277100001;
  for (const [firstName, lastName, dateOfBirth, sex, icd10Code, description] of SYNTHETIC) {
    const nationalId = await freeNationalId(nextId);
    nextId = Number(nationalId) + 1;
    const [p] = await db
      .insert(patients)
      .values({
        nationalId,
        firstName,
        lastName,
        dateOfBirth,
        sex,
        primaryFacilityId: opts.facilityId,
      })
      .returning({ id: patients.id });
    await db.insert(careAssignments).values({
      patientId: p!.id,
      doctorId: opts.demoDoctorId,
      assignedById: opts.demoDoctorId,
    });
    const diagnosedAt = daysAgo(200 + Math.floor(rand() * 500));
    await db.insert(diagnoses).values({
      patientId: p!.id,
      doctorId: opts.demoDoctorId,
      icd10Code,
      description,
      status: 'CHRONIC',
      diagnosedAt,
    });
    if (icd10Code.startsWith('N18') || icd10Code.startsWith('I50')) {
      for (const d of [20 + Math.floor(rand() * 60), 220 + Math.floor(rand() * 60)]) {
        await db.insert(labResults).values({
          patientId: p!.id,
          orderedById: opts.demoDoctorId,
          testName: 'Creatinine',
          value: String(110 + Math.floor(rand() * 110)),
          unit: 'µmol/L',
          referenceRange: '45–110',
          flag: 'HIGH',
          collectedAt: daysAgo(d),
        });
      }
      await db.insert(vitalSigns).values({
        patientId: p!.id,
        systolic: 128 + Math.floor(rand() * 30),
        diastolic: 76 + Math.floor(rand() * 16),
        heartRate: 70 + Math.floor(rand() * 15),
        weightKg: String(68 + Math.floor(rand() * 25)),
        recordedById: recorder,
        recordedAt: daysAgo(15 + Math.floor(rand() * 200)),
      });
    }
  }

  await backfillEnrolments();

  // Membership starts when the condition was diagnosed (seeded diagnoses date back months).
  await db.execute(sql`
    UPDATE register_enrolments e SET enrolled_at = d.diagnosed_at
    FROM diagnoses d WHERE d.id = e.diagnosis_id AND d.diagnosed_at < e.enrolled_at`);

  const members = await db
    .select({ patientId: registerEnrolments.patientId, register: registerEnrolments.register })
    .from(registerEnrolments)
    .where(eq(registerEnrolments.status, 'ACTIVE'));
  const of = (register: string) => members.filter((m) => m.register === register);

  // HbA1c for diabetics who have none: a spread around the target.
  const diabetics = of('DIABETES').map((m) => m.patientId);
  const withA1c = new Set(
    (
      await db
        .select({ patientId: labResults.patientId })
        .from(labResults)
        .where(
          and(
            inArray(labResults.patientId, diabetics.length ? diabetics : [opts.demoDoctorId]),
            sql`${labResults.testName} ~* 'a1c'`,
          ),
        )
    ).map((r) => r.patientId),
  );
  for (const patientId of diabetics) {
    if (withA1c.has(patientId) || rand() < 0.25) continue;
    for (const d of [40 + Math.floor(rand() * 120), 230 + Math.floor(rand() * 120)]) {
      const value = (6.2 + rand() * 3.4).toFixed(1);
      await db.insert(labResults).values({
        patientId,
        orderedById: opts.demoDoctorId,
        testName: 'HbA1c',
        testCode: '4548-4',
        value,
        unit: '%',
        referenceRange: '4.0–6.0',
        flag: Number(value) > 6 ? 'HIGH' : 'NORMAL',
        collectedAt: daysAgo(d),
      });
    }
  }

  // Annual-review items recorded by the nurse, for a realistic share of members.
  const records: (typeof careProcessRecords.$inferInsert)[] = [];
  const add = (
    patientId: string,
    register: string,
    process: string,
    result: string,
    chance: number,
  ) => {
    if (rand() < chance) {
      records.push({
        patientId,
        register,
        process,
        result,
        performedAt: daysAgo(10 + Math.floor(rand() * 330)),
        recordedById: recorder,
        facilityId: opts.facilityId,
      });
    }
  };
  for (const { patientId } of of('DIABETES')) {
    add(patientId, 'DIABETES', 'FOOT_EXAM', pick(['NORMAL', 'NORMAL', 'NORMAL', 'ABNORMAL']), 0.6);
    add(patientId, 'DIABETES', 'RETINAL_SCREENING', pick(['NORMAL', 'NORMAL', 'ABNORMAL']), 0.45);
    add(patientId, 'DIABETES', 'SMOKING_STATUS', pick(['NON_SMOKER', 'EX_SMOKER', 'SMOKER']), 0.7);
  }
  for (const { patientId } of of('HYPERTENSION')) {
    add(
      patientId,
      'HYPERTENSION',
      'SMOKING_STATUS',
      pick(['NON_SMOKER', 'EX_SMOKER', 'SMOKER']),
      0.6,
    );
  }
  for (const { patientId } of of('ASTHMA')) {
    add(patientId, 'ASTHMA', 'INHALER_TECHNIQUE', pick(['NORMAL', 'NORMAL', 'ABNORMAL']), 0.55);
    add(patientId, 'ASTHMA', 'ACTION_PLAN', 'DONE', 0.4);
    add(patientId, 'ASTHMA', 'SMOKING_STATUS', pick(['NON_SMOKER', 'NON_SMOKER', 'SMOKER']), 0.5);
  }
  for (const { patientId } of of('COPD')) {
    add(patientId, 'COPD', 'SPIROMETRY', 'OBSTRUCTION', 0.8);
    add(patientId, 'COPD', 'INHALER_TECHNIQUE', pick(['NORMAL', 'ABNORMAL']), 0.6);
    add(patientId, 'COPD', 'SMOKING_STATUS', pick(['EX_SMOKER', 'SMOKER']), 0.8);
  }
  if (records.length) await db.insert(careProcessRecords).values(records);

  // The demo patient (hypertension) is up to date except her smoking status, so she gets a recall
  // message and appears on the demo doctor's recall list; her BP and cholesterol are above target.
  // Recall messages for overdue reviews (patients with a portal account or guardians).
  await runRegisterRecallsOnce();
}

async function freeNationalId(start: number) {
  for (let n = start; ; n++) {
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.nationalId, String(n)));
    if (!taken) return String(n);
  }
}

/** Small deterministic PRNG so the demo data is the same on every seed. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
