import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { careAssignments, emergencyAccessGrants, patients, type Role } from '../../db/schema.js';
import { forbidden, HttpError, notFound } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { AuditAction, auditSafe } from '../audit/audit.service.js';
import { coverAccessVia } from '../cover/cover.service.js';
import { assertLicensed } from '../licences/licences.service.js';

/**
 * Access model: roles are distinct responsibilities, not a seniority ladder. Seniority alone never
 * authorizes access to a medical record; every decision is default-deny and contextual.
 *
 * | Role       | Clinical record                                               | Demographics              | Aggregates   |
 * |------------|---------------------------------------------------------------|---------------------------|--------------|
 * | MINISTRY   | never                                                         | never                     | national*    |
 * | DIRECTOR   | never                                                         | own facility's patients   | own facility |
 * | DOCTOR     | care team (incl. while covering an absent colleague), or same-facility break-glass | own facility / care team  | –            |
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

/**
 * A duplicate that was merged into another record is kept for lineage but closed: nothing may be
 * read from or written to it. Callers get 409 PATIENT_MERGED with the surviving record's id.
 */
export function assertNotMerged(patient: { mergedIntoId: string | null }) {
  if (patient.mergedIntoId) {
    throw new HttpError(
      409,
      'PATIENT_MERGED',
      'This record was merged into another record. Open the surviving record instead.',
      { mergedIntoId: patient.mergedIntoId },
    );
  }
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

/**
 * Access through result cover is care-team access on behalf of an absent colleague. It is recorded
 * in the audit trail (and so in the patient's access log) as such – at most once per doctor and
 * patient every 10 minutes, so a busy review session does not flood the log.
 */
const recentCoverAudits = new Map<string, number>();
async function auditCoverAccess(
  ctx: AuthContext,
  patientId: string,
  coverFor: string,
  meta: RequestMeta | undefined,
) {
  const key = `${ctx.userId}:${patientId}`;
  const now = Date.now();
  if ((recentCoverAudits.get(key) ?? 0) > now - 10 * 60_000) return;
  recentCoverAudits.set(key, now);
  if (recentCoverAudits.size > 10_000) recentCoverAudits.clear();
  await auditSafe({
    action: AuditAction.PATIENT_RECORD_VIEWED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta,
    metadata: { basis: 'CARE_TEAM', via: 'COVER', coverFor },
  });
}

/**
 * Unit-based access: staff assigned to a care unit of their own facility may open the record of a
 * patient who is currently in that unit –
 *  - a ward: the patient is admitted there;
 *  - the emergency department: an attendance is open (or ended less than 24 hours ago);
 *  - radiology: the patient has an imaging order at the facility that is not yet reported;
 *  - maternity / neonatal: a baby born at the facility in the last 28 days;
 *  - operating theatre: a scheduled or ongoing operation (or one finished <24 hours ago).
 * Access ends automatically when the patient leaves. Returns the unit name, or null.
 */
export async function unitAccessVia(
  userId: string,
  facilityId: string | null,
  patientId: string,
  executor: Executor = db,
): Promise<{ unitId: string; unitType: string } | null> {
  if (!facilityId) return null;
  const result = await executor.execute<{ unit_id: string; unit_type: string }>(sql`
    SELECT cu.id AS unit_id, cu.type AS unit_type
    FROM unit_staff us
    JOIN care_units cu ON cu.id = us.unit_id AND cu.is_active AND cu.facility_id = ${facilityId}
    WHERE us.user_id = ${userId} AND (
      EXISTS (SELECT 1 FROM admissions a
              WHERE a.patient_id = ${patientId} AND a.status = 'ADMITTED' AND a.unit_id = cu.id)
      OR (cu.type = 'EMERGENCY' AND EXISTS (
            SELECT 1 FROM ed_visits e
            WHERE e.patient_id = ${patientId} AND e.unit_id = cu.id
              AND (e.status IN ('WAITING', 'IN_TREATMENT') OR e.departed_at > now() - interval '24 hours')))
      OR (cu.type = 'RADIOLOGY' AND EXISTS (
            SELECT 1 FROM imaging_orders i
            WHERE i.patient_id = ${patientId} AND i.facility_id = cu.facility_id
              AND i.status IN ('ORDERED', 'SCHEDULED', 'PERFORMED')))
      OR (cu.type::text = 'OPERATING_THEATRE' AND EXISTS (
            SELECT 1 FROM surgical_cases sc
            WHERE sc.patient_id = ${patientId} AND sc.facility_id = cu.facility_id
              AND (sc.status IN ('SCHEDULED', 'IN_THEATRE')
                   OR (sc.status = 'COMPLETED' AND sc.out_of_theatre_at > now() - interval '24 hours'))))
      OR (cu.type::text = 'AMBULANCE_SERVICE' AND EXISTS (
            SELECT 1 FROM ems_incidents ei
            WHERE ei.patient_id = ${patientId} AND ei.service_unit_id = cu.id
              AND (ei.status NOT IN ('CLOSED', 'CANCELLED')
                   OR ei.closed_at > now() - interval '24 hours')))
      OR (cu.type::text = 'DIALYSIS' AND EXISTS (
            SELECT 1 FROM dialysis_schedules ds
            WHERE ds.patient_id = ${patientId} AND ds.unit_id = cu.id AND ds.status = 'ACTIVE'))
      OR (cu.type::text = 'COMMUNITY_NURSING' AND EXISTS (
            SELECT 1 FROM home_care_episodes hc
            WHERE hc.patient_id = ${patientId} AND hc.team_unit_id = cu.id
              AND hc.status IN ('REFERRED', 'ACTIVE', 'ON_HOLD')))
      OR (cu.type::text = 'INFECTION_CONTROL' AND (
            EXISTS (SELECT 1 FROM isolation_orders io
                    WHERE io.patient_id = ${patientId} AND io.facility_id = cu.facility_id
                      AND io.ended_at IS NULL)
            OR EXISTS (SELECT 1 FROM hai_events he
                       WHERE he.patient_id = ${patientId} AND he.facility_id = cu.facility_id
                         AND he.created_at > now() - interval '90 days')
            OR EXISTS (SELECT 1 FROM antimicrobial_approvals aa
                       WHERE aa.patient_id = ${patientId} AND aa.facility_id = cu.facility_id
                         AND (aa.status = 'REQUESTED' OR aa.reviewed_at IS NULL))))
      OR (cu.type IN ('MATERNITY', 'NEONATAL') AND EXISTS (
            SELECT 1 FROM births b
            WHERE (b.newborn_patient_id = ${patientId} OR b.mother_patient_id = ${patientId})
              AND b.facility_id = cu.facility_id AND b.born_at > now() - interval '28 days'))
    )
    LIMIT 1`);
  const row = result.rows[0];
  return row ? { unitId: row.unit_id, unitType: row.unit_type } : null;
}

const recentUnitAudits = new Map<string, number>();
async function auditUnitAccess(
  ctx: AuthContext,
  patientId: string,
  unit: { unitId: string; unitType: string },
  meta: RequestMeta | undefined,
) {
  const key = `${ctx.userId}:${patientId}`;
  const now = Date.now();
  if ((recentUnitAudits.get(key) ?? 0) > now - 10 * 60_000) return;
  recentUnitAudits.set(key, now);
  if (recentUnitAudits.size > 10_000) recentUnitAudits.clear();
  await auditSafe({
    action: AuditAction.PATIENT_RECORD_VIEWED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta,
    metadata: { basis: 'CARE_TEAM', via: 'UNIT', unitId: unit.unitId, unitType: unit.unitType },
  });
}

/** Resolves *why* the caller may read the clinical record, or audits the denial and throws 403. */
export async function resolveClinicalReadAccess(
  ctx: AuthContext,
  patientId: string,
  meta?: RequestMeta,
): Promise<ClinicalAccessBasis> {
  const patient = await getPatientOrThrow(patientId);
  assertNotMerged(patient);
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
      if (ctx.role === 'DOCTOR') {
        const coverFor = await coverAccessVia(ctx.userId, patientId);
        if (coverFor) {
          await auditCoverAccess(ctx, patientId, coverFor, meta);
          return 'CARE_TEAM';
        }
      }
      {
        const unit = await unitAccessVia(ctx.userId, ctx.facilityId, patientId);
        if (unit) {
          await auditUnitAccess(ctx, patientId, unit, meta);
          return 'CARE_TEAM';
        }
      }
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
  const access = await resolveClinicalReadAccess(ctx, patientId, meta);
  // Clinical entries need a valid professional licence (reading is never blocked by it).
  await assertLicensed(ctx, meta);
  return access;
}

/**
 * Non-clinical demographic data (name, contact, registration facility). Merged duplicates are
 * refused (409 PATIENT_MERGED) unless the caller only wants to show where the record went.
 */
export async function assertDemographicsAccess(
  ctx: AuthContext,
  patientId: string,
  opts: { allowMerged?: boolean } = {},
) {
  const patient = await getPatientOrThrow(patientId);
  if (!opts.allowMerged) assertNotMerged(patient);
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

const recentViewAudits = new Map<string, number>();

/**
 * Records that someone other than the patient read part of their record, so it appears in the
 * patient's "who viewed my record" log. Repeated reads of the same section by the same person are
 * recorded at most once every 10 minutes (boards and charts refresh often).
 */
export async function auditRecordView(
  ctx: AuthContext,
  patientId: string,
  basis: ClinicalAccessBasis | 'UNIT',
  section: string,
  meta?: RequestMeta,
) {
  if (basis === 'SELF') return;
  const key = `${ctx.userId}:${patientId}:${section}`;
  const now = Date.now();
  if ((recentViewAudits.get(key) ?? 0) > now - 10 * 60_000) return;
  recentViewAudits.set(key, now);
  if (recentViewAudits.size > 20_000) recentViewAudits.clear();
  await auditSafe({
    action: AuditAction.PATIENT_RECORD_VIEWED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta,
    metadata: { section, basis },
  });
}

/** resolveClinicalReadAccess + auditRecordView, for endpoints that return clinical data. */
export async function resolveAndAuditRead(
  ctx: AuthContext,
  patientId: string,
  meta: RequestMeta | undefined,
  section: string,
): Promise<ClinicalAccessBasis> {
  const basis = await resolveClinicalReadAccess(ctx, patientId, meta);
  await auditRecordView(ctx, patientId, basis, section, meta);
  return basis;
}
