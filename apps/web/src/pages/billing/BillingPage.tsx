import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, downloadFile } from '../../api/client';
import {
  BILLING_KEY,
  categoryLabel,
  claimStatusLabel,
  formatMoney,
  SERVICE_CATEGORIES,
  useBillingMutation,
  useInsurance,
  usePatientAccount,
  useServices,
  type BillingSummary,
  type Charge,
  type Claim,
  type ClaimDetail,
} from '../../api/billing';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  Tabs,
  TabPanel,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t, tn } from '../../i18n';
import {
  chargeTone,
  ChargesTable,
  CoverageCard,
  methodLabel,
  ReceiptDialog,
  VoidChargeDialog,
} from './components';

type Tab = 'account' | 'charges' | 'claims' | 'tariff';
const TABS: Tab[] = ['account', 'charges', 'claims', 'tariff'];

interface PatientHit {
  id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth: string;
}

/** Billing office of a facility: patient accounts, charges, claims to the Fund, tariff. */
export function BillingPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'account';
  const summary = useQuery({
    queryKey: [...BILLING_KEY, 'summary'],
    queryFn: () => api<BillingSummary>('/billing/summary'),
  });
  const setTab = (next: Tab) => setParams((p) => ({ ...Object.fromEntries(p), tab: next }));

  return (
    <>
      <PageHeader
        title={t('Billing and insurance')}
        subtitle={t(
          'Co-payments, charges produced by care and claims to the Health Insurance Fund.',
        )}
      />
      <QueryView query={summary}>
        {(s) => (
          <Grid min={170}>
            <Stat
              label={t('Co-payments to collect')}
              value={formatMoney(s.openCopayCents)}
              tone={s.openCopayCents ? 'warning' : undefined}
            />
            <Stat
              label={t('Collected this month')}
              value={formatMoney(s.copaymentsThisMonthCents)}
              tone="success"
            />
            <Stat label={t('Not yet claimed')} value={formatMoney(s.unclaimedCents)} />
            <Stat
              label={t('Claimed, awaiting payment')}
              value={formatMoney(s.claimedCents)}
              tone="info"
            />
            <Stat label={t('Paid by the Fund')} value={formatMoney(s.paidByInsurerCents)} />
          </Grid>
        )}
      </QueryView>
      <Alert tone="info" title={t('Demo tariff')}>
        {t(
          'Prices and co-payments are illustrative and must be replaced by the official tariff of the Health Insurance Fund.',
        )}
      </Alert>
      <Tabs<Tab>
        label={t('Billing sections')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'account', label: t('Patient account') },
          { id: 'charges', label: t('Charges') },
          { id: 'claims', label: t('Claims') },
          { id: 'tariff', label: t('Tariff') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'account' && <AccountTab />}
        {tab === 'charges' && <ChargesTab />}
        {tab === 'claims' && <ClaimsTab />}
        {tab === 'tariff' && <TariffTab />}
      </TabPanel>
    </>
  );
}

