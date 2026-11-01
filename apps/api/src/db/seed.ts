/**
 * Development / demo seed. Creates a small national health network with every access tier.
 * Refuses to run in production. All demo accounts share the password printed at the end.
 */
import { eq, sql } from 'drizzle-orm';
import { isProd } from '../config/env.js';
import { hashPassword } from '../lib/password.js';
import { db, pool } from './client.js';
import {
  allergies,
  appointments,
  auditLogs,
  careAssignments,
  diagnoses,
  encounters,
  facilities,
  labResults,
  patients,
  prescriptions,
  users,
  vitalSigns,
} from './schema.js';

export const DEMO_PASSWORD = 'Pacient-Demo-2026';

/** Deterministic PRNG so every seed produces the same dataset. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261101);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const FIRST_F = [
  'Arta',
  'Blerta',
  'Drita',
  'Elira',
  'Fjolla',
  'Gentiana',
  'Hana',
  'Lirije',
  'Mimoza',
  'Teuta',
  'Vlora',
  'Zana',
];
const FIRST_M = [
  'Agon',
  'Besnik',
  'Dardan',
  'Egzon',
  'Fatos',
  'Gëzim',
  'Ilir',
  'Kushtrim',
  'Liridon',
  'Valon',
  'Visar',
  'Arben',
];
const LAST = [
  'Krasniqi',
  'Gashi',
  'Berisha',
  'Morina',
  'Hoxha',
  'Shala',
  'Bytyqi',
  'Kastrati',
  'Rexhepi',
  'Ahmeti',
  'Hasani',
  'Kelmendi',
  'Zeqiri',
  'Musliu',
];

const CONDITIONS = [
  {
    code: 'I10',
    description: 'Essential (primary) hypertension',
    status: 'CHRONIC',
    rx: { medication: 'Amlodipine', dosage: '5 mg', frequency: 'once daily' },
  },
  {
    code: 'E11.9',
    description: 'Type 2 diabetes mellitus without complications',
    status: 'CHRONIC',
    rx: { medication: 'Metformin', dosage: '850 mg', frequency: 'twice daily' },
  },
  {
    code: 'E78.5',
    description: 'Hyperlipidaemia, unspecified',
    status: 'CHRONIC',
    rx: { medication: 'Atorvastatin', dosage: '20 mg', frequency: 'once daily at night' },
  },
  {
    code: 'J45.9',
    description: 'Asthma, unspecified',
    status: 'CHRONIC',
    rx: { medication: 'Salbutamol inhaler', dosage: '100 mcg', frequency: 'as needed' },
  },
  {
    code: 'J06.9',
    description: 'Acute upper respiratory infection, unspecified',
    status: 'RESOLVED',
    rx: null,
  },
  {
    code: 'N39.0',
    description: 'Urinary tract infection, site not specified',
    status: 'RESOLVED',
    rx: { medication: 'Nitrofurantoin', dosage: '100 mg', frequency: 'twice daily for 5 days' },
  },
  {
    code: 'M54.5',
    description: 'Low back pain',
    status: 'ACTIVE',
    rx: { medication: 'Ibuprofen', dosage: '400 mg', frequency: 'three times daily after meals' },
  },
  {
    code: 'K21.9',
    description: 'Gastro-oesophageal reflux disease without oesophagitis',
    status: 'ACTIVE',
    rx: { medication: 'Omeprazole', dosage: '20 mg', frequency: 'once daily before breakfast' },
  },
  { code: 'F41.1', description: 'Generalised anxiety disorder', status: 'ACTIVE', rx: null },
  {
    code: 'D50.9',
    description: 'Iron deficiency anaemia, unspecified',
    status: 'ACTIVE',
    rx: { medication: 'Ferrous sulfate', dosage: '200 mg', frequency: 'once daily' },
  },
] as const;

const ALLERGENS = [
  { substance: 'Penicillin', reaction: 'Urticaria', severity: 'MODERATE' },
  { substance: 'Peanuts', reaction: 'Anaphylaxis', severity: 'LIFE_THREATENING' },
  { substance: 'Latex', reaction: 'Contact dermatitis', severity: 'MILD' },
  { substance: 'Sulfonamides', reaction: 'Rash', severity: 'MODERATE' },
] as const;

const LABS = [
  {
    testName: 'HbA1c',
    unit: '%',
    referenceRange: '4.0–5.6',
    gen: () => (5 + rand() * 4).toFixed(1),
    flag: (v: number) => (v > 5.6 ? 'HIGH' : 'NORMAL'),
  },
  {
    testName: 'Fasting glucose',
    unit: 'mmol/L',
    referenceRange: '3.9–5.5',
    gen: () => (4 + rand() * 5).toFixed(1),
    flag: (v: number) => (v > 5.5 ? 'HIGH' : 'NORMAL'),
  },
  {
    testName: 'Total cholesterol',
    unit: 'mmol/L',
    referenceRange: '< 5.2',
    gen: () => (3.8 + rand() * 3).toFixed(1),
    flag: (v: number) => (v >= 5.2 ? 'HIGH' : 'NORMAL'),
  },
  {
    testName: 'Haemoglobin',
    unit: 'g/L',
    referenceRange: '120–160',
    gen: () => String(int(98, 165)),
    flag: (v: number) => (v < 120 ? 'LOW' : 'NORMAL'),
  },
  {
    testName: 'Creatinine',
    unit: 'µmol/L',
    referenceRange: '60–110',
    gen: () => String(int(55, 125)),
    flag: (v: number) => (v > 110 ? 'HIGH' : 'NORMAL'),
  },
] as const;

const FACILITIES = [
  {
    code: 'UCC-PR',
    name: 'University Clinical Center Prishtina',
    type: 'UNIVERSITY_CLINICAL_CENTER',
    region: 'Prishtinë',
    municipality: 'Prishtinë',
    address: 'Rr. Spitalit, Prishtinë',
    phone: '+383 38 500 600',
  },
  {
    code: 'RH-PZ',
    name: 'Regional Hospital Prizren',
    type: 'REGIONAL_HOSPITAL',
    region: 'Prizren',
    municipality: 'Prizren',
    address: 'Rr. e Spitalit, Prizren',
    phone: '+383 29 222 111',
  },
  {
    code: 'FMC-PE',
    name: 'Main Family Medicine Center Peja',
    type: 'FAMILY_MEDICINE_CENTER',
    region: 'Pejë',
    municipality: 'Pejë',
    address: 'Qendra, Pejë',
    phone: '+383 39 432 100',
  },
  {
    code: 'FMC-GJ',
    name: 'Main Family Medicine Center Gjilan',
    type: 'FAMILY_MEDICINE_CENTER',
    region: 'Gjilan',
    municipality: 'Gjilan',
    address: 'Qendra, Gjilan',
    phone: '+383 280 320 100',
  },
] as const;

const DOCTOR_SPECIALTIES = [
  'Family Medicine',
  'Internal Medicine',
  'Cardiology',
  'Endocrinology',
  'Paediatrics',
  'Pulmonology',
];

async function main() {
  if (isProd) throw new Error('Refusing to seed demo data in production');

  const [{ existing } = { existing: 0 }] = (
    await db.execute<{ existing: number }>(sql`SELECT count(*)::int AS existing FROM users`)
  ).rows;
  if (existing > 0) {
    console.log('Database already contains users – skipping seed.');
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const activeAccount = { passwordHash, passwordChangedAt: new Date() };

  const facilityRows = await db
    .insert(facilities)
    .values([...FACILITIES])
    .returning();

  await db.insert(users).values({
    email: 'minister@pacient.local',
    fullName: 'Dr. Albana Hyseni',
    role: 'MINISTRY',
    facilityId: null,
    ...activeAccount,
  });

  const doctorsByFacility = new Map<string, { id: string; fullName: string }[]>();
  let doctorIndex = 0;
  for (const [i, f] of facilityRows.entries()) {
    const slug = f.code.toLowerCase();
    await db.insert(users).values({
      email: i === 0 ? 'director@pacient.local' : `director.${slug}@pacient.local`,
      fullName: `Dr. ${pick(FIRST_M)} ${pick(LAST)}`,
      role: 'DIRECTOR',
      facilityId: f.id,
      ...activeAccount,
    });
    const count = i === 0 ? 4 : 2;
    const docs = await db
      .insert(users)
      .values(
        Array.from({ length: count }, (_, k) => {
          doctorIndex++;
          const female = rand() > 0.5;
          return {
            email:
              i === 0 && k === 0 ? 'doctor@pacient.local' : `doctor${doctorIndex}@pacient.local`,
            fullName: `Dr. ${pick(female ? FIRST_F : FIRST_M)} ${pick(LAST)}`,
            role: 'DOCTOR' as const,
            facilityId: f.id,
            specialty: k === 0 ? 'Family Medicine' : pick(DOCTOR_SPECIALTIES),
            licenseNumber: `KMC-${10000 + doctorIndex}`,
            ...activeAccount,
          };
        }),
      )
      .returning({ id: users.id, fullName: users.fullName });
    doctorsByFacility.set(f.id, docs);
  }

  // Patient portal demo account.
  const [portalUser] = await db
    .insert(users)
    .values({
      email: 'patient@pacient.local',
      fullName: 'Arta Krasniqi',
      role: 'PATIENT',
      facilityId: null,
      ...activeAccount,
    })
    .returning();

  let nationalSeq = 1_100_000_000;
  for (const f of facilityRows) {
    const docs = doctorsByFacility.get(f.id)!;
    const patientCount = f.code === 'UCC-PR' ? 30 : 15;
    for (let p = 0; p < patientCount; p++) {
      const isDemo = f.code === 'UCC-PR' && p === 0;
      const female = isDemo || rand() > 0.5;
      const dob = new Date(Date.UTC(int(1940, 2020), int(0, 11), int(1, 28)));
      const [patient] = await db
        .insert(patients)
        .values({
          userId: isDemo ? portalUser!.id : null,
          nationalId: String(nationalSeq++),
          firstName: isDemo ? 'Arta' : pick(female ? FIRST_F : FIRST_M),
          lastName: isDemo ? 'Krasniqi' : pick(LAST),
          dateOfBirth: isDemo ? '1984-06-12' : isoDate(dob),
          sex: female ? 'FEMALE' : 'MALE',
          bloodType: pick(['A+', 'A-', 'B+', 'O+', 'O-', 'AB+'] as const),
          phone: `+383 4${int(4, 9)} ${int(100, 999)} ${int(100, 999)}`,
          email: isDemo ? 'patient@pacient.local' : null,
          municipality: f.municipality,
          address: `${f.municipality}`,
          emergencyContactName: `${pick(FIRST_M)} ${pick(LAST)}`,
          emergencyContactPhone: `+383 4${int(4, 9)} ${int(100, 999)} ${int(100, 999)}`,
          primaryFacilityId: f.id,
        })
        .returning();
      const patientId = patient!.id;
      const doctor = isDemo ? docs[0]! : pick(docs);
      await db.insert(careAssignments).values({
        patientId,
        doctorId: doctor.id,
        assignedById: doctor.id,
        startedAt: daysAgo(400),
      });
      if (isDemo && docs[1]) {
        await db.insert(careAssignments).values({
          patientId,
          doctorId: docs[1].id,
          assignedById: doctor.id,
          startedAt: daysAgo(200),
        });
      }

      if (isDemo || rand() < 0.2) {
        const a = isDemo ? ALLERGENS[0] : pick(ALLERGENS);
        await db.insert(allergies).values({
          patientId,
          ...a,
          verificationStatus: 'CONFIRMED',
          recordedById: doctor.id,
          recordedAt: daysAgo(380),
        });
        await db
          .update(patients)
          .set({ allergyAssessment: 'ALLERGIES_RECORDED' })
          .where(eq(patients.id, patientId));
      } else if (rand() < 0.6) {
        await db
          .update(patients)
          .set({ allergyAssessment: 'NO_KNOWN_ALLERGIES' })
          .where(eq(patients.id, patientId));
      }

      const conditions = isDemo
        ? [CONDITIONS[0], CONDITIONS[2], CONDITIONS[4], CONDITIONS[7]]
        : Array.from({ length: int(1, 3) }, () => pick(CONDITIONS));
      const seen = new Set<string>();
      for (const c of conditions) {
        if (seen.has(c.code)) continue;
        seen.add(c.code);
        const ageDays = int(1, 360);
        const when = daysAgo(ageDays);
        const recent = ageDays <= 14;
        const signed = !recent || rand() < 0.5;
        const [enc] = await db
          .insert(encounters)
          .values({
            patientId,
            doctorId: doctor.id,
            facilityId: f.id,
            type: rand() < 0.85 ? 'OUTPATIENT' : pick(['EMERGENCY', 'TELEHEALTH'] as const),
            reason: `Consultation – ${c.description.toLowerCase()}`,
            notes: `History taken and examination performed. Assessment consistent with ${c.description.toLowerCase()}. Plan discussed with the patient.`,
            startedAt: when,
            endedAt: new Date(when.getTime() + 25 * 60_000),
            noteStatus: signed ? 'SIGNED' : 'DRAFT',
            signedAt: signed ? new Date(when.getTime() + 30 * 60_000) : null,
            signedById: signed ? doctor.id : null,
          })
          .returning();
        await db.insert(diagnoses).values({
          patientId,
          encounterId: enc!.id,
          doctorId: doctor.id,
          icd10Code: c.code,
          description: c.description,
          status: c.status,
          diagnosedAt: when,
          resolvedAt: c.status === 'RESOLVED' ? new Date(when.getTime() + 10 * 86_400_000) : null,
        });
        if (c.rx) {
          await db.insert(prescriptions).values({
            patientId,
            encounterId: enc!.id,
            doctorId: doctor.id,
            ...c.rx,
            route: c.rx.medication.includes('inhaler') ? 'inhaled' : 'oral',
            startDate: isoDate(when),
            endDate:
              c.status === 'RESOLVED' ? isoDate(new Date(when.getTime() + 7 * 86_400_000)) : null,
            status: c.status === 'RESOLVED' ? 'COMPLETED' : 'ACTIVE',
          });
        }
        await db.insert(vitalSigns).values({
          patientId,
          encounterId: enc!.id,
          recordedById: doctor.id,
          systolic: int(105, 165),
          diastolic: int(65, 100),
          heartRate: int(58, 98),
          temperatureC: (36 + rand() * 1.8).toFixed(1),
          oxygenSaturation: int(94, 100),
          weightKg: (55 + rand() * 45).toFixed(1),
          heightCm: String(int(155, 192)),
          recordedAt: when,
        });
        for (const lab of [pick(LABS), pick(LABS)]) {
          const value = lab.gen();
          await db.insert(labResults).values({
            patientId,
            encounterId: enc!.id,
            orderedById: doctor.id,
            testName: lab.testName,
            value,
            unit: lab.unit,
            referenceRange: lab.referenceRange,
            flag: lab.flag(Number(value)) as 'NORMAL' | 'HIGH' | 'LOW',
            collectedAt: when,
            // Older results have completed the follow-up loop; recent ones await review.
            acknowledgedAt: recent ? null : new Date(when.getTime() + 86_400_000),
            acknowledgedById: recent ? null : doctor.id,
            releasedAt: recent ? null : new Date(when.getTime() + 86_400_000),
            releasedById: recent ? null : doctor.id,
          });
        }
      }

      if (isDemo || rand() < 0.3) {
        const at = new Date(Date.now() + int(1, 21) * 86_400_000);
        at.setUTCHours(int(7, 13), pick([0, 20, 40]), 0, 0);
        await db.insert(appointments).values({
          patientId,
          doctorId: doctor.id,
          facilityId: f.id,
          scheduledAt: at,
          durationMinutes: 20,
          reason: isDemo ? 'Blood pressure follow-up' : 'Routine follow-up',
          status: rand() < 0.6 ? 'CONFIRMED' : 'REQUESTED',
          createdById: doctor.id,
        });
      }

      if (isDemo) {
        await db.insert(auditLogs).values([
          {
            occurredAt: daysAgo(3),
            actorUserId: doctor.id,
            actorRole: 'DOCTOR',
            actorFacilityId: f.id,
            action: 'patient.record.viewed',
            resourceType: 'patient',
            resourceId: patientId,
            patientId,
            metadata: { section: 'summary', basis: 'CARE_TEAM' },
          },
          {
            occurredAt: daysAgo(1),
            actorUserId: doctor.id,
            actorRole: 'DOCTOR',
            actorFacilityId: f.id,
            action: 'patient.record.viewed',
            resourceType: 'patient',
            resourceId: patientId,
            patientId,
            metadata: { section: 'lab-results', basis: 'CARE_TEAM' },
          },
        ]);
      }
    }
  }

  console.log(`
Seed complete. Demo accounts (password: ${DEMO_PASSWORD})
  Ministry : minister@pacient.local
  Director : director@pacient.local   (University Clinical Center Prishtina)
  Doctor   : doctor@pacient.local     (Family Medicine, UCC Prishtina)
  Patient  : patient@pacient.local    (Arta Krasniqi)
`);
}

main()
  .then(() => pool.end())
  .catch(async (err: unknown) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
