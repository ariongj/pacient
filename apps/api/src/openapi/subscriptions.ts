import {
  arr,
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

/** OpenAPI entries: plans, facilities' subscriptions, their history, invoices and payments. */
export const SUBSCRIPTIONS_TAGS = [
  {
    name: 'Subscriptions',
    description:
      'Plans, facilities’ subscriptions, their history (append-only), invoices and payments. The subscription status never restricts clinical access or existing accounts; it only limits new staff accounts (seats).',
  },
];

const T = 'Subscriptions';
const ADMIN = 'ADMIN (platform administrator)';
const cents = int({ minimum: 0, maximum: 100_000_000 });
const seats = int({ minimum: 1, maximum: 100_000 });
const cycle = enumOf('MONTHLY', 'YEARLY');
const STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];
const reasonBody = obj({ reason: str({ minLength: 5, maxLength: 1000 }) }, ['reason']);
const plan = {
  code: str({ pattern: '^[A-Za-z0-9-]{2,40}$' }),
  name: str({ minLength: 2, maxLength: 120 }),
  description: str({ maxLength: 1000 }),
  monthlyPriceCents: cents,
  yearlyPriceCents: cents,
  currency: enumOf('EUR'),
  seatLimit: { ...seats, nullable: true, description: 'Staff accounts included; null = unlimited' },
  features: arr(str({ maxLength: 120 }), { maxItems: 10 }),
  isActive: bool,
  sortOrder: int({ minimum: 0, maximum: 1000 }),
};
const start = obj(
  {
    planId: uuid,
    billingCycle: cycle,
    trial: { ...bool, description: 'Trial for the number of days in the operator settings' },
    seats: { ...seats, nullable: true },
    priceCents: { ...cents, description: 'Agreed price per cycle; default: the plan price' },
    note: str({ maxLength: 1000 }),
  },
  ['planId'],
);
const facility = obj(
  {
    code: str({ pattern: '^[A-Za-z0-9-]{2,32}$' }),
    name: str({ minLength: 2, maxLength: 200 }),
    type: enumOf(
      'UNIVERSITY_CLINICAL_CENTER',
      'REGIONAL_HOSPITAL',
      'FAMILY_MEDICINE_CENTER',
      'SPECIALIZED_CLINIC',
    ),
    region: str({ minLength: 2, maxLength: 100 }),
    municipality: str({ minLength: 2, maxLength: 100 }),
    address: str({ maxLength: 300 }),
    phone: str({ maxLength: 40 }),
  },
  ['code', 'name', 'type', 'region', 'municipality'],
);
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];

