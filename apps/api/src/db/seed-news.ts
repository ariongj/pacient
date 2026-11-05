/**
 * Demo data for NEWS2 (development seed only): observations of the current inpatients over the last
 * 24 hours, scored through the real scoring and escalation code so the early-warning board shows a
 * deteriorating (septic) patient, an urgent review, a single "red" parameter and an overdue set.
 * Two children on the paediatric ward (Pediatria) are scored with PEWS: a toddler with a chest
 * infection needing urgent review (MEDIUM) and a school-age child recovering (LOW).
 */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  careAssignments,
  admissions,
  bedMovements,
  beds,
  careUnits,
  patients,
  users,
  vitalSigns,
} from './schema.js';
import { scoreVitalSign } from '../modules/news/news.service.js';

type Obs = {
  hoursAgo: number;
  rr: number;
  spo2: number;
  o2: boolean;
  sbp: number;
  dbp: number;
  hr: number;
  acvpu: 'A' | 'C' | 'V' | 'P' | 'U';
  temp: number;
  pain?: number;
};

const normal = (hoursAgo: number, over: Partial<Obs> = {}): Obs => ({
  hoursAgo,
  rr: 16,
  spo2: 97,
  o2: false,
  sbp: 124,
  dbp: 78,
  hr: 76,
  acvpu: 'A',
  temp: 36.8,
  ...over,
});

/** Observation series per inpatient, oldest first. */
const PROFILES: Obs[][] = [
  // Sepsis developing over the day: LOW → MEDIUM → HIGH.
  [
    normal(22, { hr: 92, temp: 37.9 }),
    normal(8, { rr: 22, hr: 108, temp: 38.6, sbp: 106, spo2: 95 }),
    normal(0.5, { rr: 26, spo2: 93, sbp: 92, dbp: 54, hr: 124, temp: 39.3, pain: 6 }),
  ],
  // On oxygen with tachycardia and tachypnoea: urgent review (MEDIUM).
  [
    normal(14, { spo2: 95, hr: 96 }),
    normal(1, { rr: 22, spo2: 94, o2: true, hr: 108, temp: 37.6 }),
  ],
  // New confusion, everything else normal: a single parameter scoring 3.
  [normal(10), normal(0.7, { acvpu: 'C' })],
  // Low score but the last set is 7 hours old: observations overdue.
  [normal(13, { hr: 94 }), normal(7, { hr: 95, temp: 38.2 })],
];

export async function seedNews({ facilityId }: { facilityId: string }) {
  const stays = await db
    .select({ id: admissions.id, patientId: admissions.patientId })
    .from(admissions)
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        eq(admissions.status, 'ADMITTED'),
        isNotNull(admissions.bedId),
      ),
    )
    .orderBy(asc(admissions.admittedAt));
  if (!stays.length) return;
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), eq(users.role, 'NURSE')))
    .limit(1);
  if (!nurse) return;

  for (const [i, stay] of stays.entries()) {
    const series = PROFILES[i] ?? [normal(9), normal(2.5, { hr: 80 })];
    await record(stay.patientId, nurse.id, series);
  }
  await seedPaediatric(facilityId, nurse.id);
}

async function record(patientId: string, nurseId: string, series: Obs[]) {
  for (const o of series) {
    const [v] = await db
      .insert(vitalSigns)
      .values({
        patientId,
        recordedById: nurseId,
        respiratoryRate: o.rr,
        oxygenSaturation: o.spo2,
        onSupplementalOxygen: o.o2,
        systolic: o.sbp,
        diastolic: o.dbp,
        heartRate: o.hr,
        consciousness: o.acvpu,
        temperatureC: o.temp.toFixed(1),
        painScore: o.pain ?? null,
        recordedAt: new Date(Date.now() - o.hoursAgo * 3_600_000),
      })
      .returning({ id: vitalSigns.id });
    await scoreVitalSign(v!.id);
  }
}

const yearsAgo = (years: number, extraDays = 0) => {
  const d = new Date(Date.now() - extraDays * 86_400_000);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};

/** Two children admitted to the paediatric ward, observed and scored with PEWS. */
async function seedPaediatric(facilityId: string, nurseId: string) {
  const [unit] = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.type, 'PAEDIATRIC')))
    .limit(1);
  const [doctor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'doctor@pacient.local'))
    .limit(1);
  if (!unit || !doctor) return;
  const freeBeds = await db
    .select({ id: beds.id })
    .from(beds)
    .where(and(eq(beds.unitId, unit.id), eq(beds.status, 'AVAILABLE')))
    .orderBy(asc(beds.label))
    .limit(2);
  const CHILDREN = [
    {
      firstName: 'Ardit',
      lastName: 'Krasniqi',
      dateOfBirth: yearsAgo(3, 40),
      sex: 'MALE' as const,
      reason: 'Bronkopneumoni, temperaturë dhe frymëmarrje e shpejtë',
      // Toddler band: RR 44 (1) + HR 152 (2) + SpO2 94 (1) + 38.4 °C (1) = PEWS 5, MEDIUM.
      series: [
        normal(10, { rr: 34, spo2: 96, sbp: 96, dbp: 60, hr: 128, temp: 37.9 }),
        normal(0.8, { rr: 44, spo2: 94, sbp: 95, dbp: 58, hr: 152, temp: 38.4 }),
      ],
    },
    {
      firstName: 'Elira',
      lastName: 'Berisha',
      dateOfBirth: yearsAgo(9, 120),
      sex: 'FEMALE' as const,
      reason: 'Gastroenterit me dehidrim, në rehidrim intravenoz',
      // Child band, all observations in range: PEWS 0, LOW.
      series: [
        normal(9, { rr: 24, sbp: 100, dbp: 62, hr: 112, temp: 37.4 }),
        normal(2, { rr: 20, spo2: 98, sbp: 104, dbp: 66, hr: 94, temp: 37.0 }),
      ],
    },
  ];
  for (const [i, c] of CHILDREN.entries()) {
    const bedId = freeBeds[i]?.id;
    if (!bedId) return;
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: await freeNationalId(1299400001 + i * 7),
        firstName: c.firstName,
        lastName: c.lastName,
        dateOfBirth: c.dateOfBirth,
        sex: c.sex,
        primaryFacilityId: facilityId,
      })
      .returning({ id: patients.id });
    const admittedAt = new Date(Date.now() - (30 + i * 12) * 3_600_000);
    const [a] = await db
      .insert(admissions)
      .values({
        patientId: p!.id,
        facilityId,
        unitId: unit.id,
        bedId,
        admittingDoctorId: doctor.id,
        attendingDoctorId: doctor.id,
        source: 'EMERGENCY',
        reason: c.reason,
        admittedAt,
        createdAt: admittedAt,
      })
      .returning({ id: admissions.id });
    await db.update(beds).set({ status: 'OCCUPIED' }).where(eq(beds.id, bedId));
    // As in a real admission, the attending doctor joins the care team.
    await db
      .insert(careAssignments)
      .values({ patientId: p!.id, doctorId: doctor.id, assignedById: doctor.id });
    await db.insert(bedMovements).values({
      admissionId: a!.id,
      toUnitId: unit.id,
      toBedId: bedId,
      reason: 'Shtrimi',
      movedById: doctor.id,
      movedAt: admittedAt,
    });
    await record(p!.id, nurseId, c.series);
  }
}

async function freeNationalId(start: number) {
  for (let n = start; ; n++) {
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(sql`${patients.nationalId} = ${String(n)}`);
    if (!taken) return String(n);
  }
}
