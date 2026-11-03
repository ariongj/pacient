import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  bedMovements,
  beds,
  careAssignments,
  careUnits,
  patients,
  unitStaff,
  users,
} from './schema.js';

const sqDate = (d: Date) =>
  d.toLocaleDateString('sq-AL', { day: 'numeric', month: 'long', year: 'numeric' });

const daysAgo = (d: number, hour = 10) => {
  const t = new Date(Date.now() - d * 86_400_000);
  t.setHours(hour, 0, 0, 0);
  return t;
};

/**
 * Hospital units at the demo facility. Runs first of the hospital seeds: the emergency, births and
 * imaging seeds look their units up by type, so there is exactly one EMERGENCY, RADIOLOGY,
 * MATERNITY and NEONATAL unit.
 */
export async function seedHospital({
  facilityId,
  demoDoctorId,
  demoPatientId,
}: {
  facilityId: string;
  demoDoctorId: string;
  demoPatientId: string;
}) {
  const UNITS = [
    { code: 'INT-A', name: 'Interna A', type: 'GENERAL_WARD', beds: 12, prefix: 'A' },
    { code: 'KIR', name: 'Kirurgjia', type: 'SURGICAL_WARD', beds: 10, prefix: 'K' },
    { code: 'ICU', name: 'Kujdesi intensiv', type: 'ICU', beds: 6, prefix: 'I' },
    { code: 'MAT', name: 'Materniteti', type: 'MATERNITY', beds: 8, prefix: 'M' },
    { code: 'PED', name: 'Pediatria', type: 'PAEDIATRIC', beds: 8, prefix: 'P' },
    { code: 'NEO', name: 'Neonatologjia', type: 'NEONATAL', beds: 6, prefix: 'N' },
    { code: 'EMG', name: 'Emergjenca', type: 'EMERGENCY', beds: 0, prefix: '' },
    { code: 'RAD', name: 'Radiologjia', type: 'RADIOLOGY', beds: 0, prefix: '' },
  ] as const;

  const unit: Record<string, typeof careUnits.$inferSelect> = {};
  const bedIds: Record<string, string[]> = {};
  for (const u of UNITS) {
    const [row] = await db
      .insert(careUnits)
      .values({ facilityId, code: u.code, name: u.name, type: u.type })
      .returning();
    unit[u.code] = row!;
    if (u.beds) {
      const rows = await db
        .insert(beds)
        .values(
          Array.from({ length: u.beds }, (_, i) => ({
            unitId: row!.id,
            label: `${u.prefix}${i + 1}`,
          })),
        )
        .returning({ id: beds.id });
      bedIds[u.code] = rows.map((r) => r.id);
    }
  }

  // Staff assignments.
  const [nurse] = await db.select().from(users).where(eq(users.email, 'nurse@pacient.local'));
  const [reception] = await db
    .select()
    .from(users)
    .where(eq(users.email, 'reception@pacient.local'));
  const doctors = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DOCTOR'), eq(users.isActive, true)),
    );
  const director = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR')))
  )[0];
  const assign = async (code: string, userId: string | undefined) => {
    if (!userId) return;
    await db
      .insert(unitStaff)
      .values({ unitId: unit[code]!.id, userId, assignedById: director?.id ?? null })
      .onConflictDoNothing();
  };
  for (const code of ['INT-A', 'MAT', 'EMG']) await assign(code, nurse?.id);
  for (const code of ['INT-A', 'EMG']) await assign(code, demoDoctorId);
  await assign('EMG', reception?.id);
  const otherDoctors = doctors.map((d) => d.id).filter((id) => id !== demoDoctorId);
  if (otherDoctors[0]) await assign('KIR', otherDoctors[0]);
  if (otherDoctors[1]) await assign('ICU', otherDoctors[1]);

  // Current inpatients: existing patients of the facility (not the demo patient, not duplicates,
  // no temporary identities).
  const candidates = await db
    .select({ id: patients.id, dateOfBirth: patients.dateOfBirth, sex: patients.sex })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, facilityId),
        ne(patients.id, demoPatientId),
        isNull(patients.mergedIntoId),
        isNull(patients.temporaryIdentity),
        sql`${patients.firstName} <> 'Blerim'`,
        sql`${patients.dateOfBirth} < (now() - interval '18 years')::date`,
      ),
    )
    .orderBy(patients.lastName)
    .limit(8);

  const STAYS: {
    code: string;
    bed: number;
    reason: string;
    days: number;
    expectedInDays: number | null;
    doctor: number;
    source: 'EMERGENCY' | 'ELECTIVE' | 'TRANSFER';
  }[] = [
    {
      code: 'INT-A',
      bed: 0,
      reason: 'Pneumoni e fituar në komunitet, dispne',
      days: 3,
      expectedInDays: 0,
      doctor: -1,
      source: 'EMERGENCY',
    },
    {
      code: 'INT-A',
      bed: 1,
      reason: 'Diabet i dekompensuar, hiperglicemi',
      days: 5,
      expectedInDays: 1,
      doctor: -1,
      source: 'EMERGENCY',
    },
    {
      code: 'INT-A',
      bed: 3,
      reason: 'Insuficiencë kardiake e dekompensuar',
      days: 2,
      expectedInDays: 3,
      doctor: -1,
      source: 'EMERGENCY',
    },
    {
      code: 'INT-A',
      bed: 6,
      reason: 'Anemi për hulumtim',
      days: 1,
      expectedInDays: 2,
      doctor: -1,
      source: 'ELECTIVE',
    },
    {
      code: 'KIR',
      bed: 0,
      reason: 'Kolecistektomi laparoskopike e planifikuar',
      days: 1,
      expectedInDays: 1,
      doctor: 0,
      source: 'ELECTIVE',
    },
    {
      code: 'KIR',
      bed: 2,
      reason: 'Apendicit akut – pas operacionit',
      days: 2,
      expectedInDays: 0,
      doctor: 0,
      source: 'EMERGENCY',
    },
    {
      code: 'ICU',
      bed: 0,
      reason: 'Sepsë, monitorim intensiv',
      days: 4,
      expectedInDays: null,
      doctor: 1,
      source: 'TRANSFER',
    },
    {
      code: 'INT-A',
      bed: 8,
      reason: 'Pankreatit akut',
      days: 6,
      expectedInDays: 2,
      doctor: -1,
      source: 'EMERGENCY',
    },
  ];
  for (let i = 0; i < Math.min(STAYS.length, candidates.length); i++) {
    const s = STAYS[i]!;
    const p = candidates[i]!;
    const bedId = bedIds[s.code]![s.bed]!;
    const attendingId = s.doctor < 0 ? demoDoctorId : (otherDoctors[s.doctor] ?? demoDoctorId);
    const admittedAt = daysAgo(s.days, 9 + (i % 8));
    const [a] = await db
      .insert(admissions)
      .values({
        patientId: p.id,
        facilityId,
        unitId: unit[s.code]!.id,
        bedId,
        admittingDoctorId: attendingId,
        attendingDoctorId: attendingId,
        source: s.source,
        reason: s.reason,
        admittedAt,
        expectedDischargeAt:
          s.expectedInDays === null ? null : new Date(Date.now() + s.expectedInDays * 86_400_000),
        createdAt: admittedAt,
      })
      .returning();
    await db.update(beds).set({ status: 'OCCUPIED' }).where(eq(beds.id, bedId));
    await db.insert(bedMovements).values({
      admissionId: a!.id,
      toUnitId: unit[s.code]!.id,
      toBedId: bedId,
      reason: 'Shtrimi',
      movedById: attendingId,
      movedAt: admittedAt,
    });
    const [existing] = await db
      .select({ id: careAssignments.id })
      .from(careAssignments)
      .where(
        and(
          eq(careAssignments.patientId, p.id),
          eq(careAssignments.doctorId, attendingId),
          isNull(careAssignments.endedAt),
        ),
      );
    if (!existing) {
      await db.insert(careAssignments).values({ patientId: p.id, doctorId: attendingId });
    }
  }

  // Beds being cleaned or out of service.
  await db
    .update(beds)
    .set({ status: 'CLEANING' })
    .where(inArray(beds.id, [bedIds['INT-A']![2]!, bedIds['KIR']![1]!]));
  await db
    .update(beds)
    .set({ status: 'OUT_OF_SERVICE', note: 'Riparim i sistemit të oksigjenit' })
    .where(eq(beds.id, bedIds['INT-A']![11]!));

  // The demo patient's past stay: discharged two months ago, summary signed and released.
  const admittedAt = daysAgo(64, 14);
  const dischargedAt = daysAgo(60, 11);
  const summary = [
    'LETËR DALJEJE NGA SPITALI',
    `Shtruar më ${sqDate(admittedAt)} në Interna A. Liruar më ${sqDate(dischargedAt)}.`,
    '',
    'Arsyeja e shtrimit',
    'Kriza hipertensive me dhimbje koke dhe marramendje.',
    '',
    'Diagnozat',
    '- I10 Hipertension esencial (primar)',
    '- E78.5 Hiperlipidemi, e paspecifikuar',
    '',
    'Ecuria gjatë qëndrimit në spital',
    'Tensioni u kontrollua me terapi intravenoze, pastaj orale. EKG pa ndryshime ishemike.',
    'Ekokardiografia: funksion normal i ventrikulit të majtë.',
    '',
    'Terapia në dalje',
    '- Amlodipine 5 mg, një herë në ditë',
    '- Atorvastatin 20 mg, një herë në ditë, në mbrëmje',
    '',
    'Kontrolli i mëtejshëm',
    'Kontroll te mjeku familjar pas 2 javësh, matje e tensionit në shtëpi çdo ditë.',
  ].join('\n');
  const [past] = await db
    .insert(admissions)
    .values({
      patientId: demoPatientId,
      facilityId,
      unitId: unit['INT-A']!.id,
      bedId: bedIds['INT-A']![4]!,
      admittingDoctorId: demoDoctorId,
      attendingDoctorId: demoDoctorId,
      source: 'EMERGENCY',
      reason: 'Kriza hipertensive me dhimbje koke dhe marramendje',
      status: 'DISCHARGED',
      admittedAt,
      dischargedAt,
      dischargedById: demoDoctorId,
      disposition: 'HOME',
      dischargeSummary: summary,
      dischargeSignedAt: dischargedAt,
      releasedToPatientAt: dischargedAt,
      createdAt: admittedAt,
    })
    .returning();
  await db.insert(bedMovements).values({
    admissionId: past!.id,
    toUnitId: unit['INT-A']!.id,
    toBedId: bedIds['INT-A']![4]!,
    reason: 'Shtrimi',
    movedById: demoDoctorId,
    movedAt: admittedAt,
  });
}