export const SUBSCRIPTIONS_OPERATIONS: ModuleOperation[] = [
  op('get', '/admin/plans', T, 'Subscription plans', {
    access: ADMIN,
    description: 'With the number of running subscriptions on each plan.',
  }),
  op('post', '/admin/plans', T, 'Create a plan', {
    access: ADMIN,
    body: obj(plan, ['code', 'name', 'monthlyPriceCents', 'yearlyPriceCents']),
    responses: { '201': 'Plan', '409': 'Code already used' },
  }),
  op('patch', '/admin/plans/{id}', T, 'Change a plan (or stop offering it)', {
    access: ADMIN,
    description:
      'Only the fields sent change. Running subscriptions keep their agreed price and seat limit; changes apply to new subscriptions and plan changes.',
    body: obj(plan),
  }),
  op('get', '/admin/organizations', T, 'Facilities with their subscription', {
    access: ADMIN,
    description:
      'Plan, status, cycle, price, seats used and limit, period and trial end, open and overdue invoices; with KPIs (monthly recurring revenue, counts by status).',
    params: [q('q', str({ maxLength: 100 })), q('status', enumOf(...STATUSES, 'NONE'))],
  }),
  op('post', '/admin/organizations', T, 'A new customer: facility, subscription, first director', {
    access: ADMIN,
    description:
      'Creates the facility, starts its subscription and invites the first director (the activation link is e-mailed; outside production it is also returned once).',
    body: obj(
      {
        facility,
        director: obj(
          { email: str({ format: 'email' }), fullName: str({ minLength: 2, maxLength: 200 }) },
          ['email', 'fullName'],
        ),
        subscription: start,
      },
      ['facility'],
    ),
    responses: { '201': 'The facility with its subscription', '409': 'Code or e-mail taken' },
  }),
  op('get', '/admin/organizations/{facilityId}', T, 'One facility’s subscription', {
    access: ADMIN,
    description:
      'Facility, subscription and plan, seats used and limit, the history (newest first, with who and which plans), invoices and directors.',
  }),
  op('post', '/admin/organizations/{facilityId}/subscription', T, 'Start a subscription', {
    access: ADMIN,
    description:
      'A trial (no invoice) or an active subscription whose first invoice is issued now. The plan’s seat limit is agreed with it. A cancelled or expired subscription can be started again once the invoices of the earlier one are paid or voided.',
    body: start,
    responses: {
      '201': 'The facility with its subscription',
      '409': 'Already subscribed, or invoices of the earlier subscription still open',
    },
  }),
  op('post', '/admin/subscriptions/{id}/change', T, 'Change plan, cycle, seats or price', {
    access: ADMIN,
    description:
      'Plan, seats and price take effect now; the next invoice uses them, and a new plan brings its seat limit. A new billing cycle takes effect at the next renewal (nextBillingCycle, nextPriceCents): the current period keeps its cycle and price, also when its invoice is issued again; choosing the current cycle again withdraws the change. A trial changes its cycle at once. A new plan or cycle takes the catalogue price unless a price (per the chosen cycle) is given.',
    body: obj({
      planId: uuid,
      billingCycle: cycle,
      seats: { ...seats, nullable: true },
      priceCents: cents,
      note: str({ maxLength: 1000 }),
    }),
  }),
  op('post', '/admin/subscriptions/{id}/activate', T, 'End a trial now (first invoice)', {
    access: ADMIN,
    responses: {
      '200': 'The facility with its subscription',
      '409': 'Not a trial, or a cancellation is scheduled (withdraw it first)',
    },
  }),
  op('post', '/admin/subscriptions/{id}/suspend', T, 'Suspend (no new staff accounts)', {
    access: ADMIN,
    description:
      'Clinical access, sign-in and existing accounts are unaffected. The reason is shown to the facility’s directors. Suspended by hand (suspensionCause MANUAL), it is lifted only by reactivating – not by a payment. A scheduled cancellation stays and takes effect at the end of the period.',
    body: reasonBody,
  }),
  op('post', '/admin/subscriptions/{id}/reactivate', T, 'Reactivate a suspended subscription', {
    access: ADMIN,
    description:
      'Active again – or past due with a fresh grace period while invoices are still overdue; a trial suspended before it ended is a trial again. A period that ended while suspended starts again now, with its invoice – unless a cancellation was scheduled for its end: then the subscription ends as scheduled, without a new invoice.',
    body: obj({ note: str({ maxLength: 1000 }) }),
  }),
  op('post', '/admin/subscriptions/{id}/cancel', T, 'Cancel now or at the end of the period', {
    access: ADMIN,
    description:
      'Open invoices, also the one of the current period, stay open: they are paid or voided. A cancellation scheduled for the end of the period also takes effect while the subscription is suspended.',
    body: obj({ atPeriodEnd: bool, reason: str({ minLength: 5, maxLength: 1000 }) }, [
      'atPeriodEnd',
      'reason',
    ]),
  }),
  op(
    'post',
    '/admin/subscriptions/{id}/withdraw-cancellation',
    T,
    'Withdraw a scheduled cancellation',
    {
      access: ADMIN,
    },
  ),
  op('post', '/admin/subscriptions/{id}/notes', T, 'Internal note in the history', {
    access: ADMIN,
    description: 'Not shown to the facility.',
    body: obj({ note: str({ minLength: 2, maxLength: 1000 }) }, ['note']),
  }),
  op('post', '/admin/subscriptions/{id}/invoices', T, 'Invoice the current period', {
    access: ADMIN,
    description:
      'Only when the period has no (non-void) invoice yet, with the period’s billing cycle and price; never for the free trial period. Number without gaps per year; VAT and payment terms from the operator settings (due at the end of the due day in Kosovo; nothing to pay: issued as paid); issuer and customer details frozen.',
    responses: {
      '201': 'The facility with its invoices',
      '409': 'Trial, ended, already invoiced, or a period that does not match the billing cycle',
    },
  }),
  op('get', '/admin/invoices', T, 'Invoices', {
    access: ADMIN,
    description:
      'With totals: open, overdue, paid this year (the calendar year in Kosovo). An open invoice is overdue once its due date has passed in Kosovo; an invoice with nothing to pay never is.',
    params: [
      q('status', enumOf('open', 'overdue', 'paid', 'void', 'all')),
      q('facilityId', uuid),
      ...page,
    ],
  }),
  op('get', '/admin/invoices/{id}', T, 'One invoice (printable)'),
  op('post', '/admin/invoices/{id}/payments', T, 'Record a payment', {
    access: ADMIN,
    description:
      'Marks the invoice paid. When nothing is overdue any more, a past-due subscription, or one suspended for non-payment, is active again; otherwise the grace period counts from the oldest invoice still overdue. A suspension by the administrator stays until reactivated. A cancellation scheduled for a date that has passed takes effect.',
    body: obj(
      {
        paidAt: dateTime,
        method: enumOf('BANK_TRANSFER', 'CASH', 'CARD', 'OTHER'),
        reference: str({ maxLength: 120 }),
      },
      ['method'],
    ),
    responses: { '200': 'The invoice', '409': 'Already paid or voided' },
  }),
  op('post', '/admin/invoices/{id}/void', T, 'Void an open invoice', {
    access: ADMIN,
    description:
      'Paid invoices cannot be voided; invoices are never deleted. Afterwards the subscription’s standing is checked as after a payment.',
    body: reasonBody,
  }),
  op('get', '/subscription', T, 'My facility’s subscription', {
    access: 'DIRECTOR (own facility)',
    description:
      'Plan, status, seats used and limit, history (without the operator’s internal notes; changes by the operator are not attributed to a named person) and invoices.',
  }),
  op('get', '/subscription/invoices/{id}', T, 'One invoice of my facility (printable)', {
    access: 'DIRECTOR (own facility)',
    responses: { '200': 'The invoice', '404': 'Not an invoice of your facility' },
  }),
];
