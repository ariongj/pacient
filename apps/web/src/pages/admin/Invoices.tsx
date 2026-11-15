import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';

/** All invoices; record payments. */
export function Invoices() {
  return (
    <PageHeader title={t('Invoices and payments')} subtitle={t('All invoices; record payments.')} />
  );
}
