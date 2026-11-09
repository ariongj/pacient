import { useEffect, useState, type FormEvent } from 'react';
import {
  eventLabel,
  flagLabel,
  priorityLabel,
  REJECTION_REASONS,
  rejectionLabel,
  useLabAction,
  useLabLabel,
  useLabMe,
  useLabStats,
  useWorklist,
  type LabPriority,
  type RejectionReason,
  type WorklistItem,
  type WorklistView,
} from '../../api/labwork';
import { BarcodeScanner } from '../../components/BarcodeScanner';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  Loading,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  Tabs,
  TextAreaField,
  TextField,
  formValues,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, fullName } from '../../format';
import { t } from '../../i18n';
import { Code39 } from './Code39';
import './labwork.css';

const priorityTone = (p: LabPriority) =>
  p === 'STAT' ? 'danger' : p === 'URGENT' ? 'warning' : 'neutral';

/** Laboratory worklist (technicians, laboratory doctors) and turnaround statistics (directors). */
export function LabWorkPage() {
  const me = useLabMe();
  return (
    <>
      <PageHeader
        title={t('Laboratory worklist')}
        subtitle={t(
          'Specimens, manual results and validation by a second person. Results from a connected laboratory system arrive automatically.',
        )}
      />
      <QueryView query={me}>
        {(m) =>
          m.labStaff ? (
            <div className="stack">
              <Worklist />
              <LabStatsCard />
            </div>
          ) : m.canSeeStats ? (
            <LabStatsCard />
          ) : (
            <EmptyState title={t('This page is for laboratory staff')}>
              <p className="muted">{t('Order tests and read results in the patient’s chart.')}</p>
            </EmptyState>
          )
        }
      </QueryView>
    </>
  );
}

type Pending = { kind: 'receive' | 'reject' | 'result' | 'label'; item: WorklistItem } | null;

