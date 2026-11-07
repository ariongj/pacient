import { dateTime, enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';
import { PROGRAMME_CODES, RESULTS, TEST_TYPES } from '../modules/screening/definitions.js';

/** OpenAPI entries for cancer screening (/screening). */
export const SCREENING_TAGS = [
  {
    name: 'Cancer screening',
    description: 'Cervical, breast and colorectal screening programmes.',
  },
];

const S = 'Cancer screening';
const programme = enumOf(...PROGRAMME_CODES);
const reason = str({ minLength: 3, maxLength: 300 });
const date = str({ format: 'date' });
const careTeam = 'DOCTOR, NURSE (care team)';
const doctor = 'DOCTOR (care team)';

const OPERATIONS: ModuleOperation[] = [
  op('get', '/screening/programmes', S, 'Screening programmes, intervals and rules'),
  op('get', '/screening/patients/{patientId}', S, 'A patient’s screening programmes and history', {
    access: careTeam,
  }),
  op('post', '/screening/patients/{patientId}/invitations', S, 'Invite a patient now', {
    access: careTeam,
    description:
      'Also reinstates a programme that was ceased. Refused while an episode is open, after an opt-out or outside the age and sex range.',
    body: obj({ programme }, ['programme']),
  }),
  op('post', '/screening/patients/{patientId}/cease', S, 'Cease a programme for clinical reasons', {
    access: doctor,
    description:
      'E.g. after a total hysterectomy. No invitations follow until a doctor invites again.',
    body: obj({ programme, reason }, ['programme', 'reason']),
  }),
  op('post', '/screening/patients/{patientId}/opt-outs', S, 'Record an opt-out in person', {
    access: careTeam,
    body: obj({ programme, reason: str({ maxLength: 300 }) }, ['programme']),
  }),
  op(
    'post',
    '/screening/patients/{patientId}/opt-outs/{programme}/withdraw',
    S,
    'Withdraw an opt-out',
    { access: careTeam },
  ),
  op('post', '/screening/episodes/{id}/book', S, 'Book the screening appointment', {
    access: careTeam,
    body: obj({ bookedFor: dateTime }, ['bookedFor']),
  }),
  op('post', '/screening/episodes/{id}/test', S, 'Record that the test was taken', {
    access: careTeam,
    body: obj({ screenedAt: dateTime, testType: enumOf(...TEST_TYPES) }, [
      'screenedAt',
      'testType',
    ]),
  }),
  op('post', '/screening/episodes/{id}/result', S, 'Record the screening result', {
    access: careTeam,
    description:
      'NORMAL sets the next routine due date, INADEQUATE a repeat after 3 months; ABNORMAL starts follow-up and gives the patient’s doctor an urgent task.',
    body: obj(
      {
        result: enumOf(...RESULTS),
        resultDetail: str({ maxLength: 300 }),
        referralId: uuid,
        screenedAt: dateTime,
        testType: enumOf(...TEST_TYPES),
      },
      ['result'],
    ),
  }),
  op('post', '/screening/episodes/{id}/referral', S, 'Link the follow-up referral', {
    access: doctor,
    body: obj({ referralId: uuid }, ['referralId']),
  }),
  op('post', '/screening/episodes/{id}/close', S, 'Close the follow-up of an abnormal result', {
    access: doctor,
    body: obj({ nextDueDate: { ...date, nullable: true }, note: str({ maxLength: 300 }) }, [
      'nextDueDate',
    ]),
  }),
  op('post', '/screening/episodes/{id}/decline', S, 'The patient declined this round', {
    access: careTeam,
    body: obj({ reason }, ['reason']),
  }),
  op('get', '/screening/worklist', S, 'Screening worklist for my patients', {
    access: 'DOCTOR, NURSE',
    params: [
      q('view', enumOf('due', 'followup', 'all')),
      q('programme', programme),
      q('q', str({ maxLength: 100 }), 'Name or national ID'),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('get', '/screening/coverage', S, 'Screening coverage (small cells suppressed)', {
    access: 'MINISTRY (national), DIRECTOR (own facility)',
    params: [q('groupBy', enumOf('NONE', 'MUNICIPALITY')), q('facilityId', uuid)],
  }),
  op('get', '/screening/mine', S, 'My screening (portal)', { access: 'PATIENT (or guardian)' }),
  op('post', '/screening/mine/opt-outs', S, 'Opt out of a programme (portal)', {
    access: 'PATIENT (or guardian)',
    body: obj({ programme, reason: str({ maxLength: 300 }) }, ['programme']),
  }),
  op('post', '/screening/mine/opt-outs/{programme}/withdraw', S, 'Opt back in (portal)', {
    access: 'PATIENT (or guardian)',
  }),
];

/** {programme} path parameters are programme codes, not ids. */
export const SCREENING_OPERATIONS: ModuleOperation[] = OPERATIONS.map((o) => ({
  ...o,
  params: o.params?.map((p) => (p.name === 'programme' ? { ...p, schema: programme } : p)),
}));
