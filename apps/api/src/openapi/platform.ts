import { bool, dateTime, enumOf, int, obj, op, q, str, type ModuleOperation } from './modules.js';

/** OpenAPI entries: operator settings, the administrator's overview, terms of use and privacy notice. */
export const PLATFORM_TAGS = [
  {
    name: 'Platform',
    description:
      'Operator settings, the administrator’s overview, terms of use and privacy notice.',
  },
];

const T = 'Platform';
const ADMIN = 'ADMIN (platform administrator); never clinical data';
const kindEnum = enumOf('TERMS', 'PRIVACY', 'SERVICE_AGREEMENT', 'DPA');
/** The texts users accept at sign-in; agreements are accepted per facility (/subscription). */
const userKindEnum = enumOf('TERMS', 'PRIVACY');
const localeEnum = enumOf('sq', 'sr', 'en');
const version = str({ pattern: '^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$' });
/** requireRecentAuth: the password in X-Reauth-Password, or a sign-in in the last 10 minutes. */
const REAUTH =
  'REAUTH_REQUIRED: confirm the password (header X-Reauth-Password) or sign in again; “Password is incorrect” for a wrong one';

/** The public legal text is addressed by its kind ("terms", "privacy", …), not by an id. */
const legalByKind: ModuleOperation = {
  ...op('get', '/legal/{kind}', T, 'The current text of a kind', {
    auth: 'none',
    access: 'Public',
    description:
      'Terms of use, privacy notice, service agreement or data processing agreement: the newest published version in the requested language (fallback Albanian, then English), with the operator details as they were when it was published (texts published before the details were written into them are filled in from the current settings). 404 while nothing is published.',
    params: [q('locale', localeEnum)],
  }),
  params: [
    {
      name: 'kind',
      in: 'path',
      required: true,
      schema: enumOf('terms', 'privacy', 'service-agreement', 'dpa'),
    },
    q('locale', localeEnum),
  ],
};

const settingsBody = obj({
  operatorName: str({ maxLength: 200 }),
  operatorAddress: str({ maxLength: 500 }),
  operatorFiscalNumber: str({ maxLength: 40, nullable: true }),
  operatorVatNumber: str({ maxLength: 40, nullable: true }),
  operatorIban: str({ maxLength: 40, nullable: true }),
  operatorBank: str({ maxLength: 120, nullable: true }),
  supportEmail: str({ format: 'email', nullable: true }),
  supportPhone: str({ maxLength: 40, nullable: true }),
  supportHours: str({ maxLength: 120, nullable: true }),
  privacyEmail: str({ format: 'email', nullable: true }),
  invoicePrefix: str({ pattern: '^[A-Z0-9-]{1,10}$' }),
  paymentTermsDays: int({ minimum: 0, maximum: 120 }),
  vatRateBp: int({ minimum: 0, maximum: 5000, description: 'Basis points: 1800 = 18 %' }),
  trialDays: int({ minimum: 0, maximum: 365 }),
  graceDays: int({ minimum: 0, maximum: 365 }),
  noticeText: str({ maxLength: 300, nullable: true }),
  noticeTone: enumOf('INFO', 'WARNING'),
  noticeUntil: { ...dateTime, nullable: true },
});

