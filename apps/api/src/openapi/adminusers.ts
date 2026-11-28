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
/** requireRecentAuth: the password in X-Reauth-Password, or a sign-in in the last 10 minutes. */
const REAUTH =
  'REAUTH_REQUIRED: confirm the password (header X-Reauth-Password) or sign in again; “Password is incorrect” for a wrong one (five lock the account for 15 minutes, 429 meanwhile)';
const reauthHeader = [
  {
    name: 'X-Reauth-Password',
    in: 'header' as const,
    description:
      'The password again, as `b64:` followed by the base64 of its UTF-8 bytes (a header cannot carry other characters than Latin-1, and HTTP strips spaces at either end); any other form is refused with 400. Never stored or logged.',
    schema: str({ pattern: '^b64:[A-Za-z0-9+/]+={0,2}$' }),
  },
];

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
    access: `${ADMIN}; inviting an administrator needs the password again`,
    description:
      'Staff of a facility (facility required, seats of its subscription checked), Ministry officials and administrators (no facility). Never patients – facilities register them. Doctors, nurses and pharmacists need their licence number. Inviting an administrator asks for the password again first (401 REAUTH_REQUIRED). The activation e-mail is queued; outside production the single-use link (72 hours) is also returned.',
    params: reauthHeader,
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
      '401': REAUTH,
      '409': 'E-mail in use or no free seat',
    },
  }),
  op('patch', '/admin/users/{id}', T, 'Change name, role, facility, specialty or licence', {
    access: `${ADMIN}; role and facility ${SELF}; an administrator’s account, or making someone one, needs the password again`,
    params: reauthHeader,
    responses: { '200': account, '401': REAUTH },
    description:
      'Any change to an administrator’s account, or to the administrator role, asks for the password again first (401 REAUTH_REQUIRED). A role or facility change needs a reason, waits until the person is in no care team (their patients handed over), has no result cover (active or to come, as covering or absent doctor), no results they ordered awaiting review, no notes in draft and no prescriptions the pharmacy returned to them, checks the new facility’s seats and signs the person out everywhere. A change of role unlinks a licence of the old profession (audited); `licenceLinked` says whether a licence of the new profession is linked, `licenceUnlinked` whether one was unlinked. Patient accounts are not changed here.',
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
    access: `${ADMIN}; ${SELF}; never the last active administrator (serialised with every change of an administrator); needs the password again`,
    description: 'Signs the person out everywhere. ' + account + '.',
    body: reason(true),
    params: reauthHeader,
    responses: { '200': account, '401': REAUTH },
  }),
  op('post', '/admin/users/{id}/enable', T, 'Enable an account', {
    access: `${ADMIN}; enabling an administrator needs the password again`,
    description:
      'Facility staff need a free seat of the facility’s subscription. A patient account closed when a death was registered is refused (409): it comes back only if the death registration is withdrawn.',
    body: reason(false),
    params: reauthHeader,
    responses: { '200': account, '401': REAUTH },
  }),
  op('post', '/admin/users/{id}/unlock', T, 'Unlock after failed sign-ins', {
    access: `${ADMIN}; ${SELF} (another administrator unlocks it); unlocking an administrator needs the password again`,
    description:
      'Clears the lockout and the count of wrong passwords. Never on your own account (403): the lockout is what stops a stolen session from guessing the password it is asked for.',
    params: reauthHeader,
    responses: { '200': account, '401': REAUTH, '403': 'Your own account', '409': 'Not locked' },
  }),
  op('post', '/admin/users/{id}/password-reset', T, 'Send a password reset e-mail', {
    access: ADMIN,
    description:
      'The usual reset e-mail goes to the account’s own address; the administrator never sees the link. Link, e-mail and audit entry (the administrator as actor) are one transaction. Activated, enabled accounts only.',
  }),
  op('post', '/admin/users/{id}/mfa-reset', T, 'Reset two-step sign-in', {
    access: `${ADMIN}; ${SELF}; needs the password again`,
    params: reauthHeader,
    responses: { '200': account, '401': REAUTH },
    description:
      'Removes the authenticator app, recovery codes and passkeys, signs the person out everywhere and tells them (in the app and by e-mail). They set it up again at the next sign-in. Not for patient accounts (400): reception or a director of their facility verifies their identity in person and resets it (`POST /patients/{id}/portal-account/two-step-reset`).',
    body: reason(true),
  }),
  op('post', '/admin/users/{id}/revoke-sessions', T, 'Sign out everywhere', {
    access: `${ADMIN}; ${SELF} (use your own security page); needs the password again`,
    params: reauthHeader,
    responses: { '200': account, '401': REAUTH },
  }),
  op('post', '/admin/users/{id}/resend-invitation', T, 'Renew the activation link', {
    access: ADMIN,
    description:
      'For accounts not yet activated: earlier links stop working, a new 72-hour link is e-mailed (and returned outside production). Not for patient accounts (400): reception or a director of their facility verifies their identity in person and sends it again (`POST /patients/{id}/portal-invitation`); a patient’s link is never returned to the administrator.',
  }),
];
