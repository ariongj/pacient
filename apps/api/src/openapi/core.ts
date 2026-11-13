/**
 * OpenAPI registry entries for the core endpoints that are not described in spec.ts itself:
 * account and two-step verification, facilities and staff, the clinical record write operations,
 * appointments, collaboration (messages, referrals, channels, cover, care tasks, notifications,
 * announcements), pharmacy dispensing, hospital, emergency department, imaging, identity, merges,
 * laboratory connections and oversight. Imported by spec.ts. The coverage test compares the whole
 * registry with every route the Express app registers, so a new endpoint cannot be forgotten.
 *
 * Request bodies are given as JSON Schema; the authoritative validation is the Zod schema in each
 * route. Enumerations are read from the database schema so they never drift.
 */
import {
  administrationStatusEnum,
  allergySeverityEnum,
  announcementAudienceEnum,
  appointmentStatusEnum,
  bloodTypeEnum,
  careUnitTypeEnum,
  consentDecisionEnum,
  consentMethodEnum,
  consentTypeEnum,
  diagnosisStatusEnum,
  facilityTypeEnum,
  guardianRelationshipEnum,
  integrationMessageStatusEnum,
  labFlagEnum,
  pharmacyStatusEnum,
  prescriptionStatusEnum,
  proxyScopeEnum,
  resultStatusEnum,
  reviewOutcomeEnum,
  STAFF_ROLES,
  taskPriorityEnum,
  verificationStatusEnum,
} from '../db/schema.js';
import { AGE_GROUPS, DOSE_UNITS, FREQUENCY_CODES, ROUTES } from '../modules/safety/dosing.js';
import {
  arr,
  bool,
  date,
  dateTime,
  enumOf,
  int,
  num,
  obj,
  op,
  q,
  str,
  uuid,
  type ModuleOperation,
} from './modules.js';

const values = (e: { enumValues: readonly string[] }) => enumOf(...e.enumValues);
const text = (min: number, max: number) => str({ minLength: min, maxLength: max });
const opt = (max: number) => str({ maxLength: max });
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];
const code6 = str({ pattern: '^\\d{6}$', description: '6-digit code from the authenticator app' });
const password = str({
  minLength: 12,
  maxLength: 128,
  description: 'At least 12 characters; checked against known breached passwords.',
});
const note = (min: number, max: number) => obj({ note: text(min, max) }, ['note']);

export const CORE_TAGS: { name: string; description: string }[] = [
  { name: 'Appointments', description: 'Booking, status and visit mode of appointments.' },
  {
    name: 'Pharmacy',
    description: 'Prescription queue: verification, return to prescriber, dispensing from stock.',
  },
  {
    name: 'Data protection',
    description: 'Retention policies, data-subject requests and legal holds.',
  },
  { name: 'Monitoring', description: 'System health indicators and the audit export for a SIEM.' },
  {
    name: 'Downtime',
    description: 'Downtime mode, encrypted paper packs for outages and back-entry afterwards.',
  },
];

const AUTH = 'Authentication';
const PAT = 'Patients';
const CR = 'Clinical record';
const LAB = 'Laboratory';
const H = 'Hospital';
const ED = 'Emergency department';
const IMG = 'Imaging';
const ID = 'Identity';
const COL = 'Collaboration';
const OV = 'Oversight';
const ADM = 'Administration';
const APP = 'Appointments';
const PH = 'Pharmacy';
const DP = 'Data protection';
const MON = 'Monitoring';
const DT = 'Downtime';
const SAF = 'Medication safety';

const DOCTOR = 'DOCTOR (care team)';
const CARE = 'DOCTOR, NURSE (care team)';
const pp = '/patients/{patientId}';

const overrides = arr(obj({ code: text(3, 200), reason: text(10, 500) }, ['code', 'reason']), {
  maxItems: 30,
  description: 'Reasons for proceeding despite medication-safety alerts (one per alert code).',
});

