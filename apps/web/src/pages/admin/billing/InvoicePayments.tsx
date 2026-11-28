import { useState, type FormEvent } from 'react';
import {
  recordRefund,
  reversePayment,
  useInvoiceAccount,
  voidBlockText,
  type InvoiceAccountView,
  type InvoicePayment,
} from '../../../api/billingcorrections';
import {
  centsToInput,
  formatMoney,
  inputToCents,
  paymentMethodLabel,
  useBillingMutation,
  type Invoice,
} from '../../../api/subscriptions';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  ErrorAlert,
  formValues,
  Grid,
  QueryView,
  Stat,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate } from '../../../format';
import { t } from '../../../i18n';

/**
 * Total, paid, credited, still owed and – beyond the total – to refund, less the refunds
 * recorded (each shown with its day); the administrator records a refund once it is made.
 */
function Balance({
  account: a,
  admin,
  onRefund,
}: {
  account: InvoiceAccountView;
  admin: boolean;
  onRefund: () => void;
}) {
  const money = (cents: number) => formatMoney(cents, a.currency);
  return (
    <>
      <Grid min={150}>
        <Stat label={t('Invoice total')} value={money(a.totalCents)} />
        <Stat label={t('Paid')} value={money(a.paidCents)} />
        <Stat label={t('Credited')} value={money(a.creditedCents)} />
        <Stat
          label={t('Still owed')}
          value={money(a.balanceCents)}
          tone={a.balanceCents > 0 ? 'warning' : 'success'}
        />
        {a.toRefundCents > 0 && (
          <Stat label={t('To refund')} value={money(a.toRefundCents)} tone="warning" />
        )}
      </Grid>
      {a.toRefundCents > 0 && (
        <Alert tone="info" title={t('To refund: {amount}', { amount: money(a.toRefundCents) })}>
          {admin
            ? t(
                'More was paid and credited than the invoice total. Refunds are made outside Pacient, by bank transfer; record each refund here once it is made.',
              )
            : t('The service operator refunds this amount to your facility.')}
          {admin && (
            <div style={{ marginTop: '0.5rem' }}>
              <Button size="sm" variant="secondary" onClick={onRefund}>
                {t('Record refund')}
              </Button>
            </div>
          )}
        </Alert>
      )}
      {a.refunds.length > 0 && (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {a.refunds.map((r) => (
            <li key={r.id}>
              {t('Refunded on {date}: {amount}', {
                date: formatDate(r.refundedAt),
                amount: money(r.amountCents),
              })}
              {r.reference && ` · ${r.reference}`}
              {admin && r.recordedBy && (
                <span className="muted"> · {t('Recorded by {name}', { name: r.recordedBy })}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Records a refund made outside Pacient: at most what is to refund (administrator). */
function RefundForm({ account: a, onDone }: { account: InvoiceAccountView; onDone: () => void }) {
  const mutation = useBillingMutation(recordRefund);
  const [amountError, setAmountError] = useState<string>();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const amountCents = inputToCents(v.amount ?? '');
    if (!amountCents || Number.isNaN(amountCents) || amountCents > a.toRefundCents) {
      setAmountError(
        t('Enter an amount above 0 and at most {max}.', {
          max: formatMoney(a.toRefundCents, a.currency),
        }),
      );
      return;
    }
    setAmountError(undefined);
    mutation.mutate(
      {
        invoiceId: a.invoiceId,
        amountCents,
        // Today: the moment of recording; an earlier day: midday of that day.
        refundedAt:
          v.refundedAt && v.refundedAt !== today()
            ? new Date(`${v.refundedAt}T12:00:00`).toISOString()
            : new Date().toISOString(),
        reference: v.reference || null,
      },
      { onSuccess: onDone },
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <p>
        {t('Invoice {number}', { number: a.number })} ·{' '}
        {t('To refund: {amount}', { amount: formatMoney(a.toRefundCents, a.currency) })}
      </p>
      <div className="form-grid">
        <TextField
          label={t('Amount refunded (€)')}
          name="amount"
          inputMode="decimal"
          required
          defaultValue={centsToInput(a.toRefundCents)}
          error={amountError}
        />
        <TextField
          label={t('Refunded on')}
          name="refundedAt"
          type="date"
          required
          defaultValue={today()}
          max={today()}
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
          'Record the refund once the money was sent back to the facility. The invoice does not change; its directors see when it was refunded. You will be asked for your password.',
        )}
      </p>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Record refund')}
        </Button>
      </div>
    </form>
  );
}

function ReverseForm({
  payment,
  currency,
  onDone,
}: {
  payment: InvoicePayment;
  currency: string;
  onDone: () => void;
}) {
  const mutation = useBillingMutation(reversePayment);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = formValues(e.currentTarget).reason ?? '';
    mutation.mutate({ paymentId: payment.id, reason }, { onSuccess: onDone });
  }
  return (
    <form onSubmit={onSubmit}>
      <Alert
        tone="warning"
        title={t('{amount} received on {date}', {
          amount: formatMoney(payment.amountCents, currency),
          date: formatDate(payment.paidAt),
        })}
      >
        {t(
          'The payment stays on record, marked as reversed. A paid invoice is open again; if it is overdue, the subscription shows the overdue payment again. You will be asked for your password.',
        )}
      </Alert>
      <TextAreaField
        label={t('Reason')}
        name="reason"
        required
        minLength={5}
        maxLength={500}
        hint={t('E.g. the bank returned the transfer, or it was recorded on the wrong invoice.')}
      />
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="danger" loading={mutation.isPending}>
          {t('Reverse payment')}
        </Button>
      </div>
    </form>
  );
}

function PaymentTable({
  account: a,
  admin,
  onReverse,
}: {
  account: InvoiceAccountView;
  admin: boolean;
  onReverse: (p: InvoicePayment) => void;
}) {
  if (a.payments.length === 0) return <p className="muted">{t('No payments recorded yet.')}</p>;
  return (
    <Table caption={t('Payments')}>
      <thead>
        <tr>
          <th scope="col">{t('Paid on')}</th>
          <th scope="col">{t('Payment method')}</th>
          <th scope="col">{t('Payment reference')}</th>
          <th scope="col" className="num">
            {t('Amount')}
          </th>
          <th scope="col">{t('Status')}</th>
          {admin && (
            <th scope="col">
              <span className="sr-only">{t('Actions')}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {a.payments.map((p) => (
          <tr key={p.id}>
            <td>{formatDate(p.paidAt)}</td>
            <td>{paymentMethodLabel(p.method)}</td>
            <td>{p.reference || '—'}</td>
            <td className="num">
              {p.reversedAt ? (
                <s>{formatMoney(p.amountCents, a.currency)}</s>
              ) : (
                formatMoney(p.amountCents, a.currency)
              )}
            </td>
            <td>
              {p.reversedAt ? (
                <>
                  <Badge tone="neutral">{t('Reversed|payment')}</Badge>
                  <div className="muted">
                    {admin && p.reversedBy
                      ? t('{date} by {name}', {
                          date: formatDate(p.reversedAt),
                          name: p.reversedBy,
                        })
                      : formatDate(p.reversedAt)}
                    {p.reversalReason && ` · ${p.reversalReason}`}
                  </div>
                </>
              ) : (
                <>
                  <Badge tone="success">{t('Received|payment')}</Badge>
                  {admin && p.recordedBy && (
                    <div className="muted">{t('Recorded by {name}', { name: p.recordedBy })}</div>
                  )}
                </>
              )}
            </td>
            {admin && (
              <td>
                {!p.reversedAt && (
                  <Button size="sm" variant="ghost" onClick={() => onReverse(p)}>
                    {t('Reverse|payment action')}
                  </Button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Invoice page (InvoiceView, shared by administrators and directors), below the printable sheet:
 * the payments of the invoice with their reversals, the balance and "to refund"; administrators
 * reverse a payment recorded by mistake. Not printed (class "no-print").
 */
export function InvoicePayments({ invoice, admin }: { invoice: Invoice; admin: boolean }) {
  const query = useInvoiceAccount(invoice.id, admin ? 'admin' : 'director');
  const [reversing, setReversing] = useState<InvoicePayment | null>(null);
  const [refunding, setRefunding] = useState(false);
  // A voided invoice is not owed: there is nothing to show unless money was recorded on it.
  if (invoice.status === 'VOID' && !query.data?.payments.length) return null;
  return (
    <div className="no-print" style={{ marginTop: '1.5rem' }}>
      <Card title={t('Payments and balance')}>
        <QueryView query={query}>
          {(account) => (
            <div className="stack">
              <Balance account={account} admin={admin} onRefund={() => setRefunding(true)} />
              <PaymentTable account={account} admin={admin} onReverse={setReversing} />
              {admin && account.status === 'OPEN' && account.voidBlock && (
                <p className="muted">
                  {t('This invoice can no longer be voided: {why} Issue a credit note instead.', {
                    why: voidBlockText(account.voidBlock),
                  })}
                </p>
              )}
            </div>
          )}
        </QueryView>
      </Card>
      {admin && (
        <Dialog
          open={reversing !== null}
          onClose={() => setReversing(null)}
          title={t('Reverse payment')}
        >
          {reversing && (
            <ReverseForm
              payment={reversing}
              currency={invoice.currency}
              onDone={() => setReversing(null)}
            />
          )}
        </Dialog>
      )}
      {admin && query.data && (
        <Dialog open={refunding} onClose={() => setRefunding(false)} title={t('Record refund')}>
          <RefundForm account={query.data} onDone={() => setRefunding(false)} />
        </Dialog>
      )}
    </div>
  );
}
