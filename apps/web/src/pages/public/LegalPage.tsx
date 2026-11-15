import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** The current published text. */
export function LegalPage() {
  return <PageHeader title={t('Terms of use')} subtitle={t('The current published text.')} />;
}
