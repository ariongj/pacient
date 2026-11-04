import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
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
export const temporaryIdentityEnum = pgEnum('temporary_identity', ['NEWBORN', 'UNIDENTIFIED']);
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
    /** Interface and message language: sq (Albanian) or en (English). */
    locale: varchar('locale', { length: 5 }).notNull().default('sq'),
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
    /** Set when this record was a duplicate merged into another one (it is then read-only). */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => patients.id, {
      onDelete: 'restrict',
    }),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    /**
     * Temporary identity (newborn without a national number yet, or an unidentified patient). The
     * nationalId then holds a generated temporary number (TMP…) until the identity is confirmed.
     */
    temporaryIdentity: temporaryIdentityEnum('temporary_identity'),
    /** Free description for unidentified patients, e.g. "Man, about 40, brought by ambulance". */
    identityNote: varchar('identity_note', { length: 300 }),
    identityConfirmedAt: timestamp('identity_confirmed_at', { withTimezone: true }),
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
    /** Optional link to the national medication catalogue (used for pharmacy stock). */
    catalogItemId: uuid('catalog_item_id').references((): AnyPgColumn => medicationCatalog.id, {
      onDelete: 'set null',
    }),
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
    /** ACVPU: A alert, C new confusion, V voice, P pain, U unresponsive (for NEWS2). */
    consciousness: varchar('consciousness', { length: 1 }),
    onSupplementalOxygen: boolean('on_supplemental_oxygen'),
    painScore: integer('pain_score'),
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
    /** STAFF (booked by the facility) or PORTAL (patient booked a published slot). */
    bookedVia: varchar('booked_via', { length: 10 }).notNull().default('STAFF'),
    /** IN_PERSON or VIDEO (telemedicine). */
    mode: varchar('mode', { length: 10 }).notNull().default('IN_PERSON'),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
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
    /** Dose of the national schedule this vaccination counts for, if any. */
    scheduleItemId: uuid('schedule_item_id').references((): AnyPgColumn => vaccineSchedule.id, {
      onDelete: 'set null',
    }),
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
 * Documents, consent, result cover and escalation
 * ---------------------------------------------------------------------------------------------- */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const documentCategoryEnum = pgEnum('document_category', [
  'REFERRAL_LETTER',
  'DISCHARGE_SUMMARY',
  'IMAGING_REPORT',
  'LAB_REPORT',
  'CONSENT_FORM',
  'CLINICAL_PHOTO',
  'PATIENT_PROVIDED',
  'OTHER',
]);
export const documentStatusEnum = pgEnum('document_status', ['CURRENT', 'ENTERED_IN_ERROR']);
export const scanStatusEnum = pgEnum('scan_status', ['CLEAN', 'NOT_SCANNED']);

/**
 * Documents attached to a patient's record (scanned letters, reports, photos, signed consent
 * forms). Metadata lives here; the encrypted content lives in `document_contents`. Documents are
 * never deleted – a wrong upload is marked "entered in error" with a reason.
 */
export const patientDocuments = pgTable(
  'patient_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    category: documentCategoryEnum('category').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    fileName: varchar('file_name', { length: 200 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    scanStatus: scanStatusEnum('scan_status').notNull().default('NOT_SCANNED'),
    /** STAFF uploads become visible to the patient only when shared; PATIENT uploads always are. */
    source: varchar('source', { length: 10 }).notNull().default('STAFF'),
    visibleToPatient: boolean('visible_to_patient').notNull().default(false),
    confidentialFromGuardians: boolean('confidential_from_guardians').notNull().default(false),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    uploadedById: uuid('uploaded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: documentStatusEnum('status').notNull().default('CURRENT'),
    errorReason: varchar('error_reason', { length: 300 }),
    markedInErrorById: uuid('marked_in_error_by_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    markedInErrorAt: timestamp('marked_in_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('patient_documents_patient_idx').on(t.patientId, t.createdAt)],
);

/** Encrypted document bytes (AES-256-GCM: 12-byte IV ‖ 16-byte tag ‖ ciphertext). */
export const documentContents = pgTable('document_contents', {
  documentId: uuid('document_id')
    .primaryKey()
    .references(() => patientDocuments.id, { onDelete: 'cascade' }),
  content: bytea('content').notNull(),
});

export const consentTypeEnum = pgEnum('consent_type', [
  /** Sharing the record with another facility when the patient is referred there. */
  'CROSS_FACILITY_SHARING',
  /** Use of de-identified data for approved research and public-health statistics. */
  'RESEARCH',
  /** Consent to a specific treatment or procedure, recorded by the clinician. */
  'TREATMENT',
]);
export const consentDecisionEnum = pgEnum('consent_decision', ['GRANTED', 'WITHDRAWN', 'REFUSED']);
export const consentMethodEnum = pgEnum('consent_method', ['PORTAL', 'IN_PERSON', 'WRITTEN']);

/**
 * Consent decisions as an append-only history: every change is a new row, the latest row per
 * (patient, type[, procedure]) is the current decision. Nothing is ever overwritten.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    type: consentTypeEnum('type').notNull(),
    decision: consentDecisionEnum('decision').notNull(),
    method: consentMethodEnum('method').notNull(),
    /** For TREATMENT consent: the procedure, e.g. "Appendectomy". */
    procedure: varchar('procedure', { length: 200 }),
    /** Version of the explanation the patient was shown, so the decision can be interpreted later. */
    wordingVersion: varchar('wording_version', { length: 20 }).notNull(),
    note: varchar('note', { length: 1000 }),
    /** Signed form, when consent was given in writing. */
    documentId: uuid('document_id').references(() => patientDocuments.id, { onDelete: 'set null' }),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Set when a guardian decided on the child's behalf. */
    onBehalfGuardianshipId: uuid('on_behalf_guardianship_id').references(() => guardianships.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('consent_records_patient_idx').on(t.patientId, t.type, t.createdAt)],
);

