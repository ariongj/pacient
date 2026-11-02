import { t } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { EmailHealth, GenericReport } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { Badge, Card, ErrorAlert, Grid, Loading, QueryView, Stat } from '../../components/ui';
import { formatNumber } from '../../format';

const DAY = 86_400_000;
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const sum = (rows: GenericReport['rows'], key: string) => rows.reduce((a, r) => a + n(r[key]), 0);

function since(iso: string | null | undefined): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return t('{count} min', { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? t('{count} h', { count: hours })
    : t('{count} days', { count: Math.round(hours / 24) });
}

/** Outbox health (Ministry only): counts by status over the last 7 days, never content. */
function Delivery({ channel }: { channel: 'email' | 'sms' }) {
  const q = useQuery({
    queryKey: ['stats', channel],
    queryFn: () => api<EmailHealth>(`/stats/${channel}`),
    refetchInterval: 60_000,
  });
  return (
    <div className="stack" style={{ marginTop: '1rem' }}>
      <h3>
        {channel === 'email' ? t('Email delivery (last 7 days)') : t('SMS delivery (last 7 days)')}
      </h3>
      <QueryView query={q}>
        {(h) => {
          const pending = (h.PENDING?.count ?? 0) + (h.SENDING?.count ?? 0);
          const failed = h.FAILED?.count ?? 0;
          return (
            <>
              <Grid min={160}>
                <Stat
                  label={t('Delivered')}
                  value={formatNumber(h.SENT?.count ?? 0)}
                  tone="success"
                />
                <Stat
                  label={t('Waiting to send')}
                  value={formatNumber(pending)}
                  tone={pending > 0 ? 'warning' : undefined}
                  hint={
                    h.PENDING?.oldest
                      ? t('Oldest waiting {time}', { time: since(h.PENDING.oldest) })
                      : undefined
                  }
                />
                <Stat
                  label={t('Failed')}
                  value={
                    <span className="row">
                      {formatNumber(failed)}
                      {failed > 0 && <Badge tone="danger">{t('Needs attention')}</Badge>}
                    </span>
                  }
                  tone={failed > 0 ? 'danger' : undefined}
                  hint={t('Gave up after repeated attempts')}
                />
              </Grid>
              <p className="muted" style={{ margin: 0 }}>
                {channel === 'email'
                  ? t(
                      'Activation, password-reset and notification emails are queued and retried automatically. If SMTP is not configured on the server, emails stay waiting until it is.',
                    )
                  : t(
                      'Verification codes and important alerts are queued and retried automatically; non-urgent texts wait for the end of quiet hours. If no SMS provider is configured, texts stay waiting until one is.',
                    )}
              </p>
            </>
          );
        }}
      </QueryView>
    </div>
  );
}

/**
 * Workforce, security posture and pharmacy queue health – built from the aggregate report API,
 * so directors see their facility and the Ministry sees national totals.
 */
export function OperationsPanel({ reportsPath }: { reportsPath: string }) {
  const isMinistry = useUser().role === 'MINISTRY';
  const from = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const workforce = useQuery({
    queryKey: ['reports', 'workforce', {}],
    queryFn: () => api<GenericReport>('/reports/workforce'),
  });
  const pharmacy = useQuery({
    queryKey: ['reports', 'pharmacy', { from }],
    queryFn: () => api<GenericReport>('/reports/pharmacy', { query: { from } }),
  });

  if (workforce.isPending || pharmacy.isPending)
    return <Loading label={t('Loading operations…')} />;
  if (workforce.error || pharmacy.error)
    return <ErrorAlert error={workforce.error ?? pharmacy.error} />;

  const w = workforce.data!.rows;
  const p = pharmacy.data!.rows;
  const staff = sum(w, 'activeStaff');
  const twoStep = w.reduce((a, r) => a + (n(r.twoStepPct) / 100) * n(r.activeStaff), 0);
  const adoption = staff ? Math.round((twoStep / staff) * 100) : 0;
  const prescriptions = sum(p, 'prescriptions');
  const returned = sum(p, 'returned');
  const awaiting = sum(p, 'awaitingVerification');
  const overdueTasks = sum(w, 'overdueCareTasks');

  return (
    <Card
      title={t('Workforce & operations')}
      actions={
        <span className="row">
          <Link to="/channels">{t('Team channels')}</Link>
          <Link to={reportsPath}>{t('All reports')}</Link>
        </span>
      }
    >
      <Grid min={160}>
        <Stat label={t('Doctors')} value={formatNumber(sum(w, 'doctors'))} />
        <Stat label={t('Nurses')} value={formatNumber(sum(w, 'nurses'))} />
        <Stat label={t('Pharmacists')} value={formatNumber(sum(w, 'pharmacists'))} />
        <Stat label={t('Reception')} value={formatNumber(sum(w, 'reception'))} />
        <Stat
          label={t('Two-step sign-in')}
          value={`${adoption}%`}
          tone={adoption >= 95 ? 'success' : adoption >= 60 ? 'warning' : 'danger'}
          hint={t('{done} of {total} active staff', {
            done: formatNumber(Math.round(twoStep)),
            total: formatNumber(staff),
          })}
        />
        <Stat
          label={t('Awaiting pharmacy verification')}
          value={formatNumber(awaiting)}
          tone={awaiting > 10 ? 'warning' : undefined}
          hint={t('Prescriptions, last 30 days')}
        />
        <Stat
          label={t('Pharmacy return rate')}
          value={prescriptions ? `${Math.round((returned / prescriptions) * 1000) / 10}%` : '—'}
          hint={t('{count} returned to prescribers (30 days)', { count: formatNumber(returned) })}
        />
        <Stat
          label={t('Overdue care tasks')}
          value={formatNumber(overdueTasks)}
          tone={overdueTasks > 0 ? 'danger' : undefined}
        />
      </Grid>
      {isMinistry && (
        <>
          <Delivery channel="email" />
          <Delivery channel="sms" />
        </>
      )}
    </Card>
  );
}
