import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** What facilities can subscribe to. */
export function Plans() {
  return <PageHeader title={t('Plans')} subtitle={t('What facilities can subscribe to.')} />;
}
