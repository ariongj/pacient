import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** One account: details, sign-in history and actions. */
export function AdminUser() {
  return (
    <PageHeader
      title={t('User')}
      subtitle={t('One account: details, sign-in history and actions.')}
    />
  );
}
