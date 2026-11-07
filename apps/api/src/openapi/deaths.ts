import {
  arr,
  bool,
  date,
  dateTime,
  enumOf,
  int,
  obj,
  op,
  q,
  str,
  uuid,
  type ModuleOperation,
} from './modules.js';

/** OpenAPI entries for death registration (/deaths and the civil registry feed). */
export const DEATHS_TAGS = [
  {
    name: 'Death registration',
    description: 'Medical certificates of cause of death, mortality statistics.',
  },
];

const D = 'Death registration';
const P = 'Partner API';

const cause = obj(
  {
    line: enumOf('a', 'b', 'c', 'd', 'II'),
    text: str({ minLength: 2, maxLength: 300 }),
    icd10: str({ pattern: '^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,2})?$' }),
    interval: str({ maxLength: 50 }),
  },
  ['line', 'text'],
);

const deathFields = obj(
  {
    diedAt: dateTime,
    placeOfDeath: enumOf(
      'HOSPITAL',
      'EMERGENCY_DEPARTMENT',
      'HOME',
      'NURSING_HOME',
      'EN_ROUTE',
      'OTHER',
    ),
    placeDetail: str({ maxLength: 200 }),
    admissionId: uuid,
    causes: arr(cause, { minItems: 1, maxItems: 10 }),
    underlyingCauseIcd10: str({ pattern: '^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,2})?$' }),
    mannerOfDeath: enumOf(
      'NATURAL',
      'ACCIDENT',
      'INTENTIONAL_SELF_HARM',
      'ASSAULT',
      'PENDING_INVESTIGATION',
      'UNDETERMINED',
    ),
    autopsy: enumOf('NONE', 'REQUESTED', 'PENDING', 'PERFORMED'),
    pregnancyStatus: enumOf(
      'NOT_PREGNANT',
      'PREGNANT',
      'WITHIN_42_DAYS',
      'DAYS_43_TO_1_YEAR',
      'UNKNOWN',
    ),
    perinatal: obj({
      birthWeightGrams: int({ minimum: 100, maximum: 7000 }),
      gestationWeeks: int({ minimum: 16, maximum: 45 }),
      multiplePregnancy: bool,
      stillbirth: bool,
      hoursSurvived: int({ minimum: 0 }),
      maternalConditions: str({ maxLength: 500 }),
    }),
    reportedToForensics: bool,
  },
  ['diedAt', 'placeOfDeath', 'causes', 'underlyingCauseIcd10', 'mannerOfDeath'],
);

const acknowledge = op(
  'post',
  '/partner/deaths/{certificateNumber}/acknowledge',
  P,
  'Confirm that the civil registry registered a death',
  {
    auth: 'partner',
    access: 'deaths.read',
    body: obj({ reference: str({ minLength: 1, maxLength: 60 }) }, ['reference']),
  },
);
acknowledge.params = acknowledge.params?.map((p) =>
  p.name === 'certificateNumber'
    ? { ...p, schema: str({ pattern: '^VD-\\d{4}-\\d{6}$' }), description: 'e.g. VD-2026-000123' }
    : p,
);

const byNumber = op(
  'get',
  '/deaths/by-number/{number}',
  D,
  'Find a death certificate by its number',
  {
    access: 'MINISTRY',
    description: 'Identity, dates and status only (no causes). Audited for the person.',
  },
);
byNumber.params = byNumber.params?.map((p) =>
  p.name === 'number'
    ? { ...p, schema: str({ pattern: '^VD-\\d{4}-\\d{6}$' }), description: 'e.g. VD-2026-000123' }
    : p,
);

export const DEATHS_OPERATIONS: ModuleOperation[] = [
  op('get', '/deaths', D, 'Death certificates of my facility (no causes)', {
    access: 'DOCTOR, DIRECTOR',
    params: [
      q('status', enumOf('DRAFT', 'SIGNED')),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('get', '/deaths/stats', D, 'Mortality statistics (small cells suppressed)', {
    access: 'DIRECTOR (own facility), MINISTRY (national)',
    params: [q('from', date), q('to', date), q('facilityId', uuid)],
  }),
  op('get', '/deaths/patients/{patientId}', D, 'The patient’s death certificate', {
    access: 'DOCTOR, NURSE (care team)',
  }),
  op('post', '/deaths/patients/{patientId}', D, 'Start a draft death certificate', {
    access: 'DOCTOR (care team)',
    body: deathFields,
  }),
  op('patch', '/deaths/{id}', D, 'Edit a draft death certificate', {
    access: 'DOCTOR (care team)',
    body: deathFields,
  }),
  op('delete', '/deaths/{id}', D, 'Discard a draft death certificate', {
    access: 'DOCTOR (care team)',
  }),
  op('post', '/deaths/{id}/sign', D, 'Sign the death certificate', {
    access: 'DOCTOR (care team)',
    description:
      'Assigns the certificate number, records the death and cancels future appointments, waiting-list entries and register recalls. Refused while the patient is still admitted. Warnings must be acknowledged.',
    body: obj({ acknowledgedWarnings: arr(str()) }),
  }),
  op('post', '/deaths/{id}/amendments', D, 'Amend a signed death certificate', {
    access: 'DOCTOR (care team)',
    body: obj(
      {
        changes: obj({}),
        reason: str({ minLength: 10, maxLength: 500 }),
      },
      ['changes', 'reason'],
    ),
  }),
  byNumber,
  op('post', '/deaths/{id}/withdraw', D, 'Withdraw a death certificate issued in error', {
    access: 'MINISTRY',
    description:
      'The person is no longer recorded as deceased; register membership and waiting-list entries ended because of the death are restored; cancelled appointments are not. The civil registry sees the withdrawal in its feed.',
    body: obj(
      { reason: str({ minLength: 20, maxLength: 500 }), restorePortal: { type: 'boolean' } },
      ['reason'],
    ),
  }),
  op('get', '/partner/deaths', P, 'Signed death certificates for the civil registry (no causes)', {
    auth: 'partner',
    access: 'deaths.read',
    params: [q('since', dateTime)],
  }),
  acknowledge,
];
