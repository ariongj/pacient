import { arr, enumOf, obj, op, q, str, type ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: billing details of facilities, invoice and credit note PDFs, and e-mailing them to the customer (/admin, /subscription).
 * Round 2, builder B1: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const BILLINGDOCS_TAGS = [
  {
    name: 'Billing documents',
    description:
      'Who is invoiced (billing details), invoice and credit note PDFs, and e-mailing them to the facility’s billing addresses and directors. Business data only, never clinical data.',
  },
];

const T = 'Billing documents';
const ADMIN = 'ADMIN (platform administrator); never clinical data';
const DIRECTOR = 'DIRECTOR of the facility (own facility only)';
const localeParam = q(
  'locale',
  enumOf('sq', 'sr', 'en'),
  'Language of the document; default the account’s own language',
);
const PDF = {
  '200': 'The PDF (application/pdf, as a download)',
  '404': 'Unknown document (or, for a director, another facility’s)',
};

/** Fields of a facility's billing details. */
export const billingProfileBody = obj(
  {
    legalName: str({ minLength: 2, maxLength: 200 }),
    businessNumber: str({ maxLength: 40, nullable: true, description: 'NUI' }),
    fiscalNumber: str({ maxLength: 40, nullable: true }),
    vatNumber: str({ maxLength: 40, nullable: true }),
    billingAddress: str({ maxLength: 500, nullable: true }),
    billingEmails: arr(str({ format: 'email', maxLength: 254 }), {
      maxItems: 3,
      description: 'Stored in lower case, each once',
    }),
    contactName: str({ maxLength: 200, nullable: true }),
    customerReference: str({
      maxLength: 120,
      nullable: true,
      description: 'The customer’s purchase order or contract number, printed on invoices',
    }),
  },
  ['legalName'],
);

export const BILLINGDOCS_OPERATIONS: ModuleOperation[] = [
  op('get', '/admin/billing-readiness', T, 'Whether invoices can be issued', {
    access: ADMIN,
    description:
      'Invoices need the operator’s name, address, fiscal number (NUI), IBAN and, while VAT is charged, the VAT number. Lists the missing settings (field and label); while any is missing, every action that issues an invoice answers 409 BILLING_NOT_READY and the subscription worker leaves trial ends and renewals for its next run.',
  }),
  op(
    'get',
    '/admin/organizations/{facilityId}/billing-profile',
    T,
    'A facility’s billing details',
    {
      access: ADMIN,
      description:
        'The legal entity that is invoiced, its numbers, billing address, billing e-mails, contact and reference, with who changed them last; `profile` is null while none were entered.',
      responses: { '200': '{ profile }', '404': 'Unknown facility' },
    },
  ),
  op(
    'put',
    '/admin/organizations/{facilityId}/billing-profile',
    T,
    'Save a facility’s billing details',
    {
      access: ADMIN,
      description:
        'Creates or replaces them. Audited (billing.profile_changed, with the names of the changed fields) and noted in the subscription’s internal history, in the same transaction. The next invoice copies them; issued invoices never change.',
      body: billingProfileBody,
      responses: { '200': '{ profile }', '400': 'Invalid details', '404': 'Unknown facility' },
    },
  ),
  op('get', '/subscription/billing-profile', T, 'My facility’s billing details', {
    access: DIRECTOR,
    description: 'Read-only: the operator keeps them. `profile` is null while none were entered.',
  }),

  op('get', '/admin/invoices/{id}/pdf', T, 'Invoice PDF', {
    access: ADMIN,
    description:
      'A4, with the operator and the customer as frozen on the invoice, the lines, VAT (or “Not registered for VAT”), the total, the due date, IBAN and the payment reference.',
    params: [localeParam],
    responses: PDF,
  }),
  op('get', '/admin/credit-notes/{id}/pdf', T, 'Credit note PDF', {
    access: ADMIN,
    description: 'Like an invoice, with the invoice it corrects and the reason.',
    params: [localeParam],
    responses: PDF,
  }),
  op('get', '/admin/invoices/{id}/deliveries', T, 'Who an invoice was e-mailed to', {
    access: ADMIN,
    description:
      'Each message: why (ISSUED, REMINDER, RESEND), to which address, when it was queued and by whom, and its outbox status (sent, waiting, failed).',
  }),
  op('get', '/admin/credit-notes/{id}/deliveries', T, 'Who a credit note was e-mailed to', {
    access: ADMIN,
    description: 'As for invoices.',
  }),
  op('post', '/admin/invoices/{id}/send', T, 'E-mail an invoice again', {
    access: ADMIN,
    description:
      'Queues the invoice (PDF attached when sent) to every billing e-mail of the facility and every active director, each address once. Audited (billing.invoice_sent) in the same transaction.',
    responses: {
      '200': '{ queued, items }: how many messages, and the deliveries',
      '404': 'Unknown invoice',
      '409': 'A voided invoice, or nobody to send it to',
    },
  }),
  op('post', '/admin/credit-notes/{id}/send', T, 'E-mail a credit note again', {
    access: ADMIN,
    description: 'As for invoices. Audited (billing.invoice_sent, resource credit_note).',
    responses: {
      '200': '{ queued, items }',
      '404': 'Unknown credit note',
      '409': 'Nobody to send it to',
    },
  }),

  op('get', '/subscription/documents', T, 'My facility’s invoices and credit notes', {
    access: DIRECTOR,
    description: 'Number, date, total and state of each, to download as PDF.',
  }),
  op('get', '/subscription/invoices/{id}/pdf', T, 'One of my facility’s invoices as PDF', {
    access: DIRECTOR,
    params: [localeParam],
    responses: PDF,
  }),
  op('get', '/subscription/credit-notes/{id}/pdf', T, 'One of my facility’s credit notes as PDF', {
    access: DIRECTOR,
    params: [localeParam],
    responses: PDF,
  }),
];
