import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Every facility with its plan, status, seats and renewal. */
export function Organizations() {
  return (
    <PageHeader
      title={t('Facilities and subscriptions')}
      subtitle={t('Every facility with its plan, status, seats and renewal.')}
    />
  );
}
