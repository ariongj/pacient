import { bool, enumOf, int, num, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries for blood donors (/blood-donors). */
export const DONORS_TAGS = [
  {
    name: 'Blood donors',
    description: 'Blood donor register, eligibility, deferrals and donations.',
  },
];

const D = 'Blood donors';
const STAFF = 'DOCTOR, NURSE (blood bank unit staff)';
const ABO = enumOf('O', 'A', 'B', 'AB');
const RH = enumOf('POS', 'NEG');
const MARKER = enumOf('NEGATIVE', 'REACTIVE');
const answers = { type: 'object', additionalProperties: bool };
const measurements = obj({
  haemoglobin: num,
  systolic: int(),
  diastolic: int(),
  pulse: int(),
  weightKg: num,
});

export const DONORS_OPERATIONS: ModuleOperation[] = [
  op('get', '/blood-donors/me', D, 'Whether I work at a blood bank and may see donor statistics'),
  op('get', '/blood-donors/definitions', D, 'Donor questionnaire, eligibility limits and markers'),
  op('get', '/blood-donors/lookup', D, 'Find a person by national ID to register as a donor', {
    access: STAFF,
    params: [q('nationalId', str({ maxLength: 20 }))],
  }),
  op('get', '/blood-donors/donors', D, 'Search donors (national ID, or name at my blood bank)', {
    access: STAFF,
    params: [q('q', str({ maxLength: 100 }))],
  }),
  op('post', '/blood-donors/donors', D, 'Register a blood donor (18–65, first donation ≤ 60)', {
    access: STAFF,
    body: obj({ patientId: uuid, contactConsent: bool }, ['patientId']),
  }),
  op('get', '/blood-donors/donors/{id}', D, 'Donor record with donations and test status', {
    access: STAFF,
  }),
  op('patch', '/blood-donors/donors/{id}', D, 'Change contact consent, defer or lift a deferral', {
    access: `${STAFF}; lifting a permanent deferral: blood bank DOCTOR`,
    body: obj({
      contactConsent: bool,
      defer: obj({ days: int(), permanent: bool, reason: str() }, ['reason']),
      lift: obj({ reason: str() }, ['reason']),
    }),
  }),
  op(
    'post',
    '/blood-donors/donors/{id}/eligibility',
    D,
    'Live eligibility check (nothing stored)',
    {
      access: STAFF,
      body: obj({ answers, measurements }),
    },
  ),
  op('post', '/blood-donors/donors/{id}/donations', D, 'Record a donation visit', {
    access: STAFF,
    body: obj(
      {
        answers,
        medications: str(),
        measurements,
        outcome: enumOf('COMPLETED', 'DEFERRED', 'ABORTED'),
        volumeMl: int(),
        manualDeferral: obj({ days: int(), reason: str() }, ['days', 'reason']),
        adverseReaction: str(),
      },
      ['answers', 'measurements', 'outcome'],
    ),
    responses: { '409': 'The donor is not eligible today (NOT_ELIGIBLE, with the problems)' },
  }),
  op('post', '/blood-donors/donations/{id}/adverse-reaction', D, 'Add a reaction after donation', {
    access: STAFF,
    body: obj({ description: str({ maxLength: 300 }) }, ['description']),
  }),
  op(
    'post',
    '/blood-donors/donations/{id}/tests',
    D,
    'Record mandatory tests and release the unit',
    {
      access: STAFF,
      description:
        'All markers negative: the whole-blood unit enters stock. Any reactive marker: the unit is ' +
        'discarded, the donor permanently deferred and the blood bank doctors asked to counsel them.',
      body: obj(
        {
          abo: ABO,
          rhD: RH,
          hiv: MARKER,
          hbv: MARKER,
          hcv: MARKER,
          syphilis: MARKER,
          labReference: str({ maxLength: 60 }),
        },
        ['abo', 'rhD', 'hiv', 'hbv', 'hcv', 'syphilis'],
      ),
    },
  ),
  op('get', '/blood-donors/donations/{id}/tests', D, 'Screening results of a donation', {
    access: STAFF,
    description:
      'The individual marker results and the confirmed group (blood bank staff of the facility ' +
      'only; the view is recorded in the donor’s access log).',
    responses: { '404': 'No results recorded yet' },
  }),
  op('get', '/blood-donors/today', D, "Today's donor visits at my blood bank", { access: STAFF }),
  op('get', '/blood-donors/testing-queue', D, 'Donations waiting for their mandatory tests', {
    access: STAFF,
  }),
  op('get', '/blood-donors/deferrals', D, 'Deferred donors of my blood bank', { access: STAFF }),
  op('post', '/blood-donors/appeals', D, 'Ask eligible, consenting donors of a group to donate', {
    access: STAFF,
    description: 'At most one appeal per donor every 4 weeks.',
    body: obj({ abo: ABO, rhD: RH }, ['abo']),
  }),
  op('get', '/blood-donors/mine', D, 'My blood donor card', {
    access: 'PATIENT (not as guardian)',
  }),
  op('patch', '/blood-donors/mine', D, 'Agree or refuse to be asked to donate', {
    access: 'PATIENT (not as guardian)',
    body: obj({ contactConsent: bool }, ['contactConsent']),
  }),
  op('get', '/blood-donors/stats', D, 'Donor statistics (months, deferral reasons, retention)', {
    access: 'DIRECTOR (own facility), MINISTRY (national), blood bank staff',
  }),
];