function Worklist() {
  const [view, setView] = useState<WorklistView>('open');
  const [priority, setPriority] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useWorklist({ view, priority, q, page });
  const action = useLabAction();
  const [pending, setPending] = useState<Pending>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = (a: Parameters<typeof action.mutate>[0], message: string) =>
    action.mutate(a, {
      onSuccess: () => {
        setDone(message);
        setPending(null);
      },
    });

  return (
    <Card title={t('Orders')}>
      <Tabs
        label={t('Laboratory worklist')}
        withPanels={false}
        active={view}
        onChange={(v) => {
          setView(v);
          setPage(1);
        }}
        tabs={[
          { id: 'open', label: t('To do') },
          { id: 'validation', label: t('To validate') },
          { id: 'done', label: t('Done (7 days)') },
        ]}
      />
      <form
        className="search-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = formValues(e.currentTarget);
          setQ(v.q ?? '');
          setPriority(v.priority ?? '');
          setPage(1);
        }}
      >
        <TextField
          label={t('Order number, name or national ID')}
          name="q"
          type="search"
          defaultValue={q}
        />
        <SelectField
          label={t('Priority')}
          name="priority"
          defaultValue={priority}
          placeholder={t('All priorities')}
          options={(['STAT', 'URGENT', 'ROUTINE'] as const).map((p) => ({
            value: p,
            label: priorityLabel(p),
          }))}
        />
        <Button type="submit" variant="secondary">
          {t('Filter')}
        </Button>
      </form>
      {done && <Alert tone="success">{done}</Alert>}
      {action.error && !pending && <ErrorAlert error={action.error} />}
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('Nothing waiting here')} />
          ) : (
            <>
              <Table caption={t('Laboratory orders')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Priority')}</th>
                    <th scope="col">{t('Patient')}</th>
                    <th scope="col">{t('Test')}</th>
                    <th scope="col">{t('Ordered')}</th>
                    <th scope="col">{t('Status')}</th>
                    <th scope="col">{t('Result')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.id} className={i.priority === 'STAT' ? 'lab-row-stat' : undefined}>
                      <td>
                        <Badge tone={priorityTone(i.priority)}>{priorityLabel(i.priority)}</Badge>
                      </td>
                      <td>
                        <strong>{fullName(i.patient)}</strong>
                        <div className="muted">
                          {formatDate(i.patient.dateOfBirth)} · <code>{i.patient.nationalId}</code>
                        </div>
                      </td>
                      <td>
                        {i.testName}
                        <div className="muted">
                          {i.specimen ?? '—'} · <code>{i.placerOrderNumber}</code>
                        </div>
                        {i.clinicalNotes && <div className="muted">{i.clinicalNotes}</div>}
                      </td>
                      <td>
                        {formatDateTime(i.createdAt)}
                        <div className="muted">{i.orderedBy}</div>
                      </td>
                      <td>
                        {i.lastEvent ? (
                          <>
                            {i.lastEvent.event === 'REJECTED' ? (
                              <Badge tone="danger">{eventLabel('REJECTED')}</Badge>
                            ) : (
                              eventLabel(i.lastEvent.event)
                            )}
                            <div className="muted">{formatDateTime(i.lastEvent.at)}</div>
                            {i.lastEvent.event === 'REJECTED' && i.lastEvent.reason && (
                              <div className="muted">
                                {rejectionLabel(i.lastEvent.reason.split(':')[0]!)}
                              </div>
                            )}
                          </>
                        ) : (
                          t('Waiting for the specimen')
                        )}
                        {i.lisManaged && <div className="muted">{t('Laboratory system')}</div>}
                      </td>
                      <td>
                        {i.result ? (
                          <>
                            <span
                              className={
                                i.result.flag === 'CRITICAL' ? 'lab-flag-critical' : undefined
                              }
                            >
                              {i.result.value} {i.result.unit ?? ''}
                            </span>
                            {i.result.flag !== 'NORMAL' && (
                              <div>
                                <Badge tone={i.result.flag === 'CRITICAL' ? 'danger' : 'warning'}>
                                  {flagLabel(i.result.flag)}
                                </Badge>
                              </div>
                            )}
                            <div className="muted">
                              {i.result.status === 'PRELIMINARY'
                                ? t('Preliminary – entered by {name}', {
                                    name: i.result.enteredByName ?? '—',
                                  })
                                : t('Final')}
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <RowActions
                          item={i}
                          busy={action.isPending}
                          onAction={(kind) => {
                            setDone(null);
                            action.reset();
                            if (kind === 'collect') {
                              run({ kind: 'collect', orderId: i.id }, t('Specimen taken'));
                            } else if (kind === 'validate' && i.result) {
                              run(
                                { kind: 'validate', resultId: i.result.id },
                                t('Result validated and sent to the ordering doctor'),
                              );
                            } else if (kind !== 'validate') {
                              setPending({ kind, item: i });
                            }
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>

      <Dialog
        open={pending?.kind === 'receive'}
        onClose={() => setPending(null)}
        title={t('Receive the specimen')}
      >
        {pending?.kind === 'receive' && (
          <div className="stack">
            <p>
              {pending.item.testName} · {fullName(pending.item.patient)}
            </p>
            <BarcodeScanner
              label={t('Scan or type the specimen barcode')}
              hint={t('The barcode must match the order: {code}', {
                code: pending.item.barcode ?? pending.item.placerOrderNumber,
              })}
              autoFocus
              disabled={action.isPending}
              onScan={(barcode) =>
                run({ kind: 'receive', orderId: pending.item.id, barcode }, t('Specimen received'))
              }
            />
            {action.error && <ErrorAlert error={action.error} />}
          </div>
        )}
      </Dialog>

      <Dialog
        open={pending?.kind === 'reject'}
        onClose={() => setPending(null)}
        title={t('Reject the specimen')}
      >
        {pending?.kind === 'reject' && (
          <RejectForm
            item={pending.item}
            busy={action.isPending}
            error={action.error}
            onSubmit={(reason, note) =>
              run(
                { kind: 'reject', orderId: pending.item.id, reason, note },
                t('Specimen rejected – the ordering doctor was told a new sample is needed'),
              )
            }
          />
        )}
      </Dialog>

      <Dialog
        open={pending?.kind === 'result'}
        onClose={() => setPending(null)}
        title={t('Enter the result')}
      >
        {pending?.kind === 'result' && (
          <ResultForm
            item={pending.item}
            busy={action.isPending}
            error={action.error}
            onSubmit={(value, critical) =>
              run(
                { kind: 'result', orderId: pending.item.id, value, critical },
                t('Preliminary result saved – a colleague must validate it'),
              )
            }
          />
        )}
      </Dialog>

      <Dialog
        open={pending?.kind === 'label'}
        onClose={() => setPending(null)}
        title={t('Specimen label')}
      >
        {pending?.kind === 'label' && <LabelSheet orderId={pending.item.id} />}
      </Dialog>
    </Card>
  );
}

function RowActions({
  item,
  busy,
  onAction,
}: {
  item: WorklistItem;
  busy: boolean;
  onAction: (k: 'collect' | 'receive' | 'reject' | 'result' | 'validate' | 'label') => void;
}) {
  const ordered = item.status === 'ORDERED';
  const collected = item.lastEvent?.event === 'COLLECTED';
  const canEnter =
    !item.lisManaged &&
    (item.status === 'RECEIVED' ||
      (item.status === 'IN_PROGRESS' && item.result?.status === 'PRELIMINARY'));
  const what = `${item.testName}, ${fullName(item.patient)}`;
  return (
    <div className="lab-actions">
      {ordered && !collected && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('collect')}>
          {t('Specimen taken')}
          <span className="sr-only">: {what}</span>
        </Button>
      )}
      {ordered && (
        <Button size="sm" disabled={busy} onClick={() => onAction('receive')}>
          {t('Receive')}
          <span className="sr-only">: {what}</span>
        </Button>
      )}
      {canEnter && (
        <Button size="sm" disabled={busy} onClick={() => onAction('result')}>
          {item.result ? t('Correct the value') : t('Enter result')}
          <span className="sr-only">: {what}</span>
        </Button>
      )}
      {item.result?.canValidate && (
        <Button size="sm" disabled={busy} onClick={() => onAction('validate')}>
          {t('Validate')}
          <span className="sr-only">: {what}</span>
        </Button>
      )}
      {(ordered || item.status === 'RECEIVED') && !item.lisManaged && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('reject')}>
          {t('Reject')}
          <span className="sr-only">: {what}</span>
        </Button>
      )}
      {item.status !== 'RESULTED' && (
        <Button size="sm" variant="ghost" onClick={() => onAction('label')}>
          {t('Label')}
          <span className="sr-only">: {what}</span>
        </Button>
      )}
    </div>
  );
}

