import { useMyBillingProfile } from '../../../api/billingdocs';
import type { MySubscription } from '../../../api/subscriptions';
import { Card, EmptyState, QueryView } from '../../../components/ui';
import { t } from '../../../i18n';
import { BillingProfileList } from '../../admin/billing/BillingProfileCard';

/**
 * Director's subscription page (SubscriptionPage): the facility's billing details as the
 * operator invoices them (read-only; the operator changes them on request).
 */
export function BillingDetailsCard({ data }: { data: MySubscription }) {
  const query = useMyBillingProfile();
  return (
    <Card title={t('Billing details')}>
      <QueryView query={query}>
        {(result) =>
          result.profile ? (
            <div className="stack">
              <BillingProfileList profile={result.profile} />
              <p className="muted" style={{ margin: 0 }}>
                {t(
                  'Invoices and credit notes are sent to these billing e-mails and to the facility’s directors. To change these details, contact the service operator.',
                )}
              </p>
            </div>
          ) : (
            <EmptyState title={t('No billing details yet')}>
              {t(
                'Invoices name {facility} as it is registered in Pacient. To have them name another legal entity or reach your accounts department, contact the service operator.',
                { facility: data.facility?.name ?? t('your facility') },
              )}
            </EmptyState>
          )
        }
      </QueryView>
    </Card>
  );
}
