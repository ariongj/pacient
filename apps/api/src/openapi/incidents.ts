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
import {
  CONTRIBUTING_FACTORS,
  HARM_LEVELS,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
} from '../modules/incidents/incidents.constants.js';

/** OpenAPI entries for safety incidents (/incidents). */
export const INCIDENTS_TAGS = [
  {
    name: 'Safety incidents',
    description: 'Patient safety incident and near-miss reporting and review.',
  },
];

const I = 'Safety incidents';
const REVIEWERS = 'incident reviewers (DIRECTOR and named safety leads)';
const months = q('months', int({ minimum: 1, maximum: 36 }), 'Reporting window (default 12)');
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];

export const INCIDENTS_OPERATIONS: ModuleOperation[] = [
  op('get', '/incidents/meta', I, 'Lists, units and what the caller may do', {
    access: 'staff',
  }),
  op('post', '/incidents', I, 'Report an incident or near miss', {
    description:
      'Anonymous reports store no reporter anywhere (row or audit trail). A patient can be attached only by a doctor or nurse caring for them.',
    access: 'DOCTOR, NURSE, PHARMACIST, RECEPTION, DIRECTOR',
    body: obj(
      {
        occurredAt: dateTime,
        unitId: uuid,
        location: str({ maxLength: 200 }),
        category: enumOf(...INCIDENT_CATEGORIES),
        harm: enumOf(...HARM_LEVELS),
        description: str({ minLength: 20, maxLength: 5000 }),
        immediateAction: str({ maxLength: 2000 }),
        patientNationalId: str(),
        anonymous: bool,
      },
      ['occurredAt', 'category', 'harm', 'description'],
    ),
    responses: { '201': 'Reported (reference)' },
  }),
  op('get', '/incidents/mine', I, 'My named reports and their outcome', {
    access: 'the reporter',
    params: page,
  }),
  op('get', '/incidents/actions/mine', I, 'Incident actions assigned to me', { access: 'staff' }),
  op('patch', '/incidents/actions/{actionId}', I, 'Complete or change an action', {
    access: `${REVIEWERS}; the owner (completion only)`,
    body: obj({ completed: bool, description: str(), ownerId: uuid, dueDate: date }),
  }),
  op('get', '/incidents/reviewers', I, 'Named incident reviewers and candidates', {
    access: 'DIRECTOR',
  }),
  op('put', '/incidents/reviewers', I, 'Replace the named incident reviewers', {
    access: 'DIRECTOR',
    body: obj({ userIds: arr(uuid, { maxItems: 50 }) }, ['userIds']),
  }),
  op('get', '/incidents/staff', I, 'Facility staff and reviewers (for assigning)', {
    access: REVIEWERS,
  }),
  op('get', '/incidents/dashboard', I, 'Facility incident dashboard', {
    access: REVIEWERS,
    params: [months],
  }),
  op('get', '/incidents/national', I, 'National incident counts (small cells suppressed)', {
    access: 'MINISTRY',
    params: [months],
  }),
  op('get', '/incidents/national/it-system', I, 'Incidents involving the system', {
    description: 'For the clinical safety officer; text only after the facility closed its review.',
    access: 'MINISTRY',
    params: page,
  }),
  op('get', '/incidents', I, 'Facility review queue', {
    access: REVIEWERS,
    params: [
      q('status', enumOf(...INCIDENT_STATUSES, 'OPEN')),
      q('category', enumOf(...INCIDENT_CATEGORIES)),
      q('harm', enumOf(...HARM_LEVELS)),
      q('unitId', uuid),
      q('q', str(), 'Reference'),
      ...page,
    ],
  }),
  op('get', '/incidents/{id}', I, 'Incident (full for reviewers, own report for the reporter)', {
    access: `${REVIEWERS}, the reporter`,
  }),
  op('patch', '/incidents/{id}', I, 'Review: status, findings, harm, disclosure, hazard', {
    description:
      'NEW → UNDER_REVIEW → ACTION_PLANNED → CLOSED. Closing needs findings, confirmed harm, open disclosure for moderate or greater harm, and every action completed or carried over.',
    access: REVIEWERS,
    body: obj({
      status: enumOf(...INCIDENT_STATUSES),
      reviewerId: uuid,
      category: enumOf(...INCIDENT_CATEGORIES),
      reviewedHarm: enumOf(...HARM_LEVELS),
      contributingFactors: arr(enumOf(...CONTRIBUTING_FACTORS)),
      findings: str({ maxLength: 10_000 }),
      lessons: str({ maxLength: 5000 }),
      hazardRef: str({ pattern: '^H\\d{2}$' }),
      patientInformedAt: dateTime,
      carryOverActionIds: arr(uuid),
      reopenReason: str({ minLength: 10, maxLength: 500 }),
    }),
  }),
  op('post', '/incidents/{id}/actions', I, 'Add an action to an incident', {
    access: REVIEWERS,
    body: obj(
      { description: str({ minLength: 3, maxLength: 500 }), ownerId: uuid, dueDate: date },
      ['description'],
    ),
    responses: { '201': 'Created' },
  }),
];
