import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Facilities, subscriptions, users and the health of the service. */
export function AdminHome() {
  return (
    <PageHeader
      title={t('Platform overview')}
      subtitle={t('Facilities, subscriptions, users and the health of the service.')}
    />
  );
}
