import { dateTime, enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';
import { REGISTER_CODES } from '../modules/registers/definitions.js';

/** OpenAPI entries for disease registers (/registers). */
export const REGISTERS_TAGS = [
  {
    name: 'Disease registers',
    description: 'Chronic disease registers, recalls and quality indicators.',
  },
];

const T = 'Disease registers';
const register = enumOf(...REGISTER_CODES);

export const REGISTERS_OPERATIONS: ModuleOperation[] = [
  op('get', '/registers/definitions', T, 'Registers, review items, intervals and targets'),
  op('get', '/registers/patients/{patientId}', T, 'A patient’s registers and review status', {
    access: 'DOCTOR, NURSE (care team)',
  }),
  op('post', '/registers/patients/{patientId}/enrolments', T, 'Add a patient to a register', {
    access: 'DOCTOR with write access',
    body: obj({ register, reason: str({ maxLength: 200 }) }, ['register']),
  }),
  op('post', '/registers/enrolments/{id}/leave', T, 'Remove a patient from a register', {
    access: 'DOCTOR with write access',
    body: obj({ reason: str({ minLength: 3, maxLength: 200 }) }, ['reason']),
  }),
  op(
    'post',
    '/registers/patients/{patientId}/care-processes',
    T,
    'Record a review item (foot check, eye screening …)',
    {
      access: 'NURSE, DOCTOR (care team)',
      body: obj(
        {
          register,
          process: str({ maxLength: 30 }),
          result: str({ maxLength: 30 }),
          notes: str({ maxLength: 500 }),
          performedAt: dateTime,
        },
        ['register', 'process', 'result'],
      ),
    },
  ),
  op('get', '/registers/recalls', T, 'Recall list: overdue reviews of patients in my care', {
    access: 'DOCTOR, NURSE (care team)',
    params: [
      q('register', register),
      q('state', enumOf('OVERDUE', 'DUE', 'ALL')),
      q('q', str()),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('get', '/registers/indicators', T, 'Quality indicators (small cells suppressed)', {
    access: 'MINISTRY (national), DIRECTOR (own facility)',
    params: [
      q('register', register),
      q('groupBy', enumOf('NONE', 'FACILITY', 'MUNICIPALITY')),
      q('facilityId', uuid),
    ],
  }),
];
