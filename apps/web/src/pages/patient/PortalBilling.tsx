import { useState } from 'react';
import { formatMoney, useInsurance, usePatientAccount } from '../../api/billing';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Card, EmptyState, PageHeader, QueryView } from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';
import { ChargesTable, CoverageCard, methodLabel, ReceiptDialog } from '../billing/components';

/** The patient's (or child's) insurance, charges and receipts. No clinical detail. */
export function PortalBilling() {
  const { user, acting } = useAuth();
  const patientId = acting?.patientId ?? user?.patientId ?? null;
  const insurance = useInsurance(patientId);
  const account = usePatientAccount(patientId);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title={
          acting
            ? t('Bills and payments – {name}', { name: acting.firstName })
            : t('Bills and payments')
        }
        subtitle={t('Your health insurance, the services you received and your co-payments.')}
      />
      <div className="stack">
        <QueryView query={insurance}>{(v) => <CoverageCard view={v} />}</QueryView>
        <Card title={t('Services and co-payments')}>
          <QueryView query={account}>
            {(a) => (
              <>
                {a.totals.openCopayCents > 0 ? (
                  <Alert
                    tone="info"
                    title={t('To pay: {amount}', { amount: formatMoney(a.totals.openCopayCents) })}
                  >
                    {t(
                      'You can pay co-payments at the reception of the facility where you received the service.',
                    )}
                  </Alert>
                ) : (
                  <p className="muted">{t('Nothing to pay at the moment.')}</p>
                )}
                <ChargesTable items={a.items.filter((c) => c.status !== 'VOID')} />
              </>
            )}
          </QueryView>
        </Card>
        <Card title={t('Receipts')}>
          {account.data?.payments.length ? (
            <ul className="list">
              {account.data.payments.map((p) => (
                <li key={p.id} className="row-between">
                  <span>
                    <code>{p.receiptNumber}</code> · {formatDateTime(p.receivedAt)} ·{' '}
                    {p.facilityName} · {methodLabel(p.method)} ·{' '}
                    <strong>{formatMoney(p.amountCents)}</strong>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setReceiptId(p.id)}>
                    {t('Show receipt')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t('No receipts yet')} />
          )}
        </Card>
      </div>
      <ReceiptDialog paymentId={receiptId} onClose={() => setReceiptId(null)} />
    </>
  );
}
