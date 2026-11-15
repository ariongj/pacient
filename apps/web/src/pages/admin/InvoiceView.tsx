import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** A printable invoice. */
export function InvoiceView() {
  return <PageHeader title={t('Invoice')} subtitle={t('A printable invoice.')} />;
}
