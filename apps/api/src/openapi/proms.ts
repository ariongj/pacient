import type { ModuleOperation } from './modules.js';

/** OpenAPI entries for patient-reported outcomes (/proms). */
export const PROMS_TAGS = [
  {
    name: 'Patient-reported outcomes',
    description:
      'Questionnaires (PHQ-9, GAD-7, EQ-5D and others) assigned to patients, scores and review.',
  },
];

export const PROMS_OPERATIONS: ModuleOperation[] = [];
