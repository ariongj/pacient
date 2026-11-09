import { TICKET_KINDS } from '../modules/support/support.service.js';
import { bool, enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries for IT support (/support). */
export const SUPPORT_TAGS = [
  {
    name: 'IT support',
    description: 'Account and access support requests (no clinical access).',
  },
];

const T = 'IT support';
const DESK = 'IT_SUPPORT of the facility (never their own account); audited on the account';
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];
const close = obj({ resolution: str({ minLength: 3, maxLength: 2000 }) }, ['resolution']);
const note = obj({ note: str({ maxLength: 500 }) });

export const SUPPORT_OPERATIONS: ModuleOperation[] = [
  op('get', '/support/me', T, 'What the caller can do on the support page'),
  op('get', '/support/tickets', T, 'Support requests', {
    access: 'IT_SUPPORT and DIRECTOR: the facility’s requests; other staff: their own',
    params: [q('status', enumOf('open', 'closed', 'approval', 'all')), q('mine', bool), ...page],
  }),
  op('get', '/support/tickets/{id}', T, 'One support request'),
  op('get', '/support/colleagues', T, 'Staff of the facility a request can be about'),
  op('post', '/support/tickets', T, 'Open a support request', {
    access: 'Any staff member with a facility',
    body: obj(
      {
        kind: enumOf(...TICKET_KINDS),
        description: str({ minLength: 5, maxLength: 2000 }),
        subjectUserId: uuid,
      },
      ['kind', 'description'],
    ),
  }),
  op('post', '/support/tickets/{id}/assign', T, 'Take the request', { access: 'IT_SUPPORT' }),
  op('post', '/support/tickets/{id}/request-approval', T, 'Ask the directors to approve', {
    access: 'IT_SUPPORT; two-step sign-in resets and access changes only',
  }),
  op('post', '/support/tickets/{id}/approve', T, 'Approve (director)', {
    access: 'DIRECTOR of the facility; not for their own account',
    body: note,
  }),
  op('post', '/support/tickets/{id}/reject-approval', T, 'Decline (director)', {
    access: 'DIRECTOR of the facility; reason required',
    body: note,
  }),
  op('post', '/support/tickets/{id}/unlock', T, 'Unlock the account', { access: DESK }),
  op('post', '/support/tickets/{id}/password-reset', T, 'Send a password-reset link', {
    access: DESK,
    description: 'The usual reset e-mail goes to the account’s own address.',
  }),
  op('post', '/support/tickets/{id}/mfa-reset', T, 'Reset two-step sign-in', {
    access: `${DESK}; only after a director approved the request`,
    description:
      'Removes the authenticator app, recovery codes and passkeys and ends all sessions; the user enrols again at the next sign-in.',
  }),
  op('post', '/support/tickets/{id}/resolve', T, 'Resolve', { access: 'IT_SUPPORT', body: close }),
  op('post', '/support/tickets/{id}/reject', T, 'Close without a change', {
    access: 'IT_SUPPORT',
    body: close,
  }),
  op('get', '/support/stats', T, 'Request counts per facility', {
    access: 'MINISTRY (all facilities), DIRECTOR and IT_SUPPORT (own); counts only',
  }),
];
