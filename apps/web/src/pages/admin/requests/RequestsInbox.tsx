import { PageHeader } from '../../../components/ui';
import { t } from '../../../i18n';

/**
 * Requests from facilities to the operator (/admin/requests): filters by status, category and
 * facility. Round 2, builder G.
 */
export function RequestsInbox() {
  return <PageHeader title={t('Requests')} />;
}
