import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client';
import {
  formatMoney,
  invoiceLineText,
  isNoCharge,
  PAYMENT_METHODS,
  paymentMethodLabel,
  periodText,
  useBillingMutation,
  type Invoice,
} from '../../../api/subscriptions';
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate } from '../../../format';
import { t } from '../../../i18n';
import { InvoiceBadge } from './parts';

export const invoicePath = (id: string, audience: 'admin' | 'director') =>
  audience === 'admin' ? `/admin/invoices/${id}` : `/director/subscription/invoices/${id}`;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function PaymentForm({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const mutation = useBillingMutation((body: Record<string, unknown>) =>
    api<Invoice>(`/admin/invoices/${invoice.id}/payments`, { method: 'POST', body }),
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    mutation.mutate(
      {
        method: v.method,
        reference: v.reference || null,
        // Today: the moment of recording; an earlier day: midday of that day.
        ...(v.paidAt && v.paidAt !== today()
          ? { paidAt: new Date(`${v.paidAt}T12:00:00`).toISOString() }
          : {}),
      },
      { onSuccess: onDone },
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <p>
        {t('Invoice {number}', { number: invoice.number })} ·{' '}
        <strong>{formatMoney(invoice.totalCents, invoice.currency)}</strong>
      </p>
      <div className="form-grid">
        <TextField
          label={t('Paid on')}
          name="paidAt"
          type="date"
          required
          defaultValue={today()}
          max={today()}
        />
        <SelectField
          label={t('Payment method')}
          name="method"
          required
          defaultValue="BANK_TRANSFER"
          options={PAYMENT_METHODS.map((m) => ({ value: m, label: paymentMethodLabel(m) }))}
        />
        <TextField
          label={t('Payment reference')}
          name="reference"
          maxLength={120}
          hint={t('E.g. the bank statement entry')}
        />
      </div>
      <p className="muted">
        {t(
          'When nothing else is overdue, a subscription with an overdue payment or suspended for non-payment is active again. A suspension by an administrator is lifted only by reactivating the subscription.',
        )}
      </p>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Record payment')}
        </Button>
      </div>
    </form>
  );
}

function VoidForm({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const mutation = useBillingMutation((reason: string) =>
    api<Invoice>(`/admin/invoices/${invoice.id}/void`, { method: 'POST', body: { reason } }),
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    mutation.mutate(formValues(e.currentTarget).reason ?? '', { onSuccess: onDone });
  }
  return (
    <form onSubmit={onSubmit}>
      <Alert tone="warning" title={t('Invoice {number}', { number: invoice.number })}>
        {t(
          'A voided invoice stays on record with its number and is no longer owed. Issue a new invoice for the period if needed.',
        )}
      </Alert>
      <TextAreaField label={t('Reason')} name="reason" required minLength={5} maxLength={1000} />
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="danger" loading={mutation.isPending}>
          {t('Void invoice')}
        </Button>
      </div>
    </form>
  );
}

/** "Record payment" and "Void" for an open invoice (administrator). */
export function InvoiceActions({ invoice }: { invoice: Invoice }) {
  const [open, setOpen] = useState<'pay' | 'void' | null>(null);
  if (invoice.status !== 'OPEN') return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen('pay')}>
        {t('Record payment')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen('void')}>
        {t('Void|invoice action')}
      </Button>
      <Dialog open={open === 'pay'} onClose={() => setOpen(null)} title={t('Record payment')}>
        <PaymentForm invoice={invoice} onDone={() => setOpen(null)} />
      </Dialog>
      <Dialog open={open === 'void'} onClose={() => setOpen(null)} title={t('Void invoice')}>
        <VoidForm invoice={invoice} onDone={() => setOpen(null)} />
      </Dialog>
    </>
  );
}

/** Invoices with their state; the administrator can also record payments and void. */
export function InvoiceTable({
  invoices,
  audience,
  showFacility = false,
}: {
  invoices: Invoice[];
  audience: 'admin' | 'director';
  showFacility?: boolean;
}) {
  if (invoices.length === 0) return <EmptyState title={t('No invoices yet')} />;
  return (
    <Table caption={t('Invoices')}>
      <thead>
        <tr>
          <th scope="col">{t('Number')}</th>
          {showFacility && <th scope="col">{t('Facility')}</th>}
          <th scope="col">{t('Period')}</th>
          <th scope="col">{t('Issued')}</th>
          <th scope="col">{t('Due date')}</th>
          <th scope="col">{t('Total')}</th>
          <th scope="col">{t('Status')}</th>
          {audience === 'admin' && <th scope="col">{t('Sent on')}</th>}
          {audience === 'admin' && (
            <th scope="col">
              <span className="sr-only">{t('Actions')}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {invoices.map((i) => (
          <tr key={i.id}>
            <td>
              <Link to={invoicePath(i.id, audience)} style={{ whiteSpace: 'nowrap' }}>
                {i.number}
              </Link>
              <div className="muted">{invoiceLineText(i)}</div>
            </td>
            {showFacility && (
              <td>
                <Link to={`/admin/organizations/${i.facilityId}`}>{i.facilityName}</Link>
              </td>
            )}
            <td>{periodText(i.periodStart, i.periodEnd)}</td>
            <td>{formatDate(i.issuedAt)}</td>
            <td>{formatDate(i.dueAt)}</td>
            <td>{formatMoney(i.totalCents, i.currency)}</td>
            <td>
              <InvoiceBadge invoice={i} />
              {i.status === 'PAID' && (
                <div className="muted">
                  {formatDate(i.paidAt)} ·{' '}
                  {isNoCharge(i) ? t('No charge') : paymentMethodLabel(i.paymentMethod)}
                </div>
              )}
              {i.status === 'VOID' && i.voidReason && <div className="muted">{i.voidReason}</div>}
            </td>
            {audience === 'admin' && (
              <td>
                {/* When the invoice first reached the customer by e-mail. */}
                {i.sentAt ? (
                  formatDate(i.sentAt)
                ) : (
                  <span className="muted">
                    {i.sending ? t('Waiting to be sent') : t('Not sent')}
                  </span>
                )}
              </td>
            )}
            {audience === 'admin' && (
              <td>
                <div className="row">
                  <InvoiceActions invoice={i} />
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
