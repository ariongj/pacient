import { ALL_FLAGS, SEPSIS_STEPS, SUSPECTED_SOURCES } from '../modules/sepsis/sepsis.service.js';
import {
  arr,
  bool,
  dateTime,
  enumOf,
  obj,
  op,
  q,
  str,
  uuid,
  type ModuleOperation,
} from './modules.js';

/** OpenAPI entries for sepsis (/sepsis). */
export const SEPSIS_TAGS = [
  { name: 'Sepsis', description: 'Sepsis screening and the Sepsis Six bundle.' },
];

const T = 'Sepsis';

const screenBody = obj(
  {
    suspectedInfection: bool,
    suspectedSource: enumOf(...SUSPECTED_SOURCES),
    flags: arr(enumOf(...ALL_FLAGS)),
    notes: str({ maxLength: 2000 }),
    screenedAt: dateTime,
  },
  ['suspectedInfection'],
);

export const SEPSIS_OPERATIONS: ModuleOperation[] = [
  op('get', '/sepsis/board', T, 'Open sepsis screens and running bundles', {
    access: 'DOCTOR, NURSE (ward or emergency staff, attending doctor, care team)',
    params: [
      q('status', enumOf('OPEN', 'PENDING', 'RED_FLAG', 'SEPSIS_SUSPECTED')),
      q('unitId', uuid),
    ],
  }),
  op('get', '/sepsis/patients/{patientId}', T, 'A patient’s sepsis screens and suggested flags', {
    access: 'DOCTOR, NURSE (care team)',
  }),
  op('post', '/sepsis/patients/{patientId}/screens', T, 'Screen a patient for sepsis', {
    access: 'DOCTOR, NURSE (care team)',
    description:
      'The outcome follows from the answers: infection and a red flag start the one-hour Sepsis Six clock.',
    body: screenBody,
  }),
  op('post', '/sepsis/screens/{id}/screen', T, 'Answer a sepsis screen prompt', {
    access: 'DOCTOR, NURSE (care team)',
    body: screenBody,
  }),
  op('post', '/sepsis/screens/{id}/bundle', T, 'Record a Sepsis Six step', {
    access: 'DOCTOR, NURSE (care team)',
    body: obj({ step: enumOf(...SEPSIS_STEPS), at: dateTime, prescriptionId: uuid }, ['step']),
  }),
  op('post', '/sepsis/screens/{id}/senior-review', T, 'Record the senior review', {
    access: 'DOCTOR (care team)',
    body: obj({ at: dateTime }),
  }),
  op('get', '/sepsis/dashboard', T, 'Sepsis compliance at my facility (no names)', {
    access: 'DIRECTOR',
  }),
];