/**
 * Result cover: while a doctor is away, a colleague at the same facility receives their result
 * notifications, sees their unacknowledged results and may review them for their patients.
 */
export const coverArrangements = pgTable(
  'cover_arrangements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    coverDoctorId: uuid('cover_doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    note: varchar('note', { length: 300 }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cover_arrangements_doctor_idx').on(t.doctorId, t.endsAt),
    index('cover_arrangements_cover_idx').on(t.coverDoctorId, t.endsAt),
  ],
);

/** Escalations of critical results nobody has acknowledged (one row per result and level). */
export const resultEscalations = pgTable(
  'result_escalations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    labResultId: uuid('lab_result_id')
      .notNull()
      .references(() => labResults.id, { onDelete: 'cascade' }),
    level: integer('level').notNull(),
    notifiedUserIds: jsonb('notified_user_ids').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('result_escalations_uq').on(t.labResultId, t.level)],
);

/**
 * Lineage of patient merges. The duplicate record is kept (marked merged) and every row moved to
 * the surviving record is listed in `movedRows`, so a wrong merge can be undone exactly.
 */
export const patientMerges = pgTable(
  'patient_merges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    survivorId: uuid('survivor_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    mergedId: uuid('merged_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    reason: varchar('reason', { length: 500 }).notNull(),
    /** table name → ids of rows moved from the duplicate to the survivor. */
    movedRows: jsonb('moved_rows').$type<Record<string, string[]>>().notNull(),
    /** Demographics of both records at the time of the merge. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    mergedById: uuid('merged_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    mergedAt: timestamp('merged_at', { withTimezone: true }).notNull().defaultNow(),
    unmergedById: uuid('unmerged_by_id').references(() => users.id, { onDelete: 'restrict' }),
    unmergedAt: timestamp('unmerged_at', { withTimezone: true }),
    unmergeReason: varchar('unmerge_reason', { length: 500 }),
  },
  (t) => [
    index('patient_merges_survivor_idx').on(t.survivorId),
    uniqueIndex('patient_merges_active_uq')
      .on(t.mergedId)
      .where(sql`${t.unmergedAt} IS NULL`),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Hospital modules: care units (wards, emergency, radiology), beds, admissions, emergency
 * department, births and imaging
 * ---------------------------------------------------------------------------------------------- */

export const careUnitTypeEnum = pgEnum('care_unit_type', [
  'GENERAL_WARD',
  'SURGICAL_WARD',
  'ICU',
  'MATERNITY',
  'PAEDIATRIC',
  'NEONATAL',
  'EMERGENCY',
  'RADIOLOGY',
  'OPERATING_THEATRE',
  'BLOOD_BANK',
  'NUTRITION',
]);
export const bedStatusEnum = pgEnum('bed_status', [
  'AVAILABLE',
  'OCCUPIED',
  'CLEANING',
  'OUT_OF_SERVICE',
]);
export const admissionSourceEnum = pgEnum('admission_source', [
  'EMERGENCY',
  'ELECTIVE',
  'TRANSFER',
  'BIRTH',
]);
export const admissionStatusEnum = pgEnum('admission_status', [
  'ADMITTED',
  'DISCHARGED',
  'CANCELLED',
]);
export const dischargeDispositionEnum = pgEnum('discharge_disposition', [
  'HOME',
  'TRANSFER',
  'AGAINST_ADVICE',
  'DECEASED',
  'OTHER',
]);
export const edArrivalModeEnum = pgEnum('ed_arrival_mode', [
  'WALK_IN',
  'AMBULANCE',
  'REFERRAL',
  'POLICE',
  'OTHER',
]);
export const edStatusEnum = pgEnum('ed_status', [
  'WAITING',
  'IN_TREATMENT',
  'ADMITTED',
  'DISCHARGED',
  'TRANSFERRED',
  'LEFT_WITHOUT_BEING_SEEN',
]);
export const deliveryTypeEnum = pgEnum('delivery_type', [
  'SPONTANEOUS_VAGINAL',
  'ASSISTED_VAGINAL',
  'CAESAREAN_ELECTIVE',
  'CAESAREAN_EMERGENCY',
]);
export const imagingModalityEnum = pgEnum('imaging_modality', [
  'XRAY',
  'CT',
  'MRI',
  'ULTRASOUND',
  'MAMMOGRAPHY',
  'FLUOROSCOPY',
]);
export const imagingStatusEnum = pgEnum('imaging_status', [
  'ORDERED',
  'SCHEDULED',
  'PERFORMED',
  'REPORTED',
  'CANCELLED',
]);

/**
 * A unit of a facility where patients are cared for or examined: a ward (with beds), the
 * emergency department or radiology. Staff are assigned to units; that assignment, together with
 * the patient's presence in the unit, gives them access to the patient's record (see policy.ts).
 */
export const careUnits = pgTable(
  'care_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    code: varchar('code', { length: 20 }).notNull(),
    type: careUnitTypeEnum('type').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('care_units_code_uq').on(t.facilityId, t.code)],
);

export const unitStaff = pgTable(
  'unit_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedById: uuid('assigned_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('unit_staff_uq').on(t.unitId, t.userId),
    index('unit_staff_user_idx').on(t.userId),
  ],
);

