import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Every account of the service: invite, disable, unlock, reset sign-in. */
export function AdminUsers() {
  return (
    <PageHeader
      title={t('Users')}
      subtitle={t('Every account of the service: invite, disable, unlock, reset sign-in.')}
    />
  );
}