export const CORE_OPERATIONS: ModuleOperation[] = [
  // Authentication: account activation, passwords, two-step verification, mobile number
  op('post', '/auth/activate', AUTH, 'Activate an invited account and set a password', {
    auth: 'none',
    body: obj({ token: text(20, 200), password }, ['token', 'password']),
    responses: { '400': 'Invalid or expired invitation' },
  }),
  op('post', '/auth/reset-password', AUTH, 'Set a new password with a reset link', {
    auth: 'none',
    body: obj({ token: text(20, 200), password }, ['token', 'password']),
    responses: { '204': 'Password changed; other sessions signed out' },
  }),
  op('post', '/auth/change-password', AUTH, 'Change my password', {
    body: obj({ currentPassword: text(1, 128), newPassword: password }, [
      'currentPassword',
      'newPassword',
    ]),
    responses: { '204': 'Changed; all sessions signed out' },
  }),
  op('post', '/auth/mfa/setup', AUTH, 'Start two-step verification setup (secret and QR URI)'),
  op('post', '/auth/mfa/enable', AUTH, 'Confirm two-step verification (returns recovery codes)', {
    body: obj({ code: code6 }, ['code']),
  }),
  op('post', '/auth/mfa/disable', AUTH, 'Turn off two-step verification', {
    body: obj({ code: code6, password: text(1, 128) }, ['code', 'password']),
    responses: { '204': 'Turned off' },
  }),
  op('post', '/auth/mfa/recovery-codes', AUTH, 'Generate new recovery codes', {
    body: obj({ code: code6 }, ['code']),
  }),
  op('post', '/auth/me/phone/verify', AUTH, 'Confirm my mobile number with the SMS code', {
    body: obj({ code: str({ pattern: '^\\d{6}$' }) }, ['code']),
  }),
  op('delete', '/auth/me/phone', AUTH, 'Remove my mobile number', {
    responses: { '204': 'Removed' },
  }),

  // Patients
  op('patch', '/patients/{id}', PAT, 'Update demographics and contact details', {
    access: 'DOCTOR, NURSE, DIRECTOR, RECEPTION',
    body: obj({
      firstName: text(1, 100),
      lastName: text(1, 100),
      bloodType: values(bloodTypeEnum),
      phone: opt(40),
      email: str({ format: 'email', maxLength: 254 }),
      address: opt(300),
      municipality: opt(100),
      emergencyContactName: opt(200),
      emergencyContactPhone: opt(40),
    }),
  }),
  op('post', '/patients/{id}/portal-invitation', PAT, 'Invite the patient to the portal', {
    access: 'DOCTOR, NURSE, DIRECTOR, RECEPTION',
    description: 'Emails an activation link to the patient’s address on record.',
  }),
  op('post', '/patients/{id}/care-team', PAT, 'Add a doctor to the care team', {
    access: 'DOCTOR, NURSE, DIRECTOR',
    body: obj({ doctorId: { ...uuid, description: 'Defaults to the calling doctor' } }),
  }),
  op('delete', '/patients/{id}/care-team/{doctorId}', PAT, 'Remove a doctor from the care team', {
    access: 'DOCTOR, NURSE, DIRECTOR',
  }),
  op('get', '/patients/{id}/guardians', PAT, 'Guardians and proxies of a patient', {
    access: 'care team, RECEPTION, DIRECTOR, the patient',
  }),
  op('post', '/patients/{id}/guardians', PAT, 'Grant guardian (proxy) access', {
    access: 'RECEPTION, DIRECTOR',
    body: obj(
      {
        email: str({ format: 'email', maxLength: 254 }),
        fullName: text(2, 200),
        relationship: values(guardianRelationshipEnum),
        scope: values(proxyScopeEnum),
        evidence: { ...text(5, 300), description: 'Document that proves the relationship' },
        validUntil: date,
      },
      ['email', 'fullName', 'relationship', 'evidence'],
    ),
  }),
  op('post', '/patients/{id}/guardians/{guardianshipId}/revoke', PAT, 'Revoke guardian access', {
    access: 'RECEPTION, DIRECTOR, the adult patient',
    body: obj({ reason: text(3, 300) }, ['reason']),
  }),

  // Clinical record: visits
  op('patch', `${pp}/encounters/{entryId}`, CR, 'Edit a draft visit note', {
    access: DOCTOR,
    body: obj({ version: int({ minimum: 1 }), notes: opt(20_000), endedAt: dateTime }, ['version']),
    responses: { '409': 'Signed already, or changed since it was loaded' },
  }),
  op('post', `${pp}/encounters/{entryId}/addenda`, CR, 'Add an addendum to a signed note', {
    access: DOCTOR,
    body: obj({ reason: text(3, 300), content: text(2, 10_000) }, ['reason', 'content']),
  }),
  op(
    'post',
    `${pp}/encounters/{entryId}/confidentiality`,
    CR,
    'Mark a visit confidential from guardians',
    { access: DOCTOR, body: obj({ confidential: bool }, ['confidential']) },
  ),
  // Diagnoses, prescriptions, allergies, observations
  op('post', `${pp}/diagnoses`, CR, 'Record a diagnosis (ICD-10)', {
    access: DOCTOR,
    body: obj(
      {
        encounterId: uuid,
        icd10Code: str({ pattern: '^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$' }),
        description: text(2, 300),
        status: values(diagnosisStatusEnum),
        notes: opt(5000),
      },
      ['icd10Code', 'description'],
    ),
  }),
  op('patch', `${pp}/diagnoses/{entryId}`, CR, 'Change the status of a diagnosis', {
    access: DOCTOR,
    body: obj({ status: values(diagnosisStatusEnum), notes: opt(5000) }, ['status']),
  }),
  op('post', `${pp}/prescriptions`, CR, 'Prescribe a medicine (safety checks applied)', {
    access: DOCTOR,
    description:
      'Give a structured dose (doseAmount, doseUnit, frequencyCode – checked against the dose rules) or, for free text, dosage and frequency.',
    body: obj(
      {
        encounterId: uuid,
        medication: text(2, 200),
        catalogItemId: { ...uuid, description: 'Medicine from the national catalogue' },
        dosage: text(1, 100),
        frequency: text(1, 100),
        route: opt(50),
        doseAmount: { ...num, exclusiveMinimum: 0, maximum: 1_000_000 },
        doseUnit: enumOf(...DOSE_UNITS),
        frequencyCode: enumOf(...FREQUENCY_CODES),
        maxDosesPer24h: {
          ...int({ minimum: 1, maximum: 24 }),
          description: 'Required for PRN (as needed)',
        },
        durationDays: int({ minimum: 1, maximum: 3650 }),
        asNeeded: bool,
        instructions: opt(2000),
        startDate: date,
        endDate: date,
        overrides,
        ePrescription: {
          ...obj({
            repeats: int({ minimum: 0, maximum: 12 }),
            validDays: int({ minimum: 1, maximum: 365 }),
          }),
          description:
            'Issue as a national e-prescription for community pharmacies (code returned as ePrescriptionCode).',
        },
        antimicrobial: {
          ...obj(
            {
              indication: str({ minLength: 3, maxLength: 300 }),
              justification: str({ minLength: 10, maxLength: 2000 }),
            },
            ['indication', 'justification'],
          ),
          description:
            'Required for restricted (reserve) antibiotics: the prescription is saved and an approval request goes to the stewardship team.',
        },
      },
      ['medication', 'startDate'],
    ),
    responses: {
      '400':
        'ANTIMICROBIAL_APPROVAL_REQUIRED for a restricted antibiotic without the antimicrobial block',
      '409': 'Unacknowledged medication-safety alerts (listed in details)',
    },
  }),
  op('patch', `${pp}/prescriptions/{entryId}`, CR, 'Stop or complete a prescription', {
    access: DOCTOR,
    body: obj({ status: values(prescriptionStatusEnum) }, ['status']),
  }),
  op(
    'post',
    `${pp}/prescriptions/{entryId}/resubmit`,
    CR,
    'Correct and resubmit a prescription returned by the pharmacy',
    {
      access: DOCTOR,
      body: obj(
        {
          dosage: text(1, 100),
          frequency: text(1, 100),
          instructions: opt(2000),
          note: text(3, 1000),
        },
        ['note'],
      ),
    },
  ),
  op('post', `${pp}/allergies`, CR, 'Record an allergy', {
    access: CARE,
    body: obj(
      {
        substance: text(2, 200),
        reaction: opt(300),
        severity: values(allergySeverityEnum),
        verificationStatus: enumOf('UNCONFIRMED', 'CONFIRMED'),
        source: enumOf('CLINICIAN', 'PATIENT_REPORTED'),
      },
      ['substance', 'severity'],
    ),
  }),
  op('patch', `${pp}/allergies/{entryId}`, CR, 'Confirm or refute an allergy', {
    access: DOCTOR,
    body: obj({ verificationStatus: values(verificationStatusEnum) }, ['verificationStatus']),
  }),
  op('put', `${pp}/allergy-assessment`, CR, 'Record “no known allergies” or “unknown”', {
    access: DOCTOR,
    body: obj({ status: enumOf('NO_KNOWN_ALLERGIES', 'UNKNOWN') }, ['status']),
  }),
  op('post', `${pp}/vitals`, CR, 'Record vital signs', {
    access: CARE,
    description: 'At least one measurement is required. NEWS2 is calculated automatically.',
    body: obj({
      encounterId: uuid,
      systolic: int({ minimum: 40, maximum: 300 }),
      diastolic: int({ minimum: 20, maximum: 200 }),
      heartRate: int({ minimum: 20, maximum: 300 }),
      temperatureC: { ...num, minimum: 25, maximum: 45 },
      respiratoryRate: int({ minimum: 4, maximum: 80 }),
      oxygenSaturation: int({ minimum: 30, maximum: 100 }),
      weightKg: { ...num, minimum: 0.3, maximum: 500 },
      heightCm: { ...num, minimum: 20, maximum: 260 },
      consciousness: enumOf('A', 'C', 'V', 'P', 'U'),
      onSupplementalOxygen: bool,
      painScore: int({ minimum: 0, maximum: 10 }),
      capillaryRefillSeconds: { ...num, minimum: 0, maximum: 20 },
      respiratoryEffort: enumOf('NONE', 'MILD', 'MODERATE', 'SEVERE'),
      recordedAt: {
        ...dateTime,
        description: 'When the observation was taken (back-entry, up to 14 days ago)',
      },
    }),
  }),
  op('post', `${pp}/immunizations`, CR, 'Record a vaccination given', {
    access: CARE,
    body: obj(
      {
        encounterId: uuid,
        vaccine: text(2, 200),
        doseNumber: int({ minimum: 1, maximum: 20 }),
        lotNumber: opt(60),
        site: opt(60),
        administeredAt: dateTime,
        notes: opt(2000),
      },
      ['vaccine'],
    ),
  }),
  op('get', `${pp}/medication-administrations`, CR, 'Medication administration record', {
    access: 'care team, patient, guardian',
  }),
  op('post', `${pp}/medication-administrations`, CR, 'Record a dose given, held or refused', {
    access: CARE,
    body: obj(
      {
        prescriptionId: uuid,
        status: values(administrationStatusEnum),
        doseGiven: opt(100),
        reason: { ...opt(500), description: 'Required unless the dose was GIVEN' },
        notes: opt(2000),
        administeredAt: dateTime,
        patientScanned: bool,
        medicationScanned: bool,
        scanToken: { ...opt(512), description: 'Wristband code scanned at the bedside' },
        barcode: { ...opt(120), description: 'Pack barcode (GTIN) scanned at the bedside' },
        scanOverrideReason: {
          ...opt(300),
          description: 'Required for an unscanned dose or an overridable warning (audited)',
        },
      },
      ['prescriptionId', 'status'],
    ),
    responses: { '409': 'Wrong patient or wrong medicine, or a warning without a reason' },
  }),
  op('post', `${pp}/bcma/verify`, SAF, 'Bedside barcode check before giving a dose', {
    access: CARE,
    description: 'Checks wristband, pack, timing and allergies without recording anything.',
    body: obj({ prescriptionId: uuid, patientToken: opt(512), medicationBarcode: opt(120) }, [
      'prescriptionId',
    ]),
  }),
  op('get', `${pp}/bcma/compliance`, SAF, 'Barcode scanning compliance of the patient’s ward', {
    access: 'NURSE, DOCTOR, DIRECTOR with access to the patient',
    params: [q('days', int({ minimum: 1, maximum: 90 }), 'Default 7')],
  }),
  op('post', `${pp}/wristband`, PAT, 'Print a wristband (signed identity code)', {
    access: 'NURSE, RECEPTION, DOCTOR (admitted or emergency patients)',
  }),
  op('get', `${pp}/care-tasks`, CR, 'Care tasks for the patient', { access: 'care team' }),
  op('post', `${pp}/care-tasks`, CR, 'Create a care task for nurses or doctors', {
    access: CARE,
    body: obj(
      {
        title: text(3, 200),
        details: opt(4000),
        priority: values(taskPriorityEnum),
        dueAt: dateTime,
        assignedRole: enumOf('NURSE', 'DOCTOR'),
        assignedToId: uuid,
      },
      ['title'],
    ),
  }),
  // Results
  op('post', `${pp}/lab-results`, CR, 'Enter a laboratory result manually', {
    access: DOCTOR,
    body: obj(
      {
        encounterId: uuid,
        testName: text(2, 200),
        value: text(1, 100),
        unit: opt(40),
        referenceRange: opt(100),
        flag: values(labFlagEnum),
        status: values(resultStatusEnum),
        collectedAt: dateTime,
      },
      ['testName', 'value'],
    ),
  }),
  op('post', `${pp}/lab-results/{entryId}/release`, CR, 'Release a result to the patient', {
    access: DOCTOR,
  }),
  // Corrections requested by the patient
  op('get', `${pp}/correction-requests`, CR, 'Requests to correct the record', {
    access: 'care team, the patient',
  }),
  op('post', `${pp}/correction-requests`, CR, 'Ask for a correction of my record', {
    access: 'PATIENT (own record or as guardian)',
    body: obj(
      {
        section: enumOf(
          'demographics',
          'allergies',
          'diagnoses',
          'prescriptions',
          'encounters',
          'lab-results',
          'vitals',
          'other',
        ),
        entryId: uuid,
        description: text(10, 4000),
      },
      ['section', 'description'],
    ),
  }),
  op('patch', `${pp}/correction-requests/{entryId}`, CR, 'Accept or reject a correction request', {
    access: DOCTOR,
    body: obj({ status: enumOf('ACCEPTED', 'REJECTED'), response: text(5, 4000) }, [
      'status',
      'response',
    ]),
  }),
  // Documents and consent
  op('get', `${pp}/documents/{documentId}/content`, CR, 'Download a document', {
    access: 'care team, patient, guardian (if shared)',
    responses: { '200': 'The file (Content-Type as uploaded)' },
  }),
  op(
    'patch',
    `${pp}/documents/{documentId}`,
    CR,
    'Share with the patient or withhold from guardians',
    {
      access: DOCTOR,
      body: obj({ visibleToPatient: bool, confidentialFromGuardians: bool }),
    },
  ),
  op(
    'post',
    `${pp}/documents/{documentId}/entered-in-error`,
    CR,
    'Mark a document entered in error',
    {
      access: 'the uploader, or a DOCTOR of the care team',
      body: obj({ reason: text(5, 300) }, ['reason']),
    },
  ),
  op('post', `${pp}/documents/{documentId}/versions`, CR, 'Upload a new version of a document', {
    access: 'care team (staff documents), the patient or guardian (documents they provided)',
    description:
      'Raw body (PDF, JPEG or PNG with that Content-Type) and an X-File-Name header, as for an upload. Only the latest version that is not entered in error can be replaced; the new version keeps the category, visit and sharing.',
    params: [q('title', text(2, 200))],
    responses: {
      '201': 'The new version',
      '409': 'A newer version exists or the document was entered in error',
    },
  }),
  op('get', `${pp}/documents/{documentId}/versions`, CR, 'All versions of a document', {
    access: 'care team, patient, guardian (if shared)',
  }),
  op('post', `${pp}/consents`, CR, 'Record a consent decision', {
    access: 'the patient or guardian (PORTAL); DOCTOR, NURSE, RECEPTION in person',
    body: obj(
      {
        type: values(consentTypeEnum),
        decision: values(consentDecisionEnum),
        method: values(consentMethodEnum),
        procedure: text(2, 200),
        note: opt(1000),
        documentId: { ...uuid, description: 'Signed consent form uploaded as a document' },
        expiresAt: dateTime,
      },
      ['type', 'decision'],
    ),
  }),

  // Laboratory
  op('get', `${pp}/lab-orders`, LAB, 'Laboratory orders of a patient', { access: 'care team' }),
  op('post', `${pp}/lab-orders/{orderId}/cancel`, LAB, 'Cancel a laboratory order', {
    access: DOCTOR,
  }),
  op('get', '/integrations/lab/ping', LAB, 'Check the laboratory key and count pending orders', {
    auth: 'lab',
  }),
  op('post', '/integrations/clients', ADM, 'Register a laboratory system (key shown once)', {
    access: 'DIRECTOR',
    body: obj({ name: text(3, 120) }, ['name']),
  }),
  op('post', '/integrations/clients/{id}/revoke', ADM, 'Revoke a laboratory key', {
    access: 'DIRECTOR',
  }),
  op('get', '/integrations/messages', ADM, 'HL7 message log of my facility', {
    access: 'DIRECTOR',
    params: [q('status', values(integrationMessageStatusEnum)), q('clientId', uuid), ...page],
  }),
  op('get', '/integrations/messages/{id}', ADM, 'One HL7 message with its outcome', {
    access: 'DIRECTOR',
  }),
  op(
    'post',
    '/integrations/messages/{id}/review',
    ADM,
    'File a held message to a patient or ignore it',
    {
      access: 'DIRECTOR',
      body: {
        oneOf: [
          obj({ action: enumOf('FILE'), patientId: uuid, note: text(5, 500) }, [
            'action',
            'patientId',
            'note',
          ]),
          obj({ action: enumOf('IGNORE'), note: text(5, 500) }, ['action', 'note']),
        ],
      },
    },
  ),

  // Appointments
  op('get', '/appointments', APP, 'My appointments (patients, clinicians, reception)', {
    access: 'PATIENT, DOCTOR, NURSE, DIRECTOR, RECEPTION',
    params: [q('from', dateTime), q('to', dateTime), q('status', values(appointmentStatusEnum))],
  }),
  op('post', '/appointments', APP, 'Book an appointment', {
    access: 'PATIENT, DOCTOR, RECEPTION',
    body: obj(
      {
        patientId: { ...uuid, description: 'Required for staff; patients book for themselves' },
        doctorId: uuid,
        scheduledAt: dateTime,
        durationMinutes: int({ minimum: 5, maximum: 480 }),
        reason: text(2, 500),
        mode: enumOf('IN_PERSON', 'VIDEO'),
      },
      ['scheduledAt', 'reason'],
    ),
  }),
  op('patch', '/appointments/{id}/status', APP, 'Confirm, check in, complete or cancel', {
    access: 'PATIENT (cancel own), DOCTOR, NURSE, RECEPTION',
    body: obj({ status: values(appointmentStatusEnum) }, ['status']),
  }),
  op('patch', '/appointments/{id}/mode', APP, 'Switch between in-person and video', {
    access: 'DOCTOR, RECEPTION',
    body: obj({ mode: enumOf('IN_PERSON', 'VIDEO') }, ['mode']),
  }),

  // Collaboration: messages
  op('post', '/messages/threads', COL, 'Start a conversation', {
    access: 'PATIENT, DOCTOR, NURSE',
    body: obj({ doctorId: uuid, patientId: uuid, subject: text(2, 200), body: text(1, 5000) }, [
      'subject',
      'body',
    ]),
  }),
  op('get', '/messages/threads/{id}', COL, 'A conversation with its messages', {
    access: 'participants',
  }),
  op('post', '/messages/threads/{id}/messages', COL, 'Reply in a conversation', {
    access: 'participants',
    body: obj({ body: text(1, 5000) }, ['body']),
  }),
  op('post', '/messages/threads/{id}/close', COL, 'Close a conversation', {
    access: 'DOCTOR, NURSE',
  }),
  // Referrals
  op('get', '/referrals/{id}', COL, 'One referral', {
    access: 'sending or receiving doctor/director, the patient',
  }),
  op('post', '/referrals/{id}/accept', COL, 'Accept a referral (optionally assign a doctor)', {
    access: 'DOCTOR, DIRECTOR (receiving facility)',
    body: obj({ doctorId: uuid, responseNote: opt(2000) }),
  }),
  op('post', '/referrals/{id}/decline', COL, 'Decline a referral', {
    access: 'DOCTOR, DIRECTOR (receiving facility)',
    body: obj({ responseNote: text(3, 2000) }, ['responseNote']),
  }),
  op('post', '/referrals/{id}/complete', COL, 'Complete a referral with a reply', {
    access: 'DOCTOR (receiving)',
    body: obj({ responseNote: text(3, 2000) }, ['responseNote']),
  }),
  op('post', '/referrals/{id}/cancel', COL, 'Cancel a referral I sent', {
    access: 'DOCTOR (sending)',
    body: obj({ responseNote: text(3, 2000) }, ['responseNote']),
  }),
  // Care tasks
  op('post', '/care-tasks/{id}/complete', COL, 'Complete a care task', {
    access: 'DOCTOR, NURSE',
    body: obj({ note: opt(2000) }),
  }),
  op('post', '/care-tasks/{id}/cancel', COL, 'Cancel a care task', {
    access: 'DOCTOR, NURSE',
    body: note(3, 2000),
  }),
  // Channels
  op('post', '/channels', COL, 'Create a team channel', {
    access: 'DIRECTOR, MINISTRY',
    body: obj(
      {
        name: str({ pattern: '^[a-z0-9][a-z0-9-]{1,40}$' }),
        description: opt(300),
        allowedRoles: arr(enumOf(...STAFF_ROLES), { minItems: 1 }),
      },
      ['name', 'allowedRoles'],
    ),
  }),
  op('get', '/channels/{id}/messages', COL, 'Channel messages (newest first)', {
    access: 'staff with an allowed role',
    params: [q('before', dateTime), q('limit', int({ minimum: 1, maximum: 100 }))],
  }),
  op('post', '/channels/{id}/messages', COL, 'Post in a channel', {
    access: 'staff with an allowed role',
    body: obj({ body: text(1, 4000), isUrgent: bool }, ['body']),
  }),
  op('post', '/channels/{id}/read', COL, 'Mark a channel read'),
  op('post', '/channels/{id}/archive', COL, 'Archive a channel', { access: 'DIRECTOR, MINISTRY' }),
  // Cover (substitute doctor)
  op('get', '/cover', COL, 'Cover arrangements for me or my facility', {
    access: 'DOCTOR, DIRECTOR',
  }),
  op('post', '/cover', COL, 'Arrange cover by a colleague', {
    access: 'DOCTOR (own absence), DIRECTOR',
    body: obj(
      {
        coverDoctorId: uuid,
        doctorId: { ...uuid, description: 'Absent doctor (directors only)' },
        startsAt: dateTime,
        endsAt: dateTime,
        note: opt(300),
      },
      ['coverDoctorId', 'startsAt', 'endsAt'],
    ),
  }),
  op('post', '/cover/{id}/cancel', COL, 'Cancel a cover arrangement', {
    access: 'DOCTOR, DIRECTOR',
  }),
  op('get', '/cover/colleagues', COL, 'Doctors who can cover', { access: 'DOCTOR, DIRECTOR' }),
  op('get', '/cover/escalations', COL, 'Unanswered patient messages without cover', {
    access: 'DIRECTOR',
  }),
  // Notifications, announcements, directory, live updates
  op('get', '/notifications/unread-count', COL, 'Number of unread notifications'),
  op('post', '/notifications/read-all', COL, 'Mark all notifications read'),
  op('post', '/notifications/{id}/read', COL, 'Mark a notification read'),
  op('get', '/announcements', COL, 'Current announcements for me'),
  op('get', '/announcements/manage', COL, 'Announcements I can manage', {
    access: 'MINISTRY, DIRECTOR',
  }),
  op('post', '/announcements', COL, 'Publish an announcement', {
    access: 'MINISTRY (national), DIRECTOR (own facility)',
    body: obj(
      {
        title: text(3, 200),
        body: text(3, 5000),
        audience: values(announcementAudienceEnum),
        expiresAt: dateTime,
      },
      ['title', 'body'],
    ),
  }),
  op('post', '/announcements/{id}/withdraw', COL, 'Withdraw an announcement', {
    access: 'MINISTRY, DIRECTOR',
  }),
  op('get', '/directory', COL, 'Staff directory of my facility', {
    access: 'DIRECTOR, DOCTOR, NURSE, PHARMACIST, RECEPTION',
    params: [q('role', enumOf('DOCTOR', 'NURSE', 'PHARMACIST'))],
  }),
  op('get', '/events', COL, 'Live updates (Server-Sent Events stream)', {
    auth: 'none',
    description:
      'EventSource cannot send headers: get a one-time ticket from POST /events/ticket and pass it as ?ticket=…',
    params: [{ ...q('ticket', text(20, 100)), required: true }],
    responses: { '200': 'text/event-stream' },
  }),

  // Pharmacy
  op('get', '/pharmacy/queue', PH, 'Prescriptions waiting at my pharmacy', {
    access: 'PHARMACIST',
    params: [q('status', values(pharmacyStatusEnum), 'Default PENDING')],
  }),
  op('get', '/pharmacy/prescriptions/{id}', PH, 'Prescription with safety alerts', {
    access: 'PHARMACIST',
  }),
  op('post', '/pharmacy/prescriptions/{id}/verify', PH, 'Verify a prescription', {
    access: 'PHARMACIST',
    body: obj({
      note: opt(2000),
      alertsReviewed: { ...bool, description: 'Required when safety alerts exist' },
    }),
  }),
  op('post', '/pharmacy/prescriptions/{id}/return', PH, 'Return a prescription to the prescriber', {
    access: 'PHARMACIST',
    body: obj({ note: text(5, 2000), alertCode: opt(200) }, ['note']),
  }),
  op('get', '/pharmacy/prescriptions/{id}/stock', PH, 'Stock batches available for dispensing', {
    access: 'PHARMACIST',
  }),
  op(
    'post',
    '/pharmacy/prescriptions/{id}/dispense',
    PH,
    'Dispense (draws stock first-expiry-first-out)',
    {
      access: 'PHARMACIST',
      body: obj({
        quantity: { ...text(1, 100), description: 'Label, e.g. "30 tablets"' },
        note: opt(2000),
        stock: obj(
          {
            itemId: uuid,
            units: int({ minimum: 1, maximum: 100_000 }),
            lines: arr(obj({ batchId: uuid, units: int({ minimum: 1 }) }, ['batchId', 'units']), {
              maxItems: 20,
            }),
          },
          ['units'],
        ),
        untrackedReason: {
          ...text(5, 500),
          description: 'Medicine not in the catalogue: dispensed without stock tracking',
        },
      }),
    },
  ),

  // Hospital (inpatient)
  op('post', '/hospital/units', H, 'Create a ward or unit', {
    access: 'DIRECTOR',
    body: obj(
      {
        name: text(2, 120),
        code: str({ pattern: '^[A-Za-z0-9_-]+$', maxLength: 20 }),
        type: values(careUnitTypeEnum),
      },
      ['name', 'code', 'type'],
    ),
  }),
  op('patch', '/hospital/units/{id}', H, 'Rename or (de)activate a unit', {
    access: 'DIRECTOR',
    body: obj({ name: text(2, 120), isActive: bool }),
  }),
  op('post', '/hospital/units/{id}/beds', H, 'Add beds (labels or a numbered range)', {
    access: 'DIRECTOR',
    body: obj({
      labels: arr(text(1, 20), { minItems: 1, maxItems: 100 }),
      prefix: opt(10),
      from: int({ minimum: 0, maximum: 999 }),
      to: int({ minimum: 0, maximum: 999 }),
    }),
  }),
  op('patch', '/hospital/beds/{id}', H, 'Set a bed available, cleaning or out of service', {
    access: 'NURSE, RECEPTION, DIRECTOR',
    body: obj({ status: enumOf('AVAILABLE', 'CLEANING', 'OUT_OF_SERVICE'), note: opt(200) }, [
      'status',
    ]),
  }),
  op('get', '/hospital/units/{id}/staff', H, 'Staff assigned to a unit', { access: 'DIRECTOR' }),
  op('post', '/hospital/units/{id}/staff', H, 'Assign a staff member to a unit', {
    access: 'DIRECTOR',
    body: obj({ userId: uuid }, ['userId']),
  }),
  op('delete', '/hospital/units/{id}/staff/{userId}', H, 'Remove a staff member from a unit', {
    access: 'DIRECTOR',
  }),
  op('get', '/hospital/assignable-staff', H, 'Doctors and nurses who can be assigned to units', {
    access: 'DIRECTOR',
  }),
  op('get', '/hospital/admissions/{id}', H, 'One admission', {
    access: 'DOCTOR, NURSE of the facility',
  }),
  op('post', '/hospital/admissions/{id}/cancel', H, 'Cancel an admission made in error', {
    access: 'DOCTOR',
    body: obj({ reason: text(5, 300) }, ['reason']),
  }),
  op('get', '/hospital/admissions/{id}/summary-draft', H, 'Draft discharge summary from the stay', {
    access: 'DOCTOR',
  }),
  op('put', '/hospital/admissions/{id}/summary', H, 'Save the discharge summary text', {
    access: 'DOCTOR',
    body: obj({ dischargeSummary: text(1, 20_000) }, ['dischargeSummary']),
  }),
  op(
    'post',
    '/hospital/admissions/{id}/release',
    H,
    'Release the signed discharge letter to the patient',
    {
      access: 'DOCTOR',
    },
  ),
  op('get', '/hospital/patients/{patientId}/admissions', H, 'Hospital stays of a patient', {
    access: 'care team, patient, guardian',
  }),
  op('get', '/hospital/today', H, 'Admissions and discharges today at my facility', {
    access: 'DOCTOR, NURSE, RECEPTION, DIRECTOR',
  }),
  op('get', '/hospital/doctors', H, 'Doctors of my facility (attending selects)', {
    access: 'facility staff',
  }),

  // Emergency department
  op('get', '/ed/units', ED, 'Emergency units of my facility', {
    access: 'DOCTOR, NURSE, RECEPTION',
  }),
  op('post', '/ed/visits/{id}/start', ED, 'Start treatment (assign a doctor)', {
    access: 'DOCTOR, NURSE',
    body: obj({ doctorId: uuid }),
  }),
  op(
    'post',
    '/ed/visits/{id}/depart',
    ED,
    'Discharge, transfer or record left without being seen',
    {
      access: 'DOCTOR, NURSE',
      body: obj(
        { status: enumOf('DISCHARGED', 'TRANSFERRED', 'LEFT_WITHOUT_BEING_SEEN'), note: opt(1000) },
        ['status'],
      ),
    },
  ),
  op('get', '/ed/patients/{patientId}/visits', ED, 'Emergency visits of a patient', {
    access: 'care team or emergency staff with unit access; the PATIENT (or a full guardian)',
    description:
      'Arrival, triage, treating doctor, outcome and the advice given at departure. The portal shows these to the patient.',
  }),

  // Imaging
  op(
    'get',
    '/imaging/patients/{patientId}/orders',
    IMG,
    'Imaging orders and reports of a patient',
    {
      access: 'care team, patient, guardian (released reports)',
    },
  ),
  op('post', '/imaging/orders/{id}/schedule', IMG, 'Schedule an examination', {
    access: 'radiology DOCTOR, NURSE',
    body: obj({ scheduledAt: dateTime }, ['scheduledAt']),
  }),
  op('post', '/imaging/orders/{id}/perform', IMG, 'Mark an examination performed', {
    access: 'radiology DOCTOR, NURSE',
  }),
  op('post', '/imaging/orders/{id}/acknowledge', IMG, 'Acknowledge a report', {
    access: 'DOCTOR (ordering)',
  }),
  op('post', '/imaging/orders/{id}/release', IMG, 'Release a report to the patient', {
    access: 'DOCTOR (ordering)',
  }),
  op('post', '/imaging/orders/{id}/cancel', IMG, 'Cancel an imaging order', {
    access: 'DOCTOR',
    body: obj({ reason: text(5, 300) }, ['reason']),
  }),

  // Identity
  op('get', '/identity/temporary', ID, 'Temporary (unidentified) patients at my facility', {
    access: 'RECEPTION, DIRECTOR, DOCTOR, NURSE',
  }),
  op('get', '/identity/births', ID, 'Births at my facility', {
    access: 'DOCTOR, NURSE, RECEPTION (without clinical details)',
    params: [q('from', date), q('to', date)],
  }),
  op('get', '/identity/patients/{patientId}/birth', ID, 'Birth record of a newborn', {
    access: 'care team, guardian',
  }),
  op('get', '/patient-merges', ID, 'Merges done at my facility', { access: 'DIRECTOR' }),
  op('get', '/patient-merges/compare', ID, 'Compare two records before merging', {
    access: 'DIRECTOR',
    params: [
      { ...q('a', uuid), required: true },
      { ...q('b', uuid), required: true },
    ],
  }),
  op('post', '/patient-merges/{id}/unmerge', ID, 'Undo a merge', {
    access: 'DIRECTOR',
    body: obj({ reason: text(10, 500) }, ['reason']),
  }),

  // Oversight
  op('get', '/emergency-access/summary', OV, 'National break-glass summary', {
    access: 'MINISTRY',
  }),
  op('post', '/emergency-access/{id}/review', OV, 'Review a break-glass access', {
    access: 'DIRECTOR',
    body: obj({ outcome: values(reviewOutcomeEnum), notes: text(5, 2000) }, ['outcome', 'notes']),
  }),
  op('get', '/stats/facility', OV, 'Statistics of my facility', { access: 'DIRECTOR, MINISTRY' }),
  op('get', '/stats/email', OV, 'Email delivery health', { access: 'MINISTRY' }),
  op('get', '/stats/sms', OV, 'SMS delivery health', { access: 'MINISTRY' }),

  // Administration
  op('post', '/facilities', ADM, 'Register a facility', {
    access: 'MINISTRY',
    body: obj(
      {
        code: str({ pattern: '^[A-Z0-9-]{2,32}$' }),
        name: text(2, 200),
        type: values(facilityTypeEnum),
        region: text(2, 100),
        municipality: text(2, 100),
        address: opt(300),
        phone: opt(40),
      },
      ['code', 'name', 'type', 'region', 'municipality'],
    ),
  }),
  op('get', '/facilities/{id}', ADM, 'One facility'),
  op('patch', '/facilities/{id}', ADM, 'Update or deactivate a facility', {
    access: 'MINISTRY',
    body: obj({
      code: str({ pattern: '^[A-Z0-9-]{2,32}$' }),
      name: text(2, 200),
      type: values(facilityTypeEnum),
      region: text(2, 100),
      municipality: text(2, 100),
      address: opt(300),
      phone: opt(40),
      isActive: bool,
    }),
  }),
  op('patch', '/staff/{id}/status', ADM, 'Activate or deactivate a staff account', {
    access: 'MINISTRY, DIRECTOR (own facility)',
    body: obj({ isActive: bool }, ['isActive']),
  }),
  op('get', '/openapi.json', ADM, 'This OpenAPI description', { auth: 'none' }),
];

