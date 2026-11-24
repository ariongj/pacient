import type { ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: test e-mail, e-mail failures, operator alerts and heartbeats of outside jobs (/admin/platform, /ops).
 * Round 2, builder S2: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const OPERATIONS_TAGS = [
  {
    name: 'Operations',
    description:
      'E-mail deliverability, operator alerts and heartbeats of jobs that run outside the API (backups). No message contents and no patient data.',
  },
];

export const OPERATIONS_OPERATIONS: ModuleOperation[] = [];
