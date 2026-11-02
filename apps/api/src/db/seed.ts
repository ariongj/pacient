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
  announcements,
  appointments,
  auditLogs,
  careAssignments,
  diagnoses,
  emergencyAccessGrants,
  encounters,
  facilities,
  immunizations,
  labResults,
  messages,
  messageThreads,
  notifications,
  patients,
  prescriptions,
  referrals,
  users,
  vitalSigns,
  careTasks,
  channelMessages,
  guardianships,
  channels,
  medicationAdministrations,
} from './schema.js';
import { ensureDefaultChannels } from '../modules/channels/channels.routes.js';

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

  const [minister] = await db
    .insert(users)
    .values({
      email: 'minister@pacient.local',
      fullName: 'Dr. Albana Hyseni',
      role: 'MINISTRY',
      facilityId: null,
      ...activeAccount,
    })
    .returning();

  const directorsByFacility = new Map<string, string>();
  let demoPatientId = '';
  const patientsByFacility = new Map<string, string[]>();
  const doctorsByFacility = new Map<string, { id: string; fullName: string }[]>();
  let doctorIndex = 0;
  for (const [i, f] of facilityRows.entries()) {
    const slug = f.code.toLowerCase();
    const [director] = await db
      .insert(users)
      .values({
        email: i === 0 ? 'director@pacient.local' : `director.${slug}@pacient.local`,
        fullName: `Dr. ${pick(FIRST_M)} ${pick(LAST)}`,
        role: 'DIRECTOR',
        facilityId: f.id,
        ...activeAccount,
      })
      .returning();
    directorsByFacility.set(f.id, director!.id);
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
      emailNotifications: 'ALL',
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
      if (isDemo) demoPatientId = patientId;
      patientsByFacility.set(f.id, [...(patientsByFacility.get(f.id) ?? []), patientId]);
      const doctor = isDemo ? docs[0]! : pick(docs);
      if (isDemo || rand() < 0.4) {
        await db.insert(immunizations).values([
          {
            patientId,
            vaccine: 'Influenza (seasonal)',
            doseNumber: 1,
            lotNumber: `FLU-${int(100, 999)}`,
            site: 'Left deltoid',
            administeredAt: daysAgo(int(20, 300)),
            administeredById: doctor.id,
            facilityId: f.id,
          },
          ...(isDemo
            ? [
                {
                  patientId,
                  vaccine: 'Tetanus-diphtheria (Td) booster',
                  doseNumber: 1,
                  lotNumber: 'TD-2219',
                  site: 'Right deltoid',
                  administeredAt: daysAgo(700),
                  administeredById: doctor.id,
                  facilityId: f.id,
                },
              ]
            : []),
        ]);
      }
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

  /* ---------------------------------------------------------- collaboration & oversight demo */
  const [ucc, rhpz] = facilityRows;
  const uccDocs = doctorsByFacility.get(ucc!.id)!;
  const rhDocs = doctorsByFacility.get(rhpz!.id)!;
  const demoDoctor = uccDocs[0]!;

  // A conversation between the demo patient and their family doctor.
  const [thread] = await db
    .insert(messageThreads)
    .values({
      patientId: demoPatientId,
      doctorId: demoDoctor.id,
      subject: 'Blood pressure readings at home',
      lastMessageAt: daysAgo(1),
      createdAt: daysAgo(2),
    })
    .returning();
  await db.insert(messages).values([
    {
      threadId: thread!.id,
      senderId: portalUser!.id,
      body: 'Good morning doctor, my home readings this week were around 145/90 in the mornings. Should I change anything before our appointment?',
      createdAt: daysAgo(2),
      readAt: daysAgo(1),
    },
    {
      threadId: thread!.id,
      senderId: demoDoctor.id,
      body: 'Thank you for tracking them. Keep taking amlodipine as prescribed and bring your log to the visit. If you get a severe headache or chest pain, call 112.',
      createdAt: daysAgo(1),
    },
  ]);

  // An outgoing referral from the demo patient's doctor, accepted at Prizren.
  await db.insert(referrals).values({
    patientId: demoPatientId,
    fromDoctorId: demoDoctor.id,
    fromFacilityId: ucc!.id,
    toFacilityId: rhpz!.id,
    toDoctorId: rhDocs[0]!.id,
    specialty: 'Cardiology',
    priority: 'ROUTINE',
    reason: 'Hypertension not at target on monotherapy',
    clinicalSummary:
      '42-year-old woman with essential hypertension (I10) and hyperlipidaemia. Home BP ~145/90 on amlodipine 5 mg. Requesting cardiology review and echocardiogram.',
    status: 'ACCEPTED',
    respondedById: directorsByFacility.get(rhpz!.id)!,
    respondedAt: daysAgo(3),
    createdAt: daysAgo(5),
  });
  await db.insert(careAssignments).values({
    patientId: demoPatientId,
    doctorId: rhDocs[0]!.id,
    assignedById: directorsByFacility.get(rhpz!.id)!,
    startedAt: daysAgo(3),
  });

  // An incoming referral waiting for the UCC director / doctors.
  const pzPatient = patientsByFacility.get(rhpz!.id)![0]!;
  await db
    .insert(careAssignments)
    .values({ patientId: pzPatient, doctorId: rhDocs[1]!.id, assignedById: rhDocs[1]!.id })
    .onConflictDoNothing();
  await db.insert(referrals).values({
    patientId: pzPatient,
    fromDoctorId: rhDocs[1]!.id,
    fromFacilityId: rhpz!.id,
    toFacilityId: ucc!.id,
    specialty: 'Endocrinology',
    priority: 'URGENT',
    reason: 'Poorly controlled type 2 diabetes',
    clinicalSummary:
      'HbA1c 9.1% despite metformin 850 mg twice daily. Weight loss and polyuria over the last 2 months. Please assess for insulin initiation.',
    createdAt: daysAgo(1),
  });

  // An emergency access at UCC awaiting the director's review.
  const uccPatients = patientsByFacility.get(ucc!.id)!;
  await db.insert(emergencyAccessGrants).values({
    patientId: uccPatients[5]!,
    doctorId: uccDocs[2]!.id,
    reason: 'Patient brought in unconscious after a fall; treating doctor off duty.',
    createdAt: daysAgo(2),
    expiresAt: new Date(daysAgo(2).getTime() + 4 * 3_600_000),
  });

  await db.insert(announcements).values([
    {
      authorId: minister!.id,
      scope: 'NATIONAL',
      audience: 'EVERYONE',
      title: 'Seasonal flu vaccination campaign',
      body: 'Free seasonal influenza vaccination is available at every family medicine centre until 31 January. Priority: people over 65, pregnant women and people with chronic conditions.',
      publishedAt: daysAgo(4),
    },
    {
      authorId: minister!.id,
      scope: 'NATIONAL',
      audience: 'STAFF',
      title: 'Two-step sign-in becomes mandatory for all staff',
      body: 'From next month every doctor, director and Ministry account must use two-step sign-in. Set it up under Account → Two-step sign-in.',
      publishedAt: daysAgo(2),
    },
    {
      authorId: directorsByFacility.get(ucc!.id)!,
      scope: 'FACILITY',
      facilityId: ucc!.id,
      audience: 'PATIENTS',
      title: 'New evening clinic hours',
      body: 'The outpatient clinic is now open until 19:00 on Tuesdays and Thursdays.',
      publishedAt: daysAgo(1),
    },
  ]);

  await db.insert(notifications).values([
    {
      userId: portalUser!.id,
      type: 'message',
      title: 'New message from your doctor',
      link: `/portal/messages?thread=${thread!.id}`,
      createdAt: daysAgo(1),
    },
    {
      userId: portalUser!.id,
      type: 'referral',
      title: 'Your referral was accepted',
      link: '/portal/referrals',
      createdAt: daysAgo(3),
    },
    {
      userId: demoDoctor.id,
      type: 'referral',
      title: 'Your referral was accepted',
      link: '/doctor/referrals',
      createdAt: daysAgo(3),
    },
    {
      userId: directorsByFacility.get(ucc!.id)!,
      type: 'referral',
      title: 'New URGENT referral received',
      link: '/director/referrals',
      createdAt: daysAgo(1),
    },
    {
      userId: directorsByFacility.get(ucc!.id)!,
      type: 'emergency_access',
      title: 'Emergency access used – review required',
      link: '/director/emergency-access',
      createdAt: daysAgo(2),
    },
  ]);

  /* ---------------------------------------------------------- nursing, pharmacy, front desk */
  const NURSE_NAMES = [
    'Mimoza Hoxha',
    'Blerina Shala',
    'Kaltrina Berisha',
    'Drilon Krasniqi',
    'Fitore Gashi',
  ];
  const staffByFacility = new Map<
    string,
    { nurse: string; pharmacist: string; reception: string }
  >();
  let staffSeq = 0;
  for (const [i, f] of facilityRows.entries()) {
    const slug = f.code.toLowerCase();
    const uniq = (base: string) =>
      i === 0 ? `${base}@pacient.local` : `${base}.${slug}@pacient.local`;
    const [nurse, pharmacist, reception] = await db
      .insert(users)
      .values([
        {
          email: uniq('nurse'),
          fullName: NURSE_NAMES[staffSeq++ % NURSE_NAMES.length]!,
          role: 'NURSE' as const,
          facilityId: f.id,
          specialty: 'Registered Nurse',
          licenseNumber: `KNC-${20000 + i}`,
          ...activeAccount,
        },
        {
          email: uniq('pharmacist'),
          fullName: `Mr. ${pick(FIRST_M)} ${pick(LAST)}`,
          role: 'PHARMACIST' as const,
          facilityId: f.id,
          specialty: 'Hospital Pharmacist',
          licenseNumber: `KPC-${30000 + i}`,
          ...activeAccount,
        },
        {
          email: uniq('reception'),
          fullName: `${pick(FIRST_F)} ${pick(LAST)}`,
          role: 'RECEPTION' as const,
          facilityId: f.id,
          ...activeAccount,
        },
      ])
      .returning({ id: users.id });
    staffByFacility.set(f.id, {
      nurse: nurse!.id,
      pharmacist: pharmacist!.id,
      reception: reception!.id,
    });

    // The nurse joins the care team of the first patients of the facility.
    for (const pid of (patientsByFacility.get(f.id) ?? []).slice(0, 12)) {
      await db
        .insert(careAssignments)
        .values({
          patientId: pid,
          doctorId: nurse!.id,
          assignedById: directorsByFacility.get(f.id)!,
          startedAt: daysAgo(60),
        })
        .onConflictDoNothing();
    }
    await ensureDefaultChannels(f.id);
  }
  await ensureDefaultChannels(null);

  const uccStaff = staffByFacility.get(ucc!.id)!;

  // Pharmacy queue at UCC: recent prescriptions awaiting verification, one with an allergy alert
  // (the demo patient has a confirmed penicillin allergy).
  await db.insert(prescriptions).values({
    patientId: demoPatientId,
    doctorId: demoDoctor.id,
    medication: 'Amoxicillin 500 mg capsules',
    dosage: '500 mg',
    frequency: 'three times daily for 7 days',
    route: 'oral',
    startDate: isoDate(new Date()),
    status: 'ACTIVE',
    pharmacyStatus: 'PENDING',
    createdAt: new Date(Date.now() - 40 * 60_000),
  });
  for (const pid of uccPatients.slice(1, 5)) {
    const c = pick(CONDITIONS.filter((x) => x.rx));
    await db.insert(prescriptions).values({
      patientId: pid,
      doctorId: pick(uccDocs).id,
      ...c.rx!,
      route: 'oral',
      startDate: isoDate(new Date()),
      status: 'ACTIVE',
      pharmacyStatus: pick(['PENDING', 'PENDING', 'VERIFIED'] as const),
      verifiedAt: null,
      createdAt: new Date(Date.now() - int(10, 300) * 60_000),
    });
  }
  // Mark everything older than today as already through the pharmacy.
  await db.execute(sql`UPDATE prescriptions SET pharmacy_status = 'DISPENSED',
      created_at = start_date::timestamptz + interval '9 hours',
      verified_at = start_date::timestamptz + interval '11 hours',
      dispensed_at = start_date::timestamptz + interval '14 hours',
      dispensed_quantity = '30 tablets'
    WHERE start_date < current_date AND pharmacy_status = 'PENDING'`);

  // Medication administration and care tasks for the demo patient.
  const [amlodipine] = (
    await db.execute<{
      id: string;
    }>(sql`SELECT id FROM prescriptions WHERE patient_id = ${demoPatientId}
      AND medication = 'Amlodipine' AND status = 'ACTIVE' LIMIT 1`)
  ).rows;
  if (amlodipine) {
    await db.insert(medicationAdministrations).values([
      {
        prescriptionId: amlodipine.id,
        patientId: demoPatientId,
        administeredById: uccStaff.nurse,
        status: 'GIVEN',
        doseGiven: '5 mg',
        administeredAt: daysAgo(1),
      },
      {
        prescriptionId: amlodipine.id,
        patientId: demoPatientId,
        administeredById: uccStaff.nurse,
        status: 'WITHHELD',
        reason: 'Systolic BP 98 mmHg before dose; doctor informed',
        administeredAt: daysAgo(2),
      },
    ]);
  }
  await db.insert(careTasks).values([
    {
      patientId: demoPatientId,
      facilityId: ucc!.id,
      createdById: demoDoctor.id,
      assignedRole: 'NURSE',
      title: 'Repeat blood pressure in both arms',
      details: 'Record seated readings after 5 minutes rest.',
      priority: 'URGENT',
      dueAt: new Date(Date.now() + 2 * 3_600_000),
    },
    {
      patientId: demoPatientId,
      facilityId: ucc!.id,
      createdById: demoDoctor.id,
      assignedRole: 'NURSE',
      title: 'Teach home BP monitoring technique',
      priority: 'ROUTINE',
      dueAt: new Date(Date.now() + 26 * 3_600_000),
    },
    {
      patientId: uccPatients[2]!,
      facilityId: ucc!.id,
      createdById: uccDocs[1]!.id,
      assignedRole: 'NURSE',
      title: 'Wound dressing change',
      priority: 'ROUTINE',
      dueAt: new Date(Date.now() - 3 * 3_600_000),
    },
  ]);

  // Today's front-desk schedule at UCC.
  for (const [k, pid] of uccPatients.slice(6, 12).entries()) {
    const at = new Date();
    at.setHours(8 + k, k % 2 ? 30 : 0, 0, 0);
    await db.insert(appointments).values({
      patientId: pid,
      doctorId: uccDocs[k % uccDocs.length]!.id,
      facilityId: ucc!.id,
      scheduledAt: at,
      durationMinutes: 20,
      reason: pick(['Follow-up', 'Prescription review', 'New symptoms', 'Lab results discussion']),
      status: k < 2 ? 'CHECKED_IN' : 'CONFIRMED',
      createdById: uccStaff.reception,
    });
  }

  // Guardian access: Arta is the verified parent of Lea (10). One of Lea's visits is confidential.
  const [lea] = await db
    .insert(patients)
    .values({
      nationalId: '1199000001',
      firstName: 'Lea',
      lastName: 'Krasniqi',
      dateOfBirth: '2016-05-10',
      sex: 'FEMALE',
      bloodType: 'B+',
      municipality: 'Prishtinë',
      address: 'Prishtinë',
      allergyAssessment: 'NO_KNOWN_ALLERGIES',
      primaryFacilityId: ucc!.id,
    })
    .returning();
  const paediatrician = uccDocs.find((d) => d.id !== demoDoctor.id) ?? demoDoctor;
  await db.insert(careAssignments).values([
    {
      patientId: lea!.id,
      doctorId: demoDoctor.id,
      assignedById: demoDoctor.id,
      startedAt: daysAgo(900),
    },
    {
      patientId: lea!.id,
      doctorId: paediatrician.id,
      assignedById: demoDoctor.id,
      startedAt: daysAgo(300),
    },
  ]);
  await db.insert(guardianships).values({
    patientId: lea!.id,
    guardianUserId: portalUser!.id,
    relationship: 'PARENT',
    scope: 'FULL',
    evidence: 'Birth certificate 4411/2016 (checked at reception)',
    verifiedById: uccStaff.reception,
    validFrom: daysAgo(900),
    validUntil: new Date(Date.UTC(2034, 4, 10)),
  });
  const [leaVisit] = await db
    .insert(encounters)
    .values({
      patientId: lea!.id,
      doctorId: paediatrician.id,
      facilityId: ucc!.id,
      type: 'OUTPATIENT',
      reason: 'Fever and sore throat',
      notes:
        'Temperature 38.4 °C, red tonsils without exudate. Viral pharyngitis likely. Fluids, paracetamol, review if worse.',
      startedAt: daysAgo(12),
      endedAt: daysAgo(12),
      noteStatus: 'SIGNED',
      signedAt: daysAgo(12),
      signedById: paediatrician.id,
    })
    .returning();
  await db.insert(diagnoses).values({
    patientId: lea!.id,
    encounterId: leaVisit!.id,
    doctorId: paediatrician.id,
    icd10Code: 'J02.9',
    description: 'Acute pharyngitis, unspecified',
    status: 'RESOLVED',
    diagnosedAt: daysAgo(12),
    resolvedAt: daysAgo(5),
  });
  await db.insert(immunizations).values([
    {
      patientId: lea!.id,
      vaccine: 'MMR (measles, mumps, rubella)',
      doseNumber: 2,
      administeredAt: daysAgo(1500),
      administeredById: demoDoctor.id,
      facilityId: ucc!.id,
      site: 'Left arm',
    },
    {
      patientId: lea!.id,
      vaccine: 'DTaP-IPV booster',
      doseNumber: 1,
      administeredAt: daysAgo(800),
      administeredById: demoDoctor.id,
      facilityId: ucc!.id,
      site: 'Right arm',
    },
  ]);
  await db.insert(encounters).values({
    patientId: lea!.id,
    doctorId: paediatrician.id,
    facilityId: ucc!.id,
    type: 'OUTPATIENT',
    reason: 'Confidential consultation',
    notes: 'Seen alone at the young person’s request.',
    startedAt: daysAgo(40),
    endedAt: daysAgo(40),
    noteStatus: 'SIGNED',
    signedAt: daysAgo(40),
    signedById: paediatrician.id,
    confidentialFromGuardians: true,
  });
  {
    const at = new Date(Date.now() + 9 * 86_400_000);
    at.setUTCHours(14, 0, 0, 0);
    await db.insert(appointments).values({
      patientId: lea!.id,
      doctorId: paediatrician.id,
      facilityId: ucc!.id,
      scheduledAt: at,
      durationMinutes: 20,
      reason: 'School-entry check-up',
      status: 'CONFIRMED',
      createdById: uccStaff.reception,
    });
  }

  // Channel conversations.
  const uccChannels = await db.select().from(channels).where(eq(channels.facilityId, ucc!.id));
  const national = (await db.select().from(channels).where(eq(channels.scope, 'NATIONAL')))[0]!;
  const byName = (n: string) => uccChannels.find((c) => c.name === n)!;
  await db.insert(channelMessages).values([
    {
      channelId: byName('all-staff').id,
      authorId: directorsByFacility.get(ucc!.id)!,
      body: 'Good morning everyone. Fire drill this Thursday at 10:00 – please review the evacuation plan on your ward.',
      createdAt: daysAgo(1),
    },
    {
      channelId: byName('pharmacy').id,
      authorId: uccStaff.pharmacist,
      body: 'Heads-up: amoxicillin 500 mg capsules are low until Friday. Please consider alternatives where clinically appropriate.',
      isUrgent: true,
      createdAt: new Date(Date.now() - 3 * 3_600_000),
    },
    {
      channelId: byName('pharmacy').id,
      authorId: demoDoctor.id,
      body: 'Thanks – noted. I will check the queue for anything that needs changing.',
      createdAt: new Date(Date.now() - 2 * 3_600_000),
    },
    {
      channelId: byName('front-desk').id,
      authorId: uccStaff.reception,
      body: 'Waiting room is busy this morning; two walk-ins are waiting for triage.',
      createdAt: new Date(Date.now() - 50 * 60_000),
    },
    {
      channelId: byName('clinical').id,
      authorId: uccStaff.nurse,
      body: 'Ward round starts at 09:30 today instead of 09:00.',
      createdAt: new Date(Date.now() - 4 * 3_600_000),
    },
    {
      channelId: national.id,
      authorId: minister!.id,
      body: 'Directors: please make sure all staff have set up two-step sign-in by the end of the month. Compliance is on the national dashboard.',
      createdAt: daysAgo(2),
    },
    {
      channelId: national.id,
      authorId: directorsByFacility.get(rhpz!.id)!,
      body: 'Prizren is at 80%. Remaining staff are scheduled for set-up sessions this week.',
      createdAt: daysAgo(1),
    },
  ]);
  await db.execute(
    sql`UPDATE channels c SET last_message_at = (SELECT max(m.created_at) FROM channel_messages m WHERE m.channel_id = c.id)`,
  );

  console.log(`
Seed complete. Demo accounts (password: ${DEMO_PASSWORD})
  Ministry   : minister@pacient.local
  Director   : director@pacient.local    (University Clinical Center Prishtina)
  Doctor     : doctor@pacient.local      (Family Medicine, UCC Prishtina)
  Nurse      : nurse@pacient.local       (UCC Prishtina)
  Pharmacist : pharmacist@pacient.local  (UCC Prishtina)
  Reception  : reception@pacient.local   (UCC Prishtina)
  Patient    : patient@pacient.local     (Arta Krasniqi – also guardian of her daughter Lea, 10)
`);
}

main()
  .then(() => pool.end())
  .catch(async (err: unknown) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
