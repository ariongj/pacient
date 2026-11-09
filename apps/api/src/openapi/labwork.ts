import { REJECTION_REASONS } from '../modules/lab/work.service.js';
import { bool, enumOf, int, obj, op, q, str, type ModuleOperation } from './modules.js';

/** OpenAPI entries for laboratory work (/lab-work). */
export const LABWORK_TAGS = [
  {
    name: 'Laboratory work',
    description:
      'Specimen tracking, manual result entry and validation by laboratory staff (four eyes).',
  },
];

const T = 'Laboratory work';
const LAB = 'LAB_TECHNICIAN, or a DOCTOR with a laboratory specialty, of the order’s facility';
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];

export const LABWORK_OPERATIONS: ModuleOperation[] = [
  op('get', '/lab-work/me', T, 'Whether the caller works in the laboratory'),
  op('get', '/lab-work/worklist', T, 'Laboratory worklist of the facility', {
    access: `${LAB}; each patient shown is recorded in their access log`,
    description:
      'Only what the laboratory needs: patient identification, the order, specimen events and a preliminary result awaiting validation. No chart access.',
    params: [
      q('view', enumOf('open', 'validation', 'done')),
      q('priority', enumOf('ROUTINE', 'URGENT', 'STAT')),
      q('q', str({ maxLength: 60 }), 'Order number, name or national ID'),
      ...page,
    ],
  }),
  op('post', '/lab-work/orders/{id}/collect', T, 'Record that the specimen was taken', {
    access: LAB,
    body: obj({ barcode: str({ pattern: '^[A-Z0-9-]{4,40}$' }) }),
    responses: { '409': 'The specimen was already received' },
  }),
  op('post', '/lab-work/orders/{id}/receive', T, 'Receive the specimen (barcode must match)', {
    access: LAB,
    body: obj({ barcode: str({ pattern: '^[A-Z0-9-]{4,40}$' }) }, ['barcode']),
    responses: { '400': 'The barcode does not match', '409': 'Already received' },
  }),
  op('post', '/lab-work/orders/{id}/reject', T, 'Reject the specimen (a new sample is needed)', {
    access: LAB,
    description:
      'The order returns to ORDERED and the ordering doctor gets an important notification without patient or test in the title.',
    body: obj({ reason: enumOf(...REJECTION_REASONS), note: str({ maxLength: 250 }) }, ['reason']),
  }),
  op('post', '/lab-work/orders/{id}/result', T, 'Enter a result manually (preliminary)', {
    access: `${LAB}; refused for orders handled by a laboratory system`,
    description:
      'Creates a PRELIMINARY result flagged from the reference range and critical limits; entering again replaces the preliminary value.',
    body: obj({ value: str({ maxLength: 100 }), critical: bool }, ['value']),
    responses: { '201': 'Preliminary result', '409': 'Not received, or already validated' },
  }),
  op('post', '/lab-work/results/{id}/validate', T, 'Validate a result (second person)', {
    access: `${LAB}; never the person who entered it`,
    description:
      'The result becomes FINAL, the order RESULTED, and the ordering doctor is notified (critical results as important).',
    responses: { '403': 'Same person as the one who entered it' },
  }),
  op('get', '/lab-work/orders/{id}/label', T, 'Specimen label data for printing', { access: LAB }),
  op('get', '/lab-work/stats', T, 'Turnaround times, rejections and open workload', {
    access: 'DIRECTOR (own facility) and laboratory staff; counts and times only',
    params: [q('days', int({ minimum: 7, maximum: 365 }))],
  }),
];
