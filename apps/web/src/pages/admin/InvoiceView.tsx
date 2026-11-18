import { Link, useParams } from 'react-router-dom';
import { useInvoice } from '../../api/subscriptions';
import { useUser } from '../../auth/AuthContext';
import { Alert, Button, PageHeader, QueryView } from '../../components/ui';
import { t } from '../../i18n';
import { InvoiceActions } from './billing/InvoiceTable';
import { INVOICE_PRINT_CSS, InvoiceSheet } from './billing/InvoiceSheet';
import { InvoiceBadge } from './billing/parts';

/**
 * A printable invoice: the administrator's (/admin/invoices/:id, with payment and voiding) or a
 * director's own facility invoice (/director/subscription/invoices/:id).
 */
export function InvoiceView() {
  const { id } = useParams();
  const admin = useUser().role === 'ADMIN';
  const query = useInvoice(id, admin ? 'admin' : 'director');
  return (
    <QueryView query={query}>
      {(invoice) => (
        <>
          <style>{INVOICE_PRINT_CSS}</style>
          <PageHeader
            title={t('Invoice {number}', { number: invoice.number })}
            subtitle={<InvoiceBadge invoice={invoice} />}
            actions={
              <>
                <Link
                  to={
                    admin ? `/admin/organizations/${invoice.facilityId}` : '/director/subscription'
                  }
                >
                  {admin ? invoice.facilityName : t('Subscription and invoices')}
                </Link>
                {admin && <InvoiceActions invoice={invoice} />}
                <Button variant="secondary" onClick={() => window.print()}>
                  {t('Print')}
                </Button>
              </>
            }
          />
          {admin && !invoice.issuer.name && (
            <div className="no-print" style={{ marginBottom: '1rem' }}>
              <Alert tone="warning" title={t('Operator details missing')}>
                {t('This invoice was issued before the operator settings were filled in.')}
              </Alert>
            </div>
          )}
          <InvoiceSheet invoice={invoice} />
        </>
      )}
    </QueryView>
  );
}