const SUBJECT_REQUEST_KINDS = [
  'ACCESS',
  'RECTIFICATION',
  'RESTRICTION',
  'ERASURE',
  'OBJECTION',
  'PORTABILITY',
];
const patientRef = {
  patientId: uuid,
  nationalId: { ...text(5, 20), description: 'Alternative to patientId' },
};

CORE_OPERATIONS.push(
  // Data protection
  op('get', '/privacy/retention', DP, 'Retention policies by record category', {
    access: 'MINISTRY, DIRECTOR (read only)',
  }),
  {
    method: 'patch',
    path: '/privacy/retention/{category}',
    tag: DP,
    summary: 'Change a retention policy',
    auth: 'user',
    access: 'MINISTRY',
    params: [{ name: 'category', in: 'path', required: true, schema: opt(40) }],
    body: obj({
      retainDays: int({ minimum: 1, maximum: 36_500 }),
      legalBasis: text(10, 300),
      isActive: bool,
    }),
  },
  op('post', '/privacy/retention/preview', DP, 'Preview what retention would remove (dry run)', {
    access: 'MINISTRY, DIRECTOR',
  }),
  op('post', '/privacy/retention/run', DP, 'Run retention now', { access: 'MINISTRY' }),
  op('get', '/privacy/my-requests', DP, 'My data-protection requests', {
    access: 'PATIENT (own record, or guardian with full access)',
  }),
  op('post', '/privacy/my-requests', DP, 'Submit a data-protection request', {
    access: 'PATIENT (own record, or guardian with full access)',
    body: obj({ kind: enumOf(...SUBJECT_REQUEST_KINDS), details: opt(2000) }, ['kind']),
  }),
  op('get', '/privacy/requests', DP, 'Data-protection requests to handle', {
    access: 'MINISTRY, DIRECTOR (own facility)',
    params: [
      q('status', enumOf('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED')),
      q('kind', enumOf(...SUBJECT_REQUEST_KINDS)),
      q('overdue', enumOf('true', 'false')),
    ],
  }),
  op('post', '/privacy/requests', DP, 'Register a request received in person, by post or email', {
    access: 'MINISTRY, DIRECTOR',
    body: obj(
      {
        ...patientRef,
        kind: enumOf(...SUBJECT_REQUEST_KINDS),
        details: opt(2000),
        receivedVia: enumOf('IN_PERSON', 'POST', 'EMAIL'),
      },
      ['kind', 'receivedVia'],
    ),
  }),
  op('patch', '/privacy/requests/{id}', DP, 'Progress, complete or reject a request', {
    access: 'MINISTRY, DIRECTOR',
    body: obj({ status: enumOf('IN_PROGRESS', 'COMPLETED', 'REJECTED'), outcome: opt(2000) }, [
      'status',
    ]),
  }),
  op('get', '/privacy/holds', DP, 'Legal holds (suspend retention for a patient)', {
    access: 'MINISTRY, DIRECTOR',
    params: [q('active', enumOf('true', 'false'), 'Default true')],
  }),
  op('get', '/privacy/patients/{patientId}/holds', DP, 'Legal holds of a patient', {
    access: 'MINISTRY, DIRECTOR',
  }),
  op('post', '/privacy/holds', DP, 'Place a legal hold', {
    access: 'MINISTRY, DIRECTOR',
    body: obj({ ...patientRef, reason: text(10, 500) }, ['reason']),
  }),
  op('post', '/privacy/holds/{id}/release', DP, 'Release a legal hold', {
    access: 'MINISTRY, DIRECTOR',
    body: obj({ reason: text(5, 500) }, ['reason']),
  }),
  // Monitoring
  op('get', '/monitoring/health', MON, 'Health indicators (national or my facility)', {
    access: 'MINISTRY, DIRECTOR',
  }),
  op(
    'get',
    '/monitoring/audit-export',
    MON,
    'Export the audit trail for a SIEM (at most 31 days)',
    {
      access: 'MINISTRY',
      params: [
        { ...q('from', dateTime), required: true },
        { ...q('to', dateTime), required: true },
        q('format', enumOf('jsonl', 'cef'), 'JSON lines (default) or ArcSight CEF'),
      ],
      responses: { '200': 'application/x-ndjson or text/plain (CEF)' },
    },
  ),
);