function PatientSearch({ onPick }: { onPick: (p: PatientHit) => void }) {
  const [q, setQ] = useState('');
  const hits = useQuery({
    queryKey: [...BILLING_KEY, 'search', q],
    queryFn: () =>
      api<{ items: PatientHit[] }>('/billing/patients', { query: { q } }).then((r) => r.items),
    enabled: q.trim().length >= 2,
  });
  return (
    <Card title={t('Find patient')}>
      <TextField
        label={t('Name or national ID')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('At least 2 characters')}
        autoComplete="off"
      />
      {q.trim().length >= 2 && (
        <QueryView query={hits}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No patients found')} />
            ) : (
              <ul className="list">
                {items.map((p) => (
                  <li key={p.id} className="row-between">
                    <span>
                      <strong>
                        {p.firstName} {p.lastName}
                      </strong>{' '}
                      <span className="muted">
                        {p.nationalId} · {formatDate(p.dateOfBirth)}
                      </span>
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => onPick(p)}>
                      {t('Open account')}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
      )}
    </Card>
  );
}

function AccountTab() {
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const insurance = useInsurance(patient?.id ?? null);
  const account = usePatientAccount(patient?.id ?? null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState<Charge | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [method, setMethod] = useState('CASH');
  const pay = useBillingMutation((body: Record<string, unknown>) =>
    api<{ id: string }>('/billing/payments', { method: 'POST', body }),
  );

  if (!patient) return <PatientSearch onPick={(p) => setPatient(p)} />;
  const items = account.data?.items ?? [];
  const total = items.filter((c) => selected.has(c.id)).reduce((a, c) => a + c.copayCents, 0);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const payableIds = items
    .filter((c) => c.status !== 'VOID' && c.copayCents > 0 && !c.copayPaid)
    .map((c) => c.id);

  return (
    <div className="stack">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>
          {patient.firstName} {patient.lastName}{' '}
          <span className="muted" style={{ fontWeight: 400 }}>
            {patient.nationalId}
          </span>
        </h2>
        <Button variant="secondary" size="sm" onClick={() => setPatient(null)}>
          {t('Another patient')}
        </Button>
      </div>
      <QueryView query={insurance}>{(v) => <CoverageCard view={v} />}</QueryView>
      <Card
        title={t('Charges at this facility')}
        actions={
          payableIds.length ? (
            <span className="row" style={{ gap: '0.5rem' }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setSelected(new Set(payableIds))}
              >
                {t('Select all to pay')}
              </Button>
              <Button size="sm" disabled={!selected.size} onClick={() => setPaying(true)}>
                {t('Take payment')} {selected.size ? `· ${formatMoney(total)}` : ''}
              </Button>
            </span>
          ) : undefined
        }
      >
        <QueryView query={account}>
          {(a) => (
            <>
              <p className="muted">
                {t('To pay: {open} · paid: {paid} · paid by the Fund: {insurer}', {
                  open: formatMoney(a.totals.openCopayCents),
                  paid: formatMoney(a.totals.paidCopayCents),
                  insurer: formatMoney(a.totals.insurerCents),
                })}
              </p>
              <ChargesTable
                items={a.items}
                selectable
                selected={selected}
                onToggle={toggle}
                onVoid={setVoiding}
              />
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
                  {methodLabel(p.method)} · <strong>{formatMoney(p.amountCents)}</strong>
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
      <Dialog open={paying} onClose={() => setPaying(false)} title={t('Take payment')}>
        <p>
          {tn(selected.size, '{count} co-payment', '{count} co-payments')} ·{' '}
          <strong>{formatMoney(total)}</strong>
        </p>
        <SelectField
          label={t('Payment method')}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={[
            { value: 'CASH', label: t('Cash') },
            { value: 'CARD', label: t('Card') },
            { value: 'TRANSFER', label: t('Bank transfer') },
          ]}
        />
        <ErrorAlert error={pay.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setPaying(false)}>
            {t('Cancel')}
          </Button>
          <Button
            loading={pay.isPending}
            onClick={() =>
              pay.mutate(
                { patientId: patient.id, chargeIds: [...selected], method },
                {
                  onSuccess: (r) => {
                    setPaying(false);
                    setSelected(new Set());
                    setReceiptId(r.id);
                  },
                },
              )
            }
          >
            {t('Confirm payment')}
          </Button>
        </div>
      </Dialog>
      <VoidChargeDialog charge={voiding} onClose={() => setVoiding(null)} />
      <ReceiptDialog paymentId={receiptId} onClose={() => setReceiptId(null)} />
    </div>
  );
}

function ChargesTab() {
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [unpaid, setUnpaid] = useState(false);
  const [page, setPage] = useState(1);
  const [voiding, setVoiding] = useState<Charge | null>(null);
  const list = useQuery({
    queryKey: [...BILLING_KEY, 'charges', status, category, unpaid, page],
    queryFn: () =>
      api<{ items: Charge[]; page: number; totalPages: number; total: number }>(
        '/billing/charges',
        {
          query: {
            status: status || undefined,
            category: category || undefined,
            unpaidCopay: unpaid ? 'true' : undefined,
            page,
          },
        },
      ),
  });
  const capture = useBillingMutation(() =>
    api<{ created: Record<string, number> }>('/billing/capture', { method: 'POST' }),
  );
  const created = capture.data
    ? Object.values(capture.data.created).reduce((a, b) => a + b, 0)
    : null;
  return (
    <Card
      title={t('Charges')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={capture.isPending}
          onClick={() => capture.mutate(undefined)}
        >
          {t('Capture new charges now')}
        </Button>
      }
    >
      <p className="muted">
        {t(
          'Charges are created automatically every hour from signed visits, emergency visits, completed tests, imaging reports, hospital stays, operations and dispensed medicines.',
        )}
      </p>
      {created !== null && (
        <Alert tone="success" title={tn(created, '{count} new charge', '{count} new charges')} />
      )}
      <ErrorAlert error={capture.error} />
      <div className="form-grid">
        <SelectField
          label={t('Status')}
          value={status}
          placeholder={t('All')}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          options={['OPEN', 'CLAIMED', 'PAID', 'REJECTED', 'VOID'].map((s) => ({
            value: s,
            label: t(
              {
                OPEN: 'Not yet claimed',
                CLAIMED: 'Claimed from the Fund',
                PAID: 'Settled',
                REJECTED: 'Rejected by the Fund',
                VOID: 'Voided',
              }[s]!,
            ),
          }))}
        />
        <SelectField
          label={t('Category')}
          value={category}
          placeholder={t('All')}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
          options={SERVICE_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
        />
        <label className="checkbox" style={{ alignSelf: 'end' }}>
          <input
            type="checkbox"
            checked={unpaid}
            onChange={(e) => {
              setUnpaid(e.target.checked);
              setPage(1);
            }}
          />
          <span>{t('Only unpaid co-payments')}</span>
        </label>
      </div>
      <QueryView query={list}>
        {(r) => (
          <>
            <ChargesTable items={r.items} onVoid={setVoiding} />
            <Pagination page={r.page} totalPages={r.totalPages} onChange={setPage} />
          </>
        )}
      </QueryView>
      <VoidChargeDialog charge={voiding} onClose={() => setVoiding(null)} />
    </Card>
  );
}

const monthStart = (offset: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function ClaimsTab() {
  const user = useUser();
  const list = useQuery({
    queryKey: [...BILLING_KEY, 'claims'],
    queryFn: () => api<{ items: Claim[] }>('/billing/claims').then((r) => r.items),
  });
  const [from, setFrom] = useState(isoDay(monthStart(-1)));
  const [to, setTo] = useState(isoDay(new Date(monthStart(0).getTime() - 86_400_000)));
  const [openId, setOpenId] = useState<string | null>(null);
  const create = useBillingMutation((body: { periodFrom: string; periodTo: string }) =>
    api<Claim>('/billing/claims', { method: 'POST', body }),
  );
  return (
    <div className="stack">
      <Card title={t('New claim to the Health Insurance Fund')}>
        <p className="muted">
          {t(
            'A claim collects the insured charges of the period that are not yet claimed. Review it, then submit; the Fund reads submitted claims through its system and sends its decision.',
          )}
        </p>
        <div className="form-grid">
          <TextField
            label={t('From')}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label={t('To')}
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <ErrorAlert error={create.error} />
        <div className="form-actions">
          <Button
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                { periodFrom: from, periodTo: to },
                { onSuccess: (c) => setOpenId(c.id) },
              )
            }
          >
            {t('Prepare claim')}
          </Button>
        </div>
      </Card>
      <Card title={t('Claims')}>
        <QueryView query={list}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No claims yet')} />
            ) : (
              <Table caption={t('Claims')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Reference')}</th>
                    <th scope="col">{t('Period')}</th>
                    <th scope="col" className="num">
                      {t('Lines')}
                    </th>
                    <th scope="col" className="num">
                      {t('Claimed')}
                    </th>
                    <th scope="col" className="num">
                      {t('Paid')}
                    </th>
                    <th scope="col">{t('Status')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <code>{c.reference}</code>
                      </td>
                      <td>
                        {formatDate(c.periodFrom)} – {formatDate(c.periodTo)}
                      </td>
                      <td className="num">{c.lineCount}</td>
                      <td className="num">{formatMoney(c.totalCents)}</td>
                      <td className="num">{formatMoney(c.paidCents)}</td>
                      <td>
                        <ClaimBadge status={c.status} />
                        {c.responseNote && <div className="muted">{c.responseNote}</div>}
                      </td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setOpenId(c.id)}>
                          {t('Open|action')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>
      <ClaimDialog
        claimId={openId}
        onClose={() => setOpenId(null)}
        canSubmit={['DIRECTOR', 'RECEPTION'].includes(user.role)}
      />
    </div>
  );
}

function ClaimBadge({ status }: { status: string }) {
  const tone =
    status === 'PAID'
      ? 'success'
      : status === 'REJECTED'
        ? 'danger'
        : status === 'DRAFT'
          ? 'warning'
          : status === 'PARTIALLY_PAID'
            ? 'warning'
            : 'info';
  return <Badge tone={tone}>{claimStatusLabel(status)}</Badge>;
}

function ClaimDialog({
  claimId,
  onClose,
  canSubmit,
}: {
  claimId: string | null;
  onClose: () => void;
  canSubmit: boolean;
}) {
  const q = useQuery({
    queryKey: [...BILLING_KEY, 'claim', claimId],
    queryFn: () => api<ClaimDetail>(`/billing/claims/${claimId}`),
    enabled: Boolean(claimId),
  });
  const submit = useBillingMutation((id: string) =>
    api(`/billing/claims/${id}/submit`, { method: 'POST' }),
  );
  const discard = useBillingMutation((id: string) =>
    api(`/billing/claims/${id}/discard`, { method: 'POST' }),
  );
  return (
    <Dialog open={Boolean(claimId)} onClose={onClose} title={t('Claim')} wide>
      <QueryView query={q}>
        {(c) => (
          <div className="stack">
            <div className="row-between">
              <span>
                <code>{c.reference}</code> · {formatDate(c.periodFrom)} – {formatDate(c.periodTo)}
              </span>
              <ClaimBadge status={c.status} />
            </div>
            <Grid min={150}>
              <Stat label={t('Claimed')} value={formatMoney(c.totalCents)} />
              <Stat label={t('Paid')} value={formatMoney(c.paidCents)} />
              <Stat label={t('Lines')} value={String(c.lines.length)} />
            </Grid>
            <Table caption={t('Claim lines')}>
              <thead>
                <tr>
                  <th scope="col">{t('Date')}</th>
                  <th scope="col">{t('Patient')}</th>
                  <th scope="col">{t('Service')}</th>
                  <th scope="col" className="num">
                    {t('Fund pays')}
                  </th>
                  <th scope="col">{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.slice(0, 200).map((l) => (
                  <tr key={l.id}>
                    <td>{formatDate(l.serviceDate)}</td>
                    <td>
                      {l.patientName}
                      <div className="muted">{l.policyNumber ?? l.nationalId}</div>
                    </td>
                    <td>
                      {l.serviceName}
                      {l.quantity > 1 ? ` × ${l.quantity}` : ''}
                    </td>
                    <td className="num">{formatMoney(l.insurerCents)}</td>
                    <td>
                      <Badge tone={chargeTone(l.status)}>
                        {t(
                          l.status === 'CLAIMED'
                            ? 'Claimed from the Fund'
                            : l.status === 'PAID'
                              ? 'Settled'
                              : l.status === 'REJECTED'
                                ? 'Rejected by the Fund'
                                : 'Not yet claimed',
                        )}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {c.lines.length > 200 && (
              <p className="muted">{t('Showing the first 200 lines; download the CSV for all.')}</p>
            )}
            <ErrorAlert error={submit.error ?? discard.error} />
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={() =>
                  void downloadFile(`/billing/claims/${c.id}`, `${c.reference}.csv`, {
                    format: 'csv',
                  })
                }
              >
                {t('Download CSV')}
              </Button>
              {canSubmit && c.status === 'DRAFT' && (
                <>
                  <Button
                    variant="ghost"
                    loading={discard.isPending}
                    onClick={() => discard.mutate(c.id, { onSuccess: onClose })}
                  >
                    {t('Discard draft')}
                  </Button>
                  <Button loading={submit.isPending} onClick={() => submit.mutate(c.id)}>
                    {t('Submit to the Fund')}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

function TariffTab() {
  const services = useServices();
  return (
    <Card title={t('National tariff (demo)')}>
      <QueryView query={services}>
        {(items) => (
          <Table caption={t('National tariff (demo)')}>
            <thead>
              <tr>
                <th scope="col">{t('Code')}</th>
                <th scope="col">{t('Service')}</th>
                <th scope="col">{t('Category')}</th>
                <th scope="col" className="num">
                  {t('Price')}
                </th>
                <th scope="col" className="num">
                  {t('Co-payment')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className={s.isActive ? undefined : 'muted'}>
                  <td>
                    <code>{s.code}</code>
                  </td>
                  <td>{s.name}</td>
                  <td>{categoryLabel(s.category)}</td>
                  <td className="num">{formatMoney(s.priceCents)}</td>
                  <td className="num">{formatMoney(s.copayCents)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryView>
    </Card>
  );
}
