import {
  invoiceStateLabel,
  invoiceTone,
  seatsText,
  SUBSCRIPTION_TONE,
  subscriptionStatusLabel,
  type Invoice,
  type SubscriptionStatus,
} from '../../../api/subscriptions';
import { Badge } from '../../../components/ui';
import { t } from '../../../i18n';

export function SubscriptionBadge({ status }: { status: SubscriptionStatus }) {
  return <Badge tone={SUBSCRIPTION_TONE[status]}>{subscriptionStatusLabel(status)}</Badge>;
}

export function InvoiceBadge({ invoice }: { invoice: Pick<Invoice, 'status' | 'overdue'> }) {
  return <Badge tone={invoiceTone(invoice)}>{invoiceStateLabel(invoice)}</Badge>;
}

/** Staff accounts used against the subscription's limit (patients never count). */
export function SeatsMeter({ used, limit }: { used: number; limit: number | null }) {
  const full = limit !== null && used >= limit;
  return (
    <div className="stack" style={{ gap: '0.35rem' }}>
      <div className="row-between">
        <span>{t('Staff accounts in use')}</span>
        <strong>{seatsText(used, limit)}</strong>
      </div>
      {limit !== null && (
        <meter
          min={0}
          max={limit}
          low={Math.max(1, Math.floor(limit * 0.8))}
          high={Math.max(1, Math.floor(limit * 0.95))}
          optimum={0}
          value={Math.min(used, limit)}
          style={{ width: '100%' }}
          aria-label={t('Staff accounts in use')}
        />
      )}
      {full && (
        <small className="muted">
          {t('All staff accounts of the subscription are in use: no one new can be invited.')}
        </small>
      )}
    </div>
  );
}
