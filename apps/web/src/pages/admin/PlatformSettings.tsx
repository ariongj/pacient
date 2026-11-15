import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Who runs the service, billing rules and a notice to all users. */
export function PlatformSettings() {
  return (
    <PageHeader
      title={t('Operator settings')}
      subtitle={t('Who runs the service, billing rules and a notice to all users.')}
    />
  );
}
