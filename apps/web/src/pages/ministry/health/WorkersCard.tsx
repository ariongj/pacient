import { workerLabel } from '../../../api/operations';
import type { SystemHealthReport, WorkerStatus } from '../../../api/monitoring';
import { Alert, Badge, Card, EmptyState, Table } from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t, tn } from '../../../i18n';

/** "every 5 s", "every 10 min", "every 6 h", "once a day". */
function every(seconds: number): string {
  if (seconds < 60) return t('every {n} s', { n: seconds });
  if (seconds < 3600) return t('every {n} min', { n: Math.round(seconds / 60) });
  if (seconds < 86_400) return t('every {n} h', { n: Math.round(seconds / 3600) });
  return seconds === 86_400 ? t('once a day') : t('every {n} days', { n: seconds / 86_400 });
}

/**
 * A job the answering API instance does not run is neither "running" nor "stalled" for it: it is
 * switched off there, or another instance runs it, and only that one can tell (the server sends
 * stale: null).
 */
function State({ w }: { w: WorkerStatus }) {
  if (!w.running) return <Badge tone="neutral">{t('Not started by this instance')}</Badge>;
  if (w.stale) return <Badge tone="danger">{t('Stalled')}</Badge>;
  if (w.lastRunOk === false) return <Badge tone="warning">{t('Last run failed')}</Badge>;
  return <Badge tone="success">{t('Running')}</Badge>;
}

/**
 * System health (shared by the Ministry and the platform administrator): Background jobs: each
 * worker with its last run, last success, last error and whether it is stale (no successful run
 * for three of its intervals, and at least 5 minutes). The error texts give the error's class and
 * cause, never the data it failed on, and never name a person (the server cleans them).
 */
export function WorkersCard({ health }: { health: SystemHealthReport }) {
  const workers = health.workers;
  if (!workers) return null;
  const stalled = workers.filter((w) => w.stale);
  const elsewhere = workers.some((w) => !w.running);
  return (
    <Card title={t('Background jobs')}>
      {stalled.length > 0 ? (
        <Alert
          tone="danger"
          title={tn(
            stalled.length,
            '{count} background job has stopped',
            '{count} background jobs have stopped',
          )}
        >
          {t(
            'No successful run for three of its intervals, and for at least 5 minutes. The administrators are alerted; check the API log and restart the API if it does not recover.',
          )}
        </Alert>
      ) : (
        <p className="muted">
          {t(
            'Reminders, escalations, e-mail and the other jobs that run in the background. A job is stalled after three of its intervals without a successful run, and never sooner than 5 minutes.',
          )}
        </p>
      )}
      {elsewhere && (
        <p className="muted">
          {t(
            'Not started by this instance: switched off on the API instance that answered, or run by another one. Its last run and error are shown, but only an instance that runs a job judges whether it has stalled.',
          )}
        </p>
      )}
      {workers.length === 0 ? (
        <EmptyState title={t('No background job has run yet')} />
      ) : (
        <Table caption={t('Background jobs')}>
          <thead>
            <tr>
              <th scope="col">{t('Job')}</th>
              <th scope="col">{t('Status')}</th>
              <th scope="col">{t('Last run')}</th>
              <th scope="col">{t('Last success')}</th>
              <th scope="col">{t('Last error')}</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.name}>
                <th scope="row" style={{ fontWeight: 'normal' }}>
                  <strong>{workerLabel(w.name)}</strong>
                  <div className="muted">
                    <code>{w.name}</code>
                    {w.intervalSeconds !== null && <> · {every(w.intervalSeconds)}</>}
                  </div>
                </th>
                <td>
                  <State w={w} />
                </td>
                <td>{w.lastRunAt ? formatDateTime(w.lastRunAt) : t('Never')}</td>
                <td>{w.lastOkAt ? formatDateTime(w.lastOkAt) : t('Never')}</td>
                <td>
                  {w.lastError ? (
                    <>
                      <div>{formatDateTime(w.lastError.at)}</div>
                      {w.lastError.text && (
                        <div className="muted" lang="en" style={{ overflowWrap: 'anywhere' }}>
                          {w.lastError.text}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="muted">{t('None in 7 days')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
