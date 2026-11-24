import { Link, useParams } from 'react-router-dom';
import { useCreditNote, type CreditNote } from '../../../api/billingcorrections';
import { formatMoney, formatRate, periodText } from '../../../api/subscriptions';
import { useUser } from '../../../auth/AuthContext';
import { Button, PageHeader, QueryView } from '../../../components/ui';
import { formatDate } from '../../../format';
import { t } from '../../../i18n';
import { invoicePath } from './InvoiceTable';
import { INVOICE_PRINT_CSS } from './InvoiceSheet';

const lines = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => Boolean(p && p.trim()));

/**
 * The printable credit note, from the details it copied from its invoice when it was issued (the
 * same A4 sheet as an invoice: class "invoice-sheet").
 */
function CreditNoteSheet({ note: n }: { note: CreditNote }) {
  const issuer = n.issuer ?? {};
  const customer = n.customer ?? {};
  const money = (cents: number) => formatMoney(cents, n.currency);
  return (
    <article className="invoice-sheet" aria-label={t('Credit note {number}', { number: n.number })}>
      <div className="is-top">
        <div>
          <strong style={{ fontSize: '13pt' }}>{issuer.name || '—'}</strong>
          {lines(
            issuer.address,
            issuer.fiscalNumber && `${t('Fiscal number (NUI)')}: ${issuer.fiscalNumber}`,
            issuer.vatNumber && `${t('VAT number')}: ${issuer.vatNumber}`,
            issuer.email,
            issuer.phone,
          ).map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
        <div className="is-title">
          <h2>{t('CREDIT NOTE')}</h2>
          <div>
            {t('No.')} <strong>{n.number}</strong>
          </div>
          <div>
            {t('Issued')}: {formatDate(n.issuedAt)}
          </div>
          <div>
            {t('For invoice {number} of {date}', {
              number: n.invoice.number,
              date: formatDate(n.invoice.issuedAt),
            })}
          </div>
        </div>
      </div>

      <div className="is-parties">
        <div>
          <div className="is-label">{t('Bill to')}</div>
          <strong>{customer.legalName || customer.name || n.facilityName}</strong>
          {/* The customer's billing details when the invoice had them, else the facility. */}
          {lines(
            customer.code && `${t('Code')}: ${customer.code}`,
            (customer.businessNumber || customer.fiscalNumber) &&
              `${t('Fiscal number (NUI)')}: ${customer.businessNumber || customer.fiscalNumber}`,
            customer.vatNumber && `${t('VAT number')}: ${customer.vatNumber}`,
            customer.billingAddress ?? customer.address,
            lines(customer.municipality, customer.region).join(', '),
          ).map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
        <div>
          <div className="is-label">{t('Service period')}</div>
          <strong>{periodText(n.invoice.periodStart, n.invoice.periodEnd)}</strong>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th scope="col">{t('Description')}</th>
            <th scope="col" className="num">
              {t('Amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {t('Credit for invoice {number}: {reason}', {
                number: n.invoice.number,
                reason: n.reason,
              })}
            </td>
            <td className="num">{money(n.netCents)}</td>
          </tr>
        </tbody>
      </table>

      <table className="is-totals">
        <tbody>
          <tr>
            <td>{t('Amount without VAT')}</td>
            <td className="num">{money(n.netCents)}</td>
          </tr>
          <tr>
            <td>
              {n.vatRateBp > 0
                ? t('VAT {rate}', { rate: formatRate(n.vatRateBp) })
                : t('Not registered for VAT')}
            </td>
            <td className="num">{money(n.taxCents)}</td>
          </tr>
          <tr className="is-grand">
            <td>{t('Total credited')}</td>
            <td className="num">{money(n.totalCents)}</td>
          </tr>
        </tbody>
      </table>

      <div className="is-pay">
        {t('This credit note reduces invoice {number} ({total}) by {amount}.', {
          number: n.invoice.number,
          total: money(n.invoice.totalCents),
          amount: money(n.totalCents),
        })}
      </div>
    </article>
  );
}

/**
 * A printable credit note: the administrator's (/admin/credit-notes/:id) or a director's own
 * facility's (/director/subscription/credit-notes/:id), like InvoiceView.
 */
export function CreditNoteView() {
  const { id } = useParams();
  const admin = useUser().role === 'ADMIN';
  const query = useCreditNote(id, admin ? 'admin' : 'director');
  return (
    <QueryView query={query}>
      {(note) => (
        <>
          <style>{INVOICE_PRINT_CSS}</style>
          <PageHeader
            title={t('Credit note {number}', { number: note.number })}
            subtitle={admin ? note.facilityName : undefined}
            actions={
              <>
                <Link to={invoicePath(note.invoice.id, admin ? 'admin' : 'director')}>
                  {t('Invoice {number}', { number: note.invoice.number })}
                </Link>
                <Button variant="secondary" onClick={() => window.print()}>
                  {t('Print')}
                </Button>
              </>
            }
          />
          <CreditNoteSheet note={note} />
        </>
      )}
    </QueryView>
  );
}
