import { date, dateTime, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: payment reversals, credit notes and exports for the accountant (/admin, /subscription).
 * Round 2, builder B2: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const BILLINGCORRECTIONS_TAGS = [
  {
    name: 'Billing corrections',
    description:
      'Reversing a payment, credit notes (issued invoices are never changed) and CSV exports for the accountant.',
  },
];

const T = 'Billing corrections';
const ADMIN = 'ADMIN (platform administrator)';
const DIRECTOR = 'DIRECTOR (own facility)';
const REAUTH =
  'Needs the password again in the X-Reauth-Password header, or a sign-in within the last 10 minutes; otherwise 401 REAUTH_REQUIRED.';
const reason = str({ minLength: 5, maxLength: 500 });
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 100 }))];
const period = [
  { ...q('from', date, 'First day, in Kosovo (YYYY-MM-DD)'), required: true },
  { ...q('to', date, 'Last day, included; at most one year after `from`'), required: true },
];
const csv = (file: string, summary: string) =>
  op('get', `/admin/exports/${file}`, T, summary, {
    access: ADMIN,
    description: `${REAUTH} UTF-8 with a byte order mark, comma-separated, every cell quoted; text that a spreadsheet would run as a formula is kept as text. Amounts in euros with a decimal point, dates as calendar days in Kosovo. Audited as billing.exported with the export and its period only.`,
    params: period,
    responses: {
      '200': 'text/csv',
      '400': 'Invalid period',
      '401': 'REAUTH_REQUIRED',
    },
  });

export const BILLINGCORRECTIONS_OPERATIONS: ModuleOperation[] = [
  op('get', '/admin/invoices/{id}/account', T, 'Payments, credit notes and balance of an invoice', {
    access: ADMIN,
    description:
      'Payments (also reversed ones, with who recorded and reversed them), credit notes, refunds recorded, what was paid, credited and refunded, the balance still owed, the amount to refund (paid and credited beyond the total, less the refunds recorded) and whether the invoice may still be voided (voidBlock: NOT_OPEN, PAYMENTS, CREDIT_NOTES, NOT_THIS_MONTH, EMAILED).',
  }),
  op('post', '/admin/payments/{id}/reverse', T, 'Reverse a payment', {
    access: ADMIN,
    description: `${REAUTH} The payment stays on record, marked reversed with the reason. A settled invoice that is no longer paid in full opens again; an active subscription with an invoice then overdue is past due again (the grace period counts from the oldest overdue due date) – never suspended directly – and its directors are told and the invoice is e-mailed as an overdue reminder, also when they were told of that past-due period before. A subscription already past due keeps its grace period. Audited as billing.payment_reversed.`,
    body: obj({ reason }, ['reason']),
    responses: {
      '200': 'The invoice’s account',
      '401': 'REAUTH_REQUIRED',
      '404': 'No such payment',
      '409': 'Already reversed',
    },
  }),
  op('post', '/admin/invoices/{id}/credit-notes', T, 'Issue a credit note', {
    access: ADMIN,
    description: `${REAUTH} For at most the invoice total less earlier credit notes (VAT included). Numbered without gaps per calendar year in Kosovo (<prefix>-CN-2026-00001); issuer and customer copied from the invoice, VAT split at the invoice's rate. Settles an open invoice when it brings the balance to 0 (method CREDIT_NOTE); on a paid invoice the amount is to be refunded outside Pacient. E-mailed to the facility's billing addresses and directors; the directors are notified. Audited as billing.credit_note_issued.`,
    body: obj({ amountCents: int({ minimum: 1, maximum: 100_000_000 }), reason }, [
      'amountCents',
      'reason',
    ]),
    responses: {
      '201': 'The credit note',
      '401': 'REAUTH_REQUIRED',
      '409': 'Voided invoice, or more than is left to credit',
    },
  }),
  op('post', '/admin/invoices/{id}/refunds', T, 'Record a refund', {
    access: ADMIN,
    description: `${REAUTH} A refund made outside Pacient (by bank transfer) of money received and credited beyond the invoice total: amountCents (default: everything still to refund) of at most what is to refund, the day it was made (refundedAt; default now, not in the future) and the bank reference. Kept as a note in the subscription history; the invoice and its payments do not change. "To refund" goes down by it, and the facility's directors see when it was refunded. Audited as billing.subscription.changed (event REFUND_RECORDED).`,
    body: obj({
      amountCents: int({ minimum: 1, maximum: 100_000_000 }),
      refundedAt: dateTime,
      reference: str({ maxLength: 120 }),
    }),
    responses: {
      '200': 'The invoice’s account',
      '400': 'A date in the future or before the invoice',
      '401': 'REAUTH_REQUIRED',
      '409': 'Nothing to refund, or more than is to refund',
    },
  }),
  op('get', '/admin/credit-notes', T, 'Credit notes', {
    access: ADMIN,
    description: 'Newest first, with the invoice number and facility name.',
    params: [q('facilityId', uuid), q('invoiceId', uuid), ...page],
  }),
  op('get', '/admin/credit-notes/{id}', T, 'One credit note (printable)', {
    access: ADMIN,
    description: 'Its frozen issuer and customer details, and the invoice it corrects.',
  }),
  op('get', '/subscription/invoices/{id}/account', T, 'Payments and credit notes of my invoice', {
    access: DIRECTOR,
    description:
      'As for the administrator, without who recorded or reversed a payment and without the voiding details.',
    responses: { '200': 'The invoice’s account', '404': 'Not an invoice of your facility' },
  }),
  op('get', '/subscription/credit-notes', T, 'Credit notes of my facility', {
    access: DIRECTOR,
    params: [q('invoiceId', uuid), ...page],
  }),
  op('get', '/subscription/credit-notes/{id}', T, 'One credit note of my facility (printable)', {
    access: DIRECTOR,
    responses: { '200': 'The credit note', '404': 'Not a credit note of your facility' },
  }),
  csv('invoices.csv', 'Invoices issued in a period, with paid, credited and balance (CSV)'),
  csv(
    'payments.csv',
    'Payments by payment date; reversals as negative rows on the day reversed (CSV)',
  ),
  csv('credit-notes.csv', 'Credit notes issued in a period (CSV)'),
  csv(
    'sales-book.csv',
    'Sales book: invoices and credit notes by number, totals per VAT rate (CSV, Albanian)',
  ),
];
