/**
 * Demo data for the emergency department (development seed only). Runs after seedHospital, which
 * normally creates the facility's EMERGENCY unit and assigns staff; anything missing is created
 * here so the board always has something to show.
 */
import { and, asc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  careUnits,
  edVisits,
  patients,
  unitStaff,
  users,
  vitalSigns,
} from './schema.js';

const MIN = 60_000;

export async function seedEmergency({ facilityId }: { facilityId: string }) {
  // The emergency department of the demo facility.
  let [unit] = await db
    .select()
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.type, 'EMERGENCY')))
    .limit(1);
  if (!unit) {
    [unit] = await db
      .insert(careUnits)
      .values({ facilityId, name: 'Emergjenca', code: 'URG', type: 'EMERGENCY' })
      .returning();
  }
  const unitId = unit!.id;

  const staff = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(
      inArray(users.email, [
        'doctor@pacient.local',
        'nurse@pacient.local',
        'reception@pacient.local',
      ]),
    );
  const byEmail = (e: string) => staff.find((s) => s.email === e)!;
  const doctor = byEmail('doctor@pacient.local');
  const nurse = byEmail('nurse@pacient.local');
  const reception = byEmail('reception@pacient.local');
  // A second emergency physician so assignments have a choice.
  const [colleague] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.facilityId, facilityId),
        eq(users.role, 'DOCTOR'),
        sql`${users.email} <> 'doctor@pacient.local'`,
      ),
    )
    .orderBy(asc(users.email))
    .limit(1);
  await db
    .insert(unitStaff)
    .values(
      [doctor.id, nurse.id, reception.id, colleague?.id]
        .filter((id): id is string => Boolean(id))
        .map((userId) => ({ unitId, userId })),
    )
    .onConflictDoNothing();

  // Patients registered at the facility without a portal account, not in hospital right now.
  const candidates = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, facilityId),
        isNull(patients.userId),
        isNull(patients.mergedIntoId),
        isNull(patients.temporaryIdentity),
        notExists(
          db
            .select({ one: sql`1` })
            .from(admissions)
            .where(and(eq(admissions.patientId, patients.id), eq(admissions.status, 'ADMITTED'))),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(edVisits)
            .where(
              and(
                eq(edVisits.patientId, patients.id),
                inArray(edVisits.status, ['WAITING', 'IN_TREATMENT']),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(patients.lastName), asc(patients.firstName))
    .limit(10);
  const pick = (i: number) => candidates[i]?.id;

  // An unidentified patient brought in by ambulance.
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const [unknown] = await db
    .insert(patients)
    .values({
      nationalId: `TMP${stamp}${String(Math.floor(1000 + Math.random() * 9000))}`,
      firstName: 'Pacient',
      lastName: 'i panjohur',
      dateOfBirth: '1986-01-01',
      sex: 'MALE',
      primaryFacilityId: facilityId,
      temporaryIdentity: 'UNIDENTIFIED',
      identityNote:
        'Burrë rreth 40 vjeç, xhaketë e zezë, pa dokumente. Sjellë nga ambulanca; mosha është e vlerësuar.',
    })
    .returning();

  const now = Date.now();
  type Open = {
    patientId: string | undefined;
    minutesAgo: number;
    mode: (typeof edVisits.$inferInsert)['arrivalMode'];
    complaint: string;
    level: number | null;
    note?: string;
    inTreatment?: boolean;
    vitals?: Partial<typeof vitalSigns.$inferInsert>;
  };
  const open: Open[] = [
    {
      patientId: pick(0),
      minutesAgo: 25,
      mode: 'AMBULANCE',
      complaint: 'Dhimbje gjoksi me përhapje në krahun e majtë, djersitje',
      level: 1,
      note: 'EKG me ngritje të segmentit ST – njoftuar kardiologu',
      inTreatment: true,
      vitals: {
        systolic: 88,
        diastolic: 54,
        heartRate: 124,
        oxygenSaturation: 90,
        respiratoryRate: 26,
      },
    },
    {
      patientId: unknown!.id,
      minutesAgo: 40,
      mode: 'AMBULANCE',
      complaint: 'Gjetur pa vetëdije në rrugë, plagë në kokë',
      level: 2,
      note: 'GCS 11, pupilat të barabarta – kërkuar CT e kokës',
      inTreatment: true,
      vitals: { systolic: 150, diastolic: 90, heartRate: 96, oxygenSaturation: 95 },
    },
    {
      patientId: pick(1),
      minutesAgo: 8,
      mode: 'WALK_IN',
      complaint: 'Vështirësi në frymëmarrje, astmë e njohur',
      level: 2,
      note: 'Fishkëllimë e theksuar, flet me fjali të shkurtra',
      vitals: { heartRate: 112, oxygenSaturation: 89, respiratoryRate: 28 },
    },
    {
      patientId: pick(2),
      minutesAgo: 50,
      mode: 'WALK_IN',
      complaint: 'Dhimbje barku në anën e djathtë, temperaturë',
      level: 3,
      note: 'Dhimbje në pikën e McBurney-t',
      vitals: { temperatureC: '38.4', heartRate: 102, systolic: 128, diastolic: 80 },
    },
    {
      patientId: pick(3),
      minutesAgo: 135,
      mode: 'WALK_IN',
      complaint: 'Lëndim i kyçit të dorës pas rënies',
      level: 4,
      note: 'Ënjtje, pa deformim të dukshëm – VAS 5/10',
    },
    {
      patientId: pick(4),
      minutesAgo: 70,
      mode: 'REFERRAL',
      complaint: 'Kollë dhe rrufë prej tre ditësh',
      level: 5,
    },
    {
      patientId: pick(5),
      minutesAgo: 6,
      mode: 'WALK_IN',
      complaint: 'Marramendje dhe të përziera',
      level: null,
    },
  ];

  for (const o of open) {
    if (!o.patientId) continue;
    const arrivedAt = new Date(now - o.minutesAgo * MIN);
    const [visit] = await db
      .insert(edVisits)
      .values({
        patientId: o.patientId,
        facilityId,
        unitId,
        arrivedAt,
        arrivalMode: o.mode,
        chiefComplaint: o.complaint,
        registeredById: reception.id,
        triageLevel: o.level,
        triageNote: o.note ?? null,
        triagedById: o.level ? nurse.id : null,
        triagedAt: o.level ? new Date(arrivedAt.getTime() + 3 * MIN) : null,
        status: o.inTreatment ? 'IN_TREATMENT' : 'WAITING',
        assignedDoctorId: o.inTreatment ? doctor.id : null,
        seenAt: o.inTreatment ? new Date(arrivedAt.getTime() + 4 * MIN) : null,
      })
      .returning();
    if (o.vitals) {
      await db.insert(vitalSigns).values({
        patientId: o.patientId,
        recordedById: nurse.id,
        recordedAt: new Date(arrivedAt.getTime() + 3 * MIN),
        ...o.vitals,
      });
    }
    void visit;
  }

  // Departures earlier today.
  const departed: {
    patientId: string | undefined;
    arrivedHoursAgo: number;
    stayedMinutes: number;
    status: 'DISCHARGED' | 'LEFT_WITHOUT_BEING_SEEN' | 'TRANSFERRED';
    complaint: string;
    level: number | null;
    note?: string;
  }[] = [
    {
      patientId: pick(6),
      arrivedHoursAgo: 5,
      stayedMinutes: 110,
      status: 'DISCHARGED',
      complaint: 'Prerje në gisht me thikë kuzhine',
      level: 4,
      note: 'Qepje me 3 pika, kontroll te mjeku familjar pas 7 ditësh',
    },
    {
      patientId: pick(7),
      arrivedHoursAgo: 4,
      stayedMinutes: 95,
      status: 'LEFT_WITHOUT_BEING_SEEN',
      complaint: 'Dhimbje fyti',
      level: 5,
    },
    {
      patientId: pick(8),
      arrivedHoursAgo: 7,
      stayedMinutes: 150,
      status: 'TRANSFERRED',
      complaint: 'Djegie e dorës me ujë të valë',
      level: 3,
      note: 'Transferuar në Qendrën e Djegieve',
    },
  ];
  for (const d of departed) {
    if (!d.patientId) continue;
    const arrivedAt = new Date(now - d.arrivedHoursAgo * 3_600_000);
    await db.insert(edVisits).values({
      patientId: d.patientId,
      facilityId,
      unitId,
      arrivedAt,
      arrivalMode: 'WALK_IN',
      chiefComplaint: d.complaint,
      registeredById: reception.id,
      triageLevel: d.level,
      triagedById: d.level ? nurse.id : null,
      triagedAt: d.level ? new Date(arrivedAt.getTime() + 5 * MIN) : null,
      status: d.status,
      assignedDoctorId: d.status === 'LEFT_WITHOUT_BEING_SEEN' ? null : doctor.id,
      seenAt:
        d.status === 'LEFT_WITHOUT_BEING_SEEN' ? null : new Date(arrivedAt.getTime() + 30 * MIN),
      departedAt: new Date(arrivedAt.getTime() + d.stayedMinutes * MIN),
      dispositionNote: d.note ?? null,
    });
  }

  // An attendance that ended with an admission, if the hospital seed admitted someone from the
  // emergency department.
  const [admitted] = await db
    .select()
    .from(admissions)
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        eq(admissions.status, 'ADMITTED'),
        isNull(admissions.edVisitId),
      ),
    )
    .orderBy(asc(admissions.admittedAt))
    .limit(1);
  if (admitted) {
    const arrivedAt = new Date(admitted.admittedAt.getTime() - 150 * MIN);
    const [visit] = await db
      .insert(edVisits)
      .values({
        patientId: admitted.patientId,
        facilityId,
        unitId,
        arrivedAt,
        arrivalMode: 'AMBULANCE',
        chiefComplaint: admitted.reason.slice(0, 300),
        registeredById: reception.id,
        triageLevel: 2,
        triagedById: nurse.id,
        triagedAt: new Date(arrivedAt.getTime() + 4 * MIN),
        status: 'ADMITTED',
        assignedDoctorId: doctor.id,
        seenAt: new Date(arrivedAt.getTime() + 12 * MIN),
        departedAt: admitted.admittedAt,
        admissionId: admitted.id,
      })
      .returning();
    await db.update(admissions).set({ edVisitId: visit!.id }).where(eq(admissions.id, admitted.id));
  }
}
