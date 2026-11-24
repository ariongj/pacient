import type { ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: the service agreement and the data processing agreement accepted per facility (/subscription, /admin).
 * Round 2, builder G: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const AGREEMENTS_TAGS = [
  {
    name: 'Agreements',
    description:
      'The service agreement and the data processing agreement, accepted once per facility by a director. A missing acceptance never blocks anything.',
  },
];

export const AGREEMENTS_OPERATIONS: ModuleOperation[] = [];
