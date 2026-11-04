import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import {
  BILLING_KEY,
  categoryLabel,
  chargeStatusLabel,
  EXEMPTIONS,
  exemptionLabel,
  formatMoney,
  INSURERS,
  insurerLabel,
  useBillingMutation,
  type Charge,
  type InsuranceView,
  type Receipt,
} from '../../api/billing';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';

const today = () => new Date().toISOString().slice(0, 10);

export function chargeTone(status: string) {
  switch (status) {
    case 'PAID':
      return 'success' as const;
    case 'REJECTED':
      return 'danger' as const;
    case 'VOID':
      return 'neutral' as const;
    case 'CLAIMED':
      return 'info' as const;
    default:
      return 'warning' as const;
  }
}

/** Insurance status of a patient, with verification and editing for billing staff. */
export function CoverageCard({ view }: { view: InsuranceView }) {
  const [adding, setAdding] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const verify = useBillingMutation(() =>
    api<{ eligible: boolean; message: string }>(
      `/billing/patients/${view.patient.id}/insurance/verify`,
      { method: 'POST' },
    ),
  );
  const end = useBillingMutation((id: string) =>
    api(`/billing/patients/${view.patient.id}/insurance/${id}`, {
      method: 'PATCH',
      body: { status: 'ENDED', validUntil: today() },
    }),
  );
  const c = view.current;
  const exemption = c?.exemption ?? view.automaticExemption;
  return (
    <Card
      title={t('Health insurance')}
      actions={
        view.canEdit ? (
          <span className="row" style={{ gap: '0.5rem' }}>
            <Button
              size="sm"
              variant="secondary"
              loading={verify.isPending}
              onClick={() =>
                verify.mutate(undefined, {
                  onSuccess: (r) =>
                    setVerifyMessage(
                      r.eligible ? t('Insured with the Health Insurance Fund.') : t(r.message),
                    ),
                })
              }
            >
              {t('Check with the Fund')}
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              {t('Add coverage')}
            </Button>
          </span>
        ) : undefined
      }
    >
      {c ? (
        <DefinitionList
          items={[
            [t('Insurer'), insurerLabel(c.insurer)],
            [t('Insurance number'), c.policyNumber ?? '—'],
            [
              t('Co-payment'),
              exemption ? (
                <Badge tone="success">
                  {t('Exempt')} · {exemptionLabel(exemption)}
                </Badge>
              ) : c.insurer === 'NONE' ? (
                <Badge tone="warning">{t('Pays the full price')}</Badge>
              ) : (
                <Badge tone="info">{t('Pays the co-payment')}</Badge>
              ),
            ],
            [
              t('Valid'),
              `${formatDate(c.validFrom)} – ${c.validUntil ? formatDate(c.validUntil) : t('open-ended')}`,
            ],
            [t('Last checked'), c.verifiedAt ? formatDateTime(c.verifiedAt) : t('Not checked')],
          ]}
        />
      ) : (
        <Alert tone="warning" title={t('No valid insurance on record')}>
          {t('Without insurance the patient pays the full price of services.')}
          {view.automaticExemption
            ? ` ${t('Co-payment exemption by age: {category}.', { category: exemptionLabel(view.automaticExemption) })}`
            : ''}
        </Alert>
      )}
      {verifyMessage && <Alert tone="info" title={verifyMessage} />}
      <ErrorAlert error={verify.error ?? end.error} />
      {view.history.length > 1 && (
        <details style={{ marginTop: '0.75rem' }}>
          <summary>{t('Coverage history')}</summary>
          <ul className="list">
            {view.history.map((h) => (
              <li key={h.id} className="row-between">
                <span>
                  {insurerLabel(h.insurer)} · {h.policyNumber ?? '—'} · {formatDate(h.validFrom)} –{' '}
                  {h.validUntil ? formatDate(h.validUntil) : t('open-ended')}{' '}
                  <Badge tone={h.status === 'ACTIVE' ? 'success' : 'neutral'}>
                    {h.status === 'ACTIVE'
                      ? t('Active')
                      : h.status === 'SUSPENDED'
                        ? t('Suspended')
                        : t('Ended')}
                  </Badge>
                </span>
                {view.canEdit && h.status === 'ACTIVE' && (
                  <Button size="sm" variant="ghost" onClick={() => end.mutate(h.id)}>
                    {t('End coverage')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {view.canEdit && (
        <AddCoverageDialog
          patientId={view.patient.id}
          open={adding}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

function AddCoverageDialog({
  patientId,
  open,
  onClose,
}: {
  patientId: string;
  open: boolean;
  onClose: () => void;
}) {
  const save = useBillingMutation((body: Record<string, unknown>) =>
    api(`/billing/patients/${patientId}/insurance`, { method: 'POST', body }),
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    save.mutate(
      {
        insurer: v.insurer,
        policyNumber: v.policyNumber || null,
        exemption: v.exemption || null,
        validFrom: v.validFrom,
        validUntil: v.validUntil || null,
      },
      { onSuccess: onClose },
    );
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('Add coverage')}>
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <SelectField
            label={t('Insurer')}
            name="insurer"
            required
            defaultValue="FSSH"
            options={INSURERS.map((i) => ({ value: i, label: insurerLabel(i) }))}
          />
          <TextField label={t('Insurance number')} name="policyNumber" maxLength={60} />
          <SelectField
            label={t('Co-payment exemption')}
            name="exemption"
            placeholder={t('No exemption')}
            options={EXEMPTIONS.map((e) => ({ value: e, label: exemptionLabel(e) }))}
            hint={t('Children under 18 and people aged 65 and over are exempt automatically.')}
          />
          <TextField
            label={t('Valid from')}
            name="validFrom"
            type="date"
            required
            defaultValue={today()}
          />
          <TextField label={t('Valid until')} name="validUntil" type="date" />
        </div>
        <ErrorAlert error={save.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Charges of one patient; billing staff can select open co-payments to take payment. */
export function ChargesTable({
  items,
  selectable,
  selected,
  onToggle,
  onVoid,
}: {
  items: Charge[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onVoid?: (c: Charge) => void;
}) {
  if (!items.length) return <EmptyState title={t('No charges')} />;
  return (
    <Table caption={t('Charges')}>
      <thead>
        <tr>
          {selectable && (
            <th scope="col">
              <span className="sr-only">{t('Select')}</span>
            </th>
          )}
          <th scope="col">{t('Date')}</th>
          <th scope="col">{t('Service')}</th>
          <th scope="col" className="num">
            {t('Price')}
          </th>
          <th scope="col" className="num">
            {t('Fund pays')}
          </th>
          <th scope="col" className="num">
            {t('Patient pays')}
          </th>
          <th scope="col">{t('Status')}</th>
          {onVoid && (
            <th scope="col">
              <span className="sr-only">{t('Actions')}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {items.map((c) => {
          const payable = c.status !== 'VOID' && c.copayCents > 0 && !c.copayPaid;
          return (
            <tr key={c.id} className={c.status === 'VOID' ? 'muted' : undefined}>
              {selectable && (
                <td>
                  {payable && (
                    <input
                      type="checkbox"
                      aria-label={t('Pay {service}', { service: c.serviceName })}
                      checked={selected?.has(c.id) ?? false}
                      onChange={() => onToggle?.(c.id)}
                    />
                  )}
                </td>
              )}
              <td>{formatDate(c.serviceDate)}</td>
              <td>
                <strong>{c.serviceName}</strong>
                <div className="muted">
                  {categoryLabel(c.category)}
                  {c.quantity > 1 ? ` · × ${c.quantity}` : ''} · {c.facilityName}
                  {c.patientName ? ` · ${c.patientName}` : ''}
                </div>
              </td>
              <td className="num">{formatMoney(c.totalCents)}</td>
              <td className="num">{formatMoney(c.insurerCents)}</td>
              <td className="num">
                {formatMoney(c.copayCents)}
                <div>
                  {c.copayCents === 0 ? (
                    <small className="muted">{t('Nothing to pay')}</small>
                  ) : c.copayPaid ? (
                    <Badge tone="success">{t('Paid')}</Badge>
                  ) : c.status !== 'VOID' ? (
                    <Badge tone="warning">{t('To pay')}</Badge>
                  ) : null}
                </div>
              </td>
              <td>
                <Badge tone={chargeTone(c.status)}>{chargeStatusLabel(c.status)}</Badge>
                {c.voidReason && <div className="muted">{c.voidReason}</div>}
              </td>
              {onVoid && (
                <td>
                  {c.status === 'OPEN' && !c.claimId && !c.receiptNumber && (
                    <Button size="sm" variant="ghost" onClick={() => onVoid(c)}>
                      {t('Void')}
                    </Button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export function VoidChargeDialog({
  charge,
  onClose,
}: {
  charge: Charge | null;
  onClose: () => void;
}) {
  const voidIt = useBillingMutation((v: { id: string; reason: string }) =>
    api(`/billing/charges/${v.id}/void`, { method: 'POST', body: { reason: v.reason } }),
  );
  return (
    <Dialog open={Boolean(charge)} onClose={onClose} title={t('Void charge')}>
      {charge && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const { reason } = formValues(e.currentTarget);
            voidIt.mutate({ id: charge.id, reason: reason ?? '' }, { onSuccess: onClose });
          }}
        >
          <p>
            <strong>{charge.serviceName}</strong> · {formatDate(charge.serviceDate)} ·{' '}
            {formatMoney(charge.totalCents)}
          </p>
          <TextField label={t('Reason')} name="reason" required minLength={5} maxLength={300} />
          <ErrorAlert error={voidIt.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" variant="danger" loading={voidIt.isPending}>
              {t('Void charge')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function methodLabel(m: string) {
  return m === 'CARD' ? t('Card') : m === 'TRANSFER' ? t('Bank transfer') : t('Cash');
}

/** A printable co-payment receipt. */
export function ReceiptDialog({
  paymentId,
  onClose,
}: {
  paymentId: string | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: [...BILLING_KEY, 'receipt', paymentId],
    queryFn: () => api<Receipt>(`/billing/payments/${paymentId}`),
    enabled: Boolean(paymentId),
  });
  return (
    <Dialog open={Boolean(paymentId)} onClose={onClose} title={t('Receipt')} wide>
      <QueryView query={q}>
        {(r) => (
          <div className="receipt">
            <div className="row-between">
              <div>
                <strong>{r.facilityName}</strong>
                <div className="muted">{r.facilityCode}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div>
                  {t('Receipt no.')} <code>{r.receiptNumber}</code>
                </div>
                <div className="muted">{formatDateTime(r.receivedAt)}</div>
              </div>
            </div>
            <p>
              {t('Patient')}: <strong>{r.patientName}</strong> · {t('National ID')} {r.nationalId}
            </p>
            <Table caption={t('Receipt lines')}>
              <thead>
                <tr>
                  <th scope="col">{t('Date')}</th>
                  <th scope="col">{t('Service')}</th>
                  <th scope="col" className="num">
                    {t('Co-payment')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{formatDate(l.serviceDate)}</td>
                    <td>
                      {l.serviceName}
                      {l.quantity > 1 ? ` × ${l.quantity}` : ''}
                    </td>
                    <td className="num">{formatMoney(l.copayCents)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" colSpan={2}>
                    {t('Total paid')} ({methodLabel(r.method)})
                  </th>
                  <td className="num">
                    <strong>{formatMoney(r.amountCents)}</strong>
                  </td>
                </tr>
              </tbody>
            </Table>
            <p className="muted">
              {t(
                'Co-payment for publicly insured services. The remaining cost is paid by the Health Insurance Fund.',
              )}
            </p>
            <div className="form-actions">
              <Button variant="secondary" onClick={() => window.print()}>
                {t('Print')}
              </Button>
            </div>
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

export { methodLabel };
