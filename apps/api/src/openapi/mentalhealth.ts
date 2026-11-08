import { END_REASONS, GROUNDS, RESTRICTIVE_KINDS } from '../modules/mentalhealth/definitions.js';
import {
  arr,
  bool,
  dateTime,
  enumOf,
  obj,
  op,
  str,
  uuid,
  type ModuleOperation,
} from './modules.js';

/** OpenAPI entries for mental health safeguards (/mental-health). */
export const MENTALHEALTH_TAGS = [
  {
    name: 'Mental health safeguards',
    description:
      'Involuntary admission safeguards (second examination, court, rights, representative, ' +
      'authorisation review) and restrictive interventions (observations, debrief). Visible to the ' +
      'care team and the staff of the psychiatric ward; every read is in the patient’s access log.',
  },
];

const T = 'Mental health safeguards';
const CARE = 'DOCTOR, NURSE (care team or ward staff)';
const DOCTOR = 'DOCTOR (care team or ward staff)';
const at = obj({ at: dateTime });

export const MENTALHEALTH_OPERATIONS: ModuleOperation[] = [
  op('get', '/mental-health/board', T, 'Involuntary admissions and restrictive interventions', {
    access: 'DOCTOR, NURSE (ward staff, attending doctor, care team)',
    description:
      'Active involuntary admissions with the state of every legal step, and restrictive ' +
      'interventions that are running or still need a debrief. Each patient shown is recorded in ' +
      'their access log.',
  }),
  op('get', '/mental-health/patients/{patientId}', T, 'A patient’s mental health safeguards', {
    access: CARE,
  }),
  op(
    'post',
    '/mental-health/patients/{patientId}/involuntary',
    T,
    'Record an involuntary admission',
    {
      access: DOCTOR,
      description:
        'Only for a patient currently admitted to a psychiatric ward of the doctor’s facility. ' +
        'Starts the clocks for the legal steps.',
      body: obj(
        {
          grounds: arr(enumOf(...GROUNDS), { minItems: 1 }),
          assessment: str({ minLength: 20, maxLength: 5000 }),
          startedAt: dateTime,
        },
        ['grounds', 'assessment'],
      ),
    },
  ),
  op('post', '/mental-health/involuntary/{id}/second-opinion', T, 'Record the second examination', {
    access: 'DOCTOR (a different doctor from the one who decided)',
    description:
      'If the second doctor does not confirm, the patient is released, or stays as a voluntary ' +
      'patient when they agree to.',
    body: obj({ confirms: bool, staysVoluntarily: bool, at: dateTime }, ['confirms']),
  }),
  op('post', '/mental-health/involuntary/{id}/rights', T, 'Record that rights were explained', {
    access: CARE,
    body: at,
  }),
  op(
    'post',
    '/mental-health/involuntary/{id}/representative',
    T,
    'Record that the representative or family was informed',
    {
      access: CARE,
      body: obj({ name: str({ minLength: 2, maxLength: 200 }), at: dateTime }, ['name']),
    },
  ),
  op(
    'post',
    '/mental-health/involuntary/{id}/court-notification',
    T,
    'Record notification of the court',
    {
      access: DOCTOR,
      body: obj({ reference: str({ minLength: 2, maxLength: 60 }), at: dateTime }, ['reference']),
    },
  ),
  op('post', '/mental-health/involuntary/{id}/court-decision', T, 'Record the court decision', {
    access: DOCTOR,
    description:
      'CONFIRMED needs the date until which it is authorised; REJECTED releases the patient.',
    body: obj(
      { decision: enumOf('CONFIRMED', 'REJECTED'), at: dateTime, authorisedUntil: dateTime },
      ['decision'],
    ),
  }),
  op(
    'post',
    '/mental-health/involuntary/{id}/authorisation',
    T,
    'Record an extended authorisation',
    {
      access: DOCTOR,
      body: obj({ authorisedUntil: dateTime, reference: str({ maxLength: 60 }), at: dateTime }, [
        'authorisedUntil',
      ]),
    },
  ),
  op('post', '/mental-health/involuntary/{id}/end', T, 'End an involuntary admission', {
    access: DOCTOR,
    body: obj({ reason: enumOf(...END_REASONS), note: str({ maxLength: 280 }), at: dateTime }, [
      'reason',
    ]),
  }),
  op(
    'post',
    '/mental-health/patients/{patientId}/restrictive',
    T,
    'Record a restrictive intervention',
    {
      access: CARE,
      description:
        'Restraint, seclusion or rapid tranquillisation of an admitted patient. Rapid ' +
        'tranquillisation may refer to a recorded medication administration.',
      body: obj(
        {
          kind: enumOf(...RESTRICTIVE_KINDS),
          reason: str({ minLength: 10, maxLength: 2000 }),
          startedAt: dateTime,
          medicationAdministrationId: uuid,
        },
        ['kind', 'reason'],
      ),
    },
  ),
  op('post', '/mental-health/restrictive/{id}/observations', T, 'Add an observation', {
    access: CARE,
    description: 'Due at least every 15 minutes while restraint or seclusion continues.',
    body: obj({ note: str({ minLength: 2, maxLength: 500 }), vitalsChecked: bool, at: dateTime }, [
      'note',
    ]),
  }),
  op('post', '/mental-health/restrictive/{id}/end', T, 'End a restrictive intervention', {
    access: CARE,
    body: obj({ at: dateTime, injuries: str({ maxLength: 300 }) }),
  }),
  op('post', '/mental-health/restrictive/{id}/debrief', T, 'Record the debrief', {
    access: CARE,
    description: 'Due within 72 hours after the intervention ended.',
    body: obj({ note: str({ minLength: 10, maxLength: 3000 }), at: dateTime }, ['note']),
  }),
  op('get', '/mental-health/oversight', T, 'Legal deadlines for the director', {
    access: 'DIRECTOR (own facility)',
    description:
      'Active involuntary admissions with the patient’s name, ward and the state of each legal ' +
      'step, plus restrictive intervention counts. No assessment or clinical notes. Each patient ' +
      'listed is recorded in their access log.',
  }),
  op('get', '/mental-health/stats', T, 'National mental health safeguard statistics', {
    access: 'MINISTRY',
    description:
      'Last 12 months by facility and month. Counts of 1–4 are hidden; rates and medians are ' +
      'given only above that threshold.',
  }),
];
