/**
 * Medication safety decision support. The checks live in the safety engine
 * (modules/safety/engine.ts): interactions, duplicate therapy, allergies with cross-reactivity,
 * kidney function, age and pregnancy. This module keeps the historic import path for callers.
 *
 * The checks flag possible problems for a professional to review; they are based on a curated demo
 * knowledge set, not a validated clinical database (see docs/BLUEPRINT-ALIGNMENT.md).
 */
export {
  checkMedication,
  evaluate,
  ingredientsFromText,
  loadContexts,
  toPublicAlert,
  type EngineAlert,
  type PublicAlert,
} from '../modules/safety/engine.js';
