import { READING_KINDS, THRESHOLD_KEYS } from '../modules/remote/definitions.js';
import {
  arr,
  dateTime,
  enumOf,
  int,
  num,
  obj,
  op,
  q,
  str,
  type ModuleOperation,
} from './modules.js';

/** OpenAPI entries for remote monitoring (/remote-monitoring). */
export const REMOTE_TAGS = [
  {
    name: 'Remote monitoring',
    description: 'Home readings from patients, personal alert limits and review.',
  },
];

const T = 'Remote monitoring';
const kind = enumOf(...READING_KINDS);
const thresholds = obj(Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, num])));
const plan = obj(
  {
    kinds: arr(kind, { minItems: 1 }),
    thresholds,
    frequency: str({ maxLength: 100 }),
    instructions: str({ maxLength: 2000 }),
  },
  ['kinds'],
);
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];

export const REMOTE_OPERATIONS: ModuleOperation[] = [
  op('get', '/remote-monitoring/definitions', T, 'Measurements, units and default alert limits'),
  op('get', '/remote-monitoring/patients/{patientId}', T, 'A patient’s plan and home readings', {
    access: 'DOCTOR, NURSE (care team); audited as a record view',
  }),
  op('post', '/remote-monitoring/patients/{patientId}/plans', T, 'Enrol a patient', {
    access: 'DOCTOR with write access (one active plan per patient)',
    body: plan,
  }),
  op('patch', '/remote-monitoring/plans/{id}', T, 'Change a plan’s measurements or limits', {
    access: 'DOCTOR with write access',
    body: obj({
      kinds: arr(kind, { minItems: 1 }),
      thresholds,
      frequency: str({ maxLength: 100 }),
      instructions: str({ maxLength: 2000 }),
    }),
  }),
  op('post', '/remote-monitoring/plans/{id}/end', T, 'End a monitoring plan', {
    access: 'DOCTOR with write access',
    body: obj({ reason: str({ minLength: 3, maxLength: 300 }) }, ['reason']),
  }),
  op('get', '/remote-monitoring/mine', T, 'My plan and my home readings', {
    access: 'PATIENT (self, or guardian with full access)',
  }),
  op('post', '/remote-monitoring/mine/readings', T, 'Enter a home reading', {
    access: 'PATIENT (self, or guardian with full access)',
    body: obj(
      {
        kind,
        values: obj({
          systolic: int(),
          diastolic: int(),
          pulse: int(),
          value: num,
          context: enumOf('FASTING', 'BEFORE_MEAL', 'AFTER_MEAL', 'BEDTIME', 'RANDOM'),
        }),
        measuredAt: dateTime,
        note: str({ maxLength: 300 }),
      },
      ['kind', 'values'],
    ),
  }),
  op('get', '/remote-monitoring/review', T, 'Flagged readings of patients in my care', {
    access: 'DOCTOR, NURSE (care team)',
    params: [q('flag', enumOf('URGENT', 'OUT_OF_RANGE', 'ALL')), q('kind', kind), ...page],
  }),
  op('get', '/remote-monitoring/silent', T, 'Enrolled patients who stopped sending readings', {
    access: 'DOCTOR, NURSE (care team)',
  }),
  op('get', '/remote-monitoring/suggestions', T, 'Register patients who could be enrolled', {
    access: 'DOCTOR, NURSE (care team)',
  }),
  op('post', '/remote-monitoring/readings/{id}/review', T, 'Mark a flagged reading as reviewed', {
    access: 'DOCTOR, NURSE (care team)',
    body: obj({ note: str({ maxLength: 500 }) }),
  }),
  op('get', '/remote-monitoring/stats', T, 'Facility figures (no names)', {
    access: 'DIRECTOR (own facility)',
  }),
];
