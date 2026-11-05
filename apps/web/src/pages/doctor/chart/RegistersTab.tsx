import { useState, type FormEvent } from 'react';
import {
  detailLabel,
  processLabel,
  REGISTER_CODES,
  registerLabel,
  resultLabel,
  STATE_TONE,
  stateLabel,
  targetDescription,
  useEnrol,
  useLeave,
  usePatientRegisters,
  useRecordProcess,
  type PatientRegisters,
  type ProcessStatus,
  type RegisterCode,
} from '../../../api/registers';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';

/** Small trend line (values scaled between their own minimum and maximum). */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 96;
  const h = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * (w - 4) + 2},${h - 2 - ((v - min) / span) * (h - 4)}`,
    )
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <polyline points={pts} style={{ fill: 'none', stroke: 'var(--primary)', strokeWidth: 2 }} />
    </svg>
  );
}

function TargetBadge({ target }: { target: ProcessStatus['target'] }) {
  if (!target) return null;
  if (target.met === null) return <Badge>{t('No recent value')}</Badge>;
  return target.met ? (
    <Badge tone="success">{t('At target')}</Badge>
  ) : (
    <Badge tone="warning">{t('Above target')}</Badge>
  );
}

function RecordDialog({
  patientId,
  register,
  process,
  onClose,
}: {
  patientId: string;
  register: RegisterCode;
  process: ProcessStatus;
  onClose: () => void;
}) {
  const record = useRecordProcess(patientId, onClose);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const date = String(f.get('performedAt') ?? '');
    record.mutate({
      register,
      process: process.code,
      result: String(f.get('result')),
      notes: String(f.get('notes') ?? '').trim() || undefined,
      performedAt: date ? new Date(date).toISOString() : undefined,
    });
  }
  return (
    <Dialog open onClose={onClose} title={processLabel(process.code)}>
      <form onSubmit={onSubmit}>
        <p className="muted">{registerLabel(register)}</p>
        <SelectField
          label={t('Result')}
          name="result"
          required
          options={(process.results ?? []).map((r) => ({ value: r, label: resultLabel(r) }))}
        />
        <TextField
          label={t('Date')}
          name="performedAt"
          type="date"
          hint={t('Leave empty for today')}
          max={new Date().toISOString().slice(0, 10)}
        />
        <TextAreaField label={t('Notes')} name="notes" maxLength={500} rows={2} />
        <ErrorAlert error={record.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={record.isPending}>
            {t('Save to record')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EnrolDialog({
  patientId,
  data,
  initial,
  onClose,
}: {
  patientId: string;
  data: PatientRegisters;
  initial?: RegisterCode;
  onClose: () => void;
}) {
  const enrol = useEnrol(patientId, onClose);
  const available = REGISTER_CODES.filter((r) => !data.registers.some((e) => e.register === r));
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    enrol.mutate({
      register: String(f.get('register')) as RegisterCode,
      reason: String(f.get('reason') ?? '').trim() || undefined,
    });
  }
  return (
    <Dialog open onClose={onClose} title={t('Add to a register')}>
      <form onSubmit={onSubmit}>
        <SelectField
          label={t('Register')}
          name="register"
          required
          defaultValue={initial}
          options={available.map((r) => ({ value: r, label: registerLabel(r) }))}
        />
        <TextField
          label={t('Reason')}
          name="reason"
          maxLength={200}
          hint={t('e.g. diagnosis confirmed by spirometry')}
        />
        <ErrorAlert error={enrol.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={enrol.isPending}>
            {t('Add to register')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function LeaveDialog({
  patientId,
  enrolment,
  onClose,
}: {
  patientId: string;
  enrolment: { id: string; register: RegisterCode };
  onClose: () => void;
}) {
  const leave = useLeave(patientId, onClose);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    leave.mutate({ enrolmentId: enrolment.id, reason: String(f.get('reason') ?? '').trim() });
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Remove from the {register} register', {
        register: registerLabel(enrolment.register),
      })}
    >
      <form onSubmit={onSubmit}>
        <TextField
          label={t('Reason')}
          name="reason"
          required
          minLength={3}
          maxLength={200}
          hint={t('e.g. diagnosis revised, moved to another family doctor')}
        />
        <ErrorAlert error={leave.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={leave.isPending}>
            {t('Remove from register')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Chronic care: the registers the patient is in and the state of each annual-review item, with
 * targets and trends; doctors add or remove registers, doctors and nurses record review items.
 */
export function RegistersTab({ patientId }: { patientId: string }) {
  const query = usePatientRegisters(patientId);
  const [recording, setRecording] = useState<{
    register: RegisterCode;
    process: ProcessStatus;
  } | null>(null);
  const [enrolling, setEnrolling] = useState<{ initial?: RegisterCode } | null>(null);
  const [leaving, setLeaving] = useState<{ id: string; register: RegisterCode } | null>(null);

  return (
    <QueryView query={query}>
      {(data) => (
        <div className="stack">
          {data.suggested.length > 0 && data.canEnrol && (
            <Alert tone="info" title={t('Register suggested by a diagnosis')}>
              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {data.suggested.map((s) => (
                  <li key={s.register}>
                    {registerLabel(s.register)} — {s.diagnosis}{' '}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEnrolling({ initial: s.register })}
                    >
                      {t('Add to register')}
                    </Button>
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          {data.registers.length === 0 ? (
            <Card
              actions={
                data.canEnrol && (
                  <Button size="sm" onClick={() => setEnrolling({})}>
                    {t('Add to a register')}
                  </Button>
                )
              }
            >
              <EmptyState title={t('Not in any chronic disease register')}>
                {t(
                  'Patients join automatically when a matching diagnosis is recorded (diabetes, hypertension, asthma, COPD, chronic kidney disease, heart failure).',
                )}
              </EmptyState>
            </Card>
          ) : (
            data.registers.map((r) => {
              const overdue = r.processes.filter((p) => p.state === 'OVERDUE').length;
              return (
                <Card
                  key={r.id}
                  title={
                    <>
                      {registerLabel(r.register)}{' '}
                      {overdue > 0 ? (
                        <Badge tone="danger">{t('{count} overdue', { count: overdue })}</Badge>
                      ) : (
                        <Badge tone="success">{t('Reviews up to date')}</Badge>
                      )}
                    </>
                  }
                  actions={
                    data.canEnrol && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setLeaving({ id: r.id, register: r.register })}
                      >
                        {t('Remove from register')}
                      </Button>
                    )
                  }
                >
                  <p className="muted">
                    {t('In the register since {date} ({source}) · {facility}', {
                      date: formatDate(r.enrolledAt),
                      source:
                        r.source === 'DIAGNOSIS' ? t('from a diagnosis') : t('added by a doctor'),
                      facility: r.facilityName,
                    })}
                  </p>
                  <Table
                    caption={t('Review items for {register}', {
                      register: registerLabel(r.register),
                    })}
                  >
                    <thead>
                      <tr>
                        <th>{t('Review item')}</th>
                        <th>{t('Last result')}</th>
                        <th>{t('Status')}</th>
                        <th>{t('Target')}</th>
                        <th>{t('Trend')}</th>
                        <th>
                          <span className="sr-only">{t('Actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.processes.map((p) => (
                        <tr key={p.code}>
                          <td>
                            {processLabel(p.code)}
                            <div className="muted">
                              {t('Every {months} months', {
                                months: Math.round(p.intervalDays / 30.4),
                              })}
                            </div>
                          </td>
                          <td>
                            {p.last ? (
                              <>
                                {p.recordable ? resultLabel(p.last.display) : p.last.display}
                                <div className="muted">{formatDate(p.last.at)}</div>
                                {p.last.detail && (
                                  <div className="muted">{detailLabel(p.last.detail)}</div>
                                )}
                              </>
                            ) : (
                              <span className="muted">{t('Not recorded')}</span>
                            )}
                          </td>
                          <td>
                            <Badge tone={STATE_TONE[p.state]}>{stateLabel(p.state)}</Badge>
                            <div className="muted">
                              {t('Due {date}', { date: formatDate(p.dueDate) })}
                            </div>
                          </td>
                          <td>
                            {p.target ? (
                              <>
                                <TargetBadge target={p.target} />
                                <div className="muted">{targetDescription(p.target.code)}</div>
                              </>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>
                            <Sparkline
                              values={p.trend.map((x) => x.value)}
                              label={t('Trend of {item}: {values}', {
                                item: processLabel(p.code),
                                values: p.trend.map((x) => x.value).join(', '),
                              })}
                            />
                          </td>
                          <td>
                            {p.recordable && data.canRecord && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setRecording({ register: r.register, process: p })}
                              >
                                {t('Record')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              );
            })
          )}
          {data.registers.length > 0 && data.canEnrol && (
            <div>
              <Button size="sm" variant="secondary" onClick={() => setEnrolling({})}>
                {t('Add to a register')}
              </Button>
            </div>
          )}
          {data.records.length > 0 && (
            <Card title={t('Recorded review items')}>
              <Table caption={t('Recorded review items')}>
                <thead>
                  <tr>
                    <th>{t('Date')}</th>
                    <th>{t('Register')}</th>
                    <th>{t('Review item')}</th>
                    <th>{t('Result')}</th>
                    <th>{t('Recorded by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.records.map((x) => (
                    <tr key={x.id}>
                      <td>{formatDateTime(x.performedAt)}</td>
                      <td>{registerLabel(x.register)}</td>
                      <td>{processLabel(x.process)}</td>
                      <td>
                        {resultLabel(x.result)}
                        {x.notes && <div className="muted">{x.notes}</div>}
                      </td>
                      <td>{x.recordedBy ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
          {data.history.length > 0 && (
            <Card title={t('Earlier register memberships')}>
              <ul>
                {data.history.map((h) => (
                  <li key={h.id}>
                    {t('{register}: {from} – {to}', {
                      register: registerLabel(h.register),
                      from: formatDate(h.enrolledAt),
                      to: formatDate(h.leftAt),
                    })}
                    {h.leftReason && <span className="muted"> · {h.leftReason}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="muted">
            {t(
              'Intervals and targets are placeholders until confirmed by the national clinical guidelines.',
            )}
          </p>
          {recording && (
            <RecordDialog
              patientId={patientId}
              register={recording.register}
              process={recording.process}
              onClose={() => setRecording(null)}
            />
          )}
          {enrolling && (
            <EnrolDialog
              patientId={patientId}
              data={data}
              initial={enrolling.initial}
              onClose={() => setEnrolling(null)}
            />
          )}
          {leaving && (
            <LeaveDialog
              patientId={patientId}
              enrolment={leaving}
              onClose={() => setLeaving(null)}
            />
          )}
        </div>
      )}
    </QueryView>
  );
}
