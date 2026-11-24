import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  cycleLabel,
  formatMoney,
  perCycle,
  seatsText,
  SUBSCRIPTION_STATUSES,
  subscriptionStatusLabel,
  useOrganizations,
  type OrganizationRow,
} from '../../api/subscriptions';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, formatNumber } from '../../format';
import { t, tn } from '../../i18n';
import { NewCustomerForm } from './billing/NewCustomerForm';
import { SubscriptionBadge } from './billing/parts';

/** The next date that matters: the end of a trial, a renewal, or the end of a cancelled one. */
function NextDate({ o }: { o: OrganizationRow }) {
  const s = o.subscription;
  if (!s) return <>—</>;
  if (s.status === 'TRIAL') {
    return (
      <>
        {formatDate(s.trialEndsAt)}
        <div className="muted">{s.cancelAtPeriodEnd ? t('Ends then') : t('Trial ends')}</div>
      </>
    );
  }
  if (s.status === 'CANCELLED' || s.status === 'EXPIRED') {
    return (
      <>
        {formatDate(s.cancelledAt)}
        <div className="muted">{t('Ended')}</div>
      </>
    );
  }
  // A suspended subscription does not renew; a scheduled cancellation still ends it.
  if (s.status === 'SUSPENDED' && !s.cancelAtPeriodEnd) return <>—</>;
  return (
    <>
      {formatDate(s.currentPeriodEnd)}
      <div className="muted">{s.cancelAtPeriodEnd ? t('Ends then') : t('Renews')}</div>
    </>
  );
}

/** Every facility with its plan, status, seats and renewal. */
export function Organizations() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useOrganizations({ q, status });

  return (
    <>
      <PageHeader
        title={t('Facilities and subscriptions')}
        subtitle={t('Every facility with its plan, status, seats and renewal.')}
        actions={<Button onClick={() => setAdding(true)}>{t('New customer')}</Button>}
      />
      <QueryView query={query}>
        {(data) => (
          <div className="stack">
            <Grid min={150}>
              <Stat
                label={t('Monthly recurring revenue')}
                value={formatMoney(data.kpis.mrrCents, data.kpis.currency)}
                hint={t('Active and overdue subscriptions; yearly plans counted per month.')}
              />
              <Stat
                label={t('Active|subscription status')}
                value={formatNumber(data.kpis.byStatus.ACTIVE ?? 0)}
                tone="success"
              />
              <Stat
                label={t('Trial|subscription status')}
                value={formatNumber(data.kpis.byStatus.TRIAL ?? 0)}
                tone="info"
              />
              <Stat
                label={t('Payment overdue|subscription status')}
                value={formatNumber(data.kpis.byStatus.PAST_DUE ?? 0)}
                tone={data.kpis.byStatus.PAST_DUE ? 'warning' : undefined}
              />
              <Stat
                label={t('Suspended|subscription status')}
                value={formatNumber(data.kpis.byStatus.SUSPENDED ?? 0)}
                tone={data.kpis.byStatus.SUSPENDED ? 'danger' : undefined}
              />
              <Stat label={t('Without a subscription')} value={formatNumber(data.kpis.none)} />
            </Grid>

            <div className="search-bar" role="search">
              <TextField
                label={t('Search')}
                type="search"
                placeholder={t('Facility name or code')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <SelectField
                label={t('Status')}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={[
                  { value: '', label: t('All') },
                  ...SUBSCRIPTION_STATUSES.map((s) => ({
                    value: s,
                    label: subscriptionStatusLabel(s),
                  })),
                  { value: 'NONE', label: t('Without a subscription') },
                ]}
              />
            </div>

            {data.items.length === 0 ? (
              <EmptyState title={t('No facility matches')} />
            ) : (
              <Table caption={t('Facilities and subscriptions')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Facility')}</th>
                    <th scope="col">{t('Plan')}</th>
                    <th scope="col">{t('Status')}</th>
                    <th scope="col">{t('Staff accounts')}</th>
                    <th scope="col">{t('Next date')}</th>
                    <th scope="col">{t('Price')}</th>
                    <th scope="col">{t('Invoices')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((o) => {
                    const s = o.subscription;
                    return (
                      <tr key={o.facility.id}>
                        <td>
                          <Link to={`/admin/organizations/${o.facility.id}`}>
                            {o.facility.name}
                          </Link>
                          <div className="muted">
                            {o.facility.code} · {o.facility.municipality}
                          </div>
                        </td>
                        <td>
                          {s ? (
                            <>
                              {s.plan.name}
                              <div className="muted">{cycleLabel(s.billingCycle)}</div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {s ? (
                            <SubscriptionBadge status={s.status} />
                          ) : (
                            <Badge>{t('No subscription')}</Badge>
                          )}
                        </td>
                        <td>
                          {s ? seatsText(o.seatsUsed, o.seatLimit) : formatNumber(o.seatsUsed)}
                        </td>
                        <td>
                          <NextDate o={o} />
                        </td>
                        <td>
                          {s ? (
                            <>
                              {formatMoney(s.priceCents, s.currency)}
                              <div className="muted">{perCycle(s.billingCycle)}</div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {o.overdueInvoices > 0 ? (
                            <Badge tone="danger">
                              {t('{count} overdue', { count: o.overdueInvoices })}
                            </Badge>
                          ) : o.openInvoices > 0 ? (
                            <Badge tone="warning">
                              {tn(o.openInvoices, '{count} open|invoice', '{count} open|invoices')}
                            </Badge>
                          ) : (
                            <span className="muted">{t('Nothing open')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </QueryView>
      <Dialog open={adding} onClose={() => setAdding(false)} title={t('New customer')} wide>
        <NewCustomerForm onDone={() => setAdding(false)} />
      </Dialog>
    </>
  );
}
