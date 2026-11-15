import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Every administrative action on accounts, subscriptions and settings. */
export function AdminAudit() {
  return (
    <PageHeader
      title={t('Administrative audit')}
      subtitle={t('Every administrative action on accounts, subscriptions and settings.')}
    />
  );
}
