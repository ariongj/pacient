import { useMyDocuments } from '../../../api/billingdocs';
import { formatMoney, type MySubscription } from '../../../api/subscriptions';
import { Card, EmptyState, QueryView, Table } from '../../../components/ui';
import { formatDate } from '../../../format';
import { t } from '../../../i18n';
import { PdfButton } from '../../admin/billing/InvoiceDeliveries';

/**
 * Director's subscription page (SubscriptionPage): "Download PDF" for each invoice and credit
 * note of the facility, in the director's own language.
 */
export function DocumentsCard({ data }: { data: MySubscription }) {
  const query = useMyDocuments();
  // Nothing to download before the first invoice (e.g. during the trial).
  if (data.invoices.length === 0 && !query.data?.creditNotes.length) return null;
  return (
    <Card title={t('Documents to download')}>
      <QueryView query={query}>
        {(docs) =>
          docs.invoices.length + docs.creditNotes.length === 0 ? (
            <EmptyState title={t('No invoices yet')} />
          ) : (
            <Table caption={t('Invoices and credit notes as PDF')}>
              <thead>
                <tr>
                  <th scope="col">{t('Document')}</th>
                  <th scope="col">{t('Number')}</th>
                  <th scope="col">{t('Issued')}</th>
                  <th scope="col">{t('Total')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {docs.invoices.map((i) => (
                  <tr key={i.id}>
                    <td>{t('Invoice')}</td>
                    <td>{i.number}</td>
                    <td>{formatDate(i.issuedAt)}</td>
                    <td>{formatMoney(i.totalCents, i.currency)}</td>
                    <td>
                      <PdfButton kind="invoice" document={i} scope="director" size="sm" />
                    </td>
                  </tr>
                ))}
                {docs.creditNotes.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {t('Credit note')}
                      <div className="muted">
                        {t('For invoice {number}', { number: c.invoiceNumber })}
                      </div>
                    </td>
                    <td>{c.number}</td>
                    <td>{formatDate(c.issuedAt)}</td>
                    <td>{formatMoney(c.totalCents, c.currency)}</td>
                    <td>
                      <PdfButton kind="credit_note" document={c} scope="director" size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
    </Card>
  );
}
