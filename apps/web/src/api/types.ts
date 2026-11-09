export type Role =
  | 'MINISTRY'
  | 'DIRECTOR'
  | 'DOCTOR'
  | 'NURSE'
  | 'PHARMACIST'
  | 'RECEPTION'
  | 'LAB_TECHNICIAN'
  | 'IT_SUPPORT'
  | 'PATIENT';

export type StaffRole = Exclude<Role, 'PATIENT'>;

export interface Profile {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  specialty: string | null;
  lastLoginAt: string | null;
  facility: { id: string; name: string; code: string; region: string } | null;
  patientId: string | null;
  mfaEnabled: boolean;
  emailNotifications: EmailPreference;
  smsNotifications: SmsPreference;
  /** Authenticator-app two-step sign-in is set up. */
  totpEnabled?: boolean;
  /** Number of registered passkeys. */
  passkeyCount?: number;
  locale: 'sq' | 'en' | 'sr';
  /** Masked mobile number (e.g. "+383 •••• 801"), or null. */
  phone: string | null;
  /** Staff must enrol in two-step sign-in before using their workspace. */
  mfaRequired: boolean;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Facility {
  id: string;
  code: string;
  name: string;
  type:
    | 'UNIVERSITY_CLINICAL_CENTER'
    | 'REGIONAL_HOSPITAL'
    | 'FAMILY_MEDICINE_CENTER'
    | 'SPECIALIZED_CLINIC';
  region: string;
  municipality: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
}

export interface PatientListItem {
  /** NEWBORN or UNIDENTIFIED while the identity is temporary. */
  temporaryIdentity?: 'NEWBORN' | 'UNIDENTIFIED' | null;
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  primaryFacilityId: string;
  hasPortalAccount: boolean;
  inMyCare: boolean;
}

export interface Demographics {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  bloodType: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  municipality: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  allergyAssessment: 'NOT_RECORDED' | 'NO_KNOWN_ALLERGIES' | 'ALLERGIES_RECORDED' | 'UNKNOWN';
  primaryFacilityId: string;
  primaryFacilityName: string;
}

export interface Allergy {
  id: string;
  substance: string;
  reaction: string | null;
  severity: 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING';
  verificationStatus: 'UNCONFIRMED' | 'CONFIRMED' | 'REFUTED' | 'ENTERED_IN_ERROR';
  source: 'CLINICIAN' | 'PATIENT_REPORTED' | 'IMPORTED';
  recordedAt: string;
  recordedBy: string;
}

export interface Diagnosis {
  id: string;
  encounterId: string | null;
  icd10Code: string;
  description: string;
  status: 'ACTIVE' | 'RESOLVED' | 'CHRONIC';
  diagnosedAt: string;
  resolvedAt: string | null;
  notes: string | null;
  doctorName: string;
}

export interface Prescription {
  id: string;
  encounterId: string | null;
  medication: string;
  dosage: string;
  frequency: string;
  route: string;
  instructions: string | null;
  startDate: string;
  endDate: string | null;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  pharmacyStatus: PharmacyStatus;
  pharmacistNote: string | null;
  verifiedAt: string | null;
  dispensedAt: string | null;
  doctorName: string;
}

export type PharmacyStatus = 'PENDING' | 'VERIFIED' | 'RETURNED' | 'DISPENSED';

export interface Vitals {
  id: string;
  systolic: number | null;
  diastolic: number | null;
  heartRate: number | null;
  temperatureC: string | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  weightKg: string | null;
  heightCm: string | null;
  capillaryRefillSeconds?: string | null;
  respiratoryEffort?: string | null;
  recordedAt: string;
  recordedBy: string;
}

export interface LabResult {
  id: string;
  encounterId: string | null;
  testName: string;
  value: string;
  unit: string | null;
  referenceRange: string | null;
  flag: 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL';
  status: 'PRELIMINARY' | 'FINAL' | 'CORRECTED';
  collectedAt: string;
  acknowledgedAt: string | null;
  releasedAt: string | null;
  orderedBy: string;
  orderId?: string | null;
  testCode?: string | null;
  /** MANUAL (entered by a clinician) or LIS (received from a connected laboratory). */
  source?: 'MANUAL' | 'LIS';
  /** For a corrected result: the value it replaced. */
  previousValue?: string | null;
}

export interface Addendum {
  id: string;
  reason: string;
  content: string;
  createdAt: string;
  authorName: string;
}

export interface Encounter {
  id: string;
  type: 'OUTPATIENT' | 'INPATIENT' | 'EMERGENCY' | 'TELEHEALTH' | 'HOME_VISIT';
  reason: string;
  notes: string | null;
  noteStatus: 'DRAFT' | 'SIGNED';
  confidentialFromGuardians: boolean;
  signedAt: string | null;
  version: number;
  startedAt: string;
  endedAt: string | null;
  doctorId: string;
  doctorName: string;
  doctorSpecialty: string | null;
  facilityName: string;
  diagnoses: Pick<Diagnosis, 'id' | 'icd10Code' | 'description' | 'status'>[];
  prescriptions: Pick<Prescription, 'id' | 'medication' | 'dosage' | 'frequency' | 'status'>[];
  addenda: Addendum[];
}

export type AccessBasis = 'SELF' | 'GUARDIAN' | 'CARE_TEAM' | 'EMERGENCY';

export interface ClinicalSummary {
  patient: Demographics;
  allergies: Allergy[];
  activeProblems: Diagnosis[];
  activeMedications: Prescription[];
  latestVitals: Vitals | null;
  recentLabResults: LabResult[];
  recentEncounters: Encounter[];
  immunizations: Immunization[];
  counts: {
    encounters: number;
    diagnoses: number;
    prescriptions: number;
    labResults: number;
    openCorrectionRequests: number;
  };
  accessBasis: AccessBasis;
}

export interface CareTeamMember {
  doctorId: string;
  fullName: string;
  role: Role;
  specialty: string | null;
  facilityId: string;
  startedAt: string;
}

export type AppointmentStatus =
  'REQUESTED' | 'CONFIRMED' | 'CHECKED_IN' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

export interface Appointment {
  id: string;
  /** STAFF or PORTAL (booked by the patient online). */
  bookedVia?: 'STAFF' | 'PORTAL';
  /** IN_PERSON or VIDEO (telemedicine). */
  mode?: 'IN_PERSON' | 'VIDEO';
  scheduledAt: string;
  durationMinutes: number;
  reason: string;
  status: AppointmentStatus;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  doctorSpecialty: string | null;
  facilityId: string;
  facilityName: string;
}

export interface CorrectionRequest {
  id: string;
  section: string;
  entryId: string | null;
  description: string;
  status: 'OPEN' | 'ACCEPTED' | 'REJECTED';
  response: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export interface AccessLogEntry {
  id: string;
  occurredAt: string;
  action: string;
  actorName: string | null;
  actorRole: Role | null;
  actorSpecialty: string | null;
  facilityName: string | null;
  section: string | null;
  basis: string | null;
  /** Organisation name for accesses by partner systems (no user account). */
  actorLabel?: string | null;
  emergencyReason: string | null;
}

export interface Worklist {
  unacknowledgedResults: {
    id: string;
    patientId: string;
    patientName: string;
    testName: string;
    value: string;
    unit: string | null;
    flag: LabResult['flag'];
    status: LabResult['status'];
    collectedAt: string;
  }[];
  openCorrectionRequests: {
    id: string;
    patientId: string;
    patientName: string;
    section: string;
    description: string;
    createdAt: string;
  }[];
  draftNotes: {
    id: string;
    patientId: string;
    patientName: string;
    type: Encounter['type'];
    reason: string;
    startedAt: string;
    version: number;
  }[];
  returnedPrescriptions: {
    id: string;
    patientId: string;
    patientName: string;
    medication: string;
    dosage: string;
    frequency: string;
    pharmacistNote: string | null;
    returnedAt: string | null;
  }[];
}

export interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  role: StaffRole;
  specialty: string | null;
  licenseNumber: string | null;
  isActive: boolean;
  activated: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  facilityId: string | null;
  facilityName: string | null;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  actorUserId: string | null;
  actorName: string | null;
  actorRole: Role | null;
  actorFacilityId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  patientId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MonthCount {
  month: string;
  count: number;
}

export interface DiagnosisCount {
  icd10Code: string;
  description: string;
  count: number | null;
  suppressed: boolean;
}

export interface FacilityStats {
  totals: {
    patients: number;
    portalUsers: number;
    activeDoctors: number;
    encounters30d: number;
    upcomingAppointments: number;
    pendingAppointmentRequests: number;
    emergencyAccess30d: number;
  };
  exceptions: {
    resultsUnacknowledgedOver48h: number;
    notesUnsignedOver72h: number;
    openCorrectionRequests: number;
  };
  encountersByMonth: MonthCount[];
  encountersByType: { type: string; count: number }[];
  topDiagnoses: DiagnosisCount[];
  doctorWorkload: {
    doctorId: string;
    fullName: string;
    specialty: string | null;
    patients: number;
    encounters30d: number;
  }[];
  appointmentsByStatus: { status: string; count: number }[];
}

export interface NationalStats {
  totals: {
    facilities: number;
    patients: number;
    portalUsers: number;
    doctors: number;
    encounters30d: number;
    emergencyAccess30d: number;
  };
  byFacility: {
    id: string;
    code: string;
    name: string;
    type: Facility['type'];
    region: string;
    isActive: boolean;
    patients: number;
    doctors: number;
    encounters30d: number;
    directorName: string | null;
  }[];
  byRegion: { region: string; facilities: number; patients: number; encounters30d: number }[];
  encountersByMonth: MonthCount[];
  topDiagnoses: DiagnosisCount[];
  smallCellThreshold: number;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface MessageThreadSummary {
  id: string;
  subject: string;
  status: 'OPEN' | 'CLOSED';
  lastMessageAt: string;
  createdAt: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  doctorSpecialty: string | null;
  unreadCount: number;
}

export interface ThreadMessage {
  id: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  senderId: string;
  senderName: string;
  senderRole: Role;
}

export interface MessageThreadDetail {
  id: string;
  subject: string;
  status: 'OPEN' | 'CLOSED';
  patientId: string;
  doctorId: string;
  patientName: string;
  doctorName: string;
  canReply: boolean;
  messages: ThreadMessage[];
}

export type ReferralStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'COMPLETED' | 'CANCELLED';

export interface Referral {
  id: string;
  status: ReferralStatus;
  priority: 'ROUTINE' | 'URGENT';
  specialty: string;
  reason: string;
  clinicalSummary: string;
  responseNote: string | null;
  respondedAt: string | null;
  createdAt: string;
  patientId: string;
  patientName: string;
  patientDateOfBirth: string;
  patientSex: string;
  fromDoctorId: string;
  fromDoctorName: string;
  fromFacilityId: string;
  fromFacilityName: string;
  toFacilityId: string;
  toFacilityName: string;
  toDoctorId: string | null;
  toDoctorName: string | null;
}

export interface Immunization {
  id: string;
  encounterId: string | null;
  vaccine: string;
  doseNumber: number | null;
  lotNumber: string | null;
  site: string | null;
  administeredAt: string;
  notes: string | null;
  administeredBy: string;
  facilityName: string;
}

export type ReviewOutcome = 'APPROPRIATE' | 'INAPPROPRIATE' | 'NEEDS_FOLLOW_UP';

export interface EmergencyAccessEvent {
  id: string;
  createdAt: string;
  expiresAt: string;
  reason: string;
  doctorId: string;
  doctorName: string;
  doctorSpecialty: string | null;
  patientId: string;
  patientName: string;
  reviewedAt: string | null;
  reviewOutcome: ReviewOutcome | null;
  reviewNotes: string | null;
  reviewedBy: string | null;
  recordViews: number;
  recordChanges: number;
}

export interface EmergencyOversightRow {
  facilityId: string;
  facilityName: string;
  region: string;
  total: number;
  unreviewed: number;
  overdueReviews: number;
  inappropriate: number;
  needsFollowUp: number;
}

export interface Announcement {
  id: string;
  scope: 'NATIONAL' | 'FACILITY';
  audience: 'EVERYONE' | 'STAFF' | 'PATIENTS';
  title: string;
  body: string;
  publishedAt: string;
  expiresAt: string | null;
  facilityId: string | null;
  facilityName: string | null;
  authorName: string;
}

export interface DiagnosesReportRow {
  region: string;
  icd10Code: string;
  description: string;
  patients: number | null;
  suppressed: boolean;
}

export interface ActivityReportRow {
  code: string;
  name: string;
  region: string;
  encounters: number;
  uniquePatients: number | null;
  appointmentsCompleted: number;
  noShows: number;
  referralsSent: number;
  referralsReceived: number;
  vaccinations: number;
  emergencyAccess: number;
}

export interface Report<Row> {
  from: string;
  to: string;
  smallCellThreshold: number;
  columns: string[];
  rows: Row[];
}

export interface DirectoryEntry {
  id: string;
  fullName: string;
  role: StaffRole;
  specialty: string | null;
}

export interface CareTask {
  id: string;
  patientId?: string;
  patientName?: string;
  title: string;
  details: string | null;
  priority: 'ROUTINE' | 'URGENT';
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  dueAt: string | null;
  assignedRole: Role;
  assignedToId: string | null;
  assignedToName: string | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  completedAt: string | null;
  completionNote?: string | null;
  completedByName?: string | null;
  overdue?: boolean;
}

export type AdministrationStatus = 'GIVEN' | 'WITHHELD' | 'REFUSED' | 'OMITTED';

export interface MedicationAdministration {
  id: string;
  prescriptionId: string;
  medication: string;
  dosage: string;
  status: AdministrationStatus;
  doseGiven: string | null;
  reason: string | null;
  notes: string | null;
  administeredAt: string;
  recordedBy: string;
}

export interface SafetyAlert {
  kind: 'ALLERGY' | 'CROSS_REACTIVITY' | 'DUPLICATE_THERAPY';
  severity: 'HIGH' | 'MODERATE';
  message: string;
}

export interface PharmacyItem {
  /** Link to the national medication catalogue (pharmacy stock). */
  catalogItemId?: string | null;
  id: string;
  patientId: string;
  patientName: string;
  patientDateOfBirth: string;
  patientSex: string;
  medication: string;
  dosage: string;
  frequency: string;
  route: string;
  instructions: string | null;
  startDate: string;
  endDate: string | null;
  status: Prescription['status'];
  pharmacyStatus: PharmacyStatus;
  pharmacistNote: string | null;
  verifiedAt: string | null;
  dispensedAt: string | null;
  dispensedQuantity: string | null;
  createdAt: string;
  prescriberId: string;
  prescriberName: string;
  alerts?: SafetyAlert[];
}

export interface PharmacyQueue {
  items: PharmacyItem[];
  counts: Partial<Record<PharmacyStatus, number>>;
}

export interface PharmacyContext {
  prescription: PharmacyItem;
  allergyAssessment: Demographics['allergyAssessment'];
  allergies: Pick<Allergy, 'substance' | 'reaction' | 'severity' | 'verificationStatus'>[];
  otherActiveMedications: {
    id: string;
    medication: string;
    dosage: string;
    frequency: string;
    pharmacyStatus: PharmacyStatus;
  }[];
  activeProblems: { icd10Code: string; description: string; status: string }[];
  renalAndElectrolytes: {
    testName: string;
    value: string;
    unit: string | null;
    flag: LabResult['flag'];
    collectedAt: string;
  }[];
  latestWeight: { weightKg: string; recordedAt: string } | null;
  alerts: SafetyAlert[];
}

export interface Channel {
  id: string;
  scope: 'FACILITY' | 'NATIONAL';
  name: string;
  description: string | null;
  allowedRoles: StaffRole[];
  facilityName: string | null;
  lastMessageAt: string | null;
  isArchived: boolean;
  unreadCount: number;
}

export interface ChannelMessage {
  id: string;
  body: string;
  isUrgent: boolean;
  createdAt: string;
  authorId: string;
  authorName: string;
  authorRole: StaffRole;
  authorFacility: string | null;
}

export type ReportName =
  | 'activity'
  | 'diagnoses'
  | 'medications'
  | 'pharmacy'
  | 'vaccinations'
  | 'referrals'
  | 'appointments'
  | 'workforce';

/** Generic report payload; rows are keyed by `columns`. Suppressed patient counts are null. */
export interface GenericReport {
  from: string;
  to: string;
  smallCellThreshold: number;
  columns: string[];
  rows: (Record<string, string | number | boolean | null> & { suppressed?: boolean })[];
}

export type EmailPreference = 'ALL' | 'IMPORTANT' | 'OFF';
export type GuardianRelationship =
  'PARENT' | 'LEGAL_GUARDIAN' | 'FOSTER_CARER' | 'OTHER_AUTHORISED';
export type ProxyScope = 'FULL' | 'APPOINTMENTS';

/** A record this account may open on someone else's behalf. */
export interface Dependant {
  guardianshipId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  relationship: GuardianRelationship;
  scope: ProxyScope;
  validUntil: string;
}

export interface Guardianship {
  id: string;
  guardianUserId: string;
  guardianName: string;
  /** Only returned to staff. */
  guardianEmail?: string;
  guardianActivated: boolean;
  relationship: GuardianRelationship;
  scope: ProxyScope;
  evidence: string;
  validFrom: string;
  validUntil: string;
  revokedAt: string | null;
  revokeReason: string | null;
  verifiedBy: string;
  createdAt: string;
  active: boolean;
}

export type EmailHealth = Partial<
  Record<'PENDING' | 'SENDING' | 'SENT' | 'FAILED', { count: number; oldest: string | null }>
>;

export type SmsPreference = 'IMPORTANT' | 'OFF';
export type SmsHealth = EmailHealth;

/* ------------------------------------------------------------------ laboratory */
export interface LabTest {
  code: string;
  name: string;
  specimen: string;
  unit: string;
  referenceRange: string;
}

export type LabOrderStatus = 'ORDERED' | 'RECEIVED' | 'IN_PROGRESS' | 'RESULTED' | 'CANCELLED';
export type LabPriority = 'ROUTINE' | 'URGENT' | 'STAT';

export interface LabOrder {
  id: string;
  placerOrderNumber: string;
  testCode: string;
  testName: string;
  specimen: string | null;
  priority: LabPriority;
  clinicalNotes: string | null;
  status: LabOrderStatus;
  fillerOrderNumber: string | null;
  createdAt: string;
  receivedAt: string | null;
  resultedAt: string | null;
  cancelledAt: string | null;
  orderedBy: string;
}

export interface IntegrationClient {
  id: string;
  name: string;
  kind: 'LAB';
  apiKeyPrefix: string;
  isActive: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export type IntegrationMessageStatus =
  'ACCEPTED' | 'REJECTED' | 'NEEDS_REVIEW' | 'RESOLVED' | 'IGNORED';

export interface IntegrationMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  messageType: string;
  controlId: string;
  status: IntegrationMessageStatus;
  error: string | null;
  resultCount: number;
  patientId: string | null;
  orderId: string | null;
  receivedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  clientName: string;
}

export interface IntegrationMessageDetail extends Omit<IntegrationMessage, 'clientName'> {
  identifiers: { nationalId: string; name: string; dateOfBirth: string; placerOrderNumber: string };
  candidates: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    nationalId: string;
  }[];
}
