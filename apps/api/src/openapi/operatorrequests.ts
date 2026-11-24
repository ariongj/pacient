import { enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: facilities’ requests to the operator of the service (/operator-requests, /admin/requests).
 * Round 2, builder G: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const OPERATORREQUESTS_TAGS = [
  {
    name: 'Requests to the operator',
    description:
      'Requests from a facility’s directors and IT support to the operator of the service (billing, accounts, technical, data protection, security incidents). Never about a patient.',
  },
];

const T = 'Requests to the operator';
const FACILITY = 'DIRECTOR, IT_SUPPORT (own facility)';
const ADMIN = 'ADMIN (platform administrator)';
const category = enumOf(
  'BILLING',
  'ACCOUNT',
  'TECHNICAL',
  'DATA_PROTECTION',
  'SECURITY_INCIDENT',
  'OTHER',
);
const status = enumOf('OPEN', 'WAITING_CUSTOMER', 'RESOLVED');
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];
const body = str({ minLength: 2, maxLength: 4000 });
const NO_PATIENT_DATA =
  'A subject or message containing a 10-digit number (it looks like a personal number) is refused with 400: requests are never about a patient.';

export const OPERATORREQUESTS_OPERATIONS: ModuleOperation[] = [
  op('get', '/operator-requests', T, 'My facility’s requests', {
    access: FACILITY,
    description: 'Unresolved first, then by the latest change.',
    params: [q('status', status), ...page],
  }),
  op('post', '/operator-requests', T, 'A new request to the operator', {
    access: FACILITY,
    description: `Numbered REQ-<year>-00001 per Kosovo calendar year. Every administrator gets an important notification; a security incident is of high priority and is e-mailed to every administrator at once. ${NO_PATIENT_DATA}`,
    body: obj({ category, subject: str({ minLength: 3, maxLength: 200 }), body }, [
      'category',
      'subject',
      'body',
    ]),
    responses: { '201': 'Created, with its first message', '400': 'Invalid or patient data' },
  }),
  op('get', '/operator-requests/{id}', T, 'One request of my facility and its conversation', {
    access: FACILITY,
    description:
      'The operator’s answers are shown as from the operator, without the administrator’s name. Another facility’s request answers 404.',
  }),
  op('post', '/operator-requests/{id}/messages', T, 'Write again on a request', {
    access: FACILITY,
    description: `A request waiting for the facility, or resolved, is open again; the administrators are told. ${NO_PATIENT_DATA}`,
    body: obj({ body }, ['body']),
    responses: { '201': 'Added; the request with its conversation' },
  }),
  op('get', '/admin/requests', T, 'Requests of every facility', {
    access: ADMIN,
    description:
      'Unresolved and high priority first. With the counts per status over all requests (and unresolved ones of high priority) and the facilities that have asked something.',
    params: [
      q('status', enumOf('OPEN', 'WAITING_CUSTOMER', 'RESOLVED', 'UNRESOLVED')),
      q('category', category),
      q('facilityId', uuid),
      ...page,
    ],
  }),
  op('get', '/admin/requests/{id}', T, 'One request and its conversation', { access: ADMIN }),
  op('post', '/admin/requests/{id}/messages', T, 'Answer a request', {
    access: ADMIN,
    description: `The first answer sets firstResponseAt. With a status, the request moves to it in the same transaction. The requester gets an important notification. ${NO_PATIENT_DATA}`,
    body: obj({ body, status }, ['body']),
    responses: { '201': 'Answered; the request with its conversation' },
  }),
  op('post', '/admin/requests/{id}/status', T, 'Change the status of a request', {
    access: ADMIN,
    description:
      'resolvedAt is set while the request is resolved and cleared when it is opened again; the requester is told when it is resolved. Audited.',
    body: obj({ status }, ['status']),
  }),
];
