import type { SystemHealthReport } from '../../../api/monitoring';
import { useEmailFailures, useSendTestEmail, type EmailFailure } from '../../../api/operations';
import { useUser } from '../../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  QueryView,
  Table,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t, tn } from '../../../i18n';

const TEMPLATE_LABELS: Record<string, () => string> = {
  activation: () => t('Account activation'),
  password_reset: () => t('Password reset'),
  notification: () => t('Notification'),
  test_email: () => t('Test e-mail'),
  billing_document: () => t('Invoice or credit note'),
};
const templateLabel = (template: string) => TEMPLATE_LABELS[template]?.() ?? template;

function FailureState({ f, max }: { f: EmailFailure; max: number }) {
  return f.status === 'FAILED' ? (
    <>
      <Badge tone="danger">{t('Given up')}</Badge>
      {f.failedAt && <div className="muted">{formatDateTime(f.failedAt)}</div>}
    </>
  ) : (
    <>
      <Badge tone="warning">
        {t('Retrying ({attempts} of {max})', { attempts: f.attempts, max })}
      </Badge>
      {f.nextAttemptAt && (
        <div className="muted">
          {t('Next attempt {time}', { time: formatDateTime(f.nextAttemptAt) })}
        </div>
      )}
    </>
  );
}

function TestEmail() {
  const send = useSendTestEmail();
  const result = send.data;
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {t(
          'Sends one message to your own address, through the same queue and mail server as every e-mail of Pacient. Check that it arrives and that it is not in the spam folder.',
        )}
      </p>
      <div>
        <Button variant="secondary" loading={send.isPending} onClick={() => send.mutate()}>
          {t('Send a test e-mail')}
        </Button>
      </div>
      <div aria-live="polite">
        {result &&
          (result.deliveryConfigured ? (
            <Alert tone="success" title={t('Test e-mail queued for {email}', { email: result.to })}>
              {t(
                'It should arrive within a minute. If it does not, look below for the error, and check the SPF, DKIM and DMARC records of the sending domain.',
              )}
            </Alert>
          ) : (
            <Alert tone="warning" title={t('E-mail delivery is not configured')}>
              {t(
                'The server has no mail server (SMTP_URL), so the message waits in the queue with every other e-mail. Set it up as described in GO-LIVE.md, E-mail.',
              )}
            </Alert>
          ))}
        <ErrorAlert error={send.error} />
      </div>
    </div>
  );
}

function RecentFailures() {
  const q = useEmailFailures(true);
  return (
    <QueryView query={q}>
      {(d) => (
        <div className="stack">
          <p style={{ margin: 0 }}>
            {tn(
              d.failedLast24h,
              '{count} e-mail given up in the last 24 hours',
              '{count} e-mails given up in the last 24 hours',
            )}{' '}
            · {tn(d.retrying, '{count} being retried', '{count} being retried')}
          </p>
          {d.items.length === 0 ? (
            <EmptyState title={t('No failed e-mails')} />
          ) : (
            <Table caption={t('Recent e-mail failures')}>
              <thead>
                <tr>
                  <th scope="col">{t('Recipient')}</th>
                  <th scope="col">{t('Message')}</th>
                  <th scope="col">{t('Status')}</th>
                  <th scope="col">{t('Error from the mail server')}</th>
                  <th scope="col">{t('Queued')}</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <code>{f.recipient}</code>
                    </td>
                    <td>{templateLabel(f.template)}</td>
                    <td>
                      <FailureState f={f} max={d.maxAttempts} />
                    </td>
                    <td lang="en" style={{ overflowWrap: 'anywhere' }}>
                      {f.lastError ?? '—'}
                    </td>
                    <td>{formatDateTime(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </QueryView>
  );
}

/**
 * System health (shared by the Ministry and the platform administrator): E-mail: "Send a test
 * e-mail" and "Recent failures" (masked recipients, the mail server's error; never the subject or
 * the text). For the platform administrator only: the Ministry's page leaves it out.
 */
export function EmailCard(_props: { health: SystemHealthReport }) {
  const isAdmin = useUser().role === 'ADMIN';
  if (!isAdmin) return null;
  return (
    <Card title={t('E-mail delivery')}>
      <div className="stack">
        <section aria-labelledby="email-test-heading" className="stack">
          <h3 id="email-test-heading" style={{ margin: 0 }}>
            {t('Send a test e-mail')}
          </h3>
          <TestEmail />
        </section>
        <section aria-labelledby="email-failures-heading" className="stack">
          <h3 id="email-failures-heading" style={{ margin: 0 }}>
            {t('Recent failures')}
          </h3>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              'Messages the mail server refused, newest first. Addresses are shortened and the contents are never shown.',
            )}
          </p>
          <RecentFailures />
        </section>
      </div>
    </Card>
  );
}
