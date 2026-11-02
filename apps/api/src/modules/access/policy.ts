import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { careAssignments, emergencyAccessGrants, patients, type Role } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { AuditAction, auditSafe } from '../audit/audit.service.js';

/**
 * Access model: roles are distinct responsibilities, not a seniority ladder. Seniority alone never
 * authorizes access to a medical record; every decision is default-deny and contextual.
 *
 * | Role       | Clinical record                                               | Demographics              | Aggregates   |
 * |------------|---------------------------------------------------------------|---------------------------|--------------|
 * | MINISTRY   | never                                                         | never                     | national*    |
 * | DIRECTOR   | never                                                         | own facility's patients   | own facility |
 * | DOCTOR     | care team, or same-facility break-glass                       | own facility / care team  | –            |
 * | NURSE      | care team (reads; writes observations, allergies, vaccines, MAR) | own facility / care team | –            |
 * | PHARMACIST | never in full – medication context only, via the pharmacy queue | via pharmacy queue only | –            |
 * | RECEPTION  | never                                                         | own facility's patients   | –            |
 * | PATIENT    | own record (read-only; released results, signed notes)        | own                       | –            |
 * | GUARDIAN   | a PATIENT account acting for a child under a verified, unexpired guardianship: like the
 * |            | patient's own view, minus confidential visits; appointments-only scope sees no clinical data |
 *
 * (*) with small-cell suppression. Institution (facility) boundaries are never bypassed – not even
 * by emergency access; the only cross-facility path is an accepted referral. Grants and denials are
 * written to the audit trail, and patients can see who accessed their record.
 */
export type ClinicalAccessBasis = 'SELF' | 'GUARDIAN' | 'CARE_TEAM' | 'EMERGENCY';

/** Who may author each kind of clinical entry (always in addition to having read access). */
export const WRITERS = {
  doctorOnly: ['DOCTOR'] as Role[],
  careTeam: ['DOCTOR', 'NURSE'] as Role[],
};

export async function getPatientOrThrow(patientId: string, executor: Executor = db) {
  const [patient] = await executor.select().from(patients).where(eq(patients.id, patientId));
  if (!patient) throw notFound('Patient not found');
  return patient;
}

/** Is this user (doctor or nurse) an active member of the patient's care team? */
export async function hasActiveCareAssignment(
  memberId: string,
  patientId: string,
  executor: Executor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: careAssignments.id })
    .from(careAssignments)
    .where(
      and(
        eq(careAssignments.doctorId, memberId),
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
  switch (ctx.role) {
    case 'PATIENT':
      if (ctx.patientId === patientId) {
        if (!ctx.proxy) return 'SELF';
        if (ctx.proxy.scope === 'FULL') return 'GUARDIAN';
        throw await deny(ctx, patientId, meta, 'Your guardian access covers appointments only');
      }
      throw await deny(ctx, patientId, meta);
    case 'DOCTOR':
    case 'NURSE':
      if (await hasActiveCareAssignment(ctx.userId, patientId)) return 'CARE_TEAM';
      if (
        ctx.role === 'DOCTOR' &&
        patient.primaryFacilityId === ctx.facilityId &&
        (await hasActiveEmergencyAccess(ctx.userId, patientId))
      ) {
        return 'EMERGENCY';
      }
      throw await deny(
        ctx,
        patientId,
        meta,
        'You are not part of this patient’s care team. Join the care team or ask a doctor for emergency access.',
      );
    case 'PHARMACIST':
      throw await deny(
        ctx,
        patientId,
        meta,
        'Pharmacists see the medication context of prescriptions in the pharmacy queue, not the full record',
      );
    default:
      // Directors, the Ministry and reception run the system; they never see clinical content.
      throw await deny(
        ctx,
        patientId,
        meta,
        'Clinical records are only available to the treating care team and the patient',
      );
  }
}

/**
 * Authoring a clinical entry: the caller's role must be allowed for that entry type (e.g. only
 * doctors diagnose and prescribe) and they must have read access to the record.
 */
export async function assertClinicalWriteAccess(
  ctx: AuthContext,
  patientId: string,
  meta?: RequestMeta,
  allowedRoles: Role[] = WRITERS.doctorOnly,
) {
  if (!allowedRoles.includes(ctx.role)) {
    throw await deny(
      ctx,
      patientId,
      meta,
      ctx.role === 'NURSE'
        ? 'This entry must be made by a doctor'
        : 'Only the treating care team can add clinical entries',
    );
  }
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
    case 'RECEPTION':
      if (patient.primaryFacilityId === ctx.facilityId) return patient;
      break;
    case 'DOCTOR':
    case 'NURSE':
      if (
        patient.primaryFacilityId === ctx.facilityId ||
        (await hasActiveCareAssignment(ctx.userId, patientId))
      ) {
        return patient;
      }
      break;
    default:
      break;
  }
  throw forbidden();
}

/** Guardians with appointments-only scope may not use messaging, referrals or clinical data. */
export function assertFullProxyScope(ctx: AuthContext) {
  if (ctx.proxy && ctx.proxy.scope !== 'FULL') {
    throw forbidden('Your guardian access covers appointments only');
  }
}
