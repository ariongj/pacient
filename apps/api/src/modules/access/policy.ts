import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { careAssignments, emergencyAccessGrants, patients } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { AuditAction, auditSafe } from '../audit/audit.service.js';

/**
 * Access model: roles are distinct responsibilities, not a seniority ladder. Seniority alone never
 * authorizes access to a medical record; every decision is default-deny and contextual.
 *
 * | Role      | Clinical record                                        | Demographics            | Aggregates   |
 * |-----------|--------------------------------------------------------|-------------------------|--------------|
 * | MINISTRY  | never                                                  | never                   | national*    |
 * | DIRECTOR  | never                                                  | own facility's patients | own facility |
 * | DOCTOR    | active care relationship, or same-facility break-glass | own facility/care team  | –            |
 * | PATIENT   | own record (read-only; released results only)          | own                     | –            |
 *
 * (*) with small-cell suppression. Institution (facility) boundaries are never bypassed – not even
 * by emergency access. Grants and denials are both written to the audit trail, and patients can see
 * who accessed their record.
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

async function deny(
  ctx: AuthContext,
  patientId: string,
  meta: RequestMeta | undefined,
  message?: string,
) {
  await auditSafe({
    action: AuditAction.PATIENT_RECORD_ACCESS_DENIED,
    actor: ctx,
    outcome: 'DENIED',
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta,
  });
  return forbidden(message);
}

/** Resolves *why* the caller may read the clinical record, or audits the denial and throws 403. */
export async function resolveClinicalReadAccess(
  ctx: AuthContext,
  patientId: string,
  meta?: RequestMeta,
): Promise<ClinicalAccessBasis> {
  const patient = await getPatientOrThrow(patientId);
  if (ctx.role === 'PATIENT') {
    if (ctx.patientId === patientId) return 'SELF';
    throw await deny(ctx, patientId, meta);
  }
  if (ctx.role === 'DOCTOR') {
    if (await hasActiveCareAssignment(ctx.userId, patientId)) return 'CARE_TEAM';
    if (
      patient.primaryFacilityId === ctx.facilityId &&
      (await hasActiveEmergencyAccess(ctx.userId, patientId))
    ) {
      return 'EMERGENCY';
    }
    throw await deny(
      ctx,
      patientId,
      meta,
      'You are not part of this patient’s care team. Request assignment or use emergency access.',
    );
  }
  // Directors and the Ministry manage the system; they never see identifiable clinical data.
  throw await deny(
    ctx,
    patientId,
    meta,
    'Clinical records are only available to the treating doctors and the patient',
  );
}

/** Only treating doctors may author clinical entries; patients' own records are read-only. */
export async function assertClinicalWriteAccess(
  ctx: AuthContext,
  patientId: string,
  meta?: RequestMeta,
) {
  if (ctx.role !== 'DOCTOR')
    throw await deny(ctx, patientId, meta, 'Only doctors can add clinical entries');
  return resolveClinicalReadAccess(ctx, patientId, meta);
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
        (await hasActiveCareAssignment(ctx.userId, patientId))
      ) {
        return patient;
      }
      break;
    case 'MINISTRY':
      break;
  }
  throw forbidden();
}
