import { getLocale, intlLocale, t } from './i18n';

/*
 * Albanian and Serbian dates are formatted here rather than by Intl: some browsers ship without
 * their locale data (and fall back to English), and Intl's Albanian default is a 12-hour clock while
 * Kosovo uses 24-hour time.
 */
const NAMES = {
  sq: {
    months: [
      'janar',
      'shkurt',
      'mars',
      'prill',
      'maj',
      'qershor',
      'korrik',
      'gusht',
      'shtator',
      'tetor',
      'nëntor',
      'dhjetor',
    ],
    short: ['jan', 'shk', 'mar', 'pri', 'maj', 'qer', 'korr', 'gush', 'sht', 'tet', 'nën', 'dhj'],
    weekdays: ['e diel', 'e hënë', 'e martë', 'e mërkurë', 'e enjte', 'e premte', 'e shtunë'],
    group: '\u00a0',
  },
  sr: {
    months: [
      'januar',
      'februar',
      'mart',
      'april',
      'maj',
      'jun',
      'jul',
      'avgust',
      'septembar',
      'oktobar',
      'novembar',
      'decembar',
    ],
    short: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'avg', 'sep', 'okt', 'nov', 'dec'],
    weekdays: ['nedelja', 'ponedeljak', 'utorak', 'sreda', 'četvrtak', 'petak', 'subota'],
    group: '.',
  },
} as const;
/** Month/day names for locales formatted in code (Albanian, Serbian); null for English. */
const custom = () => {
  const l = getLocale();
  return l === 'sq' || l === 'sr' ? NAMES[l] : null;
};
const sq = () => custom() !== null;
const pad = (n: number) => String(n).padStart(2, '0');

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
const sqDate = (d: Date) =>
  `${pad(d.getDate())} ${custom()!.short[d.getMonth()]} ${d.getFullYear()}`;
const sqTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dateFmt = {
  format: (d: Date) =>
    sq() ? sqDate(d) : fmt('date', { day: '2-digit', month: 'short', year: 'numeric' }).format(d),
};
const dateTimeFmt = {
  format: (d: Date) =>
    sq()
      ? `${sqDate(d)}, ${sqTime(d)}`
      : fmt('datetime', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(d),
};
const timeFmt = {
  format: (d: Date) =>
    sq() ? sqTime(d) : fmt('time', { hour: '2-digit', minute: '2-digit' }).format(d),
};
const monthFmt = {
  format: (d: Date) =>
    sq()
      ? custom()!.short[d.getUTCMonth()]!
      : fmt('month', { month: 'short', timeZone: 'UTC' }).format(d),
};

/** "e hënë, 2 nëntor" / "Monday 2 November" – day headings in schedules. */
export function formatDayHeading(d: Date): string {
  if (sq())
    return `${custom()!.weekdays[d.getDay()]}, ${d.getDate()} ${custom()!.months[d.getMonth()]}`;
  return fmt('dayheading', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

/** "e hënë, 2 nëntor 2026" / "Monday 2 November 2026". */
export function formatFullDate(d: Date): string {
  if (sq())
    return `${custom()!.weekdays[d.getDay()]}, ${d.getDate()} ${custom()!.months[d.getMonth()]} ${d.getFullYear()}`;
  return fmt('full', { dateStyle: 'full' }).format(d);
}

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
/** Role codes whose plain wording differs from the code. */
const ROLE_NAMES: Record<string, string> = {
  IT_SUPPORT: 'IT support',
  LAB_TECHNICIAN: 'Laboratory technician',
};

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  if (ROLE_NAMES[value]) return t(ROLE_NAMES[value]);
  const s = value.replace(/[_.-]+/g, ' ').toLowerCase();
  return t(s.charAt(0).toUpperCase() + s.slice(1));
}

/** "First Last"; unidentified patients read "Unknown patient #4821". */
export const fullName = (p: {
  firstName: string;
  lastName: string;
  temporaryIdentity?: string | null;
}) =>
  p.temporaryIdentity === 'UNIDENTIFIED'
    ? t('Unknown patient {code}', { code: p.lastName })
    : `${p.firstName} ${p.lastName}`;

/** Albanian "3 420", Serbian "3.420", English "3,420"; decimals "38,5" / "38.5". */
export function formatNumber(n: number): string {
  if (!sq()) return new Intl.NumberFormat(intlLocale()).format(n);
  const [int, dec] = String(Math.round(n * 1000) / 1000).split('.');
  const grouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, custom()!.group);
  return dec ? `${grouped},${dec}` : grouped;
}

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
  'patient.merged': 'Duplicate records merged',
  'patient.unmerged': 'Record merge undone',
  'auth.passkey.registered': 'Passkey added',
  'auth.passkey.removed': 'Passkey removed',
  'auth.passkey.login': 'Signed in with a passkey',
  'auth.session.revoked': 'Signed out a device',
  'auth.new_device': 'Sign-in from a new device',
  'surgery.requested': 'Operation requested',
  'surgery.scheduled': 'Operation scheduled',
  'surgery.status_changed': 'Operation status changed',
  'surgery.checklist_completed': 'Surgical safety checklist step completed',
  'surgery.note_signed': 'Operation note signed',
  'stock.received': 'Stock received',
  'stock.adjusted': 'Stock adjusted',
  'stock.dispensed': 'Dispensed from stock',
  'stock.settings_changed': 'Reorder level changed',
  'imaging.images_viewed': 'Images viewed',
  'scheduling.availability_changed': 'Consulting hours changed',
  'appointment.self_booked': 'Appointment booked online',
  'appointment.reminder_sent': 'Appointment reminder sent',
  'vaccination.schedule_changed': 'Vaccination calendar changed',
  'vaccination.reminder_sent': 'Vaccination reminder sent',
  'medication.alert_overridden': 'Medication safety alert overridden',
  'medication.interactions_changed': 'Drug interaction database changed',
  'blood.group_recorded': 'Blood group recorded',
  'blood.unit_received': 'Blood unit received',
  'blood.unit_discarded': 'Blood unit discarded',
  'blood.transfusion_requested': 'Transfusion requested',
  'blood.crossmatched': 'Blood crossmatched',
  'blood.unit_issued': 'Blood unit issued',
  'blood.transfusion_recorded': 'Transfusion recorded',
  'blood.transfusion_reaction': 'Transfusion reaction reported',
  'nutrition.diet_ordered': 'Diet ordered',
  'nutrition.screened': 'Nutrition screening recorded',
  'billing.insurance_changed': 'Insurance changed',
  'billing.charge_created': 'Charge created',
  'billing.charge_voided': 'Charge voided',
  'billing.payment_received': 'Payment received',
  'billing.claim_submitted': 'Insurance claim submitted',
  'billing.claim_decided': 'Insurance claim decided',
  'news.escalated': 'Early warning escalated',
  'news.acknowledged': 'Early warning acknowledged',
  'surveillance.case_created': 'Notifiable disease case created',
  'surveillance.case_submitted': 'Notifiable disease case submitted',
  'surveillance.case_reviewed': 'Notifiable disease case reviewed',
  'video.joined': 'Joined a video visit',
  'video.ended': 'Video visit ended',
  'death.drafted': 'Death certificate drafted',
  'death.signed': 'Death certificate signed',
  'death.amended': 'Death certificate amended',
  'death.registry_acknowledged': 'Death registered by the civil registry',
  'certificate.issued': 'Medical certificate issued',
  'certificate.revoked': 'Medical certificate revoked',
  'certificate.verified': 'Medical certificate verified',
  'waiting_list.added': 'Added to a waiting list',
  'waiting_list.changed': 'Waiting list entry changed',
  'register.enrolled': 'Added to a disease register',
  'register.left': 'Removed from a disease register',
  'register.care_process': 'Chronic care review recorded',
  'incident.reported': 'Safety incident reported',
  'incident.updated': 'Safety incident updated',
  'incident.reviewers_changed': 'Incident reviewers changed',
  'document.version_added': 'New document version uploaded',
  'medication.dose_rules_changed': 'Dose rules changed',
  'medication.barcode_override': 'Barcode check overridden',
  'patient.wristband_printed': 'Wristband printed',
  'downtime.started': 'Downtime started',
  'downtime.ended': 'Downtime ended',
  'downtime.pack_generated': 'Downtime pack generated',
  'downtime.pack_downloaded': 'Downtime pack downloaded',
  'audit.exported': 'Audit trail exported',
  'privacy.retention_changed': 'Retention schedule changed',
  'privacy.retention_run': 'Retention run',
  'privacy.request': 'Data protection request',
  'privacy.legal_hold': 'Legal hold changed',
  'pregnancy.booked': 'Pregnancy booked',
  'pregnancy.updated': 'Pregnancy record updated',
  'pregnancy.visit': 'Antenatal visit recorded',
  'screening.invited': 'Screening invitation sent',
  'screening.recorded': 'Screening result recorded',
  'screening.opt_out': 'Screening preference changed',
  'erx.issued': 'E-prescription issued',
  'erx.dispensed': 'E-prescription dispensed by a pharmacy',
  'erx.cancelled': 'E-prescription cancelled',
  'licence.changed': 'Professional licence changed',
  'licence.check_failed': 'Blocked: licence not valid',
  'complaint.submitted': 'Complaint submitted',
  'complaint.updated': 'Complaint updated',
  'feedback.submitted': 'Feedback submitted',
  'donation.recorded': 'Organ donation decision recorded',
  'directive.recorded': 'Advance directive recorded',
  'directive.revoked': 'Advance directive revoked',
  'death.withdrawn': 'Death certificate withdrawn',
  'ems.incident_created': 'Emergency call recorded',
  'ems.incident_updated': 'Ambulance call updated',
  'ems.care_recorded': 'Pre-hospital care recorded',
  'ems.handover': 'Ambulance patient handed over',
  'infection.isolation': 'Isolation precautions changed',
  'infection.hai': 'Healthcare-associated infection recorded',
  'infection.antimicrobial_requested': 'Restricted antibiotic requested',
  'infection.antimicrobial_decided': 'Restricted antibiotic request decided',
  'sepsis.screened': 'Sepsis screen recorded',
  'sepsis.bundle': 'Sepsis Six step recorded',
  'roster.changed': 'Roster changed',
  'homecare.changed': 'Home care episode changed',
  'homecare.visit': 'Home visit recorded',
  'equipment.changed': 'Equipment register changed',
  'equipment.event': 'Equipment service or fault recorded',
  'remote.plan': 'Home monitoring plan changed',
  'remote.reading': 'Home reading submitted',
  'remote.reviewed': 'Home reading reviewed',
  'oncology.registered': 'Cancer registered',
  'oncology.updated': 'Cancer registration updated',
  'oncology.mdt_meeting': 'Tumour board meeting changed',
  'oncology.mdt_review': 'Tumour board recommendation recorded',
  'dialysis.schedule': 'Dialysis schedule changed',
  'dialysis.session': 'Dialysis session recorded',
  'mentalhealth.involuntary': 'Involuntary admission changed',
  'mentalhealth.restrictive': 'Restrictive intervention recorded',
  'donors.donor': 'Blood donor record changed',
  'donors.donation': 'Blood donation recorded',
  'access_review.opened': 'Access review opened',
  'access_review.decided': 'Access review decision',
  'access_review.completed': 'Access review completed',
  'terminology.imported': 'Terminology version imported',
  'terminology.activated': 'Terminology version activated',
  'support.ticket': 'Support request changed',
  'support.account_action': 'Account action by IT support',
  'lab.specimen': 'Specimen tracked',
  'lab.result_entered': 'Laboratory result entered',
  'lab.result_validated': 'Laboratory result validated',
  'prom.assigned': 'Questionnaire assigned',
  'prom.submitted': 'Questionnaire submitted',
  'prom.reviewed': 'Questionnaire reviewed',
};
export const actionLabel = (a: string) => (ACTION_LABELS[a] ? t(ACTION_LABELS[a]) : humanize(a));
