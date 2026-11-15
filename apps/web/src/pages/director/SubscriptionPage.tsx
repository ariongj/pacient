import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Your facility’s plan, seats, history and invoices. */
export function SubscriptionPage() {
  return (
    <PageHeader
      title={t('Subscription and invoices')}
      subtitle={t('Your facility’s plan, seats, history and invoices.')}
    />
  );
}
