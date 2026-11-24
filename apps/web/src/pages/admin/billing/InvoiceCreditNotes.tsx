import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  creditNotePath,
  issueCreditNote,
  useInvoiceAccount,
  type InvoiceAccountView,
} from '../../../api/billingcorrections';
import {
  centsToInput,
  formatMoney,
  inputToCents,
  useBillingMutation,
  type Invoice,
} from '../../../api/subscriptions';
import {
  Alert,
  Button,
  Card,
  Dialog,
  ErrorAlert,
  formValues,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate } from '../../../format';
import { t } from '../../../i18n';

function CreditNoteForm({
  account: a,
  onDone,
}: {
  account: InvoiceAccountView;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const mutation = useBillingMutation(issueCreditNote);
  const [amountError, setAmountError] = useState<string>();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const amountCents = inputToCents(v.amount ?? '');
    if (!amountCents || Number.isNaN(amountCents) || amountCents > a.creditableCents) {
      setAmountError(
        t('Enter an amount above 0 and at most {max}.', {
          max: formatMoney(a.creditableCents, a.currency),
        }),
      );
      return;
    }
    setAmountError(undefined);
    mutation.mutate(
      { invoiceId: a.invoiceId, amountCents, reason: v.reason ?? '' },
      {
        onSuccess: (note) => {
          onDone();
          navigate(creditNotePath(note.id, 'admin'));
        },
      },
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <p>
        {t('Invoice {number}', { number: a.number })} ·{' '}
        {t('Up to {amount} can still be credited.', {
          amount: formatMoney(a.creditableCents, a.currency),
        })}
      </p>
      <div className="form-grid">
        <TextField
          label={t('Amount to credit, VAT included (€)')}
          name="amount"
          inputMode="decimal"
          required
          // An irreversible document: the amount is typed, never assumed (except what is owed).
          defaultValue={a.status === 'OPEN' ? centsToInput(a.balanceCents) : ''}
          error={amountError}
        />
      </div>
      <TextAreaField
        label={t('Reason')}
        name="reason"
        required
        minLength={5}
        maxLength={500}
        hint={t('Printed on the credit note, e.g. “Service not available from 3 to 10 March”.')}
      />
      <Alert tone="info" title={t('A credit note cannot be changed or withdrawn')}>
        {a.status === 'PAID'
          ? t(
              'The invoice is paid: the amount credited is to be refunded to the facility, outside Pacient.',
            )
          : t(
              'What is still owed goes down by the amount; a credit note that brings it to 0 settles the invoice.',
            )}{' '}
        {t(
          'The credit note is numbered, e-mailed to the facility and shown to its directors. You will be asked for your password.',
        )}
      </Alert>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Issue credit note')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Invoice page (InvoiceView, shared by administrators and directors), below the printable sheet:
 * the credit notes of the invoice (directors see them too); administrators issue one. Not printed
 * (class "no-print").
 */
export function InvoiceCreditNotes({ invoice, admin }: { invoice: Invoice; admin: boolean }) {
  const scope = admin ? 'admin' : 'director';
  const query = useInvoiceAccount(invoice.id, scope);
  const [open, setOpen] = useState(false);
  const a = query.data;
  if (!a) return null;
  const canIssue = admin && a.status !== 'VOID' && a.creditableCents > 0;
  // Directors see the card only when there is something to see.
  if (!a.creditNotes.length && !canIssue) return null;
  return (
    <div className="no-print" style={{ marginTop: '1.5rem' }}>
      <Card
        title={t('Credit notes')}
        actions={
          canIssue && (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              {t('Issue credit note')}
            </Button>
          )
        }
      >
        {a.creditNotes.length === 0 ? (
          <p className="muted">
            {t(
              'An issued invoice is never changed. To reduce or cancel what it charges, issue a credit note.',
            )}
          </p>
        ) : (
          <Table caption={t('Credit notes')}>
            <thead>
              <tr>
                <th scope="col">{t('Number')}</th>
                <th scope="col">{t('Issued')}</th>
                <th scope="col">{t('Reason')}</th>
                <th scope="col" className="num">
                  {t('Amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {a.creditNotes.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={creditNotePath(c.id, scope)} style={{ whiteSpace: 'nowrap' }}>
                      {c.number}
                    </Link>
                  </td>
                  <td>{formatDate(c.issuedAt)}</td>
                  <td>{c.reason}</td>
                  <td className="num">{formatMoney(c.totalCents, c.currency)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {admin && (
        <Dialog open={open} onClose={() => setOpen(false)} title={t('Issue credit note')}>
          <CreditNoteForm account={a} onDone={() => setOpen(false)} />
        </Dialog>
      )}
    </div>
  );
}
