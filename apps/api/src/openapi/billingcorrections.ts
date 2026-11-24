import type { ModuleOperation } from './modules.js';

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

export const BILLINGCORRECTIONS_OPERATIONS: ModuleOperation[] = [];
