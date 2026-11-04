/**
 * OpenAPI 3.1 description of the Pacient API. It is built from the registry below (kept next to
 * the code it describes) and served publicly at /api/v1/openapi.json and
 * /api/v1/partner/openapi.json – it describes endpoints only and contains no data.
 *
 * Request bodies are given as JSON Schema; the authoritative validation is the Zod schema in each
 * route. When adding an endpoint, add it here too.
 */
import { CORE_OPERATIONS, CORE_TAGS } from './core.js';
import { MODULE_OPERATIONS, MODULE_TAGS } from './modules.js';

type Schema = Record<string, unknown>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Auth = 'user' | 'partner' | 'lab' | 'none';

interface Param {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: Schema;
}

interface Operation {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: Auth;
  /** Roles (user auth) or scope (partner auth). */
  access?: string;
  params?: Param[];
  body?: Schema;
  bodyType?: string;
  responses?: Record<string, string>;
}

const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
const int = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra });
const bool: Schema = { type: 'boolean' };
const uuid: Schema = { type: 'string', format: 'uuid' };
const date: Schema = { type: 'string', format: 'date' };
const dateTime: Schema = { type: 'string', format: 'date-time' };
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const enumOf = (...values: string[]): Schema => ({ type: 'string', enum: values });
const pathId = (name = 'id'): Param => ({ name, in: 'path', required: true, schema: uuid });
const patientPath: Param = {
  name: 'patientId',
  in: 'path',
  required: true,
  schema: uuid,
  description: 'Patient record id',
};
const page: Param[] = [
  { name: 'page', in: 'query', schema: int({ minimum: 1 }) },
  { name: 'pageSize', in: 'query', schema: int({ minimum: 1, maximum: 100 }) },
];
const purposeHeaders: Param[] = [
  {
    name: 'X-Purpose-Of-Use',
    in: 'header',
    required: true,
    schema: enumOf('TREATMENT', 'PAYMENT', 'PUBLIC_HEALTH'),
    description:
      'Why the data is requested. Content is limited to what the purpose needs: TREATMENT – the record as the patient sees it (never confidential visits); PAYMENT – identification, encounters/stays and diagnosis codes only; PUBLIC_HEALTH – identification, diagnoses, vaccinations, released laboratory results.',
  },
  {
    name: 'X-Requesting-Practitioner',
    in: 'header',
    schema: str({ maxLength: 200 }),
    description: 'Required for TREATMENT: name/licence of the clinician on whose behalf you ask.',
  },
];

export const TAGS: { name: string; description: string }[] = [
  { name: 'Authentication', description: 'Sign-in, sessions, two-step verification, preferences.' },
  { name: 'Patients', description: 'Registration, demographics, care teams.' },
  { name: 'Clinical record', description: 'Visits, diagnoses, prescriptions, results, vitals…' },
  { name: 'Laboratory', description: 'Lab orders and the HL7 v2 laboratory interface.' },
  { name: 'Hospital', description: 'Wards, beds, admissions, transfers and discharge.' },
  { name: 'Emergency department', description: 'Arrivals, triage and the emergency board.' },
  { name: 'Imaging', description: 'Radiology orders, worklist and reports.' },
  { name: 'Identity', description: 'Temporary identities, newborn registration, merges.' },
  { name: 'Portal', description: 'Patient portal: access log, contact details, dependants.' },
  {
    name: 'Collaboration',
    description: 'Messages, referrals, care tasks, channels, notifications.',
  },
  { name: 'Oversight', description: 'Reports, statistics, audit, emergency-access review.' },
  { name: 'Administration', description: 'Facilities, staff, lab connections, partner systems.' },
  ...CORE_TAGS,
  ...MODULE_TAGS,
  { name: 'FHIR', description: 'HL7 FHIR R4 export for authorised staff and patients.' },
  {
    name: 'Partner API',
    description:
      'For external systems (insurance fund, civil registry, other hospitals, public health) with a scoped API key. Every call is audited and visible to the patient.',
  },
];