function RejectForm({
  item,
  busy,
  error,
  onSubmit,
}: {
  item: WorklistItem;
  busy: boolean;
  error: unknown;
  onSubmit: (reason: RejectionReason, note?: string) => void;
}) {
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    onSubmit(v.reason as RejectionReason, v.note || undefined);
  }
  return (
    <form className="stack" onSubmit={submit}>
      <p>
        {item.testName} · {fullName(item.patient)}
      </p>
      <SelectField
        label={t('Reason')}
        name="reason"
        required
        options={REJECTION_REASONS.map((r) => ({ value: r, label: rejectionLabel(r) }))}
      />
      <TextAreaField
        label={t('Note')}
        name="note"
        maxLength={250}
        hint={t('Required for “Other”.')}
      />
      <p className="muted">
        {t(
          'The order goes back to “ordered” so a new sample can be taken, and the ordering doctor is told.',
        )}
      </p>
      {error ? <ErrorAlert error={error} /> : null}
      <div className="form-actions">
        <Button type="submit" variant="danger" loading={busy}>
          {t('Reject the specimen')}
        </Button>
      </div>
    </form>
  );
}

function ResultForm({
  item,
  busy,
  error,
  onSubmit,
}: {
  item: WorklistItem;
  busy: boolean;
  error: unknown;
  onSubmit: (value: string, critical: boolean) => void;
}) {
  const [critical, setCritical] = useState(false);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    onSubmit(v.value ?? '', critical);
  }
  return (
    <form className="stack" onSubmit={submit}>
      <p>
        <strong>{item.testName}</strong> · {fullName(item.patient)} ·{' '}
        <code>{item.placerOrderNumber}</code>
      </p>
      <TextField
        label={t('Value')}
        name="value"
        required
        maxLength={100}
        autoComplete="off"
        defaultValue={item.result?.value ?? ''}
        hint={
          item.result?.referenceRange
            ? t('Reference range {range} {unit}', {
                range: item.result.referenceRange,
                unit: item.result.unit ?? '',
              })
            : undefined
        }
      />
      <label className="checkbox">
        <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} />{' '}
        {t('Mark as critical (call the ward after validation)')}
      </label>
      <p className="muted">
        {t(
          'The value is saved as preliminary. It is flagged from the reference range and critical limits, and a colleague must validate it before the doctor gets it.',
        )}
      </p>
      {error ? <ErrorAlert error={error} /> : null}
      <div className="form-actions">
        <Button type="submit" loading={busy}>
          {t('Save preliminary result')}
        </Button>
      </div>
    </form>
  );
}

