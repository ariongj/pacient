import type { ReactNode } from 'react';
import {
  cycleLabel,
  formatMoney,
  perCycle,
  periodText,
  useMySubscription,
  type MySubscription,
} from '../../api/subscriptions';
import {
  Alert,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  QueryView,
} from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';
import { SubscriptionHistory } from '../admin/billing/History';
import { InvoiceTable } from '../admin/billing/InvoiceTable';
import { SeatsMeter, SubscriptionBadge } from '../admin/billing/parts';

/** The subscription's state in plain words, with what it means for the facility. */
function StatusExplained({ data }: { data: MySubscription }) {
  const s = data.subscription!;
  const overdue = data.invoices.filter((i) => i.overdue);
  switch (s.status) {
    case 'TRIAL':
      return (
        <Alert
          tone="info"
          title={
            s.cancelAtPeriodEnd
              ? t('The trial ends on {date} and the subscription ends with it.', {
                  date: formatDate(s.trialEndsAt),
                })
              : t('Trial until {date}', { date: formatDate(s.trialEndsAt) })
          }
        >
          {!s.cancelAtPeriodEnd &&
            t(
              'Nothing is invoiced during the trial. Afterwards the subscription continues and the first invoice is issued.',
            )}
        </Alert>
      );
    case 'ACTIVE':
      return s.cancelAtPeriodEnd ? (
        <Alert
          tone="info"
          title={t('The subscription ends on {date}.', { date: formatDate(s.currentPeriodEnd) })}
        >
          {t('Patient records and existing accounts stay available.')}
        </Alert>
      ) : null;
    case 'PAST_DUE':
      return (
        <Alert tone="warning" title={t('An invoice is overdue')}>
          {t(
            'Please pay {invoices}. If it stays unpaid, no new staff accounts can be added; clinical work is never affected.',
            {
              invoices: overdue.map((i) => i.number).join(', ') || '—',
            },
          )}
        </Alert>
      );
    case 'SUSPENDED':
      return (
        <Alert tone="warning" title={t('New staff accounts cannot be added.')}>
          {t(
            'Clinical work, sign-in and existing accounts are not affected. Please contact the service operator.',
          )}
        </Alert>
      );
    default:
      return (
        <Alert tone="info" title={t('The subscription has ended.')}>
          {t(
            'Patient records and existing accounts stay available. Contact the service operator to subscribe again.',
          )}
        </Alert>
      );
  }
}

/** Your facility’s plan, seats, history and invoices. */
export function SubscriptionPage() {
  const query = useMySubscription();
  return (
    <>
      <PageHeader
        title={t('Subscription and invoices')}
        subtitle={t('Your facility’s plan, seats, history and invoices.')}
      />
      <QueryView query={query}>
        {(data) => {
          const s = data.subscription;
          if (!s || !data.plan) {
            return (
              <Card>
                <EmptyState title={t('Your facility has no subscription yet.')}>
                  {t('Contact the service operator.')}
                </EmptyState>
                <SeatsMeter used={data.seatsUsed} limit={null} />
              </Card>
            );
          }
          const ended = s.status === 'CANCELLED' || s.status === 'EXPIRED';
          const items: [string, ReactNode][] = [
            [t('Plan'), data.plan.name],
            [t('Status'), <SubscriptionBadge key="s" status={s.status} />],
            [t('Billing cycle'), cycleLabel(s.billingCycle)],
            [
              t('Price'),
              `${formatMoney(s.priceCents, s.currency)} ${perCycle(s.billingCycle)} ${t('(without VAT)')}`,
            ],
          ];
          if (s.status === 'TRIAL') items.push([t('Trial ends'), formatDate(s.trialEndsAt)]);
          else if (!ended) {
            items.push([t('Current period'), periodText(s.currentPeriodStart, s.currentPeriodEnd)]);
            items.push([
              s.cancelAtPeriodEnd ? t('Ends on') : t('Renews on'),
              formatDate(s.currentPeriodEnd),
            ]);
          } else items.push([t('Ended on'), formatDate(s.cancelledAt)]);
          return (
            <div className="stack">
              <StatusExplained data={data} />
              <Card title={t('Your plan')}>
                <div className="stack">
                  <DefinitionList items={items} />
                  {data.plan.description && <p className="muted">{data.plan.description}</p>}
                  {data.plan.features.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                      {data.plan.features.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                  <SeatsMeter used={data.seatsUsed} limit={data.seatLimit} />
                  <p className="muted">
                    {t(
                      'Staff accounts count while they are active; patients never count. Disable accounts that are no longer needed on the staff page.',
                    )}
                  </p>
                </div>
              </Card>
              <Card title={t('Invoices')}>
                <InvoiceTable invoices={data.invoices} audience="director" />
              </Card>
              <Card title={t('History')}>
                <SubscriptionHistory events={data.events} audience="director" />
              </Card>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