const OPERATIONS: Operation[] = [
  // Authentication
  {
    method: 'post',
    path: '/auth/login',
    tag: 'Authentication',
    summary: 'Sign in with email and password',
    auth: 'none',
    body: obj({ email: str({ format: 'email' }), password: str() }, ['email', 'password']),
    responses: { '200': 'Access token, or { mfaRequired, mfaToken } for two-step sign-in' },
  },
  {
    method: 'post',
    path: '/auth/mfa/verify',
    tag: 'Authentication',
    summary: 'Second step of sign-in',
    auth: 'none',
    body: obj({ mfaToken: str(), code: str(), recoveryCode: str() }, ['mfaToken']),
  },
  {
    method: 'post',
    path: '/auth/refresh',
    tag: 'Authentication',
    summary: 'New access token from the refresh cookie',
    auth: 'none',
  },
  {
    method: 'post',
    path: '/auth/logout',
    tag: 'Authentication',
    summary: 'Sign out',
    auth: 'none',
  },
  { method: 'get', path: '/auth/me', tag: 'Authentication', summary: 'Current user', auth: 'user' },
  {
    method: 'patch',
    path: '/auth/me/preferences',
    tag: 'Authentication',
    summary: 'Notification and language preferences',
    auth: 'user',
    body: obj({
      emailNotifications: enumOf('ALL', 'IMPORTANT', 'OFF'),
      smsNotifications: enumOf('IMPORTANT', 'OFF'),
      locale: enumOf('sq', 'en', 'sr'),
    }),
  },
  {
    method: 'post',
    path: '/auth/me/phone',
    tag: 'Authentication',
    summary: 'Send a verification code to a mobile number',
    auth: 'user',
    body: obj({ phone: str() }, ['phone']),
  },
  {
    method: 'post',
    path: '/auth/forgot-password',
    tag: 'Authentication',
    summary: 'Email a password-reset link',
    auth: 'none',
    body: obj({ email: str({ format: 'email' }) }, ['email']),
  },
  // Patients
  {
    method: 'get',
    path: '/patients',
    tag: 'Patients',
    summary: 'Search patients you may see',
    auth: 'user',
    params: [{ name: 'q', in: 'query', schema: str() }, ...page],
  },
  {
    method: 'post',
    path: '/patients',
    tag: 'Patients',
    summary: 'Register a patient',
    auth: 'user',
    access: 'DOCTOR, RECEPTION, DIRECTOR',
  },
  {
    method: 'get',
    path: '/patients/{id}',
    tag: 'Patients',
    summary: 'Demographics',
    auth: 'user',
    params: [pathId()],
  },
  {
    method: 'get',
    path: '/patients/{id}/care-team',
    tag: 'Patients',
    summary: 'Care team',
    auth: 'user',
    params: [pathId()],
  },
  {
    method: 'post',
    path: '/patients/{id}/emergency-access',
    tag: 'Patients',
    summary: 'Break-glass access (audited, reviewed)',
    auth: 'user',
    access: 'DOCTOR',
    params: [pathId()],
    body: obj({ reason: str({ minLength: 10 }) }, ['reason']),
  },
  // Clinical record
  ...(
    [
      ['summary', 'Clinical summary'],
      ['encounters', 'Visits'],
      ['diagnoses', 'Diagnoses'],
      ['prescriptions', 'Prescriptions'],
      ['allergies', 'Allergies'],
      ['vitals', 'Vital signs'],
      ['lab-results', 'Laboratory results'],
      ['immunizations', 'Vaccinations'],
      ['export', 'Full record export (JSON)'],
    ] as const
  ).map(([section, summary]): Operation => ({
    method: 'get',
    path: `/patients/{patientId}/${section}`,
    tag: 'Clinical record',
    summary,
    auth: 'user',
    access: 'care team, patient, guardian',
    params: [patientPath],
  })),
  {
    method: 'post',
    path: '/patients/{patientId}/encounters',
    tag: 'Clinical record',
    summary: 'Start a visit (draft note)',
    auth: 'user',
    access: 'DOCTOR',
    params: [patientPath],
  },
  {
    method: 'post',
    path: '/patients/{patientId}/encounters/{entryId}/sign',
    tag: 'Clinical record',
    summary: 'Sign a note (immutable afterwards; corrections as addenda)',
    auth: 'user',
    access: 'DOCTOR',
    params: [patientPath, pathId('entryId')],
    body: obj({ version: int({ minimum: 1 }) }, ['version']),
    responses: { '409': 'The note changed since it was loaded (version mismatch)' },
  },
  {
    method: 'post',
    path: '/patients/{patientId}/lab-results/{entryId}/acknowledge',
    tag: 'Clinical record',
    summary: 'Acknowledge a result',
    auth: 'user',
    access: 'DOCTOR',
    params: [patientPath, pathId('entryId')],
  },
  {
    method: 'get',
    path: '/patients/{patientId}/documents',
    tag: 'Clinical record',
    summary: 'Documents (metadata)',
    auth: 'user',
    params: [patientPath],
  },
  {
    method: 'post',
    path: '/patients/{patientId}/documents',
    tag: 'Clinical record',
    summary: 'Upload a PDF/JPEG/PNG (≤ 10 MiB)',
    auth: 'user',
    params: [
      patientPath,
      { name: 'category', in: 'query', required: true, schema: str() },
      { name: 'title', in: 'query', required: true, schema: str() },
    ],
    bodyType: 'application/pdf',
  },
  {
    method: 'get',
    path: '/patients/{patientId}/consents',
    tag: 'Clinical record',
    summary: 'Consent decisions and history',
    auth: 'user',
    params: [patientPath],
  },
  {
    method: 'get',
    path: '/worklist',
    tag: 'Clinical record',
    summary: "Doctor's worklist",
    auth: 'user',
    access: 'DOCTOR',
  },
  // Laboratory
  {
    method: 'get',
    path: '/lab-catalog',
    tag: 'Laboratory',
    summary: 'Orderable tests (LOINC)',
    auth: 'user',
  },
  {
    method: 'post',
    path: '/patients/{patientId}/lab-orders',
    tag: 'Laboratory',
    summary: 'Order a laboratory test',
    auth: 'user',
    access: 'DOCTOR',
    params: [patientPath],
    body: obj(
      { testCode: str(), priority: enumOf('ROUTINE', 'URGENT', 'STAT'), clinicalNotes: str() },
      ['testCode', 'priority'],
    ),
  },
  {
    method: 'get',
    path: '/integrations/lab/orders',
    tag: 'Laboratory',
    summary: 'New orders for the laboratory (JSON or ?format=hl7 ORM^O01)',
    auth: 'lab',
  },
  {
    method: 'post',
    path: '/integrations/lab/orders/{placer}/receive',
    tag: 'Laboratory',
    summary: 'Confirm receipt of an order',
    auth: 'lab',
    params: [{ name: 'placer', in: 'path', required: true, schema: str() }],
  },
  {
    method: 'post',
    path: '/integrations/lab/results',
    tag: 'Laboratory',
    summary: 'Post HL7 v2 ORU^R01 results; answered with an HL7 ACK',
    auth: 'lab',
    bodyType: 'application/hl7-v2',
  },
  // Hospital
  {
    method: 'get',
    path: '/hospital/units',
    tag: 'Hospital',
    summary: 'Wards and units with beds',
    auth: 'user',
  },
  { method: 'get', path: '/hospital/board', tag: 'Hospital', summary: 'Bed board', auth: 'user' },
  {
    method: 'post',
    path: '/hospital/admissions',
    tag: 'Hospital',
    summary: 'Admit a patient to a ward/bed',
    auth: 'user',
    access: 'DOCTOR',
  },
  {
    method: 'post',
    path: '/hospital/admissions/{id}/transfer',
    tag: 'Hospital',
    summary: 'Transfer to another bed or unit',
    auth: 'user',
    params: [pathId()],
  },
  {
    method: 'post',
    path: '/hospital/admissions/{id}/discharge',
    tag: 'Hospital',
    summary: 'Discharge with a signed summary',
    auth: 'user',
    access: 'DOCTOR',
    params: [pathId()],
  },
  // Emergency
  {
    method: 'get',
    path: '/ed/board',
    tag: 'Emergency department',
    summary: 'Emergency board',
    auth: 'user',
  },
  {
    method: 'post',
    path: '/ed/arrivals',
    tag: 'Emergency department',
    summary: 'Register an arrival',
    auth: 'user',
    access: 'RECEPTION, NURSE, DOCTOR',
  },
  {
    method: 'post',
    path: '/ed/visits/{id}/triage',
    tag: 'Emergency department',
    summary: 'Triage (levels 1–5)',
    auth: 'user',
    access: 'NURSE, DOCTOR',
    params: [pathId()],
  },
  // Imaging
  {
    method: 'get',
    path: '/imaging/worklist',
    tag: 'Imaging',
    summary: 'Radiology worklist',
    auth: 'user',
  },
  {
    method: 'post',
    path: '/imaging/orders',
    tag: 'Imaging',
    summary: 'Order an imaging study',
    auth: 'user',
    access: 'DOCTOR',
  },
  {
    method: 'post',
    path: '/imaging/orders/{id}/report',
    tag: 'Imaging',
    summary: 'Sign a radiology report',
    auth: 'user',
    access: 'DOCTOR (radiology)',
    params: [pathId()],
  },
  // Identity
  {
    method: 'post',
    path: '/identity/temporary',
    tag: 'Identity',
    summary: 'Register an unidentified patient (temporary number)',
    auth: 'user',
  },
  {
    method: 'post',
    path: '/identity/{patientId}/confirm',
    tag: 'Identity',
    summary: 'Confirm the real identity of a temporary record',
    auth: 'user',
    params: [patientPath],
  },
  {
    method: 'post',
    path: '/identity/births',
    tag: 'Identity',
    summary: 'Register a birth (creates the newborn)',
    auth: 'user',
  },
  {
    method: 'get',
    path: '/patient-merges/candidates',
    tag: 'Identity',
    summary: 'Likely duplicate records',
    auth: 'user',
    access: 'DIRECTOR',
  },
  {
    method: 'post',
    path: '/patient-merges',
    tag: 'Identity',
    summary: 'Merge a duplicate record',
    auth: 'user',
    access: 'DIRECTOR',
  },
  // Portal
  {
    method: 'get',
    path: '/portal/access-log',
    tag: 'Portal',
    summary: 'Who viewed my record',
    auth: 'user',
    access: 'PATIENT',
    params: page,
  },
  {
    method: 'get',
    path: '/portal/dependants',
    tag: 'Portal',
    summary: 'Children I am guardian of',
    auth: 'user',
    access: 'PATIENT',
  },
  {
    method: 'patch',
    path: '/portal/contact',
    tag: 'Portal',
    summary: 'Update my contact details',
    auth: 'user',
    access: 'PATIENT',
  },
  // Collaboration
  {
    method: 'get',
    path: '/notifications',
    tag: 'Collaboration',
    summary: 'My notifications',
    auth: 'user',
    params: page,
  },
  {
    method: 'get',
    path: '/messages/threads',
    tag: 'Collaboration',
    summary: 'Patient–clinician message threads',
    auth: 'user',
  },
  { method: 'get', path: '/referrals', tag: 'Collaboration', summary: 'Referrals', auth: 'user' },
  {
    method: 'post',
    path: '/referrals',
    tag: 'Collaboration',
    summary: 'Refer to another facility',
    auth: 'user',
    access: 'DOCTOR',
  },
  { method: 'get', path: '/care-tasks', tag: 'Collaboration', summary: 'Care tasks', auth: 'user' },
  {
    method: 'get',
    path: '/channels',
    tag: 'Collaboration',
    summary: 'Team channels',
    auth: 'user',
  },
  {
    method: 'post',
    path: '/events/ticket',
    tag: 'Collaboration',
    summary: 'Ticket for the live event stream (SSE)',
    auth: 'user',
  },
  // Oversight
  {
    method: 'get',
    path: '/reports/{report}',
    tag: 'Oversight',
    summary: 'Aggregate report (small cells suppressed)',
    auth: 'user',
    access: 'DIRECTOR, MINISTRY',
    params: [{ name: 'report', in: 'path', required: true, schema: str() }],
  },
  {
    method: 'get',
    path: '/stats/national',
    tag: 'Oversight',
    summary: 'National statistics',
    auth: 'user',
    access: 'MINISTRY',
  },
  {
    method: 'get',
    path: '/audit-logs',
    tag: 'Oversight',
    summary: 'Audit trail',
    auth: 'user',
    access: 'DIRECTOR, MINISTRY',
    params: page,
  },
  {
    method: 'get',
    path: '/emergency-access',
    tag: 'Oversight',
    summary: 'Emergency accesses to review',
    auth: 'user',
    access: 'DIRECTOR, MINISTRY',
  },
  // Administration
  {
    method: 'get',
    path: '/facilities',
    tag: 'Administration',
    summary: 'Facilities',
    auth: 'user',
  },
  {
    method: 'get',
    path: '/staff',
    tag: 'Administration',
    summary: 'Staff accounts',
    auth: 'user',
    access: 'DIRECTOR, MINISTRY',
  },
  {
    method: 'post',
    path: '/staff/invitations',
    tag: 'Administration',
    summary: 'Invite a staff member',
    auth: 'user',
    access: 'DIRECTOR, MINISTRY',
  },
  {
    method: 'get',
    path: '/integrations/clients',
    tag: 'Administration',
    summary: 'Laboratory connections',
    auth: 'user',
    access: 'DIRECTOR',
  },
  {
    method: 'get',
    path: '/partner/clients',
    tag: 'Administration',
    summary: 'Partner systems',
    auth: 'user',
    access: 'MINISTRY',
  },
  {
    method: 'post',
    path: '/partner/clients',
    tag: 'Administration',
    summary: 'Register a partner system (the key is shown once)',
    auth: 'user',
    access: 'MINISTRY',
    body: obj(
      {
        name: str({ minLength: 3, maxLength: 120 }),
        organisation: str({ minLength: 3, maxLength: 200 }),
        scopes: {
          type: 'array',
          items: enumOf(
            'fhir.patient.read',
            'stats.read',
            'directory.read',
            'births.notify',
            'claims.read',
            'surveillance.read',
          ),
          minItems: 1,
        },
        allowedIps: { type: 'array', items: str(), maxItems: 20 },
      },
      ['name', 'organisation', 'scopes'],
    ),
    responses: { '201': 'The new client including apiKey (only now)' },
  },
  {
    method: 'post',
    path: '/partner/clients/{id}/revoke',
    tag: 'Administration',
    summary: 'Revoke a partner key',
    auth: 'user',
    access: 'MINISTRY',
    params: [pathId()],
  },
  {
    method: 'get',
    path: '/partner/clients/{id}/usage',
    tag: 'Administration',
    summary: 'Calls per day and scope (30 days)',
    auth: 'user',
    access: 'MINISTRY',
    params: [pathId()],
  },
  // FHIR (staff and patients)
  {
    method: 'get',
    path: '/fhir/metadata',
    tag: 'FHIR',
    summary: 'CapabilityStatement',
    auth: 'none',
  },
  {
    method: 'get',
    path: '/fhir/Patient/{id}',
    tag: 'FHIR',
    summary: 'Patient resource',
    auth: 'user',
    params: [pathId()],
  },
  {
    method: 'get',
    path: '/fhir/Patient/{id}/$everything',
    tag: 'FHIR',
    summary: 'The whole record as a FHIR Bundle',
    auth: 'user',
    params: [pathId()],
  },
  // Partner API
  {
    method: 'get',
    path: '/partner/openapi.json',
    tag: 'Partner API',
    summary: 'This document',
    auth: 'none',
  },
  {
    method: 'get',
    path: '/partner/ping',
    tag: 'Partner API',
    summary: 'Check the key and see its scopes',
    auth: 'partner',
  },
  {
    method: 'get',
    path: '/partner/fhir/metadata',
    tag: 'Partner API',
    summary: 'FHIR CapabilityStatement',
    auth: 'partner',
  },
  {
    method: 'get',
    path: '/partner/fhir/Patient',
    tag: 'Partner API',
    summary: 'Find a patient by national ID',
    auth: 'partner',
    access: 'fhir.patient.read',
    params: [
      {
        name: 'identifier',
        in: 'query',
        required: true,
        schema: str(),
        description: 'urn:pacient:national-id|1234567890 or just the number',
      },
      ...purposeHeaders,
    ],
    responses: {
      '200': 'FHIR Bundle (searchset) with a minimal Patient, or empty',
      '403': 'CONSENT_WITHDRAWN – the patient does not share their record',
    },
  },
  {
    method: 'get',
    path: '/partner/fhir/Patient/{id}/$everything',
    tag: 'Partner API',
    summary: 'Record for the stated purpose of use',
    auth: 'partner',
    access: 'fhir.patient.read',
    params: [pathId(), ...purposeHeaders],
    responses: {
      '200': 'FHIR Bundle limited to the purpose',
      '403': 'CONSENT_WITHDRAWN',
      '409': 'PATIENT_MERGED – use the record in details.mergedIntoId',
    },
  },
  {
    method: 'get',
    path: '/partner/stats/national',
    tag: 'Partner API',
    summary: 'National aggregates (small cells suppressed)',
    auth: 'partner',
    access: 'stats.read',
  },
  {
    method: 'get',
    path: '/partner/directory/facilities',
    tag: 'Partner API',
    summary: 'Public directory of facilities',
    auth: 'partner',
    access: 'directory.read',
  },
  {
    method: 'get',
    path: '/partner/directory/practitioners',
    tag: 'Partner API',
    summary: 'Public directory of practitioners (no contact details)',
    auth: 'partner',
    access: 'directory.read',
    params: [
      { name: 'facility', in: 'query', schema: str(), description: 'Facility code' },
      { name: 'role', in: 'query', schema: enumOf('DOCTOR', 'NURSE', 'PHARMACIST') },
    ],
  },
  {
    method: 'get',
    path: '/partner/births',
    tag: 'Partner API',
    summary: 'Births awaiting civil registration',
    auth: 'partner',
    access: 'births.notify',
    params: [{ name: 'since', in: 'query', schema: dateTime, description: 'Default: 90 days ago' }],
  },
  {
    method: 'post',
    path: '/partner/births/{birthId}/registration',
    tag: 'Partner API',
    summary: 'Report the national ID issued for a newborn',
    auth: 'partner',
    access: 'births.notify',
    params: [pathId('birthId')],
    body: obj(
      {
        nationalId: str({ pattern: '^[0-9]{10}$' }),
        firstName: str({ maxLength: 100 }),
        lastName: str({ maxLength: 100 }),
      },
      ['nationalId', 'firstName'],
    ),
    responses: { '200': 'Registered', '409': 'IDENTITY_EXISTS or already registered' },
  },
];

