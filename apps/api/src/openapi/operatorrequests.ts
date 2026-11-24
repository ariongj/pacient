import type { ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: facilities’ requests to the operator of the service (/operator-requests, /admin/requests).
 * Round 2, builder G: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const OPERATORREQUESTS_TAGS = [
  {
    name: 'Requests to the operator',
    description:
      'Requests from a facility’s directors and IT support to the operator of the service (billing, accounts, technical, data protection, security incidents). Never about a patient.',
  },
];

export const OPERATORREQUESTS_OPERATIONS: ModuleOperation[] = [];
