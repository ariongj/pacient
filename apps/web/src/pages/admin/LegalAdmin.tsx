import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** Terms of use and privacy notice: drafts, publishing, acceptance. */
export function LegalAdmin() {
  return (
    <PageHeader
      title={t('Terms and privacy')}
      subtitle={t('Terms of use and privacy notice: drafts, publishing, acceptance.')}
    />
  );
}
