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
  COMPLAINT_CATEGORIES,
  COMPLAINT_STATUSES,
  FEEDBACK_ITEMS,
  FEEDBACK_SETTINGS,
  RESPONSE_OUTCOMES,
} from '../modules/complaints/complaints.constants.js';

/** OpenAPI entries for complaints and feedback (/complaints). */
export const COMPLAINTS_TAGS = [
  {
    name: 'Complaints and feedback',
    description: 'Patient complaints with response deadlines, anonymous feedback.',
  },
];

const C = 'Complaints and feedback';
const HANDLERS = 'DIRECTOR of the facility, the assigned member of staff';
const PORTAL = 'the patient or a guardian with full access';
const months = q('months', int({ minimum: 1, maximum: 36 }), 'Reporting window (default 12)');
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];
const score = int({ minimum: 1, maximum: 5 });

export const COMPLAINTS_OPERATIONS: ModuleOperation[] = [
  op('get', '/complaints/meta', C, 'Lists and what the caller may do', {
    access: 'signed-in users',
  }),

  op('get', '/complaints/portal/facilities', C, 'Facilities to complain about (with recent care)', {
    access: PORTAL,
  }),
  op('post', '/complaints/portal', C, 'Make a complaint', {
    access: PORTAL,
    description:
      'Accepted for any facility; the response says whether the patient had care there in the last two years. Acknowledgement is due within 5 working days and a response within 30 days.',
    body: obj(
      {
        facilityId: uuid,
        category: enumOf(...COMPLAINT_CATEGORIES),
        description: str({ minLength: 20, maxLength: 5000 }),
        desiredOutcome: str({ maxLength: 2000 }),
      },
      ['facilityId', 'category', 'description'],
    ),
    responses: { '201': 'Submitted (reference and deadlines)' },
  }),
  op('get', '/complaints/portal', C, 'My complaints', { access: PORTAL }),
  op('get', '/complaints/portal/{id}', C, 'One of my complaints with the response', {
    access: PORTAL,
  }),
  op('post', '/complaints/portal/{id}/escalate', C, 'Escalate a complaint to the Ministry', {
    access: PORTAL,
    description: 'Within 30 days of the facility’s response.',
    body: obj({ reason: str({ minLength: 10, maxLength: 2000 }) }, ['reason']),
    responses: { '409': 'Not answered yet, or the 30 days have passed' },
  }),
  op('post', '/complaints/portal/{id}/withdraw', C, 'Withdraw a complaint', {
    access: PORTAL,
    responses: { '409': 'Already answered or closed' },
  }),

  op('get', '/complaints/feedback/eligible', C, 'Recent visits I can rate', {
    access: 'the patient or a guardian (appointments only with appointment access)',
  }),
  op('post', '/complaints/feedback', C, 'Rate a visit anonymously', {
    access: 'the patient or a guardian (appointments only with appointment access)',
    description:
      'Stored without patient, user, visit or exact time (month only); a keyed hash of the visit prevents rating it twice.',
    body: obj(
      {
        setting: enumOf(...FEEDBACK_SETTINGS),
        visitId: uuid,
        overall: score,
        scores: obj(Object.fromEntries(FEEDBACK_ITEMS.map((i) => [i, score]))),
        wouldRecommend: bool,
        comment: str({ maxLength: 1000 }),
      },
      ['setting', 'visitId', 'overall'],
    ),
    responses: { '201': 'Thank you', '409': 'Already rated or not rateable' },
  }),
  op('get', '/complaints/feedback/dashboard', C, 'Feedback averages (small groups suppressed)', {
    access: 'DIRECTOR (own facility), MINISTRY (national)',
    params: [months, q('facilityId', uuid, 'Ministry only: one facility')],
  }),

  op('post', '/complaints', C, 'Record a complaint received in person, by phone or letter', {
    access: 'RECEPTION, DIRECTOR of the facility',
    body: obj(
      {
        patientNationalId: str(),
        channel: enumOf('IN_PERSON', 'PHONE', 'LETTER'),
        category: enumOf(...COMPLAINT_CATEGORIES),
        description: str({ minLength: 20, maxLength: 5000 }),
        desiredOutcome: str({ maxLength: 2000 }),
        receivedAt: dateTime,
      },
      ['patientNationalId', 'channel', 'category', 'description'],
    ),
    responses: { '201': 'Recorded' },
  }),
  op('get', '/complaints', C, 'Complaints to handle', {
    access: 'DIRECTOR (facility), assigned staff (their complaints), MINISTRY (escalated)',
    params: [
      q('status', enumOf(...COMPLAINT_STATUSES)),
      q('category', enumOf(...COMPLAINT_CATEGORIES)),
      q('overdue', enumOf('true', 'false')),
      q('view', enumOf('all', 'assigned', 'escalated')),
      ...page,
    ],
  }),
  op('get', '/complaints/dashboard', C, 'Complaint statistics and overdue list', {
    access: 'DIRECTOR (own facility), MINISTRY (national)',
    params: [months],
  }),
  op('get', '/complaints/{id}', C, 'A complaint with its handling', {
    access: `${HANDLERS}, MINISTRY (if escalated)`,
  }),
  op('post', '/complaints/{id}/assign', C, 'Assign a complaint to a member of staff', {
    access: 'DIRECTOR of the facility',
    body: obj({ userId: uuid }, ['userId']),
  }),
  op('post', '/complaints/{id}/acknowledge', C, 'Acknowledge a complaint', { access: HANDLERS }),
  op('post', '/complaints/{id}/investigate', C, 'Start the investigation', { access: HANDLERS }),
  op('post', '/complaints/{id}/respond', C, 'Send the written response', {
    access: HANDLERS,
    body: obj(
      {
        response: str({ minLength: 30, maxLength: 10_000 }),
        outcome: enumOf(...RESPONSE_OUTCOMES),
      },
      ['response', 'outcome'],
    ),
  }),
  op('post', '/complaints/{id}/close', C, 'Close an answered complaint', {
    access: 'DIRECTOR of the facility',
  }),
  op('post', '/complaints/{id}/decision', C, 'Record the Ministry’s decision on an escalation', {
    access: 'MINISTRY',
    body: obj({ decision: str({ minLength: 30, maxLength: 10_000 }) }, ['decision']),
  }),
];