/** The label is printed alone (labwork.css hides everything else while printing). */
function LabelSheet({ orderId }: { orderId: string }) {
  const label = useLabLabel(orderId);
  useEffect(() => {
    const after = () => document.body.classList.remove('printing-lab-label');
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('afterprint', after);
      after();
    };
  }, []);
  if (label.isPending) return <Loading />;
  if (label.error) return <ErrorAlert error={label.error} />;
  const l = label.data!;
  return (
    <div className="stack">
      <div className="lab-label">
        <div className="lab-label-name">
          {fullName(l.patient)} · {formatDate(l.patient.dateOfBirth)}
        </div>
        <div>
          {l.patient.nationalId} · {l.testName}
        </div>
        <Code39 value={l.barcode} />
        <div className="lab-label-code">{l.barcode}</div>
        <div>
          {priorityLabel(l.priority)}
          {l.collectedAt ? ` · ${formatDateTime(l.collectedAt)}` : ''}
        </div>
      </div>
      <div className="form-actions">
        <Button
          onClick={() => {
            document.body.classList.add('printing-lab-label');
            window.print();
          }}
        >
          {t('Print label')}
        </Button>
      </div>
    </div>
  );
}

function LabStatsCard() {
  const [days, setDays] = useState(30);
  const stats = useLabStats(days);
  return (
    <Card
      title={t('Turnaround')}
      actions={
        <SelectField
          label={t('Period')}
          name="days"
          value={String(days)}
          onChange={(e) => setDays(Number(e.target.value))}
          options={[7, 30, 90].map((d) => ({
            value: String(d),
            label: t('Last {n} days', { n: d }),
          }))}
        />
      }
    >
      <QueryView query={stats}>
        {(s) => (
          <div className="stack">
            <Grid>
              <Stat label={t('Waiting for the specimen')} value={formatNumber(s.open.ORDERED)} />
              <Stat label={t('Received, no result yet')} value={formatNumber(s.open.RECEIVED)} />
              <Stat label={t('Waiting for validation')} value={formatNumber(s.open.IN_PROGRESS)} />
              <Stat
                label={t('Resulted in the period')}
                value={formatNumber(s.resulted)}
                hint={t('{n} from the laboratory system', { n: s.resultedByLis })}
              />
            </Grid>
            <Table caption={t('Time from receipt to final result')}>
              <thead>
                <tr>
                  <th scope="col">{t('Priority')}</th>
                  <th scope="col" className="num">
                    {t('Results')}
                  </th>
                  <th scope="col" className="num">
                    {t('Median (minutes)')}
                  </th>
                  <th scope="col" className="num">
                    {t('90th percentile (minutes)')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.turnaround.map((r) => (
                  <tr key={r.priority}>
                    <th scope="row">{priorityLabel(r.priority)}</th>
                    <td className="num">{formatNumber(r.count)}</td>
                    <td className="num">{r.median === null ? '—' : formatNumber(r.median)}</td>
                    <td className="num">{r.p90 === null ? '—' : formatNumber(r.p90)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <h3>{t('Rejected specimens')}</h3>
            {s.rejections.length === 0 ? (
              <p className="muted">{t('No specimens were rejected in the period.')}</p>
            ) : (
              <ul>
                {s.rejections.map((r) => (
                  <li key={r.reason}>
                    {rejectionLabel(r.reason)}: {formatNumber(r.count)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </QueryView>
    </Card>
  );
}