OPERATIONS.push(...CORE_OPERATIONS, ...MODULE_OPERATIONS);

export function partnerOperations() {
  return OPERATIONS.filter((o) => o.auth === 'partner');
}

const SECURITY: Record<Auth, Record<string, string[]>[]> = {
  user: [{ userBearer: [] }],
  partner: [{ partnerKey: [] }],
  lab: [{ labKey: [] }],
  none: [],
};

const errorSchema: Schema = obj(
  { error: obj({ code: str(), message: str(), details: {} }, ['code', 'message']) },
  ['error'],
);

export function openApiDocument(serverUrl = '/api/v1') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const responses: Record<string, unknown> = {
      '200': { description: 'OK' },
      ...Object.fromEntries(
        Object.entries(op.responses ?? {}).map(([code, description]) => [code, { description }]),
      ),
    };
    if (op.auth !== 'none') {
      responses['401'] ??= {
        description: 'Missing or invalid credentials',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
      responses['403'] ??= {
        description: 'Not permitted',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
    }
    const entry: Record<string, unknown> = {
      tags: [op.tag],
      summary: op.summary,
      description:
        [
          op.description,
          op.access ? `${op.auth === 'partner' ? 'Scope' : 'Access'}: ${op.access}` : undefined,
        ]
          .filter(Boolean)
          .join('\n\n') || undefined,
      operationId: `${op.method}${op.path.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string) => (c ? c.toUpperCase() : ''))}`,
      security: SECURITY[op.auth],
      parameters: op.params,
      requestBody: op.body
        ? { required: true, content: { 'application/json': { schema: op.body } } }
        : op.bodyType
          ? {
              required: true,
              content: { [op.bodyType]: { schema: { type: 'string', format: 'binary' } } },
            }
          : undefined,
      responses,
    };
    if (op.access) entry['x-access'] = op.access;
    (paths[op.path] ??= {})[op.method] = Object.fromEntries(
      Object.entries(entry).filter(([, v]) => v !== undefined),
    );
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Pacient API',
      version: '1.0.0',
      summary: 'National electronic health record – Kosovo',
      description:
        'One API over one database for every part of Pacient. Staff and patients use a short-lived bearer token from /auth/login; laboratories and partner systems use a scoped API key (Authorization: Bearer pk_…). Clinical data is only returned to callers with a legitimate relationship or stated purpose, respects the patient\'s consent and is audited. Errors use { "error": { "code", "message", "details" } }. Rate limits: 300 requests/minute per user or key (stricter on sign-in).',
      contact: { name: 'Ministry of Health – Pacient' },
    },
    servers: [{ url: serverUrl }],
    tags: TAGS,
    paths,
    components: {
      securitySchemes: {
        userBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Access token from POST /auth/login (15 minutes; refreshed with the cookie).',
        },
        partnerKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Partner API key (pk_…) issued by the Ministry with specific scopes.',
        },
        labKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Laboratory system key (pk_…) issued by the facility director.',
        },
      },
      schemas: {
        Error: errorSchema,
        Date: date,
        Boolean: bool,
      },
    },
  };
}
