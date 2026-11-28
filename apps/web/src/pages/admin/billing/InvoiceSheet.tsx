import {
  formatMoney,
  formatRate,
  invoiceLineText,
  isNoCharge,
  paymentMethodLabel,
  periodText,
  type Invoice,
} from '../../../api/subscriptions';
import { formatDate } from '../../../format';
import { t } from '../../../i18n';

/** Only the invoice is printed (A4), without the application around it. */
export const INVOICE_PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 14mm; }
  html, body { background: #fff !important; }
  body * { visibility: hidden !important; }
  .invoice-sheet, .invoice-sheet * { visibility: visible !important; }
  .invoice-sheet {
    position: absolute !important; left: 0; top: 0; width: 100% !important; max-width: none !important;
    border: none !important; box-shadow: none !important; margin: 0 !important; padding: 0 !important;
  }
}
.invoice-sheet {
  background: #fff; color: #111; border: 1px solid var(--border, #bbb); border-radius: 6px;
  padding: 12mm; max-width: 210mm; box-sizing: border-box; line-height: 1.4; font-size: 10.5pt;
  position: relative; overflow: hidden;
}
.invoice-sheet .is-top { display: flex; justify-content: space-between; gap: 8mm; flex-wrap: wrap; }
.invoice-sheet .is-title { text-align: right; }
.invoice-sheet .is-title h2 { font-size: 20pt; letter-spacing: 0.08em; margin: 0 0 2mm; }
.invoice-sheet .is-label { color: #555; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.05em; }
.invoice-sheet .is-parties { display: flex; gap: 8mm; margin: 8mm 0 6mm; flex-wrap: wrap; }
.invoice-sheet .is-parties > div { flex: 1; min-width: 55mm; }
.invoice-sheet table { width: 100%; border-collapse: collapse; margin: 4mm 0; }
.invoice-sheet th, .invoice-sheet td { text-align: left; padding: 2mm 1.5mm; border-bottom: 0.3mm solid #ccc; vertical-align: top; }
.invoice-sheet th { font-size: 8.5pt; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
.invoice-sheet .num { text-align: right; white-space: nowrap; }
.invoice-sheet .is-totals { margin-left: auto; width: min(85mm, 100%); }
.invoice-sheet .is-totals td { border: none; padding: 1mm 1.5mm; }
.invoice-sheet .is-totals tr.is-grand td { border-top: 0.5mm solid #111; font-weight: 700; font-size: 12pt; padding-top: 2mm; }
.invoice-sheet .is-pay { margin-top: 8mm; padding: 4mm; border: 0.3mm solid #ccc; border-radius: 2mm; }
.invoice-sheet .is-stamp {
  position: absolute; top: 46mm; right: 12mm; transform: rotate(-12deg); border: 1mm solid; border-radius: 2mm;
  padding: 1.5mm 4mm; font-weight: 800; font-size: 16pt; letter-spacing: 0.12em; opacity: 0.85;
}
.invoice-sheet .is-paid { color: #1b7a3a; }
.invoice-sheet .is-void { color: #b00020; }
`;

const lines = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => Boolean(p && p.trim()));

/**
 * "Not registered for VAT" only for an issuer without a VAT number: a registered operator that
 * charges 0 % prints "VAT 0 %" with its VAT number (as on the PDF).
 */
export const registeredForVat = (rateBp: number, issuer: Invoice['issuer']) =>
  rateBp > 0 || Boolean(issuer.vatNumber?.trim());

/**
 * The customer as frozen on an invoice or credit note, under "Bill to": the legal entity of the
 * facility's billing details when it had them (with the facility's own name beside a different
 * one), else the facility – then its address, numbers and reference, as on the PDF.
 */
export function CustomerBlock({
  customer,
  facilityName,
}: {
  customer: Invoice['customer'];
  facilityName: string | null;
}) {
  return (
    <>
      <strong>{customer.legalName || customer.name || facilityName}</strong>
      {lines(
        customer.legalName && customer.name && customer.legalName !== customer.name
          ? `${t('Facility')}: ${customer.name}`
          : null,
        ...(customer.billingAddress
          ? [customer.billingAddress]
          : [customer.address, lines(customer.municipality, customer.region).join(', ')]),
        customer.businessNumber && `${t('Business number (NUI)')}: ${customer.businessNumber}`,
        customer.fiscalNumber && `${t('Fiscal number')}: ${customer.fiscalNumber}`,
        customer.vatNumber && `${t('VAT number')}: ${customer.vatNumber}`,
        customer.code && `${t('Code')}: ${customer.code}`,
        customer.customerReference && `${t('Your reference')}: ${customer.customerReference}`,
      ).map((l) => (
        <div key={l}>{l}</div>
      ))}
    </>
  );
}

/** The printable invoice, from the details frozen when it was issued. */
export function InvoiceSheet({ invoice: i }: { invoice: Invoice }) {
  const issuer = i.issuer ?? {};
  const customer = i.customer ?? {};
  const a = i.account;
  // Paid or credited in part: the box asks only for the rest (as the PDF does).
  const rest = a && a.paidCents + a.creditedCents > 0 && a.balanceCents > 0 ? a : null;
  return (
    <article className="invoice-sheet" aria-label={t('Invoice {number}', { number: i.number })}>
      {i.status === 'PAID' && <div className="is-stamp is-paid">{t('PAID')}</div>}
      {i.status === 'VOID' && <div className="is-stamp is-void">{t('VOID')}</div>}
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
          <h2>{t('INVOICE')}</h2>
          <div>
            {t('No.')} <strong>{i.number}</strong>
          </div>
          <div>
            {t('Issued')}: {formatDate(i.issuedAt)}
          </div>
          <div>
            {t('Due date')}: <strong>{formatDate(i.dueAt)}</strong>
          </div>
        </div>
      </div>

      <div className="is-parties">
        <div>
          <div className="is-label">{t('Bill to')}</div>
          <CustomerBlock customer={customer} facilityName={i.facilityName} />
        </div>
        <div>
          <div className="is-label">{t('Service period')}</div>
          <strong>{periodText(i.periodStart, i.periodEnd)}</strong>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th scope="col">{t('Description')}</th>
            <th scope="col">{t('Period')}</th>
            <th scope="col" className="num">
              {t('Amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {t('Subscription to the Pacient service: {line}', { line: invoiceLineText(i) })}
            </td>
            <td>{periodText(i.periodStart, i.periodEnd)}</td>
            <td className="num">{formatMoney(i.netCents, i.currency)}</td>
          </tr>
        </tbody>
      </table>

      <table className="is-totals">
        <tbody>
          {/* Without VAT registration (no VAT number) the invoice says so instead of "VAT 0 %". */}
          {registeredForVat(i.taxRateBp, issuer) ? (
            <>
              <tr>
                <td>{t('Amount without VAT')}</td>
                <td className="num">{formatMoney(i.netCents, i.currency)}</td>
              </tr>
              <tr>
                <td>{t('VAT {rate}', { rate: formatRate(i.taxRateBp) })}</td>
                <td className="num">{formatMoney(i.taxCents, i.currency)}</td>
              </tr>
            </>
          ) : (
            <tr>
              <td colSpan={2}>{t('Not registered for VAT')}</td>
            </tr>
          )}
          <tr className="is-grand">
            <td>{t('Total to pay')}</td>
            <td className="num">{formatMoney(i.totalCents, i.currency)}</td>
          </tr>
        </tbody>
      </table>

      {i.status === 'OPEN' && (
        <div className="is-pay">
          <div className="is-label">{t('Payment')}</div>
          <div>
            {rest
              ? t('Still to pay: {balance} of {total}. Please pay it by bank transfer by {date}.', {
                  balance: formatMoney(rest.balanceCents, i.currency),
                  total: formatMoney(i.totalCents, i.currency),
                  date: formatDate(i.dueAt),
                })
              : t('Please pay {amount} by bank transfer by {date}.', {
                  amount: formatMoney(i.totalCents, i.currency),
                  date: formatDate(i.dueAt),
                })}
          </div>
          {issuer.bank && (
            <div>
              {t('Bank')}: {issuer.bank}
            </div>
          )}
          <div>
            IBAN: <strong>{issuer.iban || '—'}</strong>
          </div>
          <div>
            {t('Payment reference')}: <strong>{i.number}</strong>
          </div>
        </div>
      )}
      {i.status === 'PAID' && (
        <div className="is-pay">
          {t('Paid on {date}', { date: formatDate(i.paidAt) })} ·{' '}
          {isNoCharge(i) ? t('No charge') : paymentMethodLabel(i.paymentMethod)}
          {!isNoCharge(i) && i.paymentReference && ` · ${i.paymentReference}`}
        </div>
      )}
      {i.status === 'VOID' && (
        <div className="is-pay">
          {t('Voided on {date}', { date: formatDate(i.voidedAt) })}
          {i.voidReason && ` · ${i.voidReason}`}
        </div>
      )}
    </article>
  );
}
