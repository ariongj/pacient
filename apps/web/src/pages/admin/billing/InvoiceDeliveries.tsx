import { useState } from 'react';
import {
  DELIVERY_TONE,
  deliveryKindLabel,
  deliveryStatusLabel,
  downloadPdf,
  useDeliveries,
  useSendAgain,
  type BillingDelivery,
  type DocumentKind,
} from '../../../api/billingdocs';
import type { Invoice } from '../../../api/subscriptions';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  Table,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';

/** Who a document was e-mailed to, when, why, and whether the message went out. */
function DeliveryTable({ items, caption }: { items: BillingDelivery[]; caption: string }) {
  if (items.length === 0) {
    return (
      <EmptyState title={t('Not e-mailed yet')}>
        {t(
          'Documents are e-mailed to the billing e-mails of the facility’s billing details and to its active directors.',
        )}
      </EmptyState>
    );
  }
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th scope="col">{t('Queued')}</th>
          <th scope="col">{t('Why')}</th>
          <th scope="col">{t('Recipient')}</th>
          <th scope="col">{t('Status')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id}>
            <td>{formatDateTime(d.queuedAt)}</td>
            <td>
              {deliveryKindLabel(d.kind)}
              {d.queuedBy && <div className="muted">{d.queuedBy.fullName}</div>}
            </td>
            {/* A billing address is the customer's business address: shown in full. */}
            <td style={{ wordBreak: 'break-all' }}>{d.recipient}</td>
            <td>
              <Badge tone={DELIVERY_TONE[d.status]}>{deliveryStatusLabel(d.status)}</Badge>
              {d.sentAt && <div className="muted">{formatDateTime(d.sentAt)}</div>}
              {d.status !== 'SENT' && d.lastError && (
                <div className="muted">
                  {t('Attempts: {count}', { count: d.attempts })} · {d.lastError}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The deliveries of an invoice or a credit note with "Send again" (administrators): the credit
 * note page (B2) uses it with kind 'credit_note'.
 */
export function DocumentDeliveries({
  kind,
  document,
  canSend = true,
}: {
  kind: DocumentKind;
  document: { id: string; number: string };
  canSend?: boolean;
}) {
  const query = useDeliveries(kind, document.id);
  const send = useSendAgain(kind, document.id);
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setConfirming(false);
    send.reset();
  };
  return (
    <div className="no-print" style={{ marginTop: '1rem' }}>
      <Card
        title={t('Sent by e-mail')}
        actions={
          canSend && (
            <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
              {t('Send again')}
            </Button>
          )
        }
      >
        <QueryView query={query}>
          {(data) => (
            <DeliveryTable
              items={data.items}
              caption={t('E-mails with {number}', { number: document.number })}
            />
          )}
        </QueryView>
      </Card>
      <Dialog
        open={confirming}
        onClose={close}
        title={
          kind === 'invoice'
            ? t('Send invoice {number} again', { number: document.number })
            : t('Send credit note {number} again', { number: document.number })
        }
      >
        <p>
          {t(
            'It is e-mailed with its PDF to the billing e-mails of the facility’s billing details and to its active directors, each address once.',
          )}
        </p>
        <ErrorAlert error={send.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button
            loading={send.isPending}
            onClick={() => send.mutate(undefined, { onSuccess: close })}
          >
            {t('Send again')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * Invoice page (InvoiceView, shared by administrators and directors), below the printable sheet:
 * who the invoice was e-mailed to, when and why (on issue, reminder, sent again), with the outbox
 * status, and "Send again". Administrators only. Not printed (class "no-print").
 */
export function InvoiceDeliveries({ invoice }: { invoice: Invoice }) {
  // A voided invoice is no longer owed: it is not sent again.
  return (
    <DocumentDeliveries kind="invoice" document={invoice} canSend={invoice.status !== 'VOID'} />
  );
}

/** "Download PDF" for an invoice or credit note, in the reader's own language. */
export function PdfButton({
  kind,
  document,
  scope,
  size = 'md',
}: {
  kind: DocumentKind;
  document: { id: string; number: string };
  scope: 'admin' | 'director';
  size?: 'sm' | 'md';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        loading={busy}
        aria-label={
          kind === 'invoice'
            ? t('Download invoice {number} as PDF', { number: document.number })
            : t('Download credit note {number} as PDF', { number: document.number })
        }
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await downloadPdf(kind, document, scope);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('Download PDF')}
      </Button>
      {error ? <ErrorAlert error={error} /> : null}
    </>
  );
}
