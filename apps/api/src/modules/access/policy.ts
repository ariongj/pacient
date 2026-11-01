import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { careAssignments, emergencyAccessGrants, patients } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';

/**
 * Access model (least privilege, need-to-know):
 *
 * | Tier      | Clinical record                                  | Demographics            | Aggregates      |
 * |-----------|--------------------------------------------------|-------------------------|-----------------|
 * | MINISTRY  | never                                            | never                   | national        |
 * | DIRECTOR  | never                                            | own facility's patients | own facility    |
 * | DOCTOR    | patients in their care, or emergency break-glass | facility + care team    | –               |
 * | PATIENT   | own record (read-only)                           | own                     | –               |
 *
 * Every grant of access to an identifiable record is written to the audit trail, and patients can
 * see who accessed their record from the portal.
 */
export type ClinicalAccessBasis = 'SELF' | 'CARE_TEAM' | 'EMERGENCY';

export async function getPatientOrThrow(patientId: string, executor: Executor = db) {
  const [patient] = await executor.select().from(patients).where(eq(patients.id, patientId));
  if (!patient) throw notFound('Patient not found');
  return patient;
}

export async function hasActiveCareAssignment(
  doctorId: string,
  patientId: string,
  executor: Executor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: careAssignments.id })
    .from(careAssignments)
    .where(
      and(
        eq(careAssignments.doctorId, doctorId),
        eq(careAssignments.patientId, patientId),
        isNull(careAssignments.endedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function hasActiveEmergencyAccess(
  doctorId: string,
  patientId: string,
  executor: Executor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: emergencyAccessGrants.id })
    .from(emergencyAccessGrants)
    .where(
      and(
        eq(emergencyAccessGrants.doctorId, doctorId),
        eq(emergencyAccessGrants.patientId, patientId),
        gt(emergencyAccessGrants.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Resolves *why* the caller may read the clinical record, or throws 403. */
export async function resolveClinicalReadAccess(
  ctx: AuthContext,
  patientId: string,
): Promise<ClinicalAccessBasis> {
  await getPatientOrThrow(patientId);
  if (ctx.role === 'PATIENT') {
    if (ctx.patientId === patientId) return 'SELF';
    throw forbidden();
  }
  if (ctx.role === 'DOCTOR') {
    if (await hasActiveCareAssignment(ctx.userId, patientId)) return 'CARE_TEAM';
    if (await hasActiveEmergencyAccess(ctx.userId, patientId)) return 'EMERGENCY';
    throw forbidden(
      'You are not part of this patient’s care team. Request assignment or use emergency access.',
    );
  }
  // Directors and the Ministry manage the system; they never see identifiable clinical data.
  throw forbidden('Clinical records are only available to the treating doctors and the patient');
}

/** Only treating doctors may author clinical entries; patients' own records are read-only. */
export async function assertClinicalWriteAccess(ctx: AuthContext, patientId: string) {
  if (ctx.role !== 'DOCTOR') throw forbidden('Only doctors can add clinical entries');
  return resolveClinicalReadAccess(ctx, patientId);
}

/** Non-clinical demographic data (name, contact, registration facility). */
export async function assertDemographicsAccess(ctx: AuthContext, patientId: string) {
  const patient = await getPatientOrThrow(patientId);
  switch (ctx.role) {
    case 'PATIENT':
      if (ctx.patientId === patientId) return patient;
      break;
    case 'DIRECTOR':
      if (patient.primaryFacilityId === ctx.facilityId) return patient;
      break;
    case 'DOCTOR':
      if (
        patient.primaryFacilityId === ctx.facilityId ||
        (await hasActiveCareAssignment(ctx.userId, patientId)) ||
        (await hasActiveEmergencyAccess(ctx.userId, patientId))
      ) {
        return patient;
      }
      break;
    case 'MINISTRY':
      break;
  }
  throw forbidden();
}
