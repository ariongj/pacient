import { intlLocale, t } from './i18n';

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, options: Intl.DateTimeFormatOptions) {
  const id = `${intlLocale()}|${key}`;
  let f = cache.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(intlLocale(), options);
    cache.set(id, f);
  }
  return f;
}
const dateFmt = {
  format: (d: Date) => fmt('date', { day: '2-digit', month: 'short', year: 'numeric' }).format(d),
};
const dateTimeFmt = {
  format: (d: Date) =>
    fmt('datetime', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d),
};
const timeFmt = {
  format: (d: Date) => fmt('time', { hour: '2-digit', minute: '2-digit' }).format(d),
};
const monthFmt = { format: (d: Date) => fmt('month', { month: 'short' }).format(d) };

export const formatDate = (v: string | null | undefined) => (v ? dateFmt.format(new Date(v)) : '—');
export const formatDateTime = (v: string | null | undefined) =>
  v ? dateTimeFmt.format(new Date(v)) : '—';
export const formatTime = (v: string) => timeFmt.format(new Date(v));
export const formatMonth = (yyyyMm: string) => monthFmt.format(new Date(`${yyyyMm}-01T00:00:00Z`));

export function age(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let a = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) a--;
  return a;
}

/** "OUTPATIENT" -> "Outpatient", "NO_KNOWN_ALLERGIES" -> "No known allergies" */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const s = value.replace(/[_.-]+/g, ' ').toLowerCase();
  return t(s.charAt(0).toUpperCase() + s.slice(1));
}

export const fullName = (p: { firstName: string; lastName: string }) =>
  `${p.firstName} ${p.lastName}`;

export const formatNumber = (n: number) => new Intl.NumberFormat(intlLocale()).format(n);

/** Human-readable descriptions of audit actions, used in the patient access log and audit views. */
export const ACTION_LABELS: Record<string, string> = {
  'auth.login.success': 'Signed in',
  'auth.login.failure': 'Failed sign-in',
  'auth.login.locked': 'Sign-in blocked (locked)',
  'auth.logout': 'Signed out',
  'auth.refresh.reuse_detected': 'Session token reuse detected',
  'auth.account.activated': 'Account activated',
  'auth.password.changed': 'Password changed',
  'auth.password.reset_requested': 'Password reset requested',
  'auth.password.reset_completed': 'Password reset completed',
  'auth.mfa.enabled': 'Two-step sign-in turned on',
  'auth.mfa.disabled': 'Two-step sign-in turned off',
  'auth.mfa.challenge_failed': 'Wrong two-step code',
  'auth.mfa.recovery_code_used': 'Recovery code used',
  'auth.mfa.recovery_codes_regenerated': 'Recovery codes regenerated',
  'user.invited': 'Account invited',
  'user.deactivated': 'Account deactivated',
  'user.reactivated': 'Account reactivated',
  'facility.created': 'Facility created',
  'facility.updated': 'Facility updated',
  'patient.registered': 'Patient registered',
  'patient.searched': 'Patient search',
  'patient.demographics.updated': 'Contact details updated',
  'patient.record.viewed': 'Viewed medical record',
  'patient.record.exported': 'Exported medical record',
  'patient.record.access_denied': 'Record access denied',
  'patient.duplicate_check.overridden': 'Duplicate warning overridden',
  'care.assigned': 'Added to care team',
  'care.ended': 'Removed from care team',
  'care.emergency_access.granted': 'Emergency access',
  'clinical.entry.created': 'Added a clinical entry',
  'clinical.entry.updated': 'Updated a clinical entry',
  'clinical.note.signed': 'Signed a visit note',
  'clinical.note.addendum_added': 'Added an addendum',
  'clinical.result.acknowledged': 'Reviewed a result',
  'clinical.result.released': 'Released a result',
  'record.correction.requested': 'Correction requested',
  'record.correction.resolved': 'Correction request answered',
  'appointment.created': 'Appointment created',
  'appointment.updated': 'Appointment updated',
  'message.sent': 'Sent a message',
  'referral.created': 'Referral created',
  'referral.accepted': 'Referral accepted',
  'referral.declined': 'Referral declined',
  'referral.completed': 'Referral completed',
  'referral.cancelled': 'Referral cancelled',
  'care.emergency_access.reviewed': 'Emergency access reviewed',
  'announcement.published': 'Announcement published',
  'report.exported': 'Report exported',
  'pharmacy.context.viewed': 'Pharmacist reviewed medication context',
  'pharmacy.prescription.verified': 'Prescription verified by pharmacy',
  'pharmacy.prescription.returned': 'Prescription returned by pharmacy',
  'pharmacy.prescription.dispensed': 'Medication dispensed',
  'clinical.prescription.resubmitted': 'Prescription resubmitted',
  'clinical.medication.administration_recorded': 'Medication administration recorded',
  'care.task.created': 'Care task created',
  'care.task.updated': 'Care task updated',
  'channel.created': 'Channel created',
  'channel.message.posted': 'Channel message posted',
  'patient.record.fhir_exported': 'Record exported (FHIR)',
  'document.uploaded': 'Document added',
  'document.rejected': 'Document upload rejected',
  'document.viewed': 'Document opened',
  'document.shared': 'Document sharing changed',
  'document.marked_in_error': 'Document marked as entered in error',
  'consent.recorded': 'Recorded a consent decision',
  'consent.check.blocked': 'Referral blocked: consent withdrawn',
  'cover.created': 'Result cover arranged',
  'cover.cancelled': 'Result cover cancelled',
  'lab.result.escalated': 'Unreviewed critical result escalated',
  'lab.order.created': 'Laboratory test ordered',
  'lab.order.cancelled': 'Laboratory order cancelled',
  'lab.results.received': 'Laboratory results received',
  'lab.message.reviewed': 'Laboratory message reviewed',
  'integration.client.created': 'Laboratory connection created',
  'integration.client.revoked': 'Laboratory connection revoked',
  'user.phone.verified': 'Mobile number verified',
  'user.phone.removed': 'Mobile number removed',
};
export const actionLabel = (a: string) => (ACTION_LABELS[a] ? t(ACTION_LABELS[a]) : humanize(a));
