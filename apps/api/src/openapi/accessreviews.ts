import { enumOf, obj, op, q, str, type ModuleOperation } from './modules.js';

/** OpenAPI entries for access reviews (/access-reviews). */
export const ACCESSREVIEWS_TAGS = [
  {
    name: 'Access reviews',
    description:
      'Periodic recertification of staff accounts: every quarter directors review their facility team and the Ministry reviews Ministry officials and facility directors.',
  },
];

const A = 'Access reviews';
const BOTH = 'DIRECTOR (own facility), MINISTRY (Ministry review)';

export const ACCESSREVIEWS_OPERATIONS: ModuleOperation[] = [
  op('get', '/access-reviews/meta', A, 'Current quarter, due date and roles reviewed', {
    access: 'DIRECTOR, MINISTRY',
  }),
  op('get', '/access-reviews', A, 'Reviews of my facility, or the Ministry reviews', {
    access: BOTH,
  }),
  op('post', '/access-reviews/open', A, 'Open the current quarter’s review now', {
    access: BOTH,
    description:
      'Idempotent: returns the existing review of the quarter (200) or the new one (201). A worker opens reviews automatically at the start of each quarter, due 30 days later.',
    responses: { '200': 'Existing review', '201': 'Opened' },
  }),
  op('get', '/access-reviews/compliance', A, 'Every facility’s review status for a quarter', {
    access: 'MINISTRY',
    params: [q('period', str({ pattern: '^\\d{4}-Q[1-4]$' }), 'e.g. 2026-Q4 (default: current)')],
  }),
  op('get', '/access-reviews/{id}', A, 'A review with each account’s snapshot and decision', {
    access: `${BOTH}; MINISTRY may read facility reviews`,
    description:
      'Snapshot per account: role, units, last sign-in, two-step sign-in, licence state, emergency accesses in 90 days and flags (DORMANT, NEVER_SIGNED_IN, LICENCE_INVALID, NO_TWO_STEP, FREQUENT_EMERGENCY_ACCESS).',
  }),
  op(
    'post',
    '/access-reviews/{id}/items/{itemId}/decision',
    A,
    'Keep, change or revoke an account',
    {
      access: BOTH,
      description:
        'CHANGE and REVOKE need a note. REVOKE deactivates the account at once and ends its sessions. Nobody decides on their own account.',
      body: obj({ decision: enumOf('KEEP', 'CHANGE', 'REVOKE'), note: str({ maxLength: 500 }) }, [
        'decision',
      ]),
      responses: { '200': 'Decided', '403': 'Own account or read-only', '409': 'Review completed' },
    },
  ),
  op('post', '/access-reviews/{id}/complete', A, 'Complete the review (every account decided)', {
    access: BOTH,
    responses: {
      '200': 'Completed',
      '400': 'Accounts still undecided',
      '409': 'Already completed',
    },
  }),
  op('get', '/access-reviews/{id}/export.csv', A, 'Attestation of a completed review (CSV)', {
    access: `${BOTH}; MINISTRY for any review`,
    responses: { '200': 'CSV', '409': 'Not completed yet' },
  }),
];
