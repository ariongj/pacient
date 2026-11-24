import type { SystemHealthReport } from '../../../api/monitoring';
import { Alert, Badge, Card, DefinitionList } from '../../../components/ui';
import { formatDateTime, formatNumber } from '../../../format';
import { t } from '../../../i18n';

function size(bytes: number): string {
  return bytes >= 1_073_741_824
    ? t('{n} GB', { n: formatNumber(Math.round((bytes / 1_073_741_824) * 10) / 10) })
    : t('{n} MB', { n: formatNumber(Math.max(1, Math.round(bytes / 1_048_576))) });
}

function seconds(s: number): string {
  return s < 120 ? t('{n} s', { n: Math.round(s) }) : t('{n} min', { n: Math.round(s / 60) });
}

/**
 * System health (shared by the Ministry and the platform administrator): Backups: the last
 * successful backup reported by deploy/backup.sh (heartbeat), with its size and duration. Without
 * the heartbeat token the API does not know about backups and says how to turn it on.
 */
export function BackupsCard({ health }: { health: SystemHealthReport }) {
  const b = health.backups;
  if (!b) return null;
  if (!b.monitored) {
    return (
      <Card title={t('Backups')}>
        <Alert tone="info" title={t('Backups are not reported to Pacient')}>
          {t(
            'Set OPS_HEARTBEAT_TOKEN on the server: the nightly backup then reports each success, and the administrators are alerted when none arrived for {hours} hours (GO-LIVE.md, Backups).',
            { hours: b.maxAgeHours },
          )}
        </Alert>
      </Card>
    );
  }
  return (
    <Card title={t('Backups')}>
      {b.stale && (
        <Alert
          tone="danger"
          title={t('No backup for more than {hours} hours', { hours: b.maxAgeHours })}
        >
          {t(
            'Check the backup timer on the server (systemctl status pacienti-backup.timer). Until a backup succeeds, data entered since the last one cannot be restored.',
          )}
        </Alert>
      )}
      <DefinitionList
        items={[
          [
            t('Status'),
            b.stale ? (
              <Badge tone="danger">{t('Too old')}</Badge>
            ) : b.lastOkAt ? (
              <Badge tone="success">{t('Up to date|backup')}</Badge>
            ) : (
              <Badge tone="neutral">{t('Waiting for the first backup')}</Badge>
            ),
          ],
          [t('Last successful backup'), b.lastOkAt ? formatDateTime(b.lastOkAt) : t('Never')],
          [t('Size'), b.detail?.sizeBytes !== undefined ? size(b.detail.sizeBytes) : null],
          [
            t('Duration'),
            b.detail?.durationSeconds !== undefined ? seconds(b.detail.durationSeconds) : null,
          ],
        ]}
      />
      <p className="muted" style={{ margin: '0.75rem 0 0' }}>
        {t(
          'A backup that was never restored is not a backup: check a restore every month (deploy/restore-verify.sh).',
        )}
      </p>
    </Card>
  );
}
