import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { auditLogs, users } from '../../db/schema.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { paginated, toOffset, type Pagination } from '../../lib/pagination.js';

export const AuditAction = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGIN_LOCKED: 'auth.login.locked',
  LOGOUT: 'auth.logout',
  REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
  ACCOUNT_ACTIVATED: 'auth.account.activated',
  PASSWORD_CHANGED: 'auth.password.changed',
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  MFA_ENABLED: 'auth.mfa.enabled',
  MFA_DISABLED: 'auth.mfa.disabled',
  MFA_CHALLENGE_FAILED: 'auth.mfa.challenge_failed',
  MFA_RECOVERY_CODE_USED: 'auth.mfa.recovery_code_used',
  MFA_RECOVERY_CODES_REGENERATED: 'auth.mfa.recovery_codes_regenerated',

  USER_INVITED: 'user.invited',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  FACILITY_CREATED: 'facility.created',
  FACILITY_UPDATED: 'facility.updated',

  PATIENT_REGISTERED: 'patient.registered',
  PATIENT_SEARCHED: 'patient.searched',
  PATIENT_DEMOGRAPHICS_UPDATED: 'patient.demographics.updated',
  PATIENT_RECORD_VIEWED: 'patient.record.viewed',
  PATIENT_RECORD_EXPORTED: 'patient.record.exported',
  PATIENT_RECORD_ACCESS_DENIED: 'patient.record.access_denied',
  POSSIBLE_DUPLICATE_OVERRIDDEN: 'patient.duplicate_check.overridden',
  CARE_ASSIGNED: 'care.assigned',
  CARE_ENDED: 'care.ended',
  EMERGENCY_ACCESS_GRANTED: 'care.emergency_access.granted',

  CLINICAL_ENTRY_CREATED: 'clinical.entry.created',
  CLINICAL_ENTRY_UPDATED: 'clinical.entry.updated',
  NOTE_SIGNED: 'clinical.note.signed',
  NOTE_ADDENDUM_ADDED: 'clinical.note.addendum_added',
  RESULT_ACKNOWLEDGED: 'clinical.result.acknowledged',
  RESULT_RELEASED: 'clinical.result.released',
  CORRECTION_REQUESTED: 'record.correction.requested',
  CORRECTION_RESOLVED: 'record.correction.resolved',

  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_UPDATED: 'appointment.updated',

  MESSAGE_SENT: 'message.sent',
  REFERRAL_CREATED: 'referral.created',
  REFERRAL_ACCEPTED: 'referral.accepted',
  REFERRAL_DECLINED: 'referral.declined',
  REFERRAL_COMPLETED: 'referral.completed',
  REFERRAL_CANCELLED: 'referral.cancelled',
  EMERGENCY_ACCESS_REVIEWED: 'care.emergency_access.reviewed',
  ANNOUNCEMENT_PUBLISHED: 'announcement.published',
  REPORT_EXPORTED: 'report.exported',
  PHARMACY_CONTEXT_VIEWED: 'pharmacy.context.viewed',
  PRESCRIPTION_VERIFIED: 'pharmacy.prescription.verified',
  PRESCRIPTION_RETURNED: 'pharmacy.prescription.returned',
  PRESCRIPTION_DISPENSED: 'pharmacy.prescription.dispensed',
  PRESCRIPTION_RESUBMITTED: 'clinical.prescription.resubmitted',
  MEDICATION_ADMINISTERED: 'clinical.medication.administration_recorded',
  CARE_TASK_CREATED: 'care.task.created',
  CARE_TASK_UPDATED: 'care.task.updated',
  CHANNEL_CREATED: 'channel.created',
  CHANNEL_MESSAGE_POSTED: 'channel.message.posted',
  FHIR_EXPORTED: 'patient.record.fhir_exported',
  GUARDIAN_ADDED: 'guardian.added',
  GUARDIAN_REVOKED: 'guardian.revoked',
  PROXY_ACCESS_DENIED: 'guardian.access_denied',
  ENCOUNTER_CONFIDENTIALITY_CHANGED: 'clinical.encounter.confidentiality_changed',
  EMAIL_PREFERENCE_CHANGED: 'user.email_preference.changed',
  PHONE_VERIFIED: 'user.phone.verified',
  PHONE_REMOVED: 'user.phone.removed',
  LAB_ORDER_CREATED: 'lab.order.created',
  LAB_ORDER_CANCELLED: 'lab.order.cancelled',
  LAB_RESULTS_RECEIVED: 'lab.results.received',
  LAB_MESSAGE_REVIEWED: 'lab.message.reviewed',
  INTEGRATION_CLIENT_CREATED: 'integration.client.created',
  INTEGRATION_CLIENT_REVOKED: 'integration.client.revoked',
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_REJECTED: 'document.rejected',
  DOCUMENT_VIEWED: 'document.viewed',
  DOCUMENT_SHARED: 'document.shared',
  DOCUMENT_MARKED_IN_ERROR: 'document.marked_in_error',
  CONSENT_RECORDED: 'consent.recorded',
  CONSENT_CHECK_BLOCKED: 'consent.check.blocked',
  COVER_CREATED: 'cover.created',
  COVER_CANCELLED: 'cover.cancelled',
  RESULT_ESCALATED: 'lab.result.escalated',
  PATIENT_MERGED: 'patient.merged',
  PATIENT_UNMERGED: 'patient.unmerged',
  TEMPORARY_PATIENT_REGISTERED: 'patient.temporary.registered',
  PATIENT_IDENTITY_CONFIRMED: 'patient.identity.confirmed',
  BIRTH_REGISTERED: 'birth.registered',
  CARE_UNIT_CHANGED: 'care_unit.changed',
  UNIT_STAFF_CHANGED: 'care_unit.staff_changed',
  BED_STATUS_CHANGED: 'bed.status_changed',
  PATIENT_ADMITTED: 'admission.created',
  PATIENT_TRANSFERRED: 'admission.transferred',
  PATIENT_DISCHARGED: 'admission.discharged',
  DISCHARGE_SUMMARY_SIGNED: 'admission.summary_signed',
  ED_ARRIVAL_REGISTERED: 'ed.arrival_registered',
  ED_TRIAGED: 'ed.triaged',
  ED_STATUS_CHANGED: 'ed.status_changed',
  IMAGING_ORDERED: 'imaging.ordered',
  IMAGING_STATUS_CHANGED: 'imaging.status_changed',
  IMAGING_REPORTED: 'imaging.reported',
  IMAGING_ACKNOWLEDGED: 'imaging.acknowledged',
  PARTNER_CLIENT_CREATED: 'partner.client.created',
  PARTNER_CLIENT_REVOKED: 'partner.client.revoked',
  PARTNER_API_ACCESS: 'partner.api.access',
  SURGERY_REQUESTED: 'surgery.requested',
  SURGERY_SCHEDULED: 'surgery.scheduled',
  SURGERY_STATUS_CHANGED: 'surgery.status_changed',
  SURGERY_CHECKLIST_COMPLETED: 'surgery.checklist_completed',
  OPERATION_NOTE_SIGNED: 'surgery.note_signed',
  STOCK_RECEIVED: 'stock.received',
  STOCK_ADJUSTED: 'stock.adjusted',
  STOCK_DISPENSED: 'stock.dispensed',
  STOCK_SETTINGS_CHANGED: 'stock.settings_changed',
  IMAGES_VIEWED: 'imaging.images_viewed',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEvent {
  action: AuditActionValue;
  actor?: Pick<AuthContext, 'userId' | 'role' | 'facilityId'> | null;
  resourceType?: string;
  resourceId?: string | null;
  patientId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  meta?: RequestMeta;
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit record. Pass a transaction executor to make the audit entry atomic with the
 * change it describes: if the audit write fails the whole operation rolls back.
 */
export async function audit(event: AuditEvent, executor: Executor = db): Promise<void> {
  await executor.insert(auditLogs).values({
    action: event.action,
    actorUserId: event.actor?.userId ?? null,
    actorRole: event.actor?.role ?? null,
    actorFacilityId: event.actor?.facilityId ?? null,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    patientId: event.patientId ?? null,
    outcome: event.outcome ?? 'SUCCESS',
    ipAddress: event.meta?.ipAddress ?? null,
    userAgent: event.meta?.userAgent ?? null,
    requestId: event.meta?.requestId ?? null,
    metadata: event.metadata ?? null,
  });
}

/** For security events outside a transaction where failure to audit must not mask the response. */
export async function auditSafe(event: AuditEvent): Promise<void> {
  try {
    await audit(event);
  } catch (err) {
    logger.error({ err, action: event.action }, 'Failed to write audit log');
  }
}

export interface AuditQuery extends Pagination {
  facilityId?: string;
  actorUserId?: string;
  patientId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

export async function listAuditLogs(q: AuditQuery) {
  const filters: SQL[] = [];
  if (q.facilityId) filters.push(eq(auditLogs.actorFacilityId, q.facilityId));
  if (q.actorUserId) filters.push(eq(auditLogs.actorUserId, q.actorUserId));
  if (q.patientId) filters.push(eq(auditLogs.patientId, q.patientId));
  if (q.action) filters.push(eq(auditLogs.action, q.action));
  if (q.from) filters.push(gte(auditLogs.occurredAt, q.from));
  if (q.to) filters.push(lte(auditLogs.occurredAt, q.to));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        occurredAt: auditLogs.occurredAt,
        action: auditLogs.action,
        outcome: auditLogs.outcome,
        actorUserId: auditLogs.actorUserId,
        actorName: users.fullName,
        actorRole: auditLogs.actorRole,
        actorFacilityId: auditLogs.actorFacilityId,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        patientId: auditLogs.patientId,
        ipAddress: auditLogs.ipAddress,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(where)
      .orderBy(desc(auditLogs.occurredAt))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);
  return paginated(rows, totalRow?.total ?? 0, q);
}
