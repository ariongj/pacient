import { PageHeader } from '../../../components/ui';
import { t } from '../../../i18n';

/**
 * A printable credit note: the administrator's (/admin/credit-notes/:id) or a director's own
 * facility's (/director/subscription/credit-notes/:id), like InvoiceView. Round 2, builder B2.
 */
export function CreditNoteView() {
  return <PageHeader title={t('Credit note')} />;
}
