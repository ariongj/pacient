/**
 * Demo data for births and temporary identities (development seed only). Runs after seedHospital,
 * which creates the care units; if no maternity unit exists, one is created here.
 */
import { and, eq } from 'drizzle-orm';
import {
  kosovoDate,
  newTemporaryNumber,
  shortCode,
} from '../modules/identity/identity.service.js';
import { db } from './client.js';
import {
  admissions,
  bedMovements,
  beds,
  births,
  careAssignments,
  careUnits,
  patients,
  vitalSigns,
} from './schema.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function freeNationalId(seed: number) {
  for (let n = seed; ; n++) {
    const candidate = String(n).padStart(10, '0');
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.nationalId, candidate));
    if (!taken) return candidate;
  }
}

async function maternityUnit(facilityId: string) {
  const [unit] = await db
    .select()
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.type, 'MATERNITY')));
  if (unit) return unit;
  const [created] = await db
    .insert(careUnits)
    .values({ facilityId, name: 'Materniteti', code: 'MAT', type: 'MATERNITY' })
    .returning();
  await db
    .insert(beds)
    .values(['M1', 'M2', 'M3', 'M4'].map((label) => ({ unitId: created!.id, label })));
  return created!;
}

export async function seedBirths({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}) {
  const now = Date.now();
  const unit = await maternityUnit(facilityId);

  /* A mother in labour admitted yesterday; her daughter was born this morning (rooming-in). */
  const [drita] = await db
    .insert(patients)
    .values({
      nationalId: await freeNationalId(1197100001),
      firstName: 'Drita',
      lastName: 'Hoxha',
      dateOfBirth: kosovoDate(new Date(now - 29.3 * 365.25 * DAY)),
      sex: 'FEMALE',
      bloodType: 'O+',
      phone: '+383 44 552 731',
      address: 'Rr. Nënë Tereza 18',
      municipality: 'Prishtinë',
      primaryFacilityId: facilityId,
    })
    .returning();
  await db
    .insert(careAssignments)
    .values({ patientId: drita!.id, doctorId: demoDoctorId, assignedById: demoDoctorId });

  const [bed] = await db
    .select()
    .from(beds)
    .where(and(eq(beds.unitId, unit.id), eq(beds.status, 'AVAILABLE')))
    .limit(1);
  const admittedAt = new Date(now - 20 * HOUR);
  const [stay] = await db
    .insert(admissions)
    .values({
      patientId: drita!.id,
      facilityId,
      unitId: unit.id,
      bedId: bed?.id ?? null,
      admittingDoctorId: demoDoctorId,
      attendingDoctorId: demoDoctorId,
      source: 'ELECTIVE',
      reason: 'Lindje e parë në afat, dhimbje të rregullta lindjeje',
      admittedAt,
      expectedDischargeAt: new Date(now + 2 * DAY),
    })
    .returning();
  if (bed) await db.update(beds).set({ status: 'OCCUPIED' }).where(eq(beds.id, bed.id));
  await db.insert(bedMovements).values({
    admissionId: stay!.id,
    toUnitId: unit.id,
    toBedId: bed?.id ?? null,
    movedById: demoDoctorId,
    movedAt: admittedAt,
    reason: 'Pranim në maternitet',
  });

  const bornAt = new Date(now - 5 * HOUR);
  const [baby] = await db
    .insert(patients)
    .values({
      nationalId: await newTemporaryNumber(db, bornAt),
      firstName: 'Foshnja',
      lastName: 'Hoxha',
      dateOfBirth: kosovoDate(bornAt),
      sex: 'FEMALE',
      phone: drita!.phone,
      address: drita!.address,
      municipality: drita!.municipality,
      primaryFacilityId: facilityId,
      temporaryIdentity: 'NEWBORN',
      identityNote: 'Drita Hoxha',
    })
    .returning();
  await db.insert(births).values({
    motherPatientId: drita!.id,
    newbornPatientId: baby!.id,
    facilityId,
    motherAdmissionId: stay!.id,
    bornAt,
    deliveryType: 'SPONTANEOUS_VAGINAL',
    gestationalWeeks: 39,
    gestationalDays: 4,
    birthWeightGrams: 3420,
    lengthCm: '50.5',
    headCircumferenceCm: '34.5',
    apgar1: 8,
    apgar5: 9,
    attendantId: demoDoctorId,
    notes: 'Lindje pa komplikime. Kontakt lëkurë më lëkurë menjëherë pas lindjes; ushqyerja me gji filloi brenda orës së parë.',
  });
  await db
    .insert(careAssignments)
    .values({ patientId: baby!.id, doctorId: demoDoctorId, assignedById: demoDoctorId });
  await db.insert(vitalSigns).values({
    patientId: baby!.id,
    recordedById: demoDoctorId,
    weightKg: '3.4',
    heightCm: '50.5',
    recordedAt: bornAt,
  });
  const [babyStay] = await db
    .insert(admissions)
    .values({
      patientId: baby!.id,
      facilityId,
      unitId: unit.id,
      admittingDoctorId: demoDoctorId,
      attendingDoctorId: demoDoctorId,
      source: 'BIRTH',
      reason: 'Newborn rooming-in with mother',
      admittedAt: bornAt,
    })
    .returning();
  await db.insert(bedMovements).values({
    admissionId: babyStay!.id,
    toUnitId: unit.id,
    movedById: demoDoctorId,
    movedAt: bornAt,
    reason: 'Newborn rooming-in with mother',
  });

  /* A birth three weeks ago, already registered with the civil registry. */
  const [vjosa] = await db
    .insert(patients)
    .values({
      nationalId: await freeNationalId(1199200001),
      firstName: 'Vjosa',
      lastName: 'Berisha',
      dateOfBirth: kosovoDate(new Date(now - 31.6 * 365.25 * DAY)),
      sex: 'FEMALE',
      bloodType: 'A+',
      phone: '+383 49 318 220',
      address: 'Rr. Agim Ramadani 7',
      municipality: 'Prishtinë',
      primaryFacilityId: facilityId,
    })
    .returning();
  await db
    .insert(careAssignments)
    .values({ patientId: vjosa!.id, doctorId: demoDoctorId, assignedById: demoDoctorId });
  const bornEarlier = new Date(now - 21 * DAY - 3 * HOUR);
  const [lirim] = await db
    .insert(patients)
    .values({
      nationalId: await freeNationalId(1226000001),
      firstName: 'Lirim',
      lastName: 'Berisha',
      dateOfBirth: kosovoDate(bornEarlier),
      sex: 'MALE',
      phone: vjosa!.phone,
      address: vjosa!.address,
      municipality: vjosa!.municipality,
      primaryFacilityId: facilityId,
      identityNote: 'Vjosa Berisha',
      identityConfirmedAt: new Date(now - 17 * DAY),
    })
    .returning();
  await db.insert(births).values({
    motherPatientId: vjosa!.id,
    newbornPatientId: lirim!.id,
    facilityId,
    bornAt: bornEarlier,
    deliveryType: 'CAESAREAN_EMERGENCY',
    gestationalWeeks: 37,
    gestationalDays: 1,
    birthWeightGrams: 2890,
    lengthCm: '48.0',
    headCircumferenceCm: '33.5',
    apgar1: 7,
    apgar5: 9,
    apgar10: 10,
    attendantId: demoDoctorId,
    notes: 'Seksion cezarian urgjent për ritëm kardiak fetal jo të qëndrueshëm. Foshnja u përshtat mirë.',
    civilRegisteredAt: new Date(now - 17 * DAY),
  });
  await db
    .insert(careAssignments)
    .values({ patientId: lirim!.id, doctorId: demoDoctorId, assignedById: demoDoctorId });

  /* An adult brought in without documents, waiting to be identified. */
  const number = await newTemporaryNumber(db);
  await db.insert(patients).values({
    nationalId: number,
    firstName: 'Unknown',
    lastName: shortCode(number),
    dateOfBirth: `${new Date(now).getFullYear() - 45}-01-01`,
    sex: 'MALE',
    primaryFacilityId: facilityId,
    temporaryIdentity: 'UNIDENTIFIED',
    identityNote: 'Burrë, rreth 45 vjeç, i gjetur pa vetëdije në stacionin e autobusëve; i sjellë me ambulancë.',
    createdAt: new Date(now - 3 * HOUR),
  });
}
