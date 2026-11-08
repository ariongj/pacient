import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
  date,
  index,
  inet,
  integer,
  smallint,
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
    /** Set while the facility works on paper (planned or unplanned downtime). */
    downtimeSince: timestamp('downtime_since', { withTimezone: true }),
    downtimeNote: varchar('downtime_note', { length: 300 }),
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
    /** Set when a death certificate is signed (see death_records). */
    deceasedAt: timestamp('deceased_at', { withTimezone: true }),
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
    /** Structured dose (for dose-range checks and barcode administration). */
    doseAmount: numeric('dose_amount', { precision: 10, scale: 3 }),
    doseUnit: varchar('dose_unit', { length: 20 }),
    /** e.g. QD, BID, TID, QID, Q4H, Q6H, Q8H, Q12H, QHS, PRN, STAT, WEEKLY. */
    frequencyCode: varchar('frequency_code', { length: 12 }),
    durationDays: integer('duration_days'),
    asNeeded: boolean('as_needed').notNull().default(false),
    /** As-needed (PRN) limit; the bedside barcode check enforces it. */
    maxDosesPer24h: smallint('max_doses_per_24h'),
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
    /**
     * National e-prescription for community pharmacies: the code the patient shows at any
     * pharmacy, how many repeat supplies are allowed and until when it can be dispensed.
     */
    ePrescriptionCode: varchar('e_prescription_code', { length: 16 }),
    repeatsAllowed: smallint('repeats_allowed').notNull().default(0),
    communityValidUntil: date('community_valid_until', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    index('prescriptions_patient_idx').on(t.patientId, t.status),
    index('prescriptions_pharmacy_idx').on(t.pharmacyStatus, t.createdAt),
    uniqueIndex('prescriptions_e_code_uq').on(t.ePrescriptionCode),
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
    /** Paediatric observations for PEWS: capillary refill (seconds) and work of breathing. */
    capillaryRefillSeconds: numeric('capillary_refill_seconds', { precision: 3, scale: 1 }),
    /** NONE, MILD, MODERATE or SEVERE respiratory distress. */
    respiratoryEffort: varchar('respiratory_effort', { length: 10 }),
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
    /** Barcode checks at the bedside (wristband and medicine pack). */
    patientScanned: boolean('patient_scanned').notNull().default(false),
    medicationScanned: boolean('medication_scanned').notNull().default(false),
    scanOverrideReason: varchar('scan_override_reason', { length: 300 }),
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
    /** Where the encrypted bytes live: DB (document_contents) or S3 (object storage, storageKey). */
    storageBackend: varchar('storage_backend', { length: 10 }).notNull().default('DB'),
    storageKey: varchar('storage_key', { length: 300 }),
    /** Versions: a new version points to the one it replaces, which becomes superseded. */
    version: integer('version').notNull().default(1),
    previousVersionId: uuid('previous_version_id').references(
      (): AnyPgColumn => patientDocuments.id,
      { onDelete: 'restrict' },
    ),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('patient_documents_patient_idx').on(t.patientId, t.createdAt),
    uniqueIndex('patient_documents_previous_uq').on(t.previousVersionId),
  ],
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
  'AMBULANCE_SERVICE',
  'COMMUNITY_NURSING',
  'INFECTION_CONTROL',
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
  'deaths.read',
  'prescriptions.dispense',
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
    /** GTIN/EAN barcode on the pack, for barcode-checked administration. */
    barcode: varchar('barcode', { length: 32 }),
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
    /** NEWS2 (adults) or PEWS (children). */
    scale: varchar('scale', { length: 8 }).notNull().default('NEWS2'),
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
 * Dose rules, downtime, data protection
 * ---------------------------------------------------------------------------------------------- */

/** Dose limits per ingredient, route and age group (mg, or mg/kg when perKg). */
export const doseRules = pgTable(
  'dose_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingredient: varchar('ingredient', { length: 100 }).notNull(),
    route: varchar('route', { length: 20 }).notNull().default('ORAL'),
    /** ADULT, CHILD (≥1 month <18 y), NEONATE (<1 month), ELDERLY (≥65 y). */
    ageGroup: varchar('age_group', { length: 10 }).notNull(),
    unit: varchar('unit', { length: 10 }).notNull().default('mg'),
    perKg: boolean('per_kg').notNull().default(false),
    maxSingleDose: numeric('max_single_dose', { precision: 10, scale: 3 }),
    maxDailyDose: numeric('max_daily_dose', { precision: 10, scale: 3 }),
    /** Absolute cap even when dosed per kg (e.g. paracetamol 4 g/day). */
    absoluteMaxDaily: numeric('absolute_max_daily', { precision: 10, scale: 3 }),
    note: varchar('note', { length: 300 }),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dose_rules_uq').on(t.ingredient, t.route, t.ageGroup)],
);

/** Encrypted downtime packs generated for each facility (paper fallback). */
export const downtimeExports = pgTable(
  'downtime_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(),
    fileName: varchar('file_name', { length: 200 }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    patientCount: integer('patient_count').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('downtime_exports_facility_idx').on(t.facilityId, t.generatedAt)],
);

/** How long each category of data is kept, and what happens afterwards. */
export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    category: varchar('category', { length: 40 }).notNull(),
    retainDays: integer('retain_days').notNull(),
    action: varchar('action', { length: 10 }).notNull(),
    legalBasis: varchar('legal_basis', { length: 300 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunCount: integer('last_run_count'),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('retention_policies_category_uq').on(t.category)],
);

