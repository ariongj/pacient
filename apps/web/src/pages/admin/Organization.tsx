import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Subscription, history and invoices of one facility. */
export function Organization() {
  return (
    <PageHeader
      title={t('Facility subscription')}
      subtitle={t('Subscription, history and invoices of one facility.')}
    />
  );
}
