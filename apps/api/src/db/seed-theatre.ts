/** Demo data for operating theatres (development seed only). Text is in Albanian. */
import { and, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  careUnits,
  consentRecords,
  patients,
  surgicalCases,
  unitStaff,
  users,
} from './schema.js';

const minutes = (n: number) => n * 60_000;

export async function seedTheatre({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}) {
  // Two operating theatres.
  const theatres: { id: string; name: string }[] = [];
  for (const [code, name] of [
    ['OT1', 'Salla e operacionit 1'],
    ['OT2', 'Salla e operacionit 2'],
  ] as const) {
    const [existing] = await db
      .select({ id: careUnits.id, name: careUnits.name })
      .from(careUnits)
      .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.code, code)));
    theatres.push(
      existing ??
        (
          await db
            .insert(careUnits)
            .values({ facilityId, code, name, type: 'OPERATING_THEATRE' })
            .returning({ id: careUnits.id, name: careUnits.name })
        )[0]!,
    );
  }
  const ot1 = theatres[0]!;
  const ot2 = theatres[1]!;

  // Team: surgeons of the surgical ward, an anaesthetist from intensive care, demo staff.
  const unitDoctors = async (type: 'SURGICAL_WARD' | 'ICU') =>
    (
      await db
        .select({ id: users.id })
        .from(unitStaff)
        .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
        .innerJoin(users, eq(users.id, unitStaff.userId))
        .where(
          and(
            eq(careUnits.facilityId, facilityId),
            eq(careUnits.type, type),
            eq(users.role, 'DOCTOR'),
          ),
        )
    ).map((r) => r.id);
  const surgeons = (await unitDoctors('SURGICAL_WARD')).filter((id) => id !== demoDoctorId);
  const surgeon = surgeons[0] ?? demoDoctorId;
  const anaesthetist =
    (await unitDoctors('ICU')).find((id) => id !== surgeon && id !== demoDoctorId) ?? null;
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const names = new Map(
    (
      await db
        .select({ id: users.id, name: users.fullName })
        .from(users)
        .where(
          inArray(
            users.id,
            [demoDoctorId, surgeon, anaesthetist, nurse?.id].filter((x): x is string => !!x),
          ),
        )
    ).map((u) => [u.id, u.name]),
  );
  const staff = [
    { unitId: ot1.id, userId: demoDoctorId },
    ...(nurse ? [{ unitId: ot1.id, userId: nurse.id }] : []),
    ...[surgeon, anaesthetist]
      .filter((x): x is string => !!x)
      .flatMap((userId) => [
        { unitId: ot1.id, userId },
        { unitId: ot2.id, userId },
      ]),
  ];
  await db.insert(unitStaff).values(staff).onConflictDoNothing();

  // Patients: those on the surgical ward first, then other adults registered here.
  const onWard = await db
    .select({ id: admissions.patientId })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.type, 'SURGICAL_WARD'),
        eq(admissions.status, 'ADMITTED'),
      ),
    );
  const wardIds = onWard.map((r) => r.id);
  const others = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, facilityId),
        isNull(patients.mergedIntoId),
        isNull(patients.temporaryIdentity),
        sql`${patients.dateOfBirth} < now() - interval '18 years'`,
        wardIds.length ? notInArray(patients.id, wardIds) : undefined,
        ne(patients.lastName, 'Krasniqi'),
      ),
    )
    .orderBy(patients.lastName)
    .limit(8);
  const pool = [...wardIds, ...others.map((r) => r.id)];
  if (pool.length < 7) return;
  const [p1, p2, p3, p4, p5, p6, p7] = pool as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const consent = async (patientId: string, procedure: string) => {
    const [row] = await db
      .insert(consentRecords)
      .values({
        patientId,
        type: 'TREATMENT',
        decision: 'GRANTED',
        method: 'WRITTEN',
        procedure,
        wordingVersion: '2026-1',
        note: 'Përfitimet, rreziqet dhe alternativat u shpjeguan; pacienti pati mundësi të bëjë pyetje.',
        recordedById: surgeon,
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      })
      .returning({ id: consentRecords.id });
    return row!.id;
  };
  const by = (id: string | undefined | null) => ({
    id: id ?? surgeon,
    name: names.get(id ?? surgeon) ?? '',
  });
  const now = Date.now();
  const signIn = (t: number) => ({
    answers: {
      identityConfirmed: true,
      siteMarked: 'YES',
      consentConfirmed: true,
      anaesthesiaCheckComplete: true,
      pulseOximeterFunctioning: true,
      knownAllergy: 'NO',
      difficultAirwayRisk: 'NO',
      bloodLossRisk: 'NO',
    },
    by: by(nurse?.id),
    at: new Date(t).toISOString(),
  });
  const timeOut = (t: number) => ({
    answers: {
      teamIntroduced: true,
      patientSiteProcedureConfirmed: true,
      antibioticProphylaxis: 'GIVEN',
      criticalEventsReviewed: true,
      imagingDisplayed: 'YES',
    },
    by: by(surgeon),
    at: new Date(t).toISOString(),
  });
  const signOut = (t: number) => ({
    answers: {
      procedureRecorded: true,
      countsCorrect: true,
      specimenLabelled: 'YES',
      equipmentProblems: null,
      recoveryConcerns: 'Monitorim standard në sallën e zgjimit.',
    },
    by: by(nurse?.id),
    at: new Date(t).toISOString(),
  });
  const base = {
    facilityId,
    primarySurgeonId: surgeon,
    anaesthetistId: anaesthetist,
    createdById: surgeon,
  };

  // 1. Completed this morning, signed note.
  const start1 = now - minutes(300);
  await db.insert(surgicalCases).values({
    ...base,
    patientId: p1,
    theatreUnitId: ot1.id,
    procedure: 'Apendektomi laparoskopike',
    procedureCode: '0DTJ4ZZ',
    laterality: 'NOT_APPLICABLE',
    priority: 'URGENT',
    indication: 'Apendicit akut, dhimbje në fosën iliake të djathtë prej 24 orësh, leukocitozë.',
    anaesthesiaType: 'GENERAL',
    scheduledStart: new Date(start1),
    estimatedMinutes: 60,
    status: 'COMPLETED',
    consentRecordId: await consent(p1, 'Apendektomi laparoskopike'),
    checklist: {
      signIn: signIn(start1),
      timeOut: timeOut(start1 + minutes(15)),
      signOut: signOut(start1 + minutes(55)),
    },
    inTheatreAt: new Date(start1),
    incisionAt: new Date(start1 + minutes(15)),
    closureAt: new Date(start1 + minutes(55)),
    outOfTheatreAt: new Date(start1 + minutes(65)),
    operationNote:
      'Laparoskopi me tre porta. Apendiksi i inflamuar, pa perforim. Ligim i bazës me dy fije, ' +
      'heqja e apendiksit me qese. Larje e fosës iliake të djathtë. Hemostazë e mirë. ' +
      'Mbyllje e portave. Preparati u dërgua për ekzaminim histopatologjik.',
    complications: 'Asnjë',
    estimatedBloodLossMl: 20,
    noteSignedById: surgeon,
    noteSignedAt: new Date(start1 + minutes(70)),
    createdAt: new Date(start1 - minutes(180)),
  });

  // 2. In theatre right now (sign in and time out done).
  const start2 = now - minutes(40);
  await db.insert(surgicalCases).values({
    ...base,
    patientId: p2,
    theatreUnitId: ot2.id,
    procedure: 'Kolecistektomi laparoskopike',
    laterality: 'NOT_APPLICABLE',
    priority: 'ELECTIVE',
    indication: 'Kolelitiazë simptomatike me kolika biliare të përsëritura.',
    anaesthesiaType: 'GENERAL',
    scheduledStart: new Date(start2),
    estimatedMinutes: 90,
    status: 'IN_THEATRE',
    consentRecordId: await consent(p2, 'Kolecistektomi laparoskopike'),
    checklist: { signIn: signIn(start2), timeOut: timeOut(start2 + minutes(20)) },
    inTheatreAt: new Date(start2),
    incisionAt: new Date(start2 + minutes(20)),
    createdAt: new Date(now - 6 * 86_400_000),
  });

  // 3–4. Later today.
  await db.insert(surgicalCases).values([
    {
      ...base,
      patientId: p3,
      theatreUnitId: ot1.id,
      procedure: 'Hernioplastikë inguinale me rrjetë',
      laterality: 'RIGHT',
      priority: 'ELECTIVE',
      indication: 'Hernie inguinale e djathtë, simptomatike, e reduktueshme.',
      anaesthesiaType: 'SPINAL',
      scheduledStart: new Date(now + minutes(90)),
      estimatedMinutes: 75,
      status: 'SCHEDULED',
      consentRecordId: await consent(p3, 'Hernioplastikë inguinale me rrjetë'),
      createdAt: new Date(now - 10 * 86_400_000),
    },
    {
      ...base,
      patientId: p4,
      theatreUnitId: ot2.id,
      procedure: 'Ekscizion i lipomës së shpinës',
      laterality: 'NOT_APPLICABLE',
      priority: 'ELECTIVE',
      indication: 'Lipomë 4 cm në regjionin skapular, në rritje.',
      anaesthetistId: null,
      anaesthesiaType: 'LOCAL',
      scheduledStart: new Date(now + minutes(150)),
      estimatedMinutes: 30,
      status: 'SCHEDULED',
      consentRecordId: await consent(p4, 'Ekscizion i lipomës së shpinës'),
      createdAt: new Date(now - 14 * 86_400_000),
    },
  ]);

  // 5. Urgent request waiting for a theatre.
  await db.insert(surgicalCases).values({
    ...base,
    patientId: p5,
    procedure: 'Laparoskopi diagnostike',
    laterality: 'NOT_APPLICABLE',
    priority: 'URGENT',
    indication: 'Dhimbje abdominale e paqartë me shenja peritoneale, ekografi jo diagnostike.',
    anaesthesiaType: 'GENERAL',
    estimatedMinutes: 60,
    status: 'REQUESTED',
    createdAt: new Date(now - minutes(45)),
  });

  // 6–7. Tomorrow's electives.
  const tomorrow = new Date(now + 86_400_000);
  tomorrow.setUTCHours(7, 0, 0, 0); // 08:00 in Kosovo (winter time)
  await db.insert(surgicalCases).values([
    {
      ...base,
      patientId: p6,
      theatreUnitId: ot1.id,
      procedure: 'Artroskopi e gjurit me meniskektomi parciale',
      laterality: 'LEFT',
      priority: 'ELECTIVE',
      indication: 'Lëndim i meniskut medial të gjurit të majtë, i konfirmuar me MRI.',
      anaesthesiaType: 'SPINAL',
      scheduledStart: tomorrow,
      estimatedMinutes: 60,
      status: 'SCHEDULED',
      consentRecordId: await consent(p6, 'Artroskopi e gjurit me meniskektomi parciale'),
    },
    {
      ...base,
      patientId: p7,
      theatreUnitId: ot2.id,
      procedure: 'Tiroidektomi totale',
      laterality: 'NOT_APPLICABLE',
      priority: 'ELECTIVE',
      indication: 'Strumë multinodulare me simptoma kompresive.',
      anaesthesiaType: 'GENERAL',
      scheduledStart: new Date(tomorrow.getTime() + minutes(60)),
      estimatedMinutes: 150,
      status: 'SCHEDULED',
      consentRecordId: await consent(p7, 'Tiroidektomi totale'),
    },
  ]);
}
