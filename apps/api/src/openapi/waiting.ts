import {
  bool,
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
import {
  PRIORITIES,
  REMOVAL_REASONS,
  SPECIALTIES,
  STATUSES,
} from '../modules/waiting/waiting.service.js';

/** OpenAPI entries for waiting lists (/waiting-lists). */
export const WAITING_TAGS = [
  {
    name: 'Waiting lists',
    description: 'Elective waiting lists, maximum waiting times, transparency.',
  },
];

const W = 'Waiting lists';
const reason = str({ minLength: 3, maxLength: 500 });

export const WAITING_OPERATIONS: ModuleOperation[] = [
  op('get', '/waiting-lists/public/times', W, 'Published waiting times', {
    auth: 'none',
    description:
      'Median and 90th percentile days waited for entries completed in the last 12 months, per facility and specialty. Groups below the small-cell threshold are suppressed; no personal data.',
  }),
  op('get', '/waiting-lists/specialties', W, 'Specialties, priorities and removal reasons'),
  op('get', '/waiting-lists', W, 'Waiting list of my facility', {
    access: 'DOCTOR, RECEPTION, DIRECTOR',
    params: [
      q('specialty', enumOf(...SPECIALTIES)),
      q('status', enumOf(...STATUSES, 'ACTIVE'), 'Default ACTIVE (waiting, scheduled, postponed)'),
      q('priority', enumOf(...PRIORITIES)),
      q('breached', bool, 'Only entries past (or within) the maximum waiting time'),
      q('q', str({ maxLength: 100 }), 'Name, national ID or procedure'),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('post', '/waiting-lists', W, 'Add a patient to a waiting list', {
    access: 'DOCTOR with write access',
    body: obj(
      {
        patientId: uuid,
        specialty: enumOf(...SPECIALTIES),
        kind: enumOf('PROCEDURE', 'OUTPATIENT'),
        procedureCode: str({ maxLength: 20 }),
        procedureName: str({ minLength: 3, maxLength: 200 }),
        priority: enumOf(...PRIORITIES),
        clinicalReason: str({ maxLength: 2000 }),
        referralId: uuid,
      },
      ['patientId', 'specialty', 'procedureName', 'priority'],
    ),
    responses: {
      '201': 'Added (target date from the priority’s maximum waiting time)',
      '409': 'Already on this list',
    },
  }),
  op('get', '/waiting-lists/dashboard', W, 'Facility waiting-time dashboard', {
    access: 'DIRECTOR, DOCTOR',
  }),
  op('get', '/waiting-lists/national', W, 'National waiting times (aggregate)', {
    access: 'MINISTRY',
    description:
      'Per specialty and per facility; groups below the small-cell threshold are suppressed.',
  }),
  op('get', '/waiting-lists/mine', W, 'My waiting lists (portal)', {
    access: 'PATIENT (or guardian)',
  }),
  op('get', '/waiting-lists/patients/{patientId}', W, 'A patient’s waiting-list entries', {
    access: 'care team (with clinical reason); RECEPTION, DIRECTOR of the facility',
  }),
  op('get', '/waiting-lists/{id}', W, 'Waiting list entry with its history', {
    access: 'DOCTOR, RECEPTION, DIRECTOR',
  }),
  op('post', '/waiting-lists/{id}/schedule', W, 'Schedule (or reschedule)', {
    access: 'DOCTOR, RECEPTION',
    body: obj({ scheduledFor: dateTime, surgicalCaseId: uuid, appointmentId: uuid }, [
      'scheduledFor',
    ]),
  }),
  op('post', '/waiting-lists/{id}/unschedule', W, 'Cancel the scheduled date', {
    access: 'DOCTOR, RECEPTION',
    body: obj({ reason }, ['reason']),
  }),
  op('post', '/waiting-lists/{id}/suspend', W, 'Postpone at the patient’s request', {
    access: 'DOCTOR, RECEPTION',
    description: 'The waiting-time clock pauses until the entry is resumed.',
    body: obj({ reason }, ['reason']),
  }),
  op('post', '/waiting-lists/{id}/resume', W, 'Resume a postponed entry', {
    access: 'DOCTOR, RECEPTION',
  }),
  op('post', '/waiting-lists/{id}/priority', W, 'Change the clinical priority', {
    access: 'DOCTOR with write access',
    body: obj({ priority: enumOf(...PRIORITIES), reason }, ['priority', 'reason']),
  }),
  op('post', '/waiting-lists/{id}/complete', W, 'Mark as treated', {
    access: 'DOCTOR, RECEPTION',
    body: obj({ completedAt: dateTime }),
  }),
  op('post', '/waiting-lists/{id}/remove', W, 'Remove from the list', {
    access: 'DOCTOR (any reason), RECEPTION (non-clinical reasons)',
    body: obj({ reasonCode: enumOf(...REMOVAL_REASONS), reason: str({ maxLength: 500 }) }, [
      'reasonCode',
    ]),
  }),
];
