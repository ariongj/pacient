import { enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries: account management by the platform administrator (/admin/users). */
export const ADMINUSERS_TAGS = [
  {
    name: 'Administration – users',
    description:
      'Accounts of every role, managed by the platform administrator: account data only, never clinical data, a national ID or a link to a health record.',
  },
];

const T = 'Administration – users';
const ADMIN = 'ADMIN (platform administrator); every change is audited on the account';
const SELF = 'never on the administrator’s own account';
const ROLES = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
  'MINISTRY',
  'ADMIN',
];
const reason = (required: boolean) =>
  obj({ reason: str({ minLength: 5, maxLength: 500 }) }, required ? ['reason'] : []);
const account = 'The account page: user, active sessions, sign-ins and administrative history';

export const ADMINUSERS_OPERATIONS: ModuleOperation[] = [
  op('get', '/admin/users', T, 'Accounts', {
    access: ADMIN,
    description:
      'Search by name or e-mail; filter by role, facility and state. `counts` gives the number of accounts in each state for the same search. Patient accounts are not browsable: one is listed only when `q` is its exact e-mail address (a support case).',
    params: [
      q('q', str({ maxLength: 100 })),
      q('role', enumOf(...ROLES, 'PATIENT')),
      q('facilityId', uuid),
      q('status', enumOf('active', 'disabled', 'locked', 'pending', 'no_mfa')),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('get', '/admin/users/facilities', T, 'Active facilities for the account dialogs', {
    access: ADMIN,
  }),
  op('get', '/admin/users/{id}', T, 'One account', { access: ADMIN, description: account }),
  op('post', '/admin/users', T, 'Invite an account', {
    access: ADMIN,
    description:
      'Staff of a facility (facility required, seats of its subscription checked), Ministry officials and administrators (no facility). Never patients – facilities register them. Doctors, nurses and pharmacists need their licence number. The activation e-mail is queued; outside production the single-use link (72 hours) is also returned.',
    body: obj(
      {
        email: str({ format: 'email', maxLength: 254 }),
        fullName: str({ minLength: 2, maxLength: 200 }),
        role: enumOf(...ROLES),
        facilityId: uuid,
        specialty: str({ maxLength: 120 }),
        licenseNumber: str({ maxLength: 60 }),
      },
      ['email', 'fullName', 'role'],
    ),
    responses: {
      '201': 'Invited',
      '400': 'Invalid role, facility or licence',
      '409': 'E-mail in use or no free seat',
    },
  }),
  op('patch', '/admin/users/{id}', T, 'Change name, role, facility, specialty or licence', {
    access: `${ADMIN}; role and facility ${SELF}`,
    description:
      'A role or facility change needs a reason, waits until the person is in no care team (their patients handed over), has no result cover (active or to come, as covering or absent doctor), no results they ordered awaiting review, no notes in draft and no prescriptions the pharmacy returned to them, checks the new facility’s seats and signs the person out everywhere. A change of role unlinks a licence of the old profession (audited); `licenceLinked` says whether a licence of the new profession is linked, `licenceUnlinked` whether one was unlinked. Patient accounts are not changed here.',
    body: obj({
      fullName: str({ minLength: 2, maxLength: 200 }),
      role: enumOf(...ROLES),
      facilityId: uuid,
      specialty: str({ maxLength: 120 }),
      licenseNumber: str({ maxLength: 60 }),
      reason: str({ minLength: 5, maxLength: 500 }),
    }),
  }),
  op('post', '/admin/users/{id}/disable', T, 'Disable an account', {
    access: `${ADMIN}; ${SELF}; never the last active administrator (serialised with every change of an administrator)`,
    description: 'Signs the person out everywhere. ' + account + '.',
    body: reason(true),
  }),
  op('post', '/admin/users/{id}/enable', T, 'Enable an account', {
    access: ADMIN,
    description:
      'Facility staff need a free seat of the facility’s subscription. A patient account closed when a death was registered is refused (409): it comes back only if the death registration is withdrawn.',
    body: reason(false),
  }),
  op('post', '/admin/users/{id}/unlock', T, 'Unlock after failed sign-ins', { access: ADMIN }),
  op('post', '/admin/users/{id}/password-reset', T, 'Send a password reset e-mail', {
    access: ADMIN,
    description:
      'The usual reset e-mail goes to the account’s own address; the administrator never sees the link. Link, e-mail and audit entry (the administrator as actor) are one transaction. Activated, enabled accounts only.',
  }),
  op('post', '/admin/users/{id}/mfa-reset', T, 'Reset two-step sign-in', {
    access: `${ADMIN}; ${SELF}`,
    description:
      'Removes the authenticator app, recovery codes and passkeys, signs the person out everywhere and tells them (in the app and by e-mail). They set it up again at the next sign-in. Not for patient accounts (400): reception or a director of their facility verifies their identity in person and resets it (`POST /patients/{id}/portal-account/two-step-reset`).',
    body: reason(true),
  }),
  op('post', '/admin/users/{id}/revoke-sessions', T, 'Sign out everywhere', {
    access: `${ADMIN}; ${SELF} (use your own security page)`,
  }),
  op('post', '/admin/users/{id}/resend-invitation', T, 'Renew the activation link', {
    access: ADMIN,
    description:
      'For accounts not yet activated: earlier links stop working, a new 72-hour link is e-mailed (and returned outside production). Not for patient accounts (400): reception or a director of their facility verifies their identity in person and sends it again (`POST /patients/{id}/portal-invitation`); a patient’s link is never returned to the administrator.',
  }),
];