CORE_OPERATIONS.push(
  // Dose rules (medication safety)
  op('get', '/safety/dose-rules', SAF, 'Dose limits by ingredient, route and age group', {
    access: 'staff',
    params: [
      q('q', opt(100)),
      q('ageGroup', enumOf(...AGE_GROUPS)),
      q('route', enumOf(...ROUTES.map((r) => r.toUpperCase()))),
      q('includeInactive', enumOf('true', 'false')),
      ...page,
    ],
  }),
  op('post', '/safety/dose-rules', SAF, 'Add a dose rule', {
    access: 'MINISTRY',
    body: obj(
      {
        ingredient: text(2, 100),
        route: enumOf(...ROUTES.map((r) => r.toUpperCase())),
        ageGroup: enumOf(...AGE_GROUPS),
        unit: enumOf('mg', 'g', 'mcg', 'IU', 'units'),
        perKg: bool,
        maxSingleDose: { ...num, exclusiveMinimum: 0 },
        maxDailyDose: { ...num, exclusiveMinimum: 0 },
        absoluteMaxDaily: { ...num, exclusiveMinimum: 0 },
        note: opt(300),
      },
      ['ingredient', 'ageGroup'],
    ),
  }),
  op('patch', '/safety/dose-rules/{id}', SAF, 'Change or deactivate a dose rule', {
    access: 'MINISTRY',
    body: obj({
      unit: enumOf('mg', 'g', 'mcg', 'IU', 'units'),
      perKg: bool,
      maxSingleDose: { ...num, exclusiveMinimum: 0 },
      maxDailyDose: { ...num, exclusiveMinimum: 0 },
      absoluteMaxDaily: { ...num, exclusiveMinimum: 0 },
      note: opt(300),
      isActive: bool,
    }),
  }),
  // Downtime
  op('get', '/downtime/status', DT, 'Downtime mode of my facility', {
    access: 'DIRECTOR, DOCTOR, NURSE, PHARMACIST, RECEPTION',
  }),
  op('post', '/downtime/start', DT, 'Declare downtime (switch to paper)', {
    access: 'DIRECTOR',
    body: obj({ note: opt(300) }),
  }),
  op('post', '/downtime/end', DT, 'End downtime', { access: 'DIRECTOR' }),
  op('get', '/downtime/packs', DT, 'Downtime packs of my facility', {
    access: 'DIRECTOR, DOCTOR, NURSE, RECEPTION',
  }),
  op('post', '/downtime/packs/generate', DT, 'Generate downtime packs now', {
    access: 'DIRECTOR',
    body: obj({ locale: enumOf('sq', 'sr', 'en') }),
  }),
  op('get', '/downtime/packs/{id}/download', DT, 'Download a downtime pack (HTML, audited)', {
    access: 'DIRECTOR, DOCTOR, NURSE, RECEPTION',
    responses: { '200': 'text/html attachment' },
  }),
  op('get', '/downtime/back-entry', DT, 'What to enter after downtime', {
    access: 'DIRECTOR, DOCTOR, NURSE',
  }),
  op('get', '/downtime/sync/latest', DT, 'Latest encrypted pack for a ward PC', {
    auth: 'none',
    description:
      'Authenticated with the facility’s downtime sync key (Authorization: Bearer dts_…), not a user session. The file is age-encrypted; only the ward PC can decrypt it.',
    responses: { '401': 'Invalid downtime sync key' },
  }),
);

// Report export: {report} is a report name, not an id, so it is described by hand.
const REPORTS = [
  'activity',
  'diagnoses',
  'medications',
  'pharmacy',
  'vaccinations',
  'referrals',
  'appointments',
  'workforce',
  'occupancy',
  'admissions',
  'emergency',
  'births',
  'imaging',
  'theatre',
  'billing',
];
CORE_OPERATIONS.push({
  method: 'get',
  path: '/reports/{report}/export',
  tag: OV,
  summary: 'Download a report as CSV',
  auth: 'user',
  access: 'MINISTRY, DIRECTOR (own facility)',
  params: [
    { name: 'report', in: 'path', required: true, schema: { type: 'string', examples: REPORTS } },
    q('from', date),
    q('to', date),
    q('region', opt(100)),
    q('facilityId', uuid),
  ],
  responses: { '200': 'text/csv' },
});
