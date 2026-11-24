import { Link } from 'react-router-dom';
import { creditNotePath, useMyCreditNotes } from '../../../api/billingcorrections';
import { formatMoney, type MySubscription } from '../../../api/subscriptions';
import { Card, Table } from '../../../components/ui';
import { formatDate } from '../../../format';
import { t } from '../../../i18n';
import { invoicePath } from '../../admin/billing/InvoiceTable';

/**
 * Director's subscription page (SubscriptionPage): the facility's credit notes, next to the
 * invoices – each reduces an invoice (or is refunded when the invoice was already paid). Shown
 * only when there are any.
 */
export function CreditNotesCard({ data }: { data: MySubscription }) {
  const query = useMyCreditNotes(Boolean(data.facility));
  const items = query.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Card title={t('Credit notes')}>
      <Table caption={t('Credit notes')}>
        <thead>
          <tr>
            <th scope="col">{t('Number')}</th>
            <th scope="col">{t('Invoice')}</th>
            <th scope="col">{t('Issued')}</th>
            <th scope="col">{t('Reason')}</th>
            <th scope="col" className="num">
              {t('Amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={creditNotePath(c.id, 'director')} style={{ whiteSpace: 'nowrap' }}>
                  {c.number}
                </Link>
              </td>
              <td>
                <Link to={invoicePath(c.invoiceId, 'director')}>{c.invoiceNumber}</Link>
              </td>
              <td>{formatDate(c.issuedAt)}</td>
              <td>{c.reason}</td>
              <td className="num">{formatMoney(c.totalCents, c.currency)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
