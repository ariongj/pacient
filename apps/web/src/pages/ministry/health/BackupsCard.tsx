import type { SystemHealthReport } from '../../../api/monitoring';

/**
 * System health (shared by the Ministry and the platform administrator): Backups: the last successful backup reported by deploy/backup.sh (heartbeat).
 * Round 2, builder S2. Renders nothing until built.
 */
export function BackupsCard(_props: { health: SystemHealthReport }) {
  return null;
}