/** Requests from patients exercising their data protection rights. */
export const dataSubjectRequests = pgTable(
  'data_subject_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    kind: varchar('kind', { length: 15 }).notNull(),
    status: varchar('status', { length: 12 }).notNull().default('RECEIVED'),
    details: varchar('details', { length: 2000 }),
    receivedVia: varchar('received_via', { length: 10 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    outcome: varchar('outcome', { length: 2000 }),
    handledById: uuid('handled_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('data_subject_requests_status_idx').on(t.status, t.dueAt)],
);

/** Legal hold: the patient's data is exempt from retention purges (litigation, investigation). */
export const legalHolds = pgTable(
  'legal_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    reason: varchar('reason', { length: 500 }).notNull(),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedById: uuid('released_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('legal_holds_patient_idx').on(t.patientId)],
);

/* ------------------------------------------------------------------------------------------------
 * Death registration (WHO international form of the medical certificate of cause of death)
 * ---------------------------------------------------------------------------------------------- */

/**
 * One death record per patient. Part I is the causal sequence (a = immediate cause … d = the
 * underlying condition that started it), Part II other significant conditions. Signed records are
 * immutable (trigger); corrections are amendment rows. The civil registry reads signed records over
 * the partner API (scope deaths.read) and acknowledges them.
 */
export const deathRecords = pgTable(
  'death_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    diedAt: timestamp('died_at', { withTimezone: true }).notNull(),
    /** HOSPITAL, EMERGENCY_DEPARTMENT, HOME, NURSING_HOME, EN_ROUTE, OTHER. */
    placeOfDeath: varchar('place_of_death', { length: 30 }).notNull(),
    placeDetail: varchar('place_detail', { length: 200 }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    /** Part I lines a–d and Part II: [{ line, text, icd10, interval }]. */
    causes: jsonb('causes').$type<DeathCause[]>().notNull(),
    /** ICD-10 code of the underlying cause, used for mortality statistics. */
    underlyingCauseIcd10: varchar('underlying_cause_icd10', { length: 10 }).notNull(),
    /** NATURAL, ACCIDENT, INTENTIONAL_SELF_HARM, ASSAULT, PENDING_INVESTIGATION, UNDETERMINED. */
    mannerOfDeath: varchar('manner_of_death', { length: 30 }).notNull(),
    /** NONE, REQUESTED, PENDING, PERFORMED (findings used). */
    autopsy: varchar('autopsy', { length: 12 }).notNull().default('NONE'),
    /** Women 10–54: NOT_PREGNANT, PREGNANT, WITHIN_42_DAYS, DAYS_43_TO_1_YEAR, UNKNOWN. */
    pregnancyStatus: varchar('pregnancy_status', { length: 20 }),
    /** Deaths under one year: birth weight, gestation, mother's conditions … */
    perinatal: jsonb('perinatal').$type<Record<string, unknown>>(),
    /** Referred to the prosecutor / forensic medicine (unnatural or unexplained deaths). */
    reportedToForensics: boolean('reported_to_forensics').notNull().default(false),
    /** DRAFT or SIGNED. */
    status: varchar('status', { length: 10 }).notNull().default('DRAFT'),
    certifiedById: uuid('certified_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** Assigned when signed, e.g. "VD-2026-000123". */
    certificateNumber: varchar('certificate_number', { length: 30 }),
    civilRegistryAcknowledgedAt: timestamp('civil_registry_acknowledged_at', {
      withTimezone: true,
    }),
    civilRegistryReference: varchar('civil_registry_reference', { length: 60 }),
    /** Withdrawn by the Ministry (e.g. certified for the wrong person); the record is restored. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnById: uuid('withdrawn_by_id').references(() => users.id, { onDelete: 'restrict' }),
    withdrawReason: varchar('withdraw_reason', { length: 500 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('death_records_patient_uq')
      .on(t.patientId)
      .where(sql`${t.status} <> 'WITHDRAWN'`),
    uniqueIndex('death_records_number_uq').on(t.certificateNumber),
    index('death_records_facility_idx').on(t.facilityId, t.diedAt),
  ],
);
export interface DeathCause {
  line: 'a' | 'b' | 'c' | 'd' | 'II';
  text: string;
  icd10: string | null;
  interval: string | null;
}

/** Corrections to a signed death record (the signed original stays unchanged). */
export const deathRecordAmendments = pgTable(
  'death_record_amendments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deathRecordId: uuid('death_record_id')
      .notNull()
      .references(() => deathRecords.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** Changed fields with old and new values, e.g. { underlyingCauseIcd10: ['I21.9', 'I25.1'] }. */
    changes: jsonb('changes').$type<Record<string, [unknown, unknown]>>().notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    amendedById: uuid('amended_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('death_record_amendments_record_idx').on(t.deathRecordId, t.createdAt)],
);

/* ------------------------------------------------------------------------------------------------
 * Medical certificates (sick leave, fitness, school absence) with public verification
 * ---------------------------------------------------------------------------------------------- */

/**
 * Certificates are issued once and never edited; a wrong one is revoked (with a reason) and a new
 * one issued. Employers and schools verify a certificate by its code (QR) and see only validity,
 * kind, dates and issuer – never the diagnosis.
 */
export const medicalCertificates = pgTable(
  'medical_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    issuedById: uuid('issued_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    /** SICK_LEAVE, FITNESS_FOR_WORK, SCHOOL_ABSENCE, SPORTS_FITNESS, DRIVING_FITNESS, GENERAL. */
    kind: varchar('kind', { length: 30 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    /** Internal only – printed only when the patient asks (diagnosisOnCertificate). */
    icd10Code: varchar('icd10_code', { length: 10 }),
    diagnosisOnCertificate: boolean('diagnosis_on_certificate').notNull().default(false),
    /** Fitness certificates: FIT, FIT_WITH_RESTRICTIONS, UNFIT. */
    outcome: varchar('outcome', { length: 30 }),
    restrictions: varchar('restrictions', { length: 500 }),
    purpose: varchar('purpose', { length: 200 }),
    remarks: text('remarks'),
    /** Extension of an earlier sick-leave certificate. */
    extendsCertificateId: uuid('extends_certificate_id').references(
      (): AnyPgColumn => medicalCertificates.id,
      { onDelete: 'restrict' },
    ),
    serialNumber: varchar('serial_number', { length: 30 }).notNull(),
    /** Random, unguessable code in the QR verification link. */
    verificationCode: varchar('verification_code', { length: 40 }).notNull(),
    /** ISSUED or REVOKED. */
    status: varchar('status', { length: 10 }).notNull().default('ISSUED'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedById: uuid('revoked_by_id').references(() => users.id, { onDelete: 'restrict' }),
    revokeReason: varchar('revoke_reason', { length: 300 }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('medical_certificates_serial_uq').on(t.serialNumber),
    uniqueIndex('medical_certificates_code_uq').on(t.verificationCode),
    index('medical_certificates_patient_idx').on(t.patientId, t.issuedAt),
    index('medical_certificates_facility_idx').on(t.facilityId, t.issuedAt),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Elective waiting lists
 * ---------------------------------------------------------------------------------------------- */

/**
 * A patient waiting for a planned procedure or a first specialist appointment. The waiting time
 * runs from addedAt and pauses while the patient has asked to postpone (SUSPENDED).
 */
export const waitingListEntries = pgTable(
  'waiting_list_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /** e.g. ORTHOPAEDICS, OPHTHALMOLOGY, CARDIOLOGY, GENERAL_SURGERY … */
    specialty: varchar('specialty', { length: 40 }).notNull(),
    /** PROCEDURE (operation, intervention) or OUTPATIENT (first specialist appointment). */
    kind: varchar('kind', { length: 12 }).notNull().default('PROCEDURE'),
    procedureCode: varchar('procedure_code', { length: 20 }),
    procedureName: varchar('procedure_name', { length: 200 }).notNull(),
    /** URGENT, PRIORITY, ROUTINE – each with a maximum waiting time. */
    priority: varchar('priority', { length: 10 }).notNull(),
    clinicalReason: text('clinical_reason'),
    referralId: uuid('referral_id').references(() => referrals.id, { onDelete: 'set null' }),
    addedById: uuid('added_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    targetDate: date('target_date', { mode: 'string' }).notNull(),
    /** WAITING, SCHEDULED, SUSPENDED, COMPLETED, REMOVED. */
    status: varchar('status', { length: 10 }).notNull().default('WAITING'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    surgicalCaseId: uuid('surgical_case_id').references(() => surgicalCases.id, {
      onDelete: 'set null',
    }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    /** Days paused at the patient's request (subtracted from the waiting time). */
    suspendedDays: integer('suspended_days').notNull().default(0),
    suspendedSince: timestamp('suspended_since', { withTimezone: true }),
    /** TREATED_ELSEWHERE, NO_LONGER_NEEDED, PATIENT_DECLINED, DECEASED, DUPLICATE, OTHER. */
    removedReason: varchar('removed_reason', { length: 30 }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('waiting_list_facility_idx').on(t.facilityId, t.specialty, t.status),
    index('waiting_list_patient_idx').on(t.patientId),
  ],
);

/** Append-only history of waiting-list changes (status, priority, dates) with the reason. */
export const waitingListEvents = pgTable(
  'waiting_list_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => waitingListEntries.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    event: varchar('event', { length: 30 }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    reason: varchar('reason', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('waiting_list_events_entry_idx').on(t.entryId, t.createdAt)],
);

/* ------------------------------------------------------------------------------------------------
 * Chronic disease registers (diabetes, hypertension, asthma, COPD, CKD, heart failure)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Register membership. Patients join automatically from a matching ICD-10 diagnosis or are added
 * by their doctor; the registers themselves (codes, care processes, targets) are defined in code.
 */
export const registerEnrolments = pgTable(
  'register_enrolments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** DIABETES, HYPERTENSION, ASTHMA, COPD, CKD, HEART_FAILURE. */
    register: varchar('register', { length: 20 }).notNull(),
    /** Managing (primary care) facility. */
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /** DIAGNOSIS (automatic) or MANUAL. */
    source: varchar('source', { length: 10 }).notNull(),
    diagnosisId: uuid('diagnosis_id').references(() => diagnoses.id, { onDelete: 'set null' }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    enrolledById: uuid('enrolled_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** ACTIVE or LEFT (resolved, wrong diagnosis, moved away, deceased). */
    status: varchar('status', { length: 10 }).notNull().default('ACTIVE'),
    leftAt: timestamp('left_at', { withTimezone: true }),
    leftReason: varchar('left_reason', { length: 200 }),
  },
  (t) => [
    uniqueIndex('register_enrolments_active_uq')
      .on(t.patientId, t.register)
      .where(sql`${t.status} = 'ACTIVE'`),
    index('register_enrolments_facility_idx').on(t.facilityId, t.register, t.status),
  ],
);

/** An annual-review item that is not a lab result or vital sign (foot check, eye screening …). */
export const careProcessRecords = pgTable(
  'care_process_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    register: varchar('register', { length: 20 }).notNull(),
    /** e.g. FOOT_EXAM, RETINAL_SCREENING, SMOKING_STATUS, INHALER_TECHNIQUE, ACTION_PLAN, SPIROMETRY. */
    process: varchar('process', { length: 30 }).notNull(),
    /** e.g. NORMAL, ABNORMAL, DONE, DECLINED, SMOKER, NON_SMOKER, EX_SMOKER. */
    result: varchar('result', { length: 30 }).notNull(),
    notes: varchar('notes', { length: 500 }),
    performedAt: timestamp('performed_at', { withTimezone: true }).notNull(),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('care_process_records_patient_idx').on(t.patientId, t.register, t.process)],
);

/* ------------------------------------------------------------------------------------------------
 * Patient safety incident reporting (incidents and near misses)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Any staff member can report an incident or near miss, anonymously if they wish (reporter not
 * stored). The facility's reviewers (director and named safety leads) investigate and close it;
 * the Ministry sees aggregated, de-identified figures; incidents involving the system link to a
 * clinical safety case hazard (hazardRef).
 */
export const safetyIncidents = pgTable(
  'safety_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. "INC-2026-00042". */
    reference: varchar('reference', { length: 30 }).notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /** Null when reported anonymously. */
    reportedById: uuid('reported_by_id').references(() => users.id, { onDelete: 'restrict' }),
    reporterRole: roleEnum('reporter_role').notNull(),
    anonymous: boolean('anonymous').notNull().default(false),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
    unitId: uuid('unit_id').references(() => careUnits.id, { onDelete: 'set null' }),
    location: varchar('location', { length: 200 }),
    /**
     * MEDICATION, FALL, PRESSURE_INJURY, IDENTIFICATION, TRANSFUSION, DIAGNOSTIC, SURGICAL,
     * INFECTION, EQUIPMENT, IT_SYSTEM, COMMUNICATION, VIOLENCE, OTHER.
     */
    category: varchar('category', { length: 20 }).notNull(),
    /** NEAR_MISS, NO_HARM, LOW, MODERATE, SEVERE, DEATH. */
    harm: varchar('harm', { length: 10 }).notNull(),
    description: text('description').notNull(),
    immediateAction: text('immediate_action'),
    /** Optional: the patient involved (visible only to reviewers). */
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'restrict' }),
    /** NEW, UNDER_REVIEW, ACTION_PLANNED, CLOSED. */
    status: varchar('status', { length: 15 }).notNull().default('NEW'),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    /** Confirmed harm after review (may differ from the reporter's estimate). */
    reviewedHarm: varchar('reviewed_harm', { length: 10 }),
    contributingFactors: text('contributing_factors').array(),
    findings: text('findings'),
    lessons: text('lessons'),
    /** Clinical safety case hazard (e.g. "H17") for incidents involving the system. */
    hazardRef: varchar('hazard_ref', { length: 10 }),
    /** Open disclosure: when the patient or family was told. */
    patientInformedAt: timestamp('patient_informed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('safety_incidents_reference_uq').on(t.reference),
    index('safety_incidents_facility_idx').on(t.facilityId, t.status, t.reportedAt),
  ],
);

export const incidentActions = pgTable(
  'incident_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => safetyIncidents.id, { onDelete: 'restrict' }),
    description: varchar('description', { length: 500 }).notNull(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    dueDate: date('due_date', { mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('incident_actions_incident_idx').on(t.incidentId)],
);

/** Facility staff named as incident reviewers (safety leads) besides the director. */
export const incidentReviewers = pgTable(
  'incident_reviewers',
  {
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('incident_reviewers_uq').on(t.facilityId, t.userId)],
);

/* ------------------------------------------------------------------------------------------------
 * Antenatal care (pregnancy record)
 * ---------------------------------------------------------------------------------------------- */

/** One pregnancy episode, from booking to its outcome (linked to the birth when delivered). */
export const pregnancies = pgTable(
  'pregnancies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** Booking (managing) facility. */
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    lmpDate: date('lmp_date', { mode: 'string' }),
    eddDate: date('edd_date', { mode: 'string' }).notNull(),
    /** LMP or ULTRASOUND (dating scan). */
    eddMethod: varchar('edd_method', { length: 12 }).notNull(),
    gravida: smallint('gravida').notNull(),
    para: smallint('para').notNull(),
    /** LOW or HIGH, from the risk factors (recomputed when they change). */
    riskLevel: varchar('risk_level', { length: 6 }).notNull().default('LOW'),
    riskFactors: text('risk_factors')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** ONGOING, DELIVERED, MISCARRIAGE, TERMINATION, ECTOPIC, TRANSFERRED_OUT. */
    status: varchar('status', { length: 16 }).notNull().default('ONGOING'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    outcomeNote: varchar('outcome_note', { length: 500 }),
    birthId: uuid('birth_id').references(() => births.id, { onDelete: 'set null' }),
    bookedById: uuid('booked_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('pregnancies_ongoing_uq')
      .on(t.patientId)
      .where(sql`${t.status} = 'ONGOING'`),
    index('pregnancies_facility_idx').on(t.facilityId, t.status, t.eddDate),
  ],
);

/** An antenatal check-up (observations by gestational age). */
export const antenatalVisits = pgTable(
  'antenatal_visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pregnancyId: uuid('pregnancy_id')
      .notNull()
      .references(() => pregnancies.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    visitAt: timestamp('visit_at', { withTimezone: true }).notNull(),
    gestationDays: smallint('gestation_days').notNull(),
    systolic: smallint('systolic'),
    diastolic: smallint('diastolic'),
    weightKg: numeric('weight_kg', { precision: 5, scale: 1 }),
    fundalHeightCm: numeric('fundal_height_cm', { precision: 4, scale: 1 }),
    fetalHeartRate: smallint('fetal_heart_rate'),
    /** CEPHALIC, BREECH, TRANSVERSE, UNKNOWN. */
    presentation: varchar('presentation', { length: 12 }),
    /** NEGATIVE, TRACE, 1+, 2+, 3+. */
    urineProtein: varchar('urine_protein', { length: 8 }),
    oedema: boolean('oedema'),
    fetalMovements: boolean('fetal_movements'),
    notes: text('notes'),
    nextVisitDate: date('next_visit_date', { mode: 'string' }),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('antenatal_visits_pregnancy_idx').on(t.pregnancyId, t.visitAt)],
);

/* ------------------------------------------------------------------------------------------------
 * Cancer screening programmes (cervical, breast, colorectal)
 * ---------------------------------------------------------------------------------------------- */

/** One screening round for a person: invitation → test → result → next due date. */
export const screeningEpisodes = pgTable(
  'screening_episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** CERVICAL, BREAST, COLORECTAL. */
    programme: varchar('programme', { length: 12 }).notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /** INVITED, BOOKED, SCREENED, RESULTED, REFERRED, DECLINED, NOT_ELIGIBLE, CLOSED. */
    status: varchar('status', { length: 12 }).notNull().default('INVITED'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    bookedFor: timestamp('booked_for', { withTimezone: true }),
    screenedAt: timestamp('screened_at', { withTimezone: true }),
    /** e.g. PAP/HPV, MAMMOGRAPHY, FIT. */
    testType: varchar('test_type', { length: 20 }),
    /** NORMAL, ABNORMAL, INADEQUATE. */
    result: varchar('result', { length: 12 }),
    resultDetail: varchar('result_detail', { length: 300 }),
    resultedAt: timestamp('resulted_at', { withTimezone: true }),
    referralId: uuid('referral_id').references(() => referrals.id, { onDelete: 'set null' }),
    nextDueDate: date('next_due_date', { mode: 'string' }),
    recordedById: uuid('recorded_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('screening_episodes_patient_idx').on(t.patientId, t.programme),
    index('screening_episodes_facility_idx').on(t.facilityId, t.programme, t.status),
  ],
);

/** A person's choice not to be invited to a programme (can be withdrawn). */
export const screeningOptOuts = pgTable(
  'screening_opt_outs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    programme: varchar('programme', { length: 12 }).notNull(),
    reason: varchar('reason', { length: 300 }),
    recordedVia: varchar('recorded_via', { length: 10 }).notNull(),
    recordedById: uuid('recorded_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('screening_opt_outs_active_uq')
      .on(t.patientId, t.programme)
      .where(sql`${t.withdrawnAt} IS NULL`),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * National e-prescriptions dispensed by community pharmacies
 * ---------------------------------------------------------------------------------------------- */

/**
 * Dispensing of an e-prescription by a community pharmacy (a partner system with scope
 * prescriptions.dispense). Append-only; a dispensing in error is reversed by a new row
 * (reversesId), never edited.
 */
export const communityDispensings = pgTable(
  'community_dispensings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prescriptionId: uuid('prescription_id')
      .notNull()
      .references(() => prescriptions.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    partnerClientId: uuid('partner_client_id')
      .notNull()
      .references(() => partnerClients.id, { onDelete: 'restrict' }),
    pharmacyName: varchar('pharmacy_name', { length: 200 }).notNull(),
    pharmacistName: varchar('pharmacist_name', { length: 200 }).notNull(),
    pharmacistLicence: varchar('pharmacist_licence', { length: 60 }),
    /** 0 = original supply, 1… = repeats. */
    supplyNumber: smallint('supply_number').notNull(),
    productName: varchar('product_name', { length: 200 }).notNull(),
    quantity: varchar('quantity', { length: 100 }).notNull(),
    reversesId: uuid('reverses_id').references((): AnyPgColumn => communityDispensings.id, {
      onDelete: 'restrict',
    }),
    reason: varchar('reason', { length: 300 }),
    dispensedAt: timestamp('dispensed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('community_dispensings_prescription_idx').on(t.prescriptionId, t.dispensedAt),
    uniqueIndex('community_dispensings_reverses_uq').on(t.reversesId),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Licensing of health professionals
 * ---------------------------------------------------------------------------------------------- */

/**
 * Professional licence issued by the chamber (doctors, nurses and midwives, pharmacists, dentists).
 * Clinical accounts are linked to a licence; an expired, suspended or revoked licence blocks
 * clinical work.
 */
export const professionalLicences = pgTable(
  'professional_licences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    licenceNumber: varchar('licence_number', { length: 40 }).notNull(),
    holderName: varchar('holder_name', { length: 200 }).notNull(),
    /** PHYSICIAN, NURSE, MIDWIFE, PHARMACIST, DENTIST. */
    profession: varchar('profession', { length: 12 }).notNull(),
    specialty: varchar('specialty', { length: 120 }),
    /** Issuing body, e.g. "Oda e Mjekëve të Kosovës". */
    issuedBy: varchar('issued_by', { length: 200 }).notNull(),
    issuedOn: date('issued_on', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    /** ACTIVE, SUSPENDED, REVOKED (EXPIRED is computed from validUntil). */
    status: varchar('status', { length: 10 }).notNull().default('ACTIVE'),
    statusReason: varchar('status_reason', { length: 500 }),
    /** Continuing professional development credits this licence period. */
    cpdCredits: smallint('cpd_credits').notNull().default(0),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('professional_licences_number_uq').on(t.licenceNumber),
    uniqueIndex('professional_licences_user_uq').on(t.userId),
    index('professional_licences_valid_idx').on(t.status, t.validUntil),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Patient complaints and feedback
 * ---------------------------------------------------------------------------------------------- */

/** A formal complaint about care at a facility, with statutory response deadlines. */
export const complaints = pgTable(
  'complaints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. "ANK-2026-00031". */
    reference: varchar('reference', { length: 30 }).notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /** The patient the complaint is about (and usually from). */
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'restrict' }),
    /** Portal user who submitted it (patient or guardian), if submitted online. */
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** PORTAL, IN_PERSON, PHONE, LETTER. */
    channel: varchar('channel', { length: 10 }).notNull(),
    /** CARE_QUALITY, COMMUNICATION, WAITING_TIME, STAFF_ATTITUDE, BILLING, PRIVACY, FACILITIES, OTHER. */
    category: varchar('category', { length: 20 }).notNull(),
    description: text('description').notNull(),
    desiredOutcome: text('desired_outcome'),
    /** RECEIVED, ACKNOWLEDGED, INVESTIGATING, RESPONDED, CLOSED, ESCALATED. */
    status: varchar('status', { length: 14 }).notNull().default('RECEIVED'),
    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgeDueAt: timestamp('acknowledge_due_at', { withTimezone: true }).notNull(),
    responseDueAt: timestamp('response_due_at', { withTimezone: true }).notNull(),
    response: text('response'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    respondedById: uuid('responded_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** UPHELD, PARTLY_UPHELD, NOT_UPHELD, WITHDRAWN. */
    outcome: varchar('outcome', { length: 14 }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    escalationReason: text('escalation_reason'),
    ministryDecision: text('ministry_decision'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('complaints_reference_uq').on(t.reference),
    index('complaints_facility_idx').on(t.facilityId, t.status, t.responseDueAt),
  ],
);

/**
 * Anonymous experience feedback after a visit or stay. No patient or user is stored; dedupeKey is
 * an HMAC of the visit so the same visit cannot be rated twice.
 */
export const feedbackResponses = pgTable(
  'feedback_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id').references(() => careUnits.id, { onDelete: 'set null' }),
    /** OUTPATIENT, INPATIENT, EMERGENCY, VIDEO. */
    setting: varchar('setting', { length: 12 }).notNull(),
    dedupeKey: varchar('dedupe_key', { length: 64 }).notNull(),
    /** 1–5 overall, plus optional item scores. */
    overall: smallint('overall').notNull(),
    scores: jsonb('scores').$type<Record<string, number>>(),
    wouldRecommend: boolean('would_recommend'),
    comment: text('comment'),
    /** Month only (no exact time) to protect anonymity. */
    month: date('month', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('feedback_responses_dedupe_uq').on(t.dedupeKey),
    index('feedback_responses_facility_idx').on(t.facilityId, t.month),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Organ donation registry and advance directives
 * ---------------------------------------------------------------------------------------------- */

/** Organ donation decisions as an append-only history; the latest row is the current decision. */
export const organDonationDecisions = pgTable(
  'organ_donation_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** DONOR (all organs), DONOR_SOME (only `organs`), NOT_DONOR. */
    decision: varchar('decision', { length: 12 }).notNull(),
    /** KIDNEYS, LIVER, HEART, LUNGS, PANCREAS, CORNEAS, TISSUE. */
    organs: text('organs').array(),
    familyInformed: boolean('family_informed'),
    faithOrBeliefNote: varchar('faith_or_belief_note', { length: 300 }),
    /** PORTAL or IN_PERSON (recorded by staff with the person present). */
    recordedVia: varchar('recorded_via', { length: 10 }).notNull(),
    recordedByUserId: uuid('recorded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('organ_donation_decisions_patient_idx').on(t.patientId, t.createdAt)],
);

/**
 * Advance directives and resuscitation decisions shown prominently in the chart and the emergency
 * department. Never edited: revoked (with a reason) and replaced.
 */
export const advanceDirectives = pgTable(
  'advance_directives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /**
     * DNACPR (clinician's do-not-attempt-resuscitation decision), TREATMENT_ESCALATION (ceiling
     * of care), ADVANCE_REFUSAL (patient's refusal of specific treatment), HEALTHCARE_PROXY.
     */
    kind: varchar('kind', { length: 22 }).notNull(),
    /** ACTIVE or REVOKED. */
    status: varchar('status', { length: 8 }).notNull().default('ACTIVE'),
    summary: text('summary').notNull(),
    /** Who took part: e.g. patient, proxy name, family. */
    discussedWith: varchar('discussed_with', { length: 300 }),
    proxyName: varchar('proxy_name', { length: 200 }),
    proxyPhone: varchar('proxy_phone', { length: 40 }),
    documentId: uuid('document_id').references(() => patientDocuments.id, {
      onDelete: 'set null',
    }),
    reviewDate: date('review_date', { mode: 'string' }),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedById: uuid('revoked_by_id').references(() => users.id, { onDelete: 'restrict' }),
    revokeReason: varchar('revoke_reason', { length: 500 }),
  },
  (t) => [index('advance_directives_patient_idx').on(t.patientId, t.status)],
);

/* ------------------------------------------------------------------------------------------------
 * Emergency medical services (ambulance dispatch, pre-hospital care, handover)
 * ---------------------------------------------------------------------------------------------- */

/** An ambulance (crewed vehicle) of an ambulance service unit. */
export const ambulanceUnits = pgTable(
  'ambulance_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The AMBULANCE_SERVICE care unit (station) the vehicle belongs to. */
    stationUnitId: uuid('station_unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'restrict' }),
    callSign: varchar('call_sign', { length: 20 }).notNull(),
    /** BLS (basic) or ALS (advanced, with a doctor or paramedic). */
    level: varchar('level', { length: 4 }).notNull(),
    /** AVAILABLE, DISPATCHED, ON_SCENE, TRANSPORTING, AT_HOSPITAL, OUT_OF_SERVICE. */
    status: varchar('status', { length: 14 }).notNull().default('AVAILABLE'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('ambulance_units_call_sign_uq').on(t.callSign)],
);

/** An emergency call and everything that happens until handover or closure. */
export const emsIncidents = pgTable(
  'ems_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. "EMS-2026-000123". */
    reference: varchar('reference', { length: 30 }).notNull(),
    /** The ambulance service (care unit) that handles the call. */
    serviceUnitId: uuid('service_unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    callerName: varchar('caller_name', { length: 200 }),
    callerPhone: varchar('caller_phone', { length: 40 }),
    address: varchar('address', { length: 300 }).notNull(),
    municipality: varchar('municipality', { length: 100 }),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    /** Chief complaint as reported, e.g. "chest pain", "road traffic collision". */
    complaint: varchar('complaint', { length: 300 }).notNull(),
    /** P1 immediately life-threatening, P2 urgent, P3 non-urgent (illustrative categories). */
    priority: varchar('priority', { length: 2 }).notNull(),
    /** RECEIVED, DISPATCHED, ON_SCENE, TRANSPORTING, HANDED_OVER, CLOSED, CANCELLED. */
    status: varchar('status', { length: 12 }).notNull().default('RECEIVED'),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'restrict' }),
    /** Description when the patient is not identified yet. */
    patientDescription: varchar('patient_description', { length: 300 }),
    ambulanceUnitId: uuid('ambulance_unit_id').references(() => ambulanceUnits.id, {
      onDelete: 'set null',
    }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    onSceneAt: timestamp('on_scene_at', { withTimezone: true }),
    leftSceneAt: timestamp('left_scene_at', { withTimezone: true }),
    atHospitalAt: timestamp('at_hospital_at', { withTimezone: true }),
    handedOverAt: timestamp('handed_over_at', { withTimezone: true }),
    destinationFacilityId: uuid('destination_facility_id').references(() => facilities.id, {
      onDelete: 'set null',
    }),
    /** The emergency department attendance created at handover. */
    edVisitId: uuid('ed_visit_id').references(() => edVisits.id, { onDelete: 'set null' }),
    /** TRANSPORTED, TREATED_ON_SCENE, REFUSED_TRANSPORT, DECEASED_ON_SCENE, NO_PATIENT, CANCELLED. */
    outcome: varchar('outcome', { length: 20 }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ems_incidents_reference_uq').on(t.reference),
    index('ems_incidents_service_idx').on(t.serviceUnitId, t.status, t.receivedAt),
    index('ems_incidents_patient_idx').on(t.patientId),
  ],
);

/** Pre-hospital patient care record (observations, interventions, medicines given). */
export const emsCareRecords = pgTable(
  'ems_care_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => emsIncidents.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'restrict' }),
    /** OBSERVATION, INTERVENTION, MEDICATION, NOTE. */
    kind: varchar('kind', { length: 12 }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** Observations: { systolic, diastolic, heartRate, respiratoryRate, spo2, gcs, glucose, temperature }. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    text: varchar('text', { length: 500 }),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ems_care_records_incident_idx').on(t.incidentId, t.recordedAt)],
);

/* ------------------------------------------------------------------------------------------------
 * Infection prevention and antimicrobial stewardship
 * ---------------------------------------------------------------------------------------------- */

/** Isolation precautions for a patient (shown on bed boards and the chart). */
export const isolationOrders = pgTable(
  'isolation_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /** CONTACT, DROPLET, AIRBORNE, PROTECTIVE. */
    precaution: varchar('precaution', { length: 10 }).notNull(),
    /** Organism or reason, e.g. "MRSA", "suspected TB", "neutropenia". */
    reason: varchar('reason', { length: 200 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    orderedById: uuid('ordered_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedById: uuid('ended_by_id').references(() => users.id, { onDelete: 'restrict' }),
    endReason: varchar('end_reason', { length: 300 }),
  },
  (t) => [index('isolation_orders_patient_idx').on(t.patientId, t.endedAt)],
);

/** A healthcare-associated infection (surveillance definitions in code). */
export const haiEvents = pgTable(
  'hai_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    unitId: uuid('unit_id').references(() => careUnits.id, { onDelete: 'set null' }),
    /** CLABSI, CAUTI, VAP, SSI, CDI, MRSA_BACTERAEMIA, OTHER. */
    type: varchar('type', { length: 20 }).notNull(),
    organism: varchar('organism', { length: 120 }),
    onsetAt: timestamp('onset_at', { withTimezone: true }).notNull(),
    deviceRelated: boolean('device_related').notNull().default(false),
    /** SUSPECTED, CONFIRMED, RULED_OUT. */
    status: varchar('status', { length: 10 }).notNull().default('SUSPECTED'),
    notes: text('notes'),
    reportedById: uuid('reported_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('hai_events_facility_idx').on(t.facilityId, t.onsetAt)],
);

/** Approval of a restricted antimicrobial (reserve antibiotics) by the stewardship team. */
export const antimicrobialApprovals = pgTable(
  'antimicrobial_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prescriptionId: uuid('prescription_id')
      .notNull()
      .references(() => prescriptions.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    indication: varchar('indication', { length: 300 }).notNull(),
    /** Culture/sensitivity result or reason empirical treatment is needed. */
    justification: text('justification').notNull(),
    /** REQUESTED, APPROVED, DECLINED. */
    status: varchar('status', { length: 10 }).notNull().default('REQUESTED'),
    requestedById: uuid('requested_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedById: uuid('decided_by_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: varchar('decision_note', { length: 500 }),
    /** 48–72 hour antibiotic review ("start smart, then focus"). */
    reviewDueAt: timestamp('review_due_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** CONTINUE, NARROW, SWITCH_ORAL, STOP. */
    reviewOutcome: varchar('review_outcome', { length: 12 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('antimicrobial_approvals_prescription_uq').on(t.prescriptionId),
    index('antimicrobial_approvals_facility_idx').on(t.facilityId, t.status),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Sepsis screening and the Sepsis Six bundle
 * ---------------------------------------------------------------------------------------------- */

export const sepsisScreens = pgTable(
  'sepsis_screens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').references(() => admissions.id, { onDelete: 'set null' }),
    edVisitId: uuid('ed_visit_id').references(() => edVisits.id, { onDelete: 'set null' }),
    /** The early warning score that prompted the screen, if any. */
    earlyWarningScoreId: uuid('early_warning_score_id').references(() => earlyWarningScores.id, {
      onDelete: 'set null',
    }),
    /** PROMPTED (by a score) or MANUAL. */
    trigger: varchar('trigger', { length: 10 }).notNull(),
    /** PENDING (prompt not yet answered), NOT_SEPSIS, SEPSIS_SUSPECTED, RED_FLAG. */
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),
    suspectedSource: varchar('suspected_source', { length: 100 }),
    redFlags: text('red_flags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    screenedAt: timestamp('screened_at', { withTimezone: true }),
    screenedById: uuid('screened_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Sepsis Six steps with the time each was done: { oxygen, cultures, antibiotics, fluids, lactate, urineOutput }. */
    bundle: jsonb('bundle').$type<Record<string, string>>().notNull().default({}),
    bundleStartedAt: timestamp('bundle_started_at', { withTimezone: true }),
    bundleCompletedAt: timestamp('bundle_completed_at', { withTimezone: true }),
    seniorReviewAt: timestamp('senior_review_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sepsis_screens_patient_idx').on(t.patientId, t.createdAt),
    index('sepsis_screens_facility_idx').on(t.facilityId, t.status),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Staff rosters and on-call
 * ---------------------------------------------------------------------------------------------- */

/** A rostered shift or on-call period for a staff member. */
export const rosterShifts = pgTable(
  'roster_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id').references(() => careUnits.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** DAY, LATE, NIGHT, ON_CALL. */
    kind: varchar('kind', { length: 8 }).notNull(),
    /** For on-call: the specialty covered, e.g. CARDIOLOGY, GENERAL_SURGERY. */
    specialty: varchar('specialty', { length: 40 }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** PLANNED, CANCELLED. */
    status: varchar('status', { length: 10 }).notNull().default('PLANNED'),
    note: varchar('note', { length: 300 }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('roster_shifts_facility_idx').on(t.facilityId, t.startsAt),
    index('roster_shifts_user_idx').on(t.userId, t.startsAt),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Home care and community nursing
 * ---------------------------------------------------------------------------------------------- */

export const homeCareEpisodes = pgTable(
  'home_care_episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    /** The COMMUNITY_NURSING care unit responsible. */
    teamUnitId: uuid('team_unit_id')
      .notNull()
      .references(() => careUnits.id, { onDelete: 'restrict' }),
    referredById: uuid('referred_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: varchar('reason', { length: 300 }).notNull(),
    /** Goals and interventions agreed with the patient. */
    carePlan: text('care_plan'),
    /** Home address used for visits (may differ from the registered address). */
    visitAddress: varchar('visit_address', { length: 300 }),
    accessNotes: varchar('access_notes', { length: 300 }),
    /** REFERRED, ACTIVE, ON_HOLD, DISCHARGED. */
    status: varchar('status', { length: 10 }).notNull().default('REFERRED'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: varchar('end_reason', { length: 300 }),
    ...timestamps,
  },
  (t) => [
    index('home_care_episodes_team_idx').on(t.teamUnitId, t.status),
    index('home_care_episodes_patient_idx').on(t.patientId),
  ],
);

export const homeVisits = pgTable(
  'home_visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => homeCareEpisodes.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    /** PLANNED, DONE, MISSED, CANCELLED. */
    status: varchar('status', { length: 10 }).notNull().default('PLANNED'),
    /** e.g. WOUND_CARE, MEDICATION, INJECTION, CATHETER, OBSERVATIONS, PALLIATIVE, ASSESSMENT. */
    tasks: text('tasks')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    visitedAt: timestamp('visited_at', { withTimezone: true }),
    notes: text('notes'),
    missedReason: varchar('missed_reason', { length: 300 }),
    recordedById: uuid('recorded_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('home_visits_episode_idx').on(t.episodeId, t.scheduledFor),
    index('home_visits_assignee_idx').on(t.assignedToId, t.scheduledFor),
  ],
);

/* ------------------------------------------------------------------------------------------------
 * Medical equipment register and maintenance
 * ---------------------------------------------------------------------------------------------- */

export const equipmentItems = pgTable(
  'equipment_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id').references(() => careUnits.id, { onDelete: 'set null' }),
    assetTag: varchar('asset_tag', { length: 40 }).notNull(),
    /** VENTILATOR, MONITOR, DEFIBRILLATOR, INFUSION_PUMP, IMAGING, LAB_ANALYSER, DIALYSIS, OTHER. */
    category: varchar('category', { length: 20 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    manufacturer: varchar('manufacturer', { length: 120 }),
    model: varchar('model', { length: 120 }),
    serialNumber: varchar('serial_number', { length: 120 }),
    /** HIGH (life support), MEDIUM, LOW. */
    criticality: varchar('criticality', { length: 6 }).notNull(),
    /** IN_SERVICE, OUT_OF_SERVICE, IN_MAINTENANCE, RETIRED. */
    status: varchar('status', { length: 14 }).notNull().default('IN_SERVICE'),
    serviceIntervalDays: smallint('service_interval_days'),
    lastServiceAt: date('last_service_at', { mode: 'string' }),
    nextServiceDue: date('next_service_due', { mode: 'string' }),
    commissionedOn: date('commissioned_on', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('equipment_items_tag_uq').on(t.facilityId, t.assetTag),
    index('equipment_items_status_idx').on(t.facilityId, t.status, t.nextServiceDue),
  ],
);

/** Append-only history: services, faults, repairs and status changes. */
export const equipmentEvents = pgTable(
  'equipment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => equipmentItems.id, { onDelete: 'restrict' }),
    /** SERVICE, FAULT, REPAIR, STATUS. */
    kind: varchar('kind', { length: 8 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    description: varchar('description', { length: 500 }).notNull(),
    /** Status after the event. */
    status: varchar('status', { length: 14 }),
    /** A fault that harmed or could have harmed a patient is also a safety incident. */
    incidentId: uuid('incident_id').references(() => safetyIncidents.id, { onDelete: 'set null' }),
    recordedById: uuid('recorded_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('equipment_events_item_idx').on(t.itemId, t.occurredAt)],
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