export const PLATFORM_OPERATIONS: ModuleOperation[] = [
  op('get', '/platform/info', T, 'Who runs the service, how to reach them, the notice to users', {
    auth: 'none',
    access: 'Public',
    description:
      'Operator name and address, support and privacy contacts with the support hours, and the notice to all users while it is valid.',
  }),
  op('get', '/legal/status', T, 'Terms and privacy versions the caller still has to accept', {
    access: 'Any signed-in user',
    description:
      'The current version when it asks for acceptance and the caller has not accepted it, or when it does not but the caller never accepted the latest version that did (or a later one).',
    params: [q('locale', localeEnum)],
  }),
  op('post', '/legal/accept', T, 'Accept the current version', {
    access: 'Any signed-in user (for their own account)',
    description:
      'Only the current version can be accepted; accepting twice is harmless. Recorded with time, IP address and browser, and audited.',
    body: obj({ kind: userKindEnum, version: str({ maxLength: 20 }) }, ['kind', 'version']),
    responses: { '200': 'Accepted; the versions still pending', '409': 'Not the current version' },
  }),
  legalByKind,

  op('get', '/admin/overview', T, 'The administrator’s overview', {
    access: ADMIN,
    description:
      'Facilities and subscriptions by status, accounts (active staff, pending activations, locked, staff without two-step sign-in, patient accounts), monthly recurring revenue, open and overdue invoices (overdue: with an amount to pay), renewals and scheduled endings in the next 30 days (with the billing cycle and price a scheduled change applies), recent subscription events and administrative actions.',
  }),
  op('get', '/admin/settings', T, 'Operator settings', {
    access: ADMIN,
    description:
      'The settings, and operatorIbanValid: false when the stored IBAN does not pass the check (one stored before the check was stricter).',
  }),
  op('get', '/admin/settings/bank-change', T, 'Bank details changed in the last 14 days', {
    access: ADMIN,
    description:
      '`change`: the latest change of the IBAN or bank in the last 14 days (time, the administrator who made it, which of the two changed, and the IBAN and bank now), or null. Shown on the platform overview.',
  }),
  op('put', '/admin/settings', T, 'Change operator settings', {
    access: `${ADMIN}; a new IBAN, bank, VAT rate or number, or invoice prefix needs the password again`,
    description:
      'Only the fields sent are changed; the changed field names are audited. Changing the IBAN, bank, VAT rate, VAT number or invoice prefix asks for the password again first (401 REAUTH_REQUIRED; values sent back unchanged ask for nothing). A new IBAN or bank is announced to every other active administrator (important notification and e-mail, in the same transaction). A new IBAN must have its country’s length and valid check digits (02–98); the stored one sent back unchanged is not checked again, so it never blocks other changes. Published legal texts keep the details they were published with.',
    body: settingsBody,
    params: [{ name: 'X-Reauth-Password', in: 'header', schema: str() }],
    responses: { '200': 'Saved', '400': 'Invalid values', '401': REAUTH },
  }),
  op('get', '/admin/legal', T, 'Legal texts: every version and language', {
    access: ADMIN,
    description:
      'Terms of use, privacy notice, service agreement and data processing agreement: drafts and published documents, the current version of each kind, users’ acceptance counts against active accounts (facilities’ acceptances of the agreements: /admin/agreements/missing), and operator details the texts need that are still empty.',
  }),
  op('get', '/admin/legal/templates', T, 'Starting text for a new version (draft)', {
    access: ADMIN,
    description: 'A draft to be reviewed by a lawyer before publishing; {placeholders} are kept.',
    params: [q('kind', kindEnum), q('locale', localeEnum)],
  }),
  op('get', '/admin/legal/acceptances', T, 'Who accepted a version', {
    access: ADMIN,
    description:
      'The count against active accounts and the latest 50 acceptances; patient accounts by role and time only (no name).',
    params: [q('kind', userKindEnum), q('version', version)],
  }),
  op('get', '/admin/legal/{id}', T, 'One document with its text', {
    access: ADMIN,
    description:
      'A published text has the operator details written in; titleSource and bodySource hold it as written, with its {placeholders} (null for drafts and for texts published before they were kept).',
  }),
  op('post', '/admin/legal', T, 'Create a draft', {
    access: ADMIN,
    body: obj(
      {
        kind: kindEnum,
        version,
        locale: localeEnum,
        title: str({ minLength: 2, maxLength: 200 }),
        body: str({ minLength: 20, maxLength: 100000 }),
        requiresAcceptance: bool,
      },
      ['kind', 'version', 'locale', 'title', 'body'],
    ),
    responses: { '201': 'Draft created', '409': 'This version already exists in this language' },
  }),
  op('patch', '/admin/legal/{id}', T, 'Edit a draft', {
    access: ADMIN,
    body: obj({
      title: str({ minLength: 2, maxLength: 200 }),
      body: str({ minLength: 20, maxLength: 100000 }),
      requiresAcceptance: bool,
    }),
    responses: { '200': 'Saved', '409': 'Published documents cannot be changed' },
  }),
  op('delete', '/admin/legal/{id}', T, 'Delete a draft', {
    access: ADMIN,
    responses: { '204': 'Deleted', '409': 'Published documents cannot be deleted' },
  }),
  op('post', '/admin/legal/{id}/publish', T, 'Publish a draft', {
    access: `${ADMIN}; needs the password again`,
    params: [{ name: 'X-Reauth-Password', in: 'header', schema: str() }],
    description:
      'The text is fixed from now on (database trigger), with the operator details it refers to written into it (each value as typed, in one pass) and the text as written kept in titleSource and bodySource. When it asks for acceptance, every user accepts it at their next sign-in. The operator details must be filled in first.',
    responses: {
      '200': 'Published',
      '400':
        'Operator settings missing, the title too long with them filled in, or the draft note of an agreement template still in the text',
      '401': REAUTH,
      '409': 'Already published',
    },
  }),
  op('get', '/admin/audit', T, 'Administrative audit trail', {
    access: ADMIN,
    description:
      'What administrators and the system did to accounts, customers (facilities), subscriptions and invoices, operator settings and legal texts, with actor and target names. Actions by facility staff, rows about a patient and what the system did to a patient’s portal account (closing it when a death is registered) are never listed; a patient account is never named or identified (targetName and resourceId null, targetPatientAccount true).',
    params: [
      q('category', enumOf('all', 'users', 'billing', 'platform')),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
];
