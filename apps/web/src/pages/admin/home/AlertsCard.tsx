import { Link } from 'react-router-dom';
import { alertLink, alertTitle, useOperatorAlerts } from '../../../api/operations';
import { Alert, Card } from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t, tn } from '../../../i18n';

/**
 * Platform overview (AdminHome): open operator alerts – a stalled background job, e-mail or SMS
 * that does not go out, no recent backup, billing settings that stop invoicing – critical first,
 * each with what to do (the server's message, in English) and where to do it. The administrators
 * were also told by notification and e-mail. Renders nothing while all is well, or when the alerts
 * cannot be loaded (the overview stays usable); it sits between other cards of the page, so it
 * has its own bottom margin.
 */
export function AlertsCard() {
  const query = useOperatorAlerts();
  const alerts = query.data?.items ?? [];
  if (alerts.length === 0) return null;
  const critical = alerts.filter((a) => a.severity === 'CRITICAL').length;
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <Card
        title={
          critical > 0
            ? tn(critical, '{count} critical alert', '{count} critical alerts')
            : tn(alerts.length, '{count} alert', '{count} alerts')
        }
      >
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {alerts.map((a) => {
            const link = alertLink(a.conditionKey);
            return (
              <li key={a.id}>
                <Alert
                  tone={a.severity === 'CRITICAL' ? 'danger' : 'warning'}
                  title={`${a.severity === 'CRITICAL' ? t('Critical') : t('Warning')}: ${alertTitle(a.conditionKey)}`}
                >
                  <p lang="en" style={{ margin: '0.25rem 0' }}>
                    {a.message}
                  </p>
                  <p className="muted" style={{ margin: 0 }}>
                    {t('Since {time}', { time: formatDateTime(a.firstSeenAt) })} ·{' '}
                    {t('last checked {time}', { time: formatDateTime(a.lastSeenAt) })}
                    {link && (
                      <>
                        {' '}
                        · <Link to={link.to}>{link.label}</Link>
                      </>
                    )}
                  </p>
                </Alert>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