export const beds = pgTable(
  'beds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 20 }).notNull(),
    status: bedStatusEnum('status').notNull().default('AVAILABLE'),
    note: varchar('note', { length: 200 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('beds_label_uq').on(t.unitId, t.label)],
);

export const admissions = pgTable(
  'admissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'restrict' }),
    bedId: uuid('bed_id').references(() => beds.id, { onDelete: 'set null' }),
    admittingDoctorId: uuid('admitting_doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    attendingDoctorId: uuid('attending_doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    source: admissionSourceEnum('source').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    edVisitId: uuid('ed_visit_id'),
    status: admissionStatusEnum('status').notNull().default('ADMITTED'),
    admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull().defaultNow(),
    expectedDischargeAt: timestamp('expected_discharge_at', { withTimezone: true }),
    dischargedAt: timestamp('discharged_at', { withTimezone: true }),
    dischargedById: uuid('discharged_by_id').references(() => users.id, { onDelete: 'restrict' }),
    disposition: dischargeDispositionEnum('disposition'),
    /** Discharge summary; immutable once signed (dischargeSignedAt). */
    dischargeSummary: text('discharge_summary'),
    dischargeSignedAt: timestamp('discharge_signed_at', { withTimezone: true }),
    releasedToPatientAt: timestamp('released_to_patient_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admissions_patient_idx').on(t.patientId, t.admittedAt),
    index('admissions_unit_status_idx').on(t.unitId, t.status),
    uniqueIndex('admissions_one_active_per_patient_uq')
      .on(t.patientId)
      .where(sql`${t.status} = 'ADMITTED'`),
    uniqueIndex('admissions_one_patient_per_bed_uq')
      .on(t.bedId)
      .where(sql`${t.status} = 'ADMITTED' AND ${t.bedId} IS NOT NULL`),
  ],
);

/** Every bed or unit change during a stay (admission, transfer). */
export const bedMovements = pgTable(
  'bed_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    fromUnitId: uuid('from_unit_id').references(() => careUnits.id, { onDelete: 'set null' }),
    fromBedId: uuid('from_bed_id').references(() => beds.id, { onDelete: 'set null' }),
    toUnitId: uuid('to_unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'restrict' }),
    toBedId: uuid('to_bed_id').references(() => beds.id, { onDelete: 'set null' }),
    reason: varchar('reason', { length: 300 }),
    movedById: uuid('moved_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    movedAt: timestamp('moved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bed_movements_admission_idx').on(t.admissionId, t.movedAt)],
);

/** An emergency department attendance, from arrival through triage to departure. */
export const edVisits = pgTable(
  'ed_visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'restrict' }),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }).notNull().defaultNow(),
    arrivalMode: edArrivalModeEnum('arrival_mode').notNull(),
    chiefComplaint: varchar('chief_complaint', { length: 300 }).notNull(),
    registeredById: uuid('registered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** 1 immediate (red) … 5 non-urgent (blue); five-level triage scale. */
    triageLevel: integer('triage_level'),
    triageNote: varchar('triage_note', { length: 1000 }),
    triagedById: uuid('triaged_by_id').references(() => users.id, { onDelete: 'restrict' }),
    triagedAt: timestamp('triaged_at', { withTimezone: true }),
    assignedDoctorId: uuid('assigned_doctor_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    seenAt: timestamp('seen_at', { withTimezone: true }),
    status: edStatusEnum('status').notNull().default('WAITING'),
    departedAt: timestamp('departed_at', { withTimezone: true }),
    dispositionNote: varchar('disposition_note', { length: 1000 }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ed_visits_board_idx').on(t.unitId, t.status, t.arrivedAt),
    index('ed_visits_patient_idx').on(t.patientId, t.arrivedAt),
    uniqueIndex('ed_visits_one_active_per_patient_uq')
      .on(t.patientId)
      .where(sql`${t.status} IN ('WAITING', 'IN_TREATMENT')`),
  ],
);

/** A birth: links the newborn's record to the mother's and records the birth details. */
export const births = pgTable(
  'births',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    motherPatientId: uuid('mother_patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    newbornPatientId: uuid('newborn_patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    motherAdmissionId: uuid('mother_admission_id').references(() => admissions.id, {
      onDelete: 'set null',
    }),
    bornAt: timestamp('born_at', { withTimezone: true }).notNull(),
    deliveryType: deliveryTypeEnum('delivery_type').notNull(),
    gestationalWeeks: integer('gestational_weeks').notNull(),
    gestationalDays: integer('gestational_days').notNull().default(0),
    birthWeightGrams: integer('birth_weight_grams').notNull(),
    lengthCm: numeric('length_cm', { precision: 4, scale: 1 }),
    headCircumferenceCm: numeric('head_circumference_cm', { precision: 4, scale: 1 }),
    apgar1: integer('apgar_1').notNull(),
    apgar5: integer('apgar_5').notNull(),
    apgar10: integer('apgar_10'),
    /** 1 for a single birth; 1, 2 … for twins/triplets. */
    birthOrder: integer('birth_order').notNull().default(1),
    attendantId: uuid('attendant_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    notes: varchar('notes', { length: 2000 }),
    /** When the civil registry number was entered for the newborn. */
    civilRegisteredAt: timestamp('civil_registered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('births_newborn_uq').on(t.newbornPatientId),
    index('births_mother_idx').on(t.motherPatientId),
    index('births_facility_idx').on(t.facilityId, t.bornAt),
  ],
);

export const imagingOrders = pgTable(
  'imaging_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accessionNumber: varchar('accession_number', { length: 20 }).notNull(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    edVisitId: uuid('ed_visit_id').references(() => edVisits.id, { onDelete: 'set null' }),
    orderedById: uuid('ordered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    modality: imagingModalityEnum('modality').notNull(),
    bodyPart: varchar('body_part', { length: 120 }).notNull(),
    clinicalQuestion: varchar('clinical_question', { length: 1000 }).notNull(),
    priority: labPriorityEnum('priority').notNull().default('ROUTINE'),
    /** Safety questions answered by the orderer (pregnancy, contrast allergy, implants). */
    safetyChecks: jsonb('safety_checks').$type<Record<string, unknown>>(),
    status: imagingStatusEnum('status').notNull().default('ORDERED'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    performedAt: timestamp('performed_at', { withTimezone: true }),
    performedById: uuid('performed_by_id').references(() => users.id, { onDelete: 'restrict' }),
    findings: text('findings'),
    impression: text('impression'),
    critical: boolean('critical').notNull().default(false),
    reportedById: uuid('reported_by_id').references(() => users.id, { onDelete: 'restrict' }),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    acknowledgedById: uuid('acknowledged_by_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: varchar('cancel_reason', { length: 300 }),
    /** DICOM Study Instance UID in the PACS, once images exist. */
    studyInstanceUid: varchar('study_instance_uid', { length: 128 }),
    imagesAvailableAt: timestamp('images_available_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('imaging_orders_accession_uq').on(t.accessionNumber),
    index('imaging_orders_worklist_idx').on(t.facilityId, t.status, t.createdAt),
    index('imaging_orders_patient_idx').on(t.patientId, t.createdAt),
  ],
);

/** Scopes a partner system may be granted (checked by a database constraint as well). */
export const PARTNER_SCOPES = [
  'fhir.patient.read',
  'stats.read',
  'directory.read',
  'births.notify',
  'claims.read',
  'surveillance.read',
] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

/**
 * External systems with API access (insurance fund, civil registry, other hospitals' EHRs, public
 * health). Managed by the Ministry; each system has its own revocable key (only its hash is
 * stored) and only the scopes it needs. Every call is audited.
 */
export const partnerClients = pgTable(
  'partner_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    organisation: varchar('organisation', { length: 200 }).notNull(),
    scopes: text('scopes').array().notNull(),
    apiKeyHash: varchar('api_key_hash', { length: 128 }).notNull(),
    apiKeyPrefix: varchar('api_key_prefix', { length: 20 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    allowedIps: text('allowed_ips').array(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('partner_clients_key_uq').on(t.apiKeyHash)],
);

/* ------------------------------------------------------------------------------------------------
 * Operating theatres and pharmacy stock
 * ---------------------------------------------------------------------------------------------- */

export const surgeryPriorityEnum = pgEnum('surgery_priority', ['ELECTIVE', 'URGENT', 'EMERGENCY']);
export const surgeryStatusEnum = pgEnum('surgery_status', [
  'REQUESTED',
  'SCHEDULED',
  'IN_THEATRE',
  'COMPLETED',
  'POSTPONED',
  'CANCELLED',
]);
export const anaesthesiaTypeEnum = pgEnum('anaesthesia_type', [
  'GENERAL',
  'SPINAL',
  'EPIDURAL',
  'REGIONAL_BLOCK',
  'LOCAL',
  'SEDATION',
]);
export const lateralityEnum = pgEnum('laterality', [
  'LEFT',
  'RIGHT',
  'BILATERAL',
  'NOT_APPLICABLE',
]);

/**
 * A surgical case: request → scheduled in a theatre → in theatre (WHO surgical safety checklist:
 * sign in, time out, sign out) → completed with a signed, immutable operation note.
 */
export const surgicalCases = pgTable(
  'surgical_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    theatreUnitId: uuid('theatre_unit_id').references(() => careUnits.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    procedure: varchar('procedure', { length: 300 }).notNull(),
    procedureCode: varchar('procedure_code', { length: 20 }),
    laterality: lateralityEnum('laterality').notNull().default('NOT_APPLICABLE'),
    priority: surgeryPriorityEnum('priority').notNull().default('ELECTIVE'),
    indication: varchar('indication', { length: 1000 }).notNull(),
    primarySurgeonId: uuid('primary_surgeon_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assistantId: uuid('assistant_id').references(() => users.id, { onDelete: 'restrict' }),
    anaesthetistId: uuid('anaesthetist_id').references(() => users.id, { onDelete: 'restrict' }),
    anaesthesiaType: anaesthesiaTypeEnum('anaesthesia_type'),
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
    estimatedMinutes: integer('estimated_minutes').notNull().default(60),
    status: surgeryStatusEnum('status').notNull().default('REQUESTED'),
    consentRecordId: uuid('consent_record_id').references(() => consentRecords.id, {
      onDelete: 'set null',
    }),
    /** WHO checklist: { signIn?: {...answers, by, at}, timeOut?: {...}, signOut?: {...} } */
    checklist: jsonb('checklist').$type<Record<string, unknown>>().notNull().default({}),
    inTheatreAt: timestamp('in_theatre_at', { withTimezone: true }),
    incisionAt: timestamp('incision_at', { withTimezone: true }),
    closureAt: timestamp('closure_at', { withTimezone: true }),
    outOfTheatreAt: timestamp('out_of_theatre_at', { withTimezone: true }),
    operationNote: text('operation_note'),
    complications: varchar('complications', { length: 2000 }),
    estimatedBloodLossMl: integer('estimated_blood_loss_ml'),
    noteSignedById: uuid('note_signed_by_id').references(() => users.id, { onDelete: 'restrict' }),
    noteSignedAt: timestamp('note_signed_at', { withTimezone: true }),
    cancelReason: varchar('cancel_reason', { length: 500 }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('surgical_cases_schedule_idx').on(t.facilityId, t.scheduledStart),
    index('surgical_cases_patient_idx').on(t.patientId, t.createdAt),
    index('surgical_cases_theatre_idx').on(t.theatreUnitId, t.scheduledStart),
  ],
);

export const stockMovementTypeEnum = pgEnum('stock_movement_type', [
  'RECEIPT',
  'DISPENSE',
  'ADJUSTMENT',
  'EXPIRED',
  'DAMAGED',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'RETURN',
]);

/** National medication catalogue (what facilities can stock and dispense). */
export const medicationCatalog = pgTable(
  'medication_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    atcCode: varchar('atc_code', { length: 10 }),
    form: varchar('form', { length: 60 }).notNull(),
    strength: varchar('strength', { length: 60 }),
    /** Dispensing unit, e.g. tablet, capsule, ml, vial, ampoule. */
    unit: varchar('unit', { length: 30 }).notNull(),
    /** Active ingredients (INN, lower case) for interaction and allergy checks. */
    ingredients: text('ingredients').array(),
    isEssential: boolean('is_essential').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('medication_catalog_uq').on(t.name, t.form, t.strength)],
);

/** A batch of stock at a facility pharmacy (quantity in dispensing units). */
export const stockBatches = pgTable(
  'stock_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => medicationCatalog.id, { onDelete: 'restrict' }),
    batchNumber: varchar('batch_number', { length: 60 }).notNull(),
    expiryDate: date('expiry_date', { mode: 'string' }).notNull(),
    quantity: integer('quantity').notNull(),
    supplier: varchar('supplier', { length: 200 }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('stock_batches_uq').on(t.facilityId, t.itemId, t.batchNumber),
    index('stock_batches_expiry_idx').on(t.facilityId, t.expiryDate),
  ],
);

/** Every stock change, append-only. Quantity is signed (+ in, − out). */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => medicationCatalog.id, { onDelete: 'restrict' }),
    batchId: uuid('batch_id').references(() => stockBatches.id, { onDelete: 'restrict' }),
    type: stockMovementTypeEnum('type').notNull(),
    quantity: integer('quantity').notNull(),
    prescriptionId: uuid('prescription_id').references(() => prescriptions.id, {
      onDelete: 'set null',
    }),
    reason: varchar('reason', { length: 500 }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stock_movements_item_idx').on(t.facilityId, t.itemId, t.createdAt)],
);

/** Per-facility reorder level for an item (low-stock alerts). */
export const stockSettings = pgTable(
  'stock_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => medicationCatalog.id, { onDelete: 'cascade' }),
    reorderLevel: integer('reorder_level').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('stock_settings_uq').on(t.facilityId, t.itemId)],
);

/* ------------------------------------------------------------------------------------------------
 * Scheduling, national vaccination calendar, account security
 * ---------------------------------------------------------------------------------------------- */

/** A doctor's recurring weekly consulting hours, from which bookable slots are generated. */
export const doctorAvailability = pgTable(
  'doctor_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    /** 0 = Sunday … 6 = Saturday. */
    weekday: integer('weekday').notNull(),
    /** Local (Europe/Belgrade) times "HH:MM". */
    startTime: varchar('start_time', { length: 5 }).notNull(),
    endTime: varchar('end_time', { length: 5 }).notNull(),
    slotMinutes: integer('slot_minutes').notNull().default(20),
    /** Whether patients may book these slots themselves in the portal. */
    portalBookable: boolean('portal_bookable').notNull().default(true),
    validFrom: date('valid_from', { mode: 'string' }),
    validUntil: date('valid_until', { mode: 'string' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('doctor_availability_doctor_idx').on(t.doctorId, t.weekday)],
);

/** Time a doctor is not available (leave, training) – no slots are offered then. */
export const availabilityExceptions = pgTable(
  'availability_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: varchar('reason', { length: 200 }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('availability_exceptions_doctor_idx').on(t.doctorId, t.startsAt)],
);

/**
 * The national immunization calendar: one row per recommended dose. Due and overdue doses of each
 * child are computed from the date of birth and the immunizations recorded against these rows.
 */
export const vaccineSchedule = pgTable(
  'vaccine_schedule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 40 }).notNull(),
    vaccine: varchar('vaccine', { length: 200 }).notNull(),
    doseNumber: integer('dose_number').notNull(),
    /** Recommended age in days; a dose becomes due at this age. */
    recommendedAgeDays: integer('recommended_age_days').notNull(),
    /** After this age the dose counts as overdue. */
    overdueAgeDays: integer('overdue_age_days').notNull(),
    description: varchar('description', { length: 500 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [uniqueIndex('vaccine_schedule_code_uq').on(t.code)],
);

/** Reminders already sent for a child's dose (one per kind), so nobody is reminded twice. */
export const immunizationReminders = pgTable(
  'immunization_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    scheduleItemId: uuid('schedule_item_id')
      .notNull()
      .references(() => vaccineSchedule.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 10 }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('immunization_reminders_uq').on(t.patientId, t.scheduleItemId, t.kind)],
);

/** Passkeys (WebAuthn credentials): phishing-resistant sign-in. */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** base64url credential id. */
    credentialId: text('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports').array(),
    deviceName: varchar('device_name', { length: 100 }).notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('webauthn_credentials_id_uq').on(t.credentialId),
    index('webauthn_credentials_user_idx').on(t.userId),
  ],
);

/** Short-lived WebAuthn challenges (registration and sign-in). */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 20 }).notNull(),
    challenge: text('challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_challenges_expiry_idx').on(t.expiresAt)],
);

/** Devices a user has signed in from; a sign-in from an unknown device triggers an alert. */
export const knownDevices = pgTable(
  'known_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Hash of a coarse device fingerprint (browser family + OS + IP network). */
    deviceHash: varchar('device_hash', { length: 64 }).notNull(),
    label: varchar('label', { length: 200 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('known_devices_uq').on(t.userId, t.deviceHash)],
);

/* ------------------------------------------------------------------------------------------------
 * Medication safety, blood bank, nutrition, billing, early warning, surveillance, telemedicine
 * ---------------------------------------------------------------------------------------------- */

export const interactionSeverityEnum = pgEnum('interaction_severity', [
  'CONTRAINDICATED',
  'MAJOR',
  'MODERATE',
  'MINOR',
]);

/** Curated drug–drug interactions between active ingredients (INN, lower case, a < b). */
export const drugInteractions = pgTable(
  'drug_interactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingredientA: varchar('ingredient_a', { length: 100 }).notNull(),
    ingredientB: varchar('ingredient_b', { length: 100 }).notNull(),
    severity: interactionSeverityEnum('severity').notNull(),
    effect: varchar('effect', { length: 500 }).notNull(),
    management: varchar('management', { length: 500 }).notNull(),
    source: varchar('source', { length: 200 }),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('drug_interactions_pair_uq').on(t.ingredientA, t.ingredientB)],
);

/** Safety alerts raised for a prescription (interaction, allergy, dose, duplicate) and overrides. */
export const prescriptionAlerts = pgTable(
  'prescription_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prescriptionId: uuid('prescription_id')
      .notNull()
      .references(() => prescriptions.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    kind: varchar('kind', { length: 20 }).notNull(),
    severity: interactionSeverityEnum('severity').notNull(),
    message: varchar('message', { length: 1000 }).notNull(),
    /** Machine-readable details, e.g. the interacting prescription. */
    details: jsonb('details').$type<Record<string, unknown>>(),
    overrideReason: varchar('override_reason', { length: 500 }),
    overriddenById: uuid('overridden_by_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('prescription_alerts_rx_idx').on(t.prescriptionId)],
);

export const bloodProductEnum = pgEnum('blood_product', [
  'RED_CELLS',
  'PLASMA',
  'PLATELETS',
  'CRYOPRECIPITATE',
  'WHOLE_BLOOD',
]);
export const bloodUnitStatusEnum = pgEnum('blood_unit_status', [
  'AVAILABLE',
  'RESERVED',
  'ISSUED',
  'TRANSFUSED',
  'RETURNED',
  'DISCARDED',
]);
export const transfusionRequestStatusEnum = pgEnum('transfusion_request_status', [
  'REQUESTED',
  'SAMPLE_RECEIVED',
  'CROSSMATCHED',
  'ISSUED',
  'COMPLETED',
  'CANCELLED',
]);

/** Blood group results of a patient (history; the latest confirmed result counts). */
export const bloodGroupTests = pgTable(
  'blood_group_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    abo: varchar('abo', { length: 2 }).notNull(),
    rhD: varchar('rh_d', { length: 3 }).notNull(),
    antibodyScreen: varchar('antibody_screen', { length: 20 }).notNull().default('NEGATIVE'),
    antibodies: varchar('antibodies', { length: 200 }),
    testedById: uuid('tested_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    testedAt: timestamp('tested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('blood_group_tests_patient_idx').on(t.patientId, t.testedAt)],
);

export const bloodUnits = pgTable(
  'blood_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    unitNumber: varchar('unit_number', { length: 30 }).notNull(),
    product: bloodProductEnum('product').notNull(),
    abo: varchar('abo', { length: 2 }).notNull(),
    rhD: varchar('rh_d', { length: 3 }).notNull(),
    volumeMl: integer('volume_ml').notNull(),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: bloodUnitStatusEnum('status').notNull().default('AVAILABLE'),
    reservedForRequestId: uuid('reserved_for_request_id'),
    discardReason: varchar('discard_reason', { length: 300 }),
    receivedById: uuid('received_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('blood_units_number_uq').on(t.unitNumber),
    index('blood_units_stock_idx').on(t.facilityId, t.product, t.status, t.expiresAt),
  ],
);

export const transfusionRequests = pgTable(
  'transfusion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    surgicalCaseId: uuid('surgical_case_id').references(() => surgicalCases.id, {
      onDelete: 'set null',
    }),
    product: bloodProductEnum('product').notNull(),
    units: integer('units').notNull(),
    urgency: varchar('urgency', { length: 20 }).notNull(),
    indication: varchar('indication', { length: 1000 }).notNull(),
    haemoglobinGl: integer('haemoglobin_g_l'),
    status: transfusionRequestStatusEnum('status').notNull().default('REQUESTED'),
    requestedById: uuid('requested_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sampleReceivedAt: timestamp('sample_received_at', { withTimezone: true }),
    crossmatchedById: uuid('crossmatched_by_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    crossmatchedAt: timestamp('crossmatched_at', { withTimezone: true }),
    cancelReason: varchar('cancel_reason', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transfusion_requests_patient_idx').on(t.patientId, t.createdAt),
    index('transfusion_requests_queue_idx').on(t.facilityId, t.status),
  ],
);

/** One unit given to a patient: bedside two-person check, observations, reactions. */
export const transfusions = pgTable(
  'transfusions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => transfusionRequests.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => bloodUnits.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    issuedById: uuid('issued_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    checkedById: uuid('checked_by_id').references(() => users.id, { onDelete: 'restrict' }),
    secondCheckerId: uuid('second_checker_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    observations: jsonb('observations').$type<Record<string, unknown>[]>().notNull().default([]),
    reaction: boolean('reaction').notNull().default(false),
    reactionType: varchar('reaction_type', { length: 60 }),
    reactionSeverity: varchar('reaction_severity', { length: 20 }),
    reactionDetails: varchar('reaction_details', { length: 2000 }),
    status: varchar('status', { length: 20 }).notNull().default('ISSUED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transfusions_unit_uq').on(t.unitId),
    index('transfusions_patient_idx').on(t.patientId),
  ],
);

export const dietTypeEnum = pgEnum('diet_type', [
  'NORMAL',
  'NIL_BY_MOUTH',
  'CLEAR_FLUIDS',
  'FULL_FLUIDS',
  'SOFT',
  'PUREED',
  'DIABETIC',
  'LOW_SALT',
  'RENAL',
  'LOW_FAT',
  'HIGH_PROTEIN',
  'GLUTEN_FREE',
  'VEGETARIAN',
  'ENTERAL_TUBE',
]);

/** Diet order for an inpatient; the kitchen list is generated from the active orders. */
export const dietOrders = pgTable(
  'diet_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    dietType: dietTypeEnum('diet_type').notNull(),
    /** Food allergies/intolerances and preferences, e.g. ["gluten", "no pork"]. */
    restrictions: text('restrictions').array(),
    fluidLimitMl: integer('fluid_limit_ml'),
    notes: varchar('notes', { length: 500 }),
    reason: varchar('reason', { length: 300 }),
    surgicalCaseId: uuid('surgical_case_id').references(() => surgicalCases.id, {
      onDelete: 'set null',
    }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    orderedById: uuid('ordered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('diet_orders_admission_idx').on(t.admissionId, t.startsAt)],
);

export const nutritionScreenings = pgTable(
  'nutrition_screenings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    tool: varchar('tool', { length: 20 }).notNull(),
    score: integer('score').notNull(),
    risk: varchar('risk', { length: 10 }).notNull(),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    screenedById: uuid('screened_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    screenedAt: timestamp('screened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('nutrition_screenings_patient_idx').on(t.patientId, t.screenedAt)],
);

export const chargeStatusEnum = pgEnum('charge_status', [
  'OPEN',
  'CLAIMED',
  'PAID',
  'REJECTED',
  'VOID',
]);
export const claimStatusEnum = pgEnum('claim_status', [
  'DRAFT',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIALLY_PAID',
  'PAID',
  'REJECTED',
]);

/** Health insurance of a patient (Health Insurance Fund or other), incl. co-payment exemptions. */
export const insuranceCoverages = pgTable(
  'insurance_coverages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    insurer: varchar('insurer', { length: 60 }).notNull(),
    policyNumber: varchar('policy_number', { length: 60 }),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    /** Co-payment exemption category (e.g. CHILD, PENSIONER, CHRONIC, SOCIAL_ASSISTANCE). */
    exemption: varchar('exemption', { length: 40 }),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('insurance_coverages_patient_idx').on(t.patientId)],
);

/** Price list of billable services (national tariff). Amounts in euro cents. */
export const billableServices = pgTable(
  'billable_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 30 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    category: varchar('category', { length: 40 }).notNull(),
    priceCents: integer('price_cents').notNull(),
    /** Patient co-payment in cents unless exempt. */
    copayCents: integer('copay_cents').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [uniqueIndex('billable_services_code_uq').on(t.code)],
);

export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    insurer: varchar('insurer', { length: 60 }).notNull(),
    reference: varchar('reference', { length: 40 }).notNull(),
    periodFrom: date('period_from', { mode: 'string' }).notNull(),
    periodTo: date('period_to', { mode: 'string' }).notNull(),
    status: claimStatusEnum('status').notNull().default('DRAFT'),
    totalCents: integer('total_cents').notNull().default(0),
    paidCents: integer('paid_cents').notNull().default(0),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    responseNote: varchar('response_note', { length: 1000 }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('claims_reference_uq').on(t.reference)],
);

/** A billable item produced by care (visit, test, imaging, bed day, operation, dispense). */
export const charges = pgTable(
  'charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => billableServices.id, { onDelete: 'restrict' }),
    sourceType: varchar('source_type', { length: 30 }).notNull(),
    sourceId: uuid('source_id'),
    quantity: integer('quantity').notNull().default(1),
    totalCents: integer('total_cents').notNull(),
    copayCents: integer('copay_cents').notNull().default(0),
    insurerCents: integer('insurer_cents').notNull(),
    status: chargeStatusEnum('status').notNull().default('OPEN'),
    claimId: uuid('claim_id').references(() => claims.id, { onDelete: 'set null' }),
    serviceDate: date('service_date', { mode: 'string' }).notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    voidReason: varchar('void_reason', { length: 300 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('charges_patient_idx').on(t.patientId, t.serviceDate),
    index('charges_facility_status_idx').on(t.facilityId, t.status, t.serviceDate),
    uniqueIndex('charges_source_uq')
      .on(t.sourceType, t.sourceId, t.serviceId)
      .where(sql`${t.sourceId} IS NOT NULL AND ${t.status} <> 'VOID'`),
  ],
);

/** Co-payment received from a patient (receipt). */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    receiptNumber: varchar('receipt_number', { length: 30 }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    method: varchar('method', { length: 10 }).notNull(),
    chargeIds: uuid('charge_ids').array().notNull(),
    receivedById: uuid('received_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payments_receipt_uq').on(t.receiptNumber)],
);

/** NEWS2 early warning score computed from a set of vital signs. */
export const earlyWarningScores = pgTable(
  'early_warning_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    vitalSignId: uuid('vital_sign_id')
      .notNull()
      .references(() => vitalSigns.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    score: integer('score').notNull(),
    risk: varchar('risk', { length: 12 }).notNull(),
    /** Points per parameter and whether any single parameter scored 3. */
    components: jsonb('components').$type<Record<string, unknown>>().notNull(),
    complete: boolean('complete').notNull(),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    acknowledgedById: uuid('acknowledged_by_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('early_warning_scores_vitals_uq').on(t.vitalSignId),
    index('early_warning_scores_patient_idx').on(t.patientId, t.computedAt),
  ],
);

/** Notifiable infectious diseases and the ICD-10 codes that trigger a case report. */
export const notifiableDiseases = pgTable(
  'notifiable_diseases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 30 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    icd10Prefixes: text('icd10_prefixes').array().notNull(),
    /** IMMEDIATE (within 24 h) or WEEKLY. */
    urgency: varchar('urgency', { length: 10 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [uniqueIndex('notifiable_diseases_code_uq').on(t.code)],
);

export const caseReports = pgTable(
  'case_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    diseaseId: uuid('disease_id')
      .notNull()
      .references(() => notifiableDiseases.id, { onDelete: 'restrict' }),
    diagnosisId: uuid('diagnosis_id').references(() => diagnoses.id, { onDelete: 'set null' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    classification: varchar('classification', { length: 12 }).notNull().default('SUSPECTED'),
    status: varchar('status', { length: 12 }).notNull().default('DRAFT'),
    onsetDate: date('onset_date', { mode: 'string' }),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    reportedById: uuid('reported_by_id').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: varchar('review_note', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('case_reports_disease_idx').on(t.diseaseId, t.createdAt),
    index('case_reports_facility_idx').on(t.facilityId, t.status),
    uniqueIndex('case_reports_diagnosis_uq').on(t.diagnosisId),
  ],
);

/** A video consultation room for a VIDEO appointment. */
export const videoSessions = pgTable(
  'video_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 10 }).notNull().default('WAITING'),
    doctorJoinedAt: timestamp('doctor_joined_at', { withTimezone: true }),
    patientJoinedAt: timestamp('patient_joined_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('video_sessions_appointment_uq').on(t.appointmentId)],
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
