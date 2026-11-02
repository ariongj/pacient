import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { careAssignments, facilities, patients, users, type Role } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';

export const app = createApp();
export const api = () => request(app);
export const PASSWORD = 'correct-horse-battery-staple';

let passwordHash: Promise<string> | undefined;
const uniq = () => randomUUID().slice(0, 8);
let nationalSeq = Math.floor(Math.random() * 1e6) * 1000;
export const nextNationalId = () => String(5_000_000_000 + nationalSeq++).padStart(10, '0');

export async function createFacility(overrides: Partial<typeof facilities.$inferInsert> = {}) {
  const [row] = await db
    .insert(facilities)
    .values({
      code: `F-${uniq()}`.toUpperCase(),
      name: `Facility ${uniq()}`,
      type: 'REGIONAL_HOSPITAL',
      region: 'Prishtinë',
      municipality: 'Prishtinë',
      ...overrides,
    })
    .returning();
  return row!;
}

export async function createUser(role: Role, facilityId: string | null = null, extra = {}) {
  passwordHash ??= hashPassword(PASSWORD);
  const [row] = await db
    .insert(users)
    .values({
      email: `${role.toLowerCase()}-${uniq()}@test.local`,
      fullName: `${role} ${uniq()}`,
      role,
      facilityId,
      passwordHash: await passwordHash,
      passwordChangedAt: new Date(),
      ...(role === 'DOCTOR' ? { licenseNumber: 'LIC-1', specialty: 'Family Medicine' } : {}),
      ...(role === 'NURSE' || role === 'PHARMACIST' ? { licenseNumber: 'LIC-2' } : {}),
      ...extra,
    })
    .returning();
  return row!;
}

export async function createPatient(
  facilityId: string,
  opts: { userId?: string; doctorId?: string } = {},
) {
  const [row] = await db
    .insert(patients)
    .values({
      nationalId: nextNationalId(),
      firstName: 'Test',
      lastName: `Patient${uniq()}`,
      dateOfBirth: '1990-01-01',
      sex: 'FEMALE',
      primaryFacilityId: facilityId,
      userId: opts.userId ?? null,
    })
    .returning();
  if (opts.doctorId) {
    await db.insert(careAssignments).values({ patientId: row!.id, doctorId: opts.doctorId });
  }
  return row!;
}

export async function login(email: string, password = PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status}`);
  return res.body.accessToken as string;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A small world with every role: two facilities, staff, and patients with care relationships. */
export async function createWorld() {
  const facility = await createFacility();
  const otherFacility = await createFacility();
  const users = {
    ministry: await createUser('MINISTRY'),
    director: await createUser('DIRECTOR', facility.id),
    otherDirector: await createUser('DIRECTOR', otherFacility.id),
    doctor: await createUser('DOCTOR', facility.id),
    colleague: await createUser('DOCTOR', facility.id),
    outsideDoctor: await createUser('DOCTOR', otherFacility.id),
    nurse: await createUser('NURSE', facility.id),
    pharmacist: await createUser('PHARMACIST', facility.id),
    outsidePharmacist: await createUser('PHARMACIST', otherFacility.id),
    reception: await createUser('RECEPTION', facility.id),
    patientUser: await createUser('PATIENT'),
    otherPatientUser: await createUser('PATIENT'),
  };
  const patient = await createPatient(facility.id, {
    userId: users.patientUser.id,
    doctorId: users.doctor.id,
  });
  const otherPatient = await createPatient(facility.id, { userId: users.otherPatientUser.id });

  const keys = Object.keys(users) as (keyof typeof users)[];
  const tokenList = await Promise.all(keys.map((k) => login(users[k].email)));
  const byKey = Object.fromEntries(keys.map((k, i) => [k, tokenList[i]!])) as Record<
    keyof typeof users,
    string
  >;

  return {
    facility,
    otherFacility,
    users,
    patient,
    otherPatient,
    tokens: {
      ministry: byKey.ministry,
      director: byKey.director,
      otherDirector: byKey.otherDirector,
      doctor: byKey.doctor,
      colleague: byKey.colleague,
      outsideDoctor: byKey.outsideDoctor,
      nurse: byKey.nurse,
      pharmacist: byKey.pharmacist,
      outsidePharmacist: byKey.outsidePharmacist,
      reception: byKey.reception,
      patient: byKey.patientUser,
      otherPatient: byKey.otherPatientUser,
    },
  };
}
