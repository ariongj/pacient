import { and, eq, isNull, ne } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { births, careAssignments, patients, users } from '../../db/schema.js';
import { badRequest, conflict, HttpError } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { assertNotMerged } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyCareTeam, notifyPatient } from '../notifications/notifications.service.js';

/**
 * Temporary identities: a newborn has no national number until the civil registry issues one,
 * and an unconscious or confused patient may arrive without documents. Such records get a
 * generated number (TMP + yymmdd + 4 digits) in the national-ID column until the real identity is
 * confirmed. Placeholder names make the record unmistakable in every list.
 */
export const TEMPORARY_PREFIX = 'TMP';
export const isTemporaryNumber = (n: string) => /^TMP\d{10}$/.test(n);
/** Shown for unidentified patients (the UI translates and appends the short code). */
export const UNKNOWN_FIRST_NAME = 'Unknown';
/** Used for newborns without a chosen first name yet ("Foshnja Hoxha"). */
export const NEWBORN_PLACEHOLDER_FIRST_NAME = 'Foshnja';

/** Calendar date in Kosovo for a moment in time (YYYY-MM-DD). */
export function kosovoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export async function newTemporaryNumber(executor: Executor = db, now = new Date()) {
  const ymd = kosovoDate(now).replace(/-/g, '').slice(2);
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${TEMPORARY_PREFIX}${ymd}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    const [taken] = await executor
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.nationalId, candidate));
    if (!taken) return candidate;
  }
  throw new HttpError(503, 'TEMPORARY_NUMBERS_EXHAUSTED', 'Could not allocate a temporary number');
}

/** "#4821" – the short code shown after "Unknown patient". */
export const shortCode = (temporaryNumber: string) => `#${temporaryNumber.slice(-4)}`;

const NATIONAL_ID = /^[0-9]{10}$/;
export type Sex = 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';

/**
 * Replaces a temporary identity with the person's real one. Used by staff (reception, director,
 * clinicians) and by the civil-registry interface. If the national ID already belongs to another
 * record, nothing changes: the director must merge the two records (409 IDENTITY_EXISTS).
 */
export async function confirmIdentity(
  input: {
    patientId: string;
    nationalId: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: Sex;
  },
  actor: {
    ctx: AuthContext | null;
    via: 'STAFF' | 'CIVIL_REGISTRY';
    meta?: RequestMeta;
    clientName?: string;
  },
): Promise<{ patientId: string }> {
  const nationalId = input.nationalId.trim();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!NATIONAL_ID.test(nationalId)) throw badRequest('National ID must be exactly 10 digits');
  if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
    throw badRequest('First and last name are required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth) || input.dateOfBirth > kosovoDate(new Date())) {
    throw badRequest('Enter a valid date of birth that is not in the future');
  }

  return db.transaction(async (tx) => {
    const [patient] = await tx
      .select()
      .from(patients)
      .where(eq(patients.id, input.patientId))
      .for('update');
    if (!patient) throw new HttpError(404, 'NOT_FOUND', 'Patient not found');
    assertNotMerged(patient);
    if (!patient.temporaryIdentity) {
      throw conflict('This record already has a confirmed identity');
    }
    const [existing] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.nationalId, nationalId), ne(patients.id, patient.id)));
    if (existing) {
      throw new HttpError(
        409,
        'IDENTITY_EXISTS',
        'A record with this national ID already exists. Ask the facility director to merge the two records.',
        { existingPatientId: existing.id },
      );
    }

    const now = new Date();
    await tx
      .update(patients)
      .set({
        nationalId,
        firstName,
        lastName,
        dateOfBirth: input.dateOfBirth,
        sex: input.sex,
        temporaryIdentity: null,
        identityConfirmedAt: now,
        updatedAt: now,
      })
      .where(eq(patients.id, patient.id));
    if (patient.temporaryIdentity === 'NEWBORN') {
      await tx
        .update(births)
        .set({ civilRegisteredAt: now })
        .where(and(eq(births.newbornPatientId, patient.id), isNull(births.civilRegisteredAt)));
    }
    await audit(
      {
        action: AuditAction.PATIENT_IDENTITY_CONFIRMED,
        actor: actor.ctx,
        resourceType: 'patient',
        resourceId: patient.id,
        patientId: patient.id,
        meta: actor.meta,
        metadata: {
          via: actor.via,
          kind: patient.temporaryIdentity,
          previousNumber: patient.nationalId,
          ...(actor.clientName ? { client: actor.clientName } : {}),
        },
      },
      tx,
    );
    await notifyCareTeam(
      patient.id,
      {
        type: 'identity',
        title: 'A temporary patient record now has a confirmed identity',
        link: `/doctor/patients/${patient.id}`,
      },
      tx,
      actor.ctx?.userId,
    );
    await notifyPatient(
      patient.id,
      { type: 'identity', title: 'The identity on a record you look after was confirmed', link: '/portal' },
      tx,
    );
    return { patientId: patient.id };
  });
}

/** Active care-team doctors of a patient (care_assignments.doctor_id holds doctors and nurses). */
export async function careTeamDoctors(patientId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(careAssignments)
    .innerJoin(users, eq(users.id, careAssignments.doctorId))
    .where(
      and(
        eq(careAssignments.patientId, patientId),
        isNull(careAssignments.endedAt),
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
      ),
    );
  return rows.map((r) => r.id);
}

/** Adds an active care-team membership unless one exists (unique per member and patient). */
export async function ensureCareAssignment(
  executor: Executor,
  patientId: string,
  memberId: string,
  assignedById: string,
) {
  await executor
    .insert(careAssignments)
    .values({ patientId, doctorId: memberId, assignedById })
    .onConflictDoNothing();
}

/** 18th birthday of someone born on `isoDate`, as the end of guardianship validity. */
export function eighteenthBirthday(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y + 18, m - 1, d));
}

