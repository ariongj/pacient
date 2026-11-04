import { useState, type FormEvent } from 'react';
import {
  groupLabel,
  phaseLabel,
  PRODUCTS,
  productLabel,
  REACTION_TYPES,
  reactionTypeLabel,
  readVitals,
  requestStatusLabel,
  SEVERITIES,
  severityLabel,
  transfusionStatusLabel,
  urgencyLabel,
  urgencyTone,
  useBloodBankAction,
  useColleagues,
  usePatientBloodBank,
  vitalsSummary,
  type BloodProduct,
  type PatientBloodBank,
  type Transfusion,
} from '../../../api/bloodbank';
import { useUser } from '../../../auth/AuthContext';
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
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { useChartRole } from './shared';
import '../../bloodbank/bloodbank.css';

const ACTIVE: Transfusion['status'][] = ['ISSUED', 'AWAITING_CHECK', 'IN_PROGRESS'];

/** Blood group, transfusion requests and the bedside record of a patient. */
export function TransfusionTab({ patientId }: { patientId: string }) {
  const query = usePatientBloodBank(patientId);
  const { isDoctor } = useChartRole();
  const [requesting, setRequesting] = useState(false);
  return (
    <QueryView query={query}>
      {(d) => (
        <div className="stack">
          <BloodGroupCard data={d} />
          <Card
            title={t('Transfusion requests')}
            actions={
              isDoctor ? (
                <Button size="sm" onClick={() => setRequesting(true)}>
                  {t('Request blood products')}
                </Button>
              ) : undefined
            }
          >
            {d.requests.length === 0 ? (
              <EmptyState title={t('No transfusion requests')} />
            ) : (
              <Table caption={t('Transfusion requests')}>
                <thead>
                  <tr>
                    <th>{t('Product')}</th>
                    <th>{t('Urgency')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Requested')}</th>
                    <th>{t('Crossmatched units')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.requests.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>
                          {t('{n} × {product}', { n: r.units, product: productLabel(r.product) })}
                        </strong>
                        <div className="muted">{r.indication}</div>
                        {r.haemoglobinGl != null && (
                          <div className="muted">{t('Hb {n} g/L', { n: r.haemoglobinGl })}</div>
                        )}
                      </td>
                      <td>
                        <Badge tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</Badge>
                      </td>
                      <td>{requestStatusLabel(r.status)}</td>
                      <td>
                        {formatDateTime(r.createdAt)}
                        <div className="muted">{r.requestedBy}</div>
                      </td>
                      <td>
                        {r.reservedUnits.length === 0
                          ? '—'
                          : r.reservedUnits.map((u) => (
                              <div key={u.id} className="mono">
                                {u.unitNumber} · {groupLabel(u)}
                              </div>
                            ))}
                      </td>
                      <td>
                        {isDoctor && !['COMPLETED', 'CANCELLED'].includes(r.status) && (
                          <CancelRequest requestId={r.id} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <TransfusionsCard data={d} />
          <RequestDialog
            open={requesting}
            onClose={() => setRequesting(false)}
            patientId={patientId}
          />
        </div>
      )}
    </QueryView>
  );
}

function BloodGroupCard({ data }: { data: PatientBloodBank }) {
  const g = data.bloodGroup;
  return (
    <Card title={t('Blood group')}>
      <div className="bb-group-line">
        <span className="bb-group" aria-label={t('Blood group')}>
          {groupLabel(g.group)}
        </span>
        {g.group &&
          (g.discordant ? (
            <Badge tone="danger">{t('Results disagree – repeat on a new sample')}</Badge>
          ) : g.confirmed ? (
            <Badge tone="success">{t('Confirmed – 2 concordant tests')}</Badge>
          ) : (
            <Badge tone="warning">
              {t('Not confirmed – one test only; group O red cells until a second sample')}
            </Badge>
          ))}
        {g.group && (
          <span className="muted">
            {g.group.antibodyScreen === 'POSITIVE'
              ? t('Antibody screen positive: {antibodies}', {
                  antibodies: g.group.antibodies ?? '—',
                })
              : t('Antibody screen negative')}
          </span>
        )}
      </div>
      {!g.group && (
        <p className="muted">
          {t(
            'No blood group on record. The blood bank tests the sample sent with the first request.',
          )}
        </p>
      )}
      {g.history.length > 0 && (
        <details>
          <summary>{t('All results ({n})', { n: g.history.length })}</summary>
          <ul className="list">
            {g.history.map((h) => (
              <li key={h.id}>
                {groupLabel(h)} · {formatDateTime(h.testedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function CancelRequest({ requestId }: { requestId: string }) {
  const [open, setOpen] = useState(false);
  const cancel = useBloodBankAction<{ reason: string }>(() => `/requests/${requestId}/cancel`);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {t('Cancel request')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Cancel request')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
            cancel.mutate({ reason }, { onSuccess: () => setOpen(false) });
          }}
        >
          <TextField label={t('Reason')} name="reason" required minLength={3} maxLength={300} />
          <p className="muted">{t('Reserved units go back to the blood bank stock.')}</p>
          <ErrorAlert error={cancel.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Back')}
            </Button>
            <Button type="submit" variant="danger" loading={cancel.isPending}>
              {t('Cancel request')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function RequestDialog({
  open,
  onClose,
  patientId,
}: {
  open: boolean;
  onClose: () => void;
  patientId: string;
}) {
  const [product, setProduct] = useState<BloodProduct>('RED_CELLS');
  const [hb, setHb] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const create = useBloodBankAction<Record<string, unknown>>(() => '/requests');
  const redCells = product === 'RED_CELLS' || product === 'WHOLE_BLOOD';
  const highHb = redCells && hb !== '' && Number(hb) > 80;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      patientId,
      product,
      units: Number(f.get('units')),
      urgency: f.get('urgency'),
      indication: String(f.get('indication') ?? ''),
    };
    if (hb !== '') body.haemoglobinGl = Number(hb);
    const exception = String(f.get('exceptionReason') ?? '').trim();
    if (exception) body.exceptionReason = exception;
    create.mutate(body, {
      onSuccess: (r) => {
        if (r.warnings?.length) setWarnings(r.warnings);
        else onClose();
      },
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('Request blood products')} wide>
      {warnings.length > 0 ? (
        <div className="stack">
          <Alert tone="warning" title={t('Request sent – please note')}>
            <ul>
              {warnings.map((w) => (
                <li key={w}>{t(w)}</li>
              ))}
            </ul>
          </Alert>
          <div className="form-actions">
            <Button
              onClick={() => {
                setWarnings([]);
                onClose();
              }}
            >
              {t('Close')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <SelectField
              label={t('Product')}
              value={product}
              onChange={(e) => setProduct(e.target.value as BloodProduct)}
              options={PRODUCTS.map((p) => ({ value: p, label: productLabel(p) }))}
            />
            <TextField
              label={t('Units')}
              name="units"
              type="number"
              min={1}
              max={20}
              defaultValue={1}
              required
            />
            <SelectField
              label={t('Urgency')}
              name="urgency"
              defaultValue="ROUTINE"
              options={(['ROUTINE', 'URGENT', 'EMERGENCY'] as const).map((u) => ({
                value: u,
                label: urgencyLabel(u),
              }))}
            />
            <TextField
              label={t('Latest haemoglobin (g/L)')}
              type="number"
              min={10}
              max={250}
              value={hb}
              onChange={(e) => setHb(e.target.value)}
              hint={
                redCells ? t('Restrictive threshold: usually transfuse below 70–80 g/L') : undefined
              }
            />
          </div>
          <TextAreaField
            label={t('Indication')}
            name="indication"
            required
            minLength={5}
            maxLength={800}
            rows={3}
          />
          {highHb && (
            <>
              <Alert tone="warning" title={t('Haemoglobin above 80 g/L')}>
                {t('State why a transfusion is needed despite the haemoglobin value.')}
              </Alert>
              <TextField
                label={t('Reason for transfusing above the threshold')}
                name="exceptionReason"
                maxLength={180}
              />
            </>
          )}
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Send request')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function TransfusionsCard({ data }: { data: PatientBloodBank }) {
  const active = data.transfusions.filter((x) => ACTIVE.includes(x.status));
  const past = data.transfusions.filter((x) => !ACTIVE.includes(x.status));
  return (
    <Card title={t('Transfusions')}>
      {data.transfusions.length === 0 && <EmptyState title={t('No transfusions')} />}
      <div className="stack">
        {active.map((x) => (
          <ActiveTransfusion key={x.id} tr={x} patient={data.patient} />
        ))}
      </div>
      {past.length > 0 && (
        <Table caption={t('Past transfusions')}>
          <thead>
            <tr>
              <th>{t('Unit')}</th>
              <th>{t('Given')}</th>
              <th>{t('Checked by')}</th>
              <th>{t('Outcome')}</th>
            </tr>
          </thead>
          <tbody>
            {past.map((x) => (
              <tr key={x.id}>
                <td>
                  <span className="mono">{x.unitNumber}</span>
                  <div className="muted">
                    {productLabel(x.product)} · {groupLabel(x)}
                  </div>
                </td>
                <td>
                  {x.startedAt ? formatDateTime(x.startedAt) : '—'}
                  {x.endedAt && <div className="muted">→ {formatDateTime(x.endedAt)}</div>}
                </td>
                <td>
                  {x.checkedBy ?? '—'}
                  {x.secondChecker && <div className="muted">{x.secondChecker}</div>}
                </td>
                <td>
                  {x.reaction ? (
                    <Badge tone="danger">
                      {t('Reaction: {type} ({severity})', {
                        type: reactionTypeLabel(x.reactionType!),
                        severity: severityLabel(x.reactionSeverity!),
                      })}
                    </Badge>
                  ) : (
                    transfusionStatusLabel(x.status)
                  )}
                  <ObservationList obs={x.observations} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ObservationList({
  obs,
  compact,
}: {
  obs: Transfusion['observations'];
  compact?: boolean;
}) {
  if (!obs.length) return null;
  const list = (
    <ul className="list bb-obs">
      {obs.map((o, i) => (
        <li key={i}>
          <strong>{phaseLabel(o.phase)}</strong> · {formatDateTime(o.at)}
          {vitalsSummary(o) && <> · {vitalsSummary(o)}</>}
          {o.volumeGivenMl != null && <> · {t('{n} ml given', { n: o.volumeGivenMl })}</>}
          {o.actionsTaken && <div className="muted">{o.actionsTaken}</div>}
          {o.note && <div className="muted">{o.note}</div>}
        </li>
      ))}
    </ul>
  );
  return compact ? (
    <details>
      <summary>{t('Observations')}</summary>
      {list}
    </details>
  ) : (
    list
  );
}

function VitalsFields({ prefix = '' }: { prefix?: string }) {
  return (
    <div className="form-grid bb-vitals">
      <TextField
        label={t('Systolic BP')}
        name={`${prefix}systolic`}
        type="number"
        min={40}
        max={300}
      />
      <TextField
        label={t('Diastolic BP')}
        name={`${prefix}diastolic`}
        type="number"
        min={20}
        max={200}
      />
      <TextField label={t('Pulse')} name={`${prefix}heartRate`} type="number" min={20} max={250} />
      <TextField
        label={t('Temperature (°C)')}
        name={`${prefix}temperature`}
        type="number"
        step="0.1"
        min={30}
        max={44}
      />
      <TextField
        label={t('Respiratory rate')}
        name={`${prefix}respiratoryRate`}
        type="number"
        min={4}
        max={80}
      />
      <TextField label="SpO₂ (%)" name={`${prefix}spo2`} type="number" min={50} max={100} />
    </div>
  );
}

/** Bedside workflow for an issued unit: two-person check, observations, completion, reaction. */
function ActiveTransfusion({
  tr,
  patient,
}: {
  tr: Transfusion;
  patient: PatientBloodBank['patient'];
}) {
  const me = useUser();
  const [dialog, setDialog] = useState<'start' | 'observe' | 'complete' | 'reaction' | null>(null);
  const confirm = useBloodBankAction<Record<string, never>>(
    () => `/transfusions/${tr.id}/confirm-check`,
  );
  const amSecondChecker = tr.status === 'AWAITING_CHECK' && tr.secondCheckerId === me.id;
  const canAct = me.role === 'DOCTOR' || me.role === 'NURSE';
  return (
    <section
      className="bb-active"
      aria-label={t('Transfusion of unit {unit}', { unit: tr.unitNumber })}
    >
      <div className="row-between">
        <div>
          <strong className="mono">{tr.unitNumber}</strong> · {productLabel(tr.product)} ·{' '}
          {groupLabel(tr)} · {t('{n} ml', { n: tr.volumeMl })}
          <div className="muted">
            {t('Issued {time} by {name}', { time: formatDateTime(tr.issuedAt), name: tr.issuedBy })}
          </div>
        </div>
        <Badge tone={tr.status === 'IN_PROGRESS' ? 'info' : 'warning'}>
          {transfusionStatusLabel(tr.status)}
        </Badge>
      </div>
      {tr.status === 'AWAITING_CHECK' && (
        <Alert tone="info">
          {t(
            '{first} completed the first check. {second} must confirm with their own sign-in within 10 minutes.',
            {
              first: tr.checkedBy ?? '—',
              second: tr.secondChecker ?? '—',
            },
          )}
        </Alert>
      )}
      <ObservationList obs={tr.observations} />
      <ErrorAlert error={confirm.error} />
      {canAct && (
        <div className="row bb-actions">
          {(tr.status === 'ISSUED' || (tr.status === 'AWAITING_CHECK' && !amSecondChecker)) && (
            <Button size="sm" onClick={() => setDialog('start')}>
              {tr.status === 'ISSUED' ? t('Start bedside check') : t('Repeat bedside check')}
            </Button>
          )}
          {amSecondChecker && (
            <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate({})}>
              {t('Confirm second check')}
            </Button>
          )}
          {tr.status === 'IN_PROGRESS' && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setDialog('observe')}>
                {t('Record observation')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDialog('complete')}>
                {t('Complete transfusion')}
              </Button>
            </>
          )}
          {tr.status === 'IN_PROGRESS' && (
            <Button size="sm" variant="danger" onClick={() => setDialog('reaction')}>
              {t('Suspected reaction – stop')}
            </Button>
          )}
        </div>
      )}
      {dialog === 'start' && (
        <StartDialog tr={tr} patient={patient} onClose={() => setDialog(null)} />
      )}
      {dialog === 'observe' && <ObserveDialog tr={tr} onClose={() => setDialog(null)} />}
      {dialog === 'complete' && <CompleteDialog tr={tr} onClose={() => setDialog(null)} />}
      {dialog === 'reaction' && <ReactionDialog tr={tr} onClose={() => setDialog(null)} />}
    </section>
  );
}

function StartDialog({
  tr,
  patient,
  onClose,
}: {
  tr: Transfusion;
  patient: PatientBloodBank['patient'];
  onClose: () => void;
}) {
  const colleagues = useColleagues();
  const start = useBloodBankAction<Record<string, unknown>>(() => `/transfusions/${tr.id}/start`);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    start.mutate(
      {
        nationalId: String(f.get('nationalId') ?? '').trim(),
        dateOfBirth: String(f.get('dateOfBirth') ?? ''),
        unitNumber: String(f.get('unitNumber') ?? '').trim(),
        secondCheckerId: String(f.get('secondCheckerId') ?? ''),
        vitals: readVitals(f),
      },
      { onSuccess: onClose },
    );
  }
  return (
    <Dialog open onClose={onClose} title={t('Bedside check')} wide>
      <form onSubmit={onSubmit}>
        <Alert tone="info" title={t('Check at the bedside, against the patient’s wristband')}>
          {t(
            'Type or scan the national ID and date of birth from the wristband and the unit number from the bag – do not copy them from this screen.',
          )}
        </Alert>
        <p className="muted">
          {t('Patient: {name}', { name: `${patient.firstName} ${patient.lastName}` })}
        </p>
        <div className="form-grid">
          <TextField
            label={t('National ID (wristband)')}
            name="nationalId"
            required
            autoComplete="off"
          />
          <TextField
            label={t('Date of birth (wristband)')}
            name="dateOfBirth"
            type="date"
            required
          />
          <TextField
            label={t('Unit number (bag label)')}
            name="unitNumber"
            required
            autoComplete="off"
          />
          <SelectField
            label={t('Second checker')}
            name="secondCheckerId"
            required
            placeholder={t('Choose a colleague')}
            options={(colleagues.data ?? []).map((c) => ({
              value: c.id,
              label: `${c.fullName} (${c.role === 'DOCTOR' ? t('Doctor') : t('Nurse')})`,
            }))}
            hint={t('They confirm on their own device within 10 minutes.')}
          />
        </div>
        <h3>{t('Baseline observations')}</h3>
        <VitalsFields />
        <ErrorAlert error={start.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={start.isPending}>
            {t('Confirm first check')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ObserveDialog({ tr, onClose }: { tr: Transfusion; onClose: () => void }) {
  const observe = useBloodBankAction<Record<string, unknown>>(
    () => `/transfusions/${tr.id}/observation`,
  );
  const has15 = tr.observations.some((o) => o.phase === 'T15');
  return (
    <Dialog open onClose={onClose} title={t('Record observation')} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const note = String(f.get('note') ?? '').trim();
          observe.mutate(
            { phase: f.get('phase'), vitals: readVitals(f), ...(note ? { note } : {}) },
            { onSuccess: onClose },
          );
        }}
      >
        <SelectField
          label={t('When')}
          name="phase"
          defaultValue={has15 ? 'HOURLY' : 'T15'}
          options={(['T15', 'HOURLY', 'OTHER'] as const).map((p) => ({
            value: p,
            label: phaseLabel(p),
          }))}
        />
        <VitalsFields />
        <TextField label={t('Note')} name="note" maxLength={300} />
        <ErrorAlert error={observe.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={observe.isPending}>
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CompleteDialog({ tr, onClose }: { tr: Transfusion; onClose: () => void }) {
  const complete = useBloodBankAction<Record<string, unknown>>(
    () => `/transfusions/${tr.id}/complete`,
  );
  return (
    <Dialog open onClose={onClose} title={t('Complete transfusion')} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          complete.mutate(
            { volumeGivenMl: Number(f.get('volumeGivenMl')), vitals: readVitals(f) },
            { onSuccess: onClose },
          );
        }}
      >
        <TextField
          label={t('Volume given (ml)')}
          name="volumeGivenMl"
          type="number"
          min={1}
          max={1500}
          defaultValue={tr.volumeMl}
          required
        />
        <h3>{t('End observations')}</h3>
        <VitalsFields />
        <ErrorAlert error={complete.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={complete.isPending}>
            {t('Complete transfusion')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReactionDialog({ tr, onClose }: { tr: Transfusion; onClose: () => void }) {
  const report = useBloodBankAction<Record<string, unknown>>(
    () => `/transfusions/${tr.id}/reaction`,
  );
  return (
    <Dialog open onClose={onClose} title={t('Suspected transfusion reaction')} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const actions = String(f.get('actionsTaken') ?? '').trim();
          report.mutate(
            {
              type: f.get('type'),
              severity: f.get('severity'),
              details: String(f.get('details') ?? ''),
              vitals: readVitals(f),
              ...(actions ? { actionsTaken: actions } : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <Alert tone="danger" title={t('Stop the transfusion now')}>
          {t(
            'Keep the line open with saline, check the patient and the unit label, and call the doctor. Saving this stops the transfusion and alerts the doctor and the blood bank.',
          )}
        </Alert>
        <div className="form-grid">
          <SelectField
            label={t('Type of reaction')}
            name="type"
            options={REACTION_TYPES.map((r) => ({ value: r, label: reactionTypeLabel(r) }))}
          />
          <SelectField
            label={t('Severity')}
            name="severity"
            options={SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) }))}
          />
        </div>
        <TextAreaField
          label={t('What happened')}
          name="details"
          required
          minLength={5}
          maxLength={1500}
          rows={3}
        />
        <TextField label={t('Actions taken')} name="actionsTaken" maxLength={400} />
        <VitalsFields />
        <ErrorAlert error={report.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Back')}
          </Button>
          <Button type="submit" variant="danger" loading={report.isPending}>
            {t('Stop transfusion and report')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
