import type { SystemHealthReport } from '../../../api/monitoring';

/**
 * System health (shared by the Ministry and the platform administrator): Background jobs: each worker with its last run, last success, last error and whether it is stale.
 * Round 2, builder S2. Renders nothing until built.
 */
export function WorkersCard(_props: { health: SystemHealthReport }) {
  return null;
}
