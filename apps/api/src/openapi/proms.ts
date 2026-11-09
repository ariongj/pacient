import { FREQUENCIES, INSTRUMENT_CODES } from '../modules/proms/instruments.js';
import { dateTime, enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries for patient-reported outcomes (/proms). */
export const PROMS_TAGS = [
  {
    name: 'Patient-reported outcomes',
    description:
      'Questionnaires (PHQ-9, GAD-7, WHO-5, AUDIT-C) assigned to patients, scores and review.',
  },
];

const T = 'Patient-reported outcomes';
const instrument = enumOf(...INSTRUMENT_CODES);
const frequency = enumOf(...FREQUENCIES);
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];

export const PROMS_OPERATIONS: ModuleOperation[] = [
  op('get', '/proms/instruments', T, 'Questionnaires: items, answers, scoring and bands', {
    description:
      'Albanian and Serbian texts are working translations, to be replaced by validated translations before clinical use.',
  }),
  op('get', '/proms/patients/{patientId}', T, 'A patient’s questionnaire requests and answers', {
    access: 'DOCTOR, NURSE (care team); audited as a record view',
  }),
  op(
    'post',
    '/proms/patients/{patientId}/assignments',
    T,
    'Ask a patient to fill in a questionnaire',
    {
      access: 'DOCTOR, NURSE with write access (one active request per questionnaire)',
      body: obj({ instrument, frequency, firstDueAt: dateTime }, ['instrument', 'frequency']),
    },
  ),
  op('patch', '/proms/assignments/{id}', T, 'Change how often a questionnaire is asked', {
    access: 'DOCTOR, NURSE with write access',
    body: obj({ frequency }, ['frequency']),
  }),
  op('post', '/proms/assignments/{id}/end', T, 'Stop asking for a questionnaire', {
    access: 'DOCTOR, NURSE with write access',
    body: obj({ reason: str({ minLength: 3, maxLength: 300 }) }, ['reason']),
  }),
  op('get', '/proms/mine', T, 'My questionnaires and my scores', {
    access:
      'PATIENT (self; a guardian with full access sees only non-sensitive questionnaires such as WHO-5)',
  }),
  op('post', '/proms/mine/responses', T, 'Submit my answers', {
    access:
      'PATIENT (self; guardians only for non-sensitive questionnaires). The reply tells the portal which advice to show at once.',
    body: obj(
      {
        instrument,
        assignmentId: uuid,
        answers: { type: 'object', additionalProperties: int({ minimum: 0, maximum: 5 }) },
      },
      ['instrument', 'answers'],
    ),
  }),
  op('get', '/proms/review', T, 'Answers of patients in my care (safety flags first)', {
    access: 'DOCTOR, NURSE (care team)',
    params: [
      q('show', enumOf('UNREVIEWED', 'FLAGGED', 'ALL')),
      q('instrument', instrument),
      ...page,
    ],
  }),
  op('post', '/proms/responses/{id}/review', T, 'Mark answers as reviewed', {
    access: 'DOCTOR, NURSE with write access',
    body: obj({ note: str({ maxLength: 500 }) }),
  }),
  op('get', '/proms/stats', T, 'Completion per questionnaire (counts only, small numbers hidden)', {
    access: 'DIRECTOR (own facility)',
  }),
];
