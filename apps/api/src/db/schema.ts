import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------------------------------------
 * Enums
 * ---------------------------------------------------------------------------------------------- */

/**
 * Roles are distinct responsibilities, not a ladder:
 *  - MINISTRY (national, aggregate only) and DIRECTOR (one facility, operational) manage the system;
 *  - DOCTOR and NURSE treat patients in their care team;
 *  - PHARMACIST works the facility's medication queue with the context it needs;
 *  - RECEPTION handles identity, contact details and scheduling, never clinical content;
 *  - PATIENT sees their own released record.
 */
export const roleEnum = pgEnum('role', [
  'MINISTRY',
  'DIRECTOR',
  'DOCTOR',
  'PATIENT',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
]);
export const STAFF_ROLES = [
  'MINISTRY',
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
] as const;
export const FACILITY_ROLES = ['DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION'] as const;
/** Roles that may be members of a patient's care team (and therefore read the clinical record). */
export const CARE_TEAM_ROLES = ['DOCTOR', 'NURSE'] as const;
export const facilityTypeEnum = pgEnum('facility_type', [
  'UNIVERSITY_CLINICAL_CENTER',
  'REGIONAL_HOSPITAL',
  'FAMILY_MEDICINE_CENTER',
  'SPECIALIZED_CLINIC',
]);
export const sexEnum = pgEnum('sex', ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN']);
export const bloodTypeEnum = pgEnum('blood_type', [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
  'UNKNOWN',
]);
export const encounterTypeEnum = pgEnum('encounter_type', [
  'OUTPATIENT',
  'INPATIENT',
  'EMERGENCY',
  'TELEHEALTH',
  'HOME_VISIT',
]);
export const diagnosisStatusEnum = pgEnum('diagnosis_status', ['ACTIVE', 'RESOLVED', 'CHRONIC']);
export const prescriptionStatusEnum = pgEnum('prescription_status', [
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
]);
export const allergySeverityEnum = pgEnum('allergy_severity', [
  'MILD',
  'MODERATE',
  'SEVERE',
  'LIFE_THREATENING',
]);
export const labFlagEnum = pgEnum('lab_flag', ['NORMAL', 'LOW', 'HIGH', 'CRITICAL']);
export const appointmentStatusEnum = pgEnum('appointment_status', [
  'REQUESTED',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
  'CHECKED_IN',
]);
export const pharmacyStatusEnum = pgEnum('pharmacy_status', [
  'PENDING',
  'VERIFIED',
  'RETURNED',
  'DISPENSED',
]);
export const administrationStatusEnum = pgEnum('administration_status', [
  'GIVEN',
  'WITHHELD',
  'REFUSED',
  'OMITTED',
]);
export const taskStatusEnum = pgEnum('task_status', ['OPEN', 'DONE', 'CANCELLED']);
export const taskPriorityEnum = pgEnum('task_priority', ['ROUTINE', 'URGENT']);
export const channelScopeEnum = pgEnum('channel_scope', ['FACILITY', 'NATIONAL']);
export const guardianRelationshipEnum = pgEnum('guardian_relationship', [
  'PARENT',
  'LEGAL_GUARDIAN',
  'FOSTER_CARER',
  'OTHER_AUTHORISED',
]);
/** FULL: the record, appointments and messages. APPOINTMENTS: scheduling and contact details only. */
export const proxyScopeEnum = pgEnum('proxy_scope', ['FULL', 'APPOINTMENTS']);
export const emailPreferenceEnum = pgEnum('email_preference', ['ALL', 'IMPORTANT', 'OFF']);
/** Delivery state of queued email and SMS messages. */
export const emailStatusEnum = pgEnum('email_status', ['PENDING', 'SENDING', 'SENT', 'FAILED']);
/** SMS costs money and reaches lock screens: opt-in, important notifications only. */
export const smsPreferenceEnum = pgEnum('sms_preference', ['IMPORTANT', 'OFF']);
export const labOrderStatusEnum = pgEnum('lab_order_status', [
  'ORDERED',
  'RECEIVED',
  'IN_PROGRESS',
  'RESULTED',
  'CANCELLED',
]);
export const labPriorityEnum = pgEnum('lab_priority', ['ROUTINE', 'URGENT', 'STAT']);
export const integrationKindEnum = pgEnum('integration_kind', ['LAB']);
export const messageDirectionEnum = pgEnum('message_direction', ['INBOUND', 'OUTBOUND']);
export const integrationMessageStatusEnum = pgEnum('integration_message_status', [
  'ACCEPTED',
  'REJECTED',
  'NEEDS_REVIEW',
  'RESOLVED',
  'IGNORED',
]);
export const tokenPurposeEnum = pgEnum('token_purpose', ['ACCOUNT_ACTIVATION', 'PASSWORD_RESET']);
/** Clinical notes are drafted, then signed; signed notes change only through addenda. */
export const noteStatusEnum = pgEnum('note_status', ['DRAFT', 'SIGNED']);
export const verificationStatusEnum = pgEnum('verification_status', [
  'UNCONFIRMED',
  'CONFIRMED',
  'REFUTED',
  'ENTERED_IN_ERROR',
]);
export const recordSourceEnum = pgEnum('record_source', [
  'CLINICIAN',
  'PATIENT_REPORTED',
  'IMPORTED',
]);
/** Distinguishes "no known allergies" from "never asked" – absence of data is not a negative. */
export const allergyAssessmentEnum = pgEnum('allergy_assessment', [
  'NOT_RECORDED',
  'NO_KNOWN_ALLERGIES',
  'ALLERGIES_RECORDED',
  'UNKNOWN',
]);
export const resultStatusEnum = pgEnum('result_status', ['PRELIMINARY', 'FINAL', 'CORRECTED']);
export const correctionStatusEnum = pgEnum('correction_status', ['OPEN', 'ACCEPTED', 'REJECTED']);
export const reviewOutcomeEnum = pgEnum('review_outcome', [
  'APPROPRIATE',
  'INAPPROPRIATE',
  'NEEDS_FOLLOW_UP',
]);
export const referralPriorityEnum = pgEnum('referral_priority', ['ROUTINE', 'URGENT']);
export const referralStatusEnum = pgEnum('referral_status', [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'COMPLETED',
  'CANCELLED',
]);
export const threadStatusEnum = pgEnum('thread_status', ['OPEN', 'CLOSED']);
export const announcementScopeEnum = pgEnum('announcement_scope', ['NATIONAL', 'FACILITY']);
export const announcementAudienceEnum = pgEnum('announcement_audience', [
  'EVERYONE',
  'STAFF',
  'PATIENTS',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/* ------------------------------------------------------------------------------------------------
 * Organisation
 * ---------------------------------------------------------------------------------------------- */

export const facilities = pgTable(
  'facilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    type: facilityTypeEnum('type').notNull(),
    region: varchar('region', { length: 100 }).notNull(),
    municipality: varchar('municipality', { length: 100 }).notNull(),
    address: varchar('address', { length: 300 }),
    phone: varchar('phone', { length: 40 }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('facilities_code_uq').on(t.code),
    index('facilities_region_idx').on(t.region),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Identity & access
 * ---------------------------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 254 }).notNull(),
    /** Null until the account is activated through a one-time activation link. */
    passwordHash: text('password_hash'),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    role: roleEnum('role').notNull(),
    /** Required for DIRECTOR and DOCTOR, null for MINISTRY and PATIENT. */
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'restrict' }),
    specialty: varchar('specialty', { length: 120 }),
    licenseNumber: varchar('license_number', { length: 60 }),
    isActive: boolean('is_active').notNull().default(true),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    /** TOTP secret, encrypted with AES-256-GCM (never stored in clear). */
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    /** Set once enrollment is confirmed with a valid code; MFA is enforced from then on. */
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
    /** Last accepted TOTP time-step, so a code cannot be replayed within its window. */
    mfaLastUsedStep: integer('mfa_last_used_step'),
    /** Which in-app notifications are also sent by email (content is always generic). */
    emailNotifications: emailPreferenceEnum('email_notifications').notNull().default('IMPORTANT'),
    /** Mobile number (E.164) for SMS notifications; used only once verified with a code. */
    phone: varchar('phone', { length: 20 }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    smsNotifications: smsPreferenceEnum('sms_notifications').notNull().default('OFF'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    index('users_facility_role_idx').on(t.facilityId, t.role),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque token; the raw token is only ever held by the client. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** All tokens issued from one login share a family; reuse of a rotated token revokes it. */
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    ipAddress: inet('ip_address'),
    userAgent: varchar('user_agent', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

export const oneTimeTokens = pgTable(
  'one_time_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: tokenPurposeEnum('purpose').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('one_time_tokens_hash_uq').on(t.tokenHash)],
);

/* ------------------------------------------------------------------------------------------------
 * Patients & care relationships
 * ---------------------------------------------------------------------------------------------- */

export const patients = pgTable(
  'patients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Portal account (role PATIENT). Optional: not every patient uses the portal. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** National personal number. Unique across the country. */
    nationalId: varchar('national_id', { length: 20 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
    sex: sexEnum('sex').notNull(),
    bloodType: bloodTypeEnum('blood_type').notNull().default('UNKNOWN'),
    phone: varchar('phone', { length: 40 }),
    email: varchar('email', { length: 254 }),
    address: varchar('address', { length: 300 }),
    municipality: varchar('municipality', { length: 100 }),
    emergencyContactName: varchar('emergency_contact_name', { length: 200 }),
    emergencyContactPhone: varchar('emergency_contact_phone', { length: 40 }),
    allergyAssessment: allergyAssessmentEnum('allergy_assessment')
      .notNull()
      .default('NOT_RECORDED'),
    /** Facility where the patient is registered (family medicine centre / primary hospital). */
    primaryFacilityId: uuid('primary_facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('patients_national_id_uq').on(t.nationalId),
    uniqueIndex('patients_user_uq').on(t.userId),
    index('patients_facility_idx').on(t.primaryFacilityId),
    index('patients_name_idx').on(t.lastName, t.firstName),
  ],
);

/**
 * A doctor may only access a patient's clinical record while an active care relationship exists
 * (or through audited emergency "break-glass" access). This is the core of least-privilege access.
 */
export const careAssignments = pgTable(
  'care_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedById: uuid('assigned_by_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('care_assignments_active_uq')
      .on(t.patientId, t.doctorId)
      .where(sql`${t.endedAt} IS NULL`),
    index('care_assignments_doctor_idx').on(t.doctorId),
  ],
);

export const emergencyAccessGrants = pgTable(
  'emergency_access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Retrospective review by the facility director (blueprint §3: break-glass review). */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'restrict' }),
    reviewOutcome: reviewOutcomeEnum('review_outcome'),
    reviewNotes: text('review_notes'),
  },
  (t) => [
    index('emergency_access_doctor_patient_idx').on(t.doctorId, t.patientId),
    index('emergency_access_unreviewed_idx')
      .on(t.createdAt)
      .where(sql`${t.reviewedAt} IS NULL`),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Clinical record
 * ---------------------------------------------------------------------------------------------- */

export const encounters = pgTable(
  'encounters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    type: encounterTypeEnum('type').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    notes: text('notes'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    noteStatus: noteStatusEnum('note_status').notNull().default('DRAFT'),
    /**
     * Confidential consultations (e.g. adolescent sexual or mental health) are hidden from guardians
     * together with everything recorded during them, as applicable law requires.
     */
    confidentialFromGuardians: boolean('confidential_from_guardians').notNull().default(false),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    signedById: uuid('signed_by_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Optimistic concurrency: every edit must present the version it was based on. */
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('encounters_patient_idx').on(t.patientId, t.startedAt),
    index('encounters_facility_idx').on(t.facilityId, t.startedAt),
  ],
);

/** Attributable amendments to a signed note. The original note is never overwritten. */
export const encounterAddenda = pgTable(
  'encounter_addenda',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: varchar('reason', { length: 300 }).notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('encounter_addenda_encounter_idx').on(t.encounterId)],
);

export const diagnoses = pgTable(
  'diagnoses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** ICD-10 code, e.g. "E11.9". */
    icd10Code: varchar('icd10_code', { length: 10 }).notNull(),
    description: varchar('description', { length: 300 }).notNull(),
    status: diagnosisStatusEnum('status').notNull().default('ACTIVE'),
    diagnosedAt: timestamp('diagnosed_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    index('diagnoses_patient_idx').on(t.patientId),
    index('diagnoses_icd10_idx').on(t.icd10Code),
  ],
);

export const prescriptions = pgTable(
  'prescriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    medication: varchar('medication', { length: 200 }).notNull(),
    dosage: varchar('dosage', { length: 100 }).notNull(),
    frequency: varchar('frequency', { length: 100 }).notNull(),
    route: varchar('route', { length: 50 }).notNull().default('oral'),
    instructions: text('instructions'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    status: prescriptionStatusEnum('status').notNull().default('ACTIVE'),
    /** Pharmacist verification and dispensing: prescriber, pharmacist and nurse duties stay distinct. */
    pharmacyStatus: pharmacyStatusEnum('pharmacy_status').notNull().default('PENDING'),
    verifiedById: uuid('verified_by_id').references(() => users.id, { onDelete: 'restrict' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    pharmacistNote: text('pharmacist_note'),
    dispensedById: uuid('dispensed_by_id').references(() => users.id, { onDelete: 'restrict' }),
    dispensedAt: timestamp('dispensed_at', { withTimezone: true }),
    dispensedQuantity: varchar('dispensed_quantity', { length: 100 }),
    ...timestamps,
  },
  (t) => [
    index('prescriptions_patient_idx').on(t.patientId, t.status),
    index('prescriptions_pharmacy_idx').on(t.pharmacyStatus, t.createdAt),
  ],
);

export const allergies = pgTable(
  'allergies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    substance: varchar('substance', { length: 200 }).notNull(),
    reaction: varchar('reaction', { length: 300 }),
    severity: allergySeverityEnum('severity').notNull(),
    verificationStatus: verificationStatusEnum('verification_status')
      .notNull()
      .default('UNCONFIRMED'),
    source: recordSourceEnum('source').notNull().default('CLINICIAN'),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('allergies_patient_idx').on(t.patientId)],
);

export const vitalSigns = pgTable(
  'vital_signs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    systolic: integer('systolic'),
    diastolic: integer('diastolic'),
    heartRate: integer('heart_rate'),
    temperatureC: numeric('temperature_c', { precision: 4, scale: 1 }),
    respiratoryRate: integer('respiratory_rate'),
    oxygenSaturation: integer('oxygen_saturation'),
    weightKg: numeric('weight_kg', { precision: 5, scale: 1 }),
    heightCm: numeric('height_cm', { precision: 5, scale: 1 }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vital_signs_patient_idx').on(t.patientId, t.recordedAt)],
);

export const labResults = pgTable(
  'lab_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    orderedById: uuid('ordered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    testName: varchar('test_name', { length: 200 }).notNull(),
    value: varchar('value', { length: 100 }).notNull(),
    unit: varchar('unit', { length: 40 }),
    referenceRange: varchar('reference_range', { length: 100 }),
    flag: labFlagEnum('flag').notNull().default('NORMAL'),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    status: resultStatusEnum('status').notNull().default('FINAL'),
    /** The order this result answers (results from a laboratory system always have one). */
    orderId: uuid('order_id').references(() => labOrders.id, { onDelete: 'set null' }),
    /** LOINC or local test code as sent by the laboratory. */
    testCode: varchar('test_code', { length: 40 }),
    /** MANUAL (entered by a clinician) or LIS (received from a laboratory system). */
    source: varchar('source', { length: 10 }).notNull().default('MANUAL'),
    /** When a laboratory corrects a result, the original is kept and points to its replacement. */
    supersededById: uuid('superseded_by_id'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /** Closed-loop follow-up: the ordering clinician owns the result until acknowledged. */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedById: uuid('acknowledged_by_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    /** Results become visible in the patient portal only once a clinician releases them. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedById: uuid('released_by_id').references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('lab_results_patient_idx').on(t.patientId, t.collectedAt),
    index('lab_results_unacknowledged_idx')
      .on(t.orderedById)
      .where(sql`${t.acknowledgedAt} IS NULL`),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(20),
    reason: varchar('reason', { length: 500 }).notNull(),
    status: appointmentStatusEnum('status').notNull().default('REQUESTED'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('appointments_doctor_idx').on(t.doctorId, t.scheduledAt),
    index('appointments_patient_idx').on(t.patientId, t.scheduledAt),
    index('appointments_facility_idx').on(t.facilityId, t.scheduledAt),
  ],
);

/**
 * Patients request corrections; they never edit clinician records directly. A clinician reviews
 * and responds, and any change to the record is made (and attributed) by that clinician.
 */
export const correctionRequests = pgTable(
  'correction_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    requestedById: uuid('requested_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    section: varchar('section', { length: 40 }).notNull(),
    entryId: uuid('entry_id'),
    description: text('description').notNull(),
    status: correctionStatusEnum('status').notNull().default('OPEN'),
    response: text('response'),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'restrict' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('correction_requests_patient_idx').on(t.patientId, t.status)],
);

export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mfa_recovery_codes_user_idx').on(t.userId)],
);

export const immunizations = pgTable(
  'immunizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    vaccine: varchar('vaccine', { length: 200 }).notNull(),
    doseNumber: integer('dose_number'),
    lotNumber: varchar('lot_number', { length: 60 }),
    site: varchar('site', { length: 60 }),
    administeredAt: timestamp('administered_at', { withTimezone: true }).notNull(),
    administeredById: uuid('administered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('immunizations_patient_idx').on(t.patientId, t.administeredAt)],
);

/**
 * Referrals are the governed way to share a patient across institutions: the referring doctor
 * writes a summary for the receiving facility, and only an *accepted* referral grants the receiving
 * doctor access (through a care assignment). Nothing is shared implicitly.
 */
export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    fromDoctorId: uuid('from_doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    fromFacilityId: uuid('from_facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    toFacilityId: uuid('to_facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    toDoctorId: uuid('to_doctor_id').references(() => users.id, { onDelete: 'restrict' }),
    specialty: varchar('specialty', { length: 120 }).notNull(),
    priority: referralPriorityEnum('priority').notNull().default('ROUTINE'),
    reason: varchar('reason', { length: 500 }).notNull(),
    clinicalSummary: text('clinical_summary').notNull(),
    status: referralStatusEnum('status').notNull().default('PENDING'),
    responseNote: text('response_note'),
    respondedById: uuid('responded_by_id').references(() => users.id, { onDelete: 'restrict' }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('referrals_patient_idx').on(t.patientId),
    index('referrals_to_facility_idx').on(t.toFacilityId, t.status),
    index('referrals_from_doctor_idx').on(t.fromDoctorId),
  ],
);

/** Non-urgent secure messaging between a patient and a doctor in their care team. */
export const messageThreads = pgTable(
  'message_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subject: varchar('subject', { length: 200 }).notNull(),
    /** Who opened the conversation (patient, guardian or clinician) – drives guardian visibility. */
    startedById: uuid('started_by_id').references(() => users.id, { onDelete: 'set null' }),
    status: threadStatusEnum('status').notNull().default('OPEN'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('message_threads_patient_idx').on(t.patientId, t.lastMessageAt),
    index('message_threads_doctor_idx').on(t.doctorId, t.lastMessageAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_thread_idx').on(t.threadId, t.createdAt)],
);

/**
 * In-app notifications. Titles and bodies are deliberately generic ("A new result is available")
 * so they reveal no clinical detail if shown on a lock screen or forwarded to email/SMS later.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 60 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: varchar('body', { length: 500 }),
    link: varchar('link', { length: 300 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    scope: announcementScopeEnum('scope').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'cascade' }),
    audience: announcementAudienceEnum('audience').notNull().default('EVERYONE'),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [index('announcements_published_idx').on(t.publishedAt)],
);

/**
 * Medication administration record (MAR). Administration is never inferred from a prescription or
 * a dispense: each dose given, withheld, refused or omitted is recorded with its author and reason.
 */
export const medicationAdministrations = pgTable(
  'medication_administrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prescriptionId: uuid('prescription_id')
      .notNull()
      .references(() => prescriptions.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    administeredById: uuid('administered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: administrationStatusEnum('status').notNull(),
    doseGiven: varchar('dose_given', { length: 100 }),
    reason: varchar('reason', { length: 500 }),
    notes: text('notes'),
    administeredAt: timestamp('administered_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('medication_administrations_patient_idx').on(t.patientId, t.administeredAt),
    index('medication_administrations_rx_idx').on(t.prescriptionId),
  ],
);

/** Care tasks: every task has an owner (a person or a role) and an explicit state. */
export const careTasks = pgTable(
  'care_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    // No database default: a new enum value cannot be used in the migration that adds it.
    assignedRole: roleEnum('assigned_role').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    details: text('details'),
    priority: taskPriorityEnum('priority').notNull().default('ROUTINE'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: taskStatusEnum('status').notNull().default('OPEN'),
    completedById: uuid('completed_by_id').references(() => users.id, { onDelete: 'restrict' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completionNote: text('completion_note'),
    ...timestamps,
  },
  (t) => [
    index('care_tasks_facility_idx').on(t.facilityId, t.status, t.dueAt),
    index('care_tasks_patient_idx').on(t.patientId),
  ],
);

/**
 * Team channels for staff communication. Facility channels are visible to facility staff whose role
 * is listed; national channels connect the Ministry with directors (or other roles) across
 * facilities. Channels are for coordination, not for clinical documentation.
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: channelScopeEnum('scope').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    description: varchar('description', { length: 300 }),
    allowedRoles: roleEnum('allowed_roles').array().notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    isArchived: boolean('is_archived').notNull().default(false),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channels_facility_idx').on(t.facilityId)],
);

export const channelMessages = pgTable(
  'channel_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    isUrgent: boolean('is_urgent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channel_messages_channel_idx').on(t.channelId, t.createdAt)],
);

export const channelReads = pgTable(
  'channel_reads',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('channel_reads_pk').on(t.channelId, t.userId)],
);

/**
 * Proxy access (blueprint §3): verified, explicit, patient-specific authority with scope and expiry.
 * There is no household-wide sharing – each child is linked to each guardian individually, after a
 * staff member has checked the evidence. For minors the authority ends at the 18th birthday.
 */
export const guardianships = pgTable(
  'guardianships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    guardianUserId: uuid('guardian_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    relationship: guardianRelationshipEnum('relationship').notNull(),
    scope: proxyScopeEnum('scope').notNull().default('FULL'),
    /** What was checked, e.g. "Birth certificate no. 123/2015" or "Court order 45/2024". */
    evidence: varchar('evidence', { length: 300 }).notNull(),
    verifiedById: uuid('verified_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedById: uuid('revoked_by_id').references(() => users.id, { onDelete: 'restrict' }),
    revokeReason: varchar('revoke_reason', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('guardianships_guardian_idx').on(t.guardianUserId),
    index('guardianships_patient_idx').on(t.patientId),
    uniqueIndex('guardianships_active_uq')
      .on(t.patientId, t.guardianUserId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

/**
 * Transactional email outbox. Messages are enqueued in the same transaction as the change that
 * caused them and delivered by a background worker with retries. Subject and body are encrypted at
 * rest (they may contain single-use links) and erased once delivered.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    toEmail: varchar('to_email', { length: 254 }).notNull(),
    template: varchar('template', { length: 60 }).notNull(),
    subjectSealed: text('subject_sealed'),
    textSealed: text('text_sealed'),
    htmlSealed: text('html_sealed'),
    status: emailStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 500 }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_outbox_due_idx').on(t.status, t.nextAttemptAt)],
);

/** Phone-number ownership check before any SMS is sent. Codes are hashed and attempt-limited. */
export const phoneVerifications = pgTable(
  'phone_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phone: varchar('phone', { length: 20 }).notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('phone_verifications_user_idx').on(t.userId, t.createdAt)],
);

/** SMS outbox – same guarantees as the email outbox (transactional, encrypted, retried). */
export const smsOutbox = pgTable(
  'sms_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    toPhone: varchar('to_phone', { length: 20 }).notNull(),
    template: varchar('template', { length: 60 }).notNull(),
    bodySealed: text('body_sealed'),
    status: emailStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 500 }),
    providerMessageId: varchar('provider_message_id', { length: 100 }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sms_outbox_due_idx').on(t.status, t.nextAttemptAt)],
);

/** Laboratory orders. The placer order number is what the laboratory system echoes back. */
export const labOrders = pgTable(
  'lab_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placerOrderNumber: varchar('placer_order_number', { length: 30 }).notNull(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    orderedById: uuid('ordered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    testCode: varchar('test_code', { length: 40 }).notNull(),
    testName: varchar('test_name', { length: 200 }).notNull(),
    specimen: varchar('specimen', { length: 60 }),
    priority: labPriorityEnum('priority').notNull().default('ROUTINE'),
    clinicalNotes: text('clinical_notes'),
    status: labOrderStatusEnum('status').notNull().default('ORDERED'),
    /** The laboratory system that took the order, and its own (filler) order number. */
    labClientId: uuid('lab_client_id').references(() => integrationClients.id, {
      onDelete: 'set null',
    }),
    fillerOrderNumber: varchar('filler_order_number', { length: 60 }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    resultedAt: timestamp('resulted_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('lab_orders_placer_uq').on(t.placerOrderNumber),
    index('lab_orders_facility_status_idx').on(t.facilityId, t.status),
    index('lab_orders_patient_idx').on(t.patientId),
  ],
);

/** External systems (e.g. a laboratory information system) authenticated by API key. */
export const integrationClients = pgTable(
  'integration_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    kind: integrationKindEnum('kind').notNull().default('LAB'),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    /** SHA-256 of the API key; the key itself is shown once at creation. */
    apiKeyHash: varchar('api_key_hash', { length: 64 }).notNull(),
    apiKeyPrefix: varchar('api_key_prefix', { length: 12 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('integration_clients_key_uq').on(t.apiKeyHash)],
);

/**
 * Every message exchanged with an integration client. Inbound messages are idempotent by control
 * id; messages that cannot be matched safely wait in a review queue instead of being guessed.
 */
export const integrationMessages = pgTable(
  'integration_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => integrationClients.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    messageType: varchar('message_type', { length: 20 }).notNull(),
    controlId: varchar('control_id', { length: 64 }).notNull(),
    status: integrationMessageStatusEnum('status').notNull(),
    error: varchar('error', { length: 1000 }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'set null' }),
    orderId: uuid('order_id').references(() => labOrders.id, { onDelete: 'set null' }),
    resultCount: integer('result_count').notNull().default(0),
    /** The raw message (contains health data) – encrypted at rest. */
    rawSealed: text('raw_sealed'),
    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: varchar('review_note', { length: 500 }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('integration_messages_control_uq').on(t.clientId, t.direction, t.controlId),
    index('integration_messages_status_idx').on(t.status, t.receivedAt),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Audit trail (append-only; UPDATE/DELETE are blocked by a database trigger, see migrations)
 * ---------------------------------------------------------------------------------------------- */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorRole: roleEnum('actor_role'),
    actorFacilityId: uuid('actor_facility_id'),
    action: varchar('action', { length: 80 }).notNull(),
    resourceType: varchar('resource_type', { length: 60 }),
    resourceId: uuid('resource_id'),
    /** Set whenever the event touches a patient's record, so patients can see who accessed it. */
    patientId: uuid('patient_id'),
    outcome: varchar('outcome', { length: 20 }).notNull().default('SUCCESS'),
    ipAddress: inet('ip_address'),
    userAgent: varchar('user_agent', { length: 500 }),
    requestId: varchar('request_id', { length: 64 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_logs_occurred_idx').on(t.occurredAt),
    index('audit_logs_patient_idx').on(t.patientId, t.occurredAt),
    index('audit_logs_actor_idx').on(t.actorUserId, t.occurredAt),
    index('audit_logs_facility_idx').on(t.actorFacilityId, t.occurredAt),
  ],
);

export type Role = (typeof roleEnum.enumValues)[number];
export type User = typeof users.$inferSelect;
export type Patient = typeof patients.$inferSelect;
export type Facility = typeof facilities.$inferSelect;
