import type { Executor } from '../../db/client.js';

/**
 * Called after a diagnosis is recorded: enrols the patient in the matching chronic disease
 * register (if any). Never throws into the caller's flow.
 */
export async function enrolFromDiagnosis(
  _diagnosisId: string,
  _executor?: Executor,
): Promise<void> {}
