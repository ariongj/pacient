const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short' });

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
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const fullName = (p: { firstName: string; lastName: string }) =>
  `${p.firstName} ${p.lastName}`;

export const formatNumber = (n: number) => new Intl.NumberFormat('en-GB').format(n);

/** Human-readable descriptions of audit actions, used in the patient access log and audit views. */
export const ACTION_LABELS: Record<string, string> = {
  'auth.login.success': 'Signed in',
  'auth.login.failure': 'Failed sign-in',
  'auth.login.locked': 'Sign-in blocked (locked)',
  'auth.logout': 'Signed out',
  'auth.refresh.reuse_detected': 'Session token reuse detected',
  'auth.account.activated': 'Account activated',
  'auth.password.changed': 'Password changed',
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
};
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? humanize(a);
