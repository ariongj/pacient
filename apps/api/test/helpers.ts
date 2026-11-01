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

/** A small world with every tier: two facilities, staff, and patients with care relationships. */
export async function createWorld() {
  const facility = await createFacility();
  const otherFacility = await createFacility();
  const ministry = await createUser('MINISTRY');
  const director = await createUser('DIRECTOR', facility.id);
  const otherDirector = await createUser('DIRECTOR', otherFacility.id);
  const doctor = await createUser('DOCTOR', facility.id);
  const colleague = await createUser('DOCTOR', facility.id);
  const outsideDoctor = await createUser('DOCTOR', otherFacility.id);
  const patientUser = await createUser('PATIENT');
  const patient = await createPatient(facility.id, { userId: patientUser.id, doctorId: doctor.id });
  const otherPatientUser = await createUser('PATIENT');
  const otherPatient = await createPatient(facility.id, { userId: otherPatientUser.id });

  const [
    tMinistry,
    tDirector,
    tOtherDirector,
    tDoctor,
    tColleague,
    tOutside,
    tPatient,
    tOtherPatient,
  ] = await Promise.all(
    [
      ministry,
      director,
      otherDirector,
      doctor,
      colleague,
      outsideDoctor,
      patientUser,
      otherPatientUser,
    ].map((u) => login(u.email)),
  );

  return {
    facility,
    otherFacility,
    users: {
      ministry,
      director,
      otherDirector,
      doctor,
      colleague,
      outsideDoctor,
      patientUser,
      otherPatientUser,
    },
    patient,
    otherPatient,
    tokens: {
      ministry: tMinistry!,
      director: tDirector!,
      otherDirector: tOtherDirector!,
      doctor: tDoctor!,
      colleague: tColleague!,
      outsideDoctor: tOutside!,
      patient: tPatient!,
      otherPatient: tOtherPatient!,
    },
  };
}
