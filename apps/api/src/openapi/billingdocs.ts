import type { ModuleOperation } from './modules.js';

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

export const BILLINGDOCS_OPERATIONS: ModuleOperation[] = [];
