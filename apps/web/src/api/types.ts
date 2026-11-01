export type Role = 'MINISTRY' | 'DIRECTOR' | 'DOCTOR' | 'PATIENT';

export interface Profile {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  specialty: string | null;
  lastLoginAt: string | null;
  facility: { id: string; name: string; code: string; region: string } | null;
  patientId: string | null;
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
  doctorName: string;
}

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

export type AccessBasis = 'SELF' | 'CARE_TEAM' | 'EMERGENCY';

export interface ClinicalSummary {
  patient: Demographics;
  allergies: Allergy[];
  activeProblems: Diagnosis[];
  activeMedications: Prescription[];
  latestVitals: Vitals | null;
  recentLabResults: LabResult[];
  recentEncounters: Encounter[];
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
  specialty: string | null;
  facilityId: string;
  startedAt: string;
}

export type AppointmentStatus = 'REQUESTED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

export interface Appointment {
  id: string;
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
}

export interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  role: Exclude<Role, 'PATIENT'>;
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
