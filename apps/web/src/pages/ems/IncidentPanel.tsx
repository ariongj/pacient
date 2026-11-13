import { useState, type FormEvent } from 'react';
import {
  ON_SCENE_OUTCOMES,
  outcomeLabel,
  priorityLabel,
  priorityTone,
  statusLabel,
  useDestinations,
  useIncident,
  useIncidentAction,
  type BoardItem,
  type CareRecord,
  type EmsOutcome,
  type IncidentDetail,
  type Vehicle,
} from '../../api/ems';
import { riskLabel } from '../../api/news';
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
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatTime } from '../../format';
import { t } from '../../i18n';
import { displayName } from '../../api/identity';
import { careText, KIND_LABEL } from './careRecord';

const RISK_TONE = {
  LOW: 'success',
  LOW_MEDIUM: 'warning',
  MEDIUM: 'warning',
  HIGH: 'danger',
} as const;

/** One call: details, crew actions, patient link and the pre-hospital care record. */
export function IncidentPanel({
  id,
  vehicles,
  onClose,
}: {
  id: string;
  vehicles: Vehicle[];
  onClose: () => void;
}) {
  const incident = useIncident(id);
  return (
    <Dialog open onClose={onClose} title={t('Ambulance call')} wide>
      <QueryView query={incident}>{(d) => <IncidentBody d={d} vehicles={vehicles} />}</QueryView>
    </Dialog>
  );
}

function IncidentBody({ d, vehicles }: { d: IncidentDetail; vehicles: Vehicle[] }) {
  return (
    <div className="stack">
      <div className="row">
        <Badge tone={priorityTone(d.priority)}>{priorityLabel(d.priority)}</Badge>
        <Badge tone="neutral">{statusLabel(d.status)}</Badge>
        {d.earlyWarning && (
          <Badge tone={RISK_TONE[d.earlyWarning.risk]}>
            {`${d.earlyWarning.scale} ${d.earlyWarning.score} – ${riskLabel(d.earlyWarning.risk)}`}
          </Badge>
        )}
        <code>{d.reference}</code>
      </div>
      <DefinitionList
        items={[
          [t('What happened (main complaint)'), d.complaint],
          [t('Address'), [d.address, d.municipality].filter(Boolean).join(', ')],
          [t('Caller'), [d.callerName, d.callerPhone].filter(Boolean).join(' · ') || '—'],
          [
            t('Patient'),
            d.patient
              ? `${displayName(d.patient as Parameters<typeof displayName>[0])} · ${d.patient.nationalId} · ${formatDate(d.patient.dateOfBirth)}`
              : d.identityWithheld
                ? t('Shown when the emergency department takes over')
                : (d.patientDescription ?? t('Not identified yet')),
          ],
          [t('Vehicle'), d.vehicle ? `${d.vehicle.callSign} (${d.vehicle.level})` : '—'],
          [t('Destination'), d.destination?.name ?? '—'],
          [t('Call received'), formatDateTime(d.receivedAt)],
          [
            t('Response time'),
            d.responseMinutes !== null
              ? t('{minutes} min from dispatch to scene', { minutes: d.responseMinutes })
              : '—',
          ],
          ...(d.outcome ? ([[t('Outcome'), outcomeLabel(d.outcome)]] as [string, string][]) : []),
        ]}
      />
      {d.canAct && <CrewActions d={d} vehicles={vehicles} />}
      {d.canAct && !d.patient && d.status !== 'CLOSED' && d.status !== 'CANCELLED' && (
        <LinkPatient id={d.id} />
      )}
      <CareRecordCard d={d} />
    </div>
  );
}

function CrewActions({ d, vehicles }: { d: IncidentDetail; vehicles: Vehicle[] }) {
  const act = useIncidentAction();
  const [dialog, setDialog] = useState<null | 'dispatch' | 'transport' | 'close' | 'cancel'>(null);
  const destinations = useDestinations(dialog === 'transport');
  const available = vehicles.filter((v) => v.status === 'AVAILABLE' && v.isActive);
  const run = (action: string, body?: Record<string, unknown>) =>
    act.mutate({ id: d.id, action, body }, { onSuccess: () => setDialog(null) });

  const submit =
    (action: string, build: (v: Record<string, string>) => Record<string, unknown>) =>
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      run(action, build(formValues(e.currentTarget)));
    };

  return (
    <Card title={t('Next step')}>
      <div className="row">
        {d.status === 'RECEIVED' && (
          <Button onClick={() => setDialog('dispatch')}>{t('Dispatch a vehicle')}</Button>
        )}
        {d.status === 'DISPATCHED' && (
          <Button onClick={() => run('status', { status: 'ON_SCENE' })} loading={act.isPending}>
            {t('Arrived on scene')}
          </Button>
        )}
        {d.status === 'ON_SCENE' && (
          <>
            <Button onClick={() => setDialog('transport')}>{t('Leave for hospital')}</Button>
            <Button variant="secondary" onClick={() => setDialog('close')}>
              {t('Close on scene')}
            </Button>
          </>
        )}
        {d.status === 'TRANSPORTING' && !d.atHospitalAt && (
          <Button onClick={() => run('status', { status: 'AT_HOSPITAL' })} loading={act.isPending}>
            {t('Arrived at hospital')}
          </Button>
        )}
        {d.status === 'TRANSPORTING' && d.atHospitalAt && (
          <p className="muted">{t('Waiting for the emergency department to take the handover.')}</p>
        )}
        {d.status === 'HANDED_OVER' && (
          <Button onClick={() => run('close', { outcome: 'TRANSPORTED' })} loading={act.isPending}>
            {t('Close the call and make the vehicle available')}
          </Button>
        )}
        {(d.status === 'RECEIVED' || d.status === 'DISPATCHED') && (
          <Button variant="danger" onClick={() => setDialog('cancel')}>
            {t('Cancel the call')}
          </Button>
        )}
        {(d.status === 'CLOSED' || d.status === 'CANCELLED') && (
          <p className="muted">{t('This call is closed.')}</p>
        )}
      </div>
      <ErrorAlert error={act.error} />

      <Dialog
        open={dialog === 'dispatch'}
        onClose={() => setDialog(null)}
        title={t('Dispatch a vehicle')}
      >
        {available.length === 0 ? (
          <EmptyState title={t('No vehicle is available')} />
        ) : (
          <form onSubmit={submit('dispatch', (v) => ({ ambulanceUnitId: v.vehicle }))}>
            <SelectField
              label={t('Vehicle')}
              name="vehicle"
              required
              options={available.map((v) => ({ value: v.id, label: `${v.callSign} (${v.level})` }))}
            />
            <ErrorAlert error={act.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={act.isPending}>
                {t('Dispatch')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        open={dialog === 'transport'}
        onClose={() => setDialog(null)}
        title={t('Leave for hospital')}
      >
        <form
          onSubmit={submit('status', (v) => ({
            status: 'TRANSPORTING',
            destinationFacilityId: v.destination,
            etaMinutes: Number(v.eta),
          }))}
        >
          <SelectField
            label={t('Destination hospital')}
            name="destination"
            required
            placeholder={t('Choose…')}
            options={(destinations.data?.items ?? []).map((f) => ({
              value: f.id,
              label: [f.name, f.municipality].filter(Boolean).join(' – '),
            }))}
          />
          <TextField
            label={t('Expected arrival in minutes')}
            name="eta"
            type="number"
            min={1}
            max={240}
            required
            hint={t('The emergency department is alerted now.')}
          />
          <ErrorAlert error={act.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={act.isPending}>
              {t('Leave and alert the hospital')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={dialog === 'close'} onClose={() => setDialog(null)} title={t('Close on scene')}>
        <form onSubmit={submit('close', (v) => ({ outcome: v.outcome as EmsOutcome }))}>
          <SelectField
            label={t('Outcome')}
            name="outcome"
            required
            placeholder={t('Choose…')}
            options={ON_SCENE_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) }))}
          />
          <ErrorAlert error={act.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={act.isPending}>
              {t('Close the call')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title={t('Cancel the call')}
      >
        <form onSubmit={submit('cancel', (v) => ({ reason: v.reason }))}>
          <TextAreaField
            label={t('Reason')}
            name="reason"
            required
            minLength={3}
            maxLength={300}
            rows={2}
            hint={t('e.g. duplicate call, no longer needed')}
          />
          <ErrorAlert error={act.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('Back')}
            </Button>
            <Button type="submit" variant="danger" loading={act.isPending}>
              {t('Cancel the call')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function LinkPatient({ id }: { id: string }) {
  const act = useIncidentAction();
  const [mode, setMode] = useState<'known' | 'unknown'>('known');
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    act.mutate({
      id,
      action: 'patient',
      body:
        mode === 'known'
          ? { nationalId: v.nationalId, dateOfBirth: v.dateOfBirth }
          : {
              unidentified: {
                sex: v.sex,
                estimatedAge: Number(v.estimatedAge),
                note: v.note,
              },
            },
    });
  }
  return (
    <Card title={t('Identify the patient')}>
      <div className="row" role="radiogroup" aria-label={t('Identify the patient')}>
        <label className="checkbox">
          <input type="radio" checked={mode === 'known'} onChange={() => setMode('known')} />
          {t('With national ID and date of birth')}
        </label>
        <label className="checkbox">
          <input type="radio" checked={mode === 'unknown'} onChange={() => setMode('unknown')} />
          {t('Unidentified (temporary number)')}
        </label>
      </div>
      <form onSubmit={onSubmit} className="stack">
        {mode === 'known' ? (
          <div className="form-grid">
            <TextField
              label={t('National ID')}
              name="nationalId"
              required
              pattern="\d{10}"
              inputMode="numeric"
              autoComplete="off"
            />
            <TextField label={t('Date of birth')} name="dateOfBirth" type="date" required />
          </div>
        ) : (
          <div className="form-grid">
            <SelectField
              label={t('Sex')}
              name="sex"
              required
              options={[
                { value: 'MALE', label: t('Male') },
                { value: 'FEMALE', label: t('Female') },
                { value: 'UNKNOWN', label: t('Unknown') },
              ]}
            />
            <TextField
              label={t('Estimated age')}
              name="estimatedAge"
              type="number"
              min={0}
              max={120}
              required
            />
            <TextField
              label={t('Description')}
              name="note"
              required
              minLength={3}
              maxLength={300}
            />
          </div>
        )}
        <p className="muted">
          {t('Both the national ID and the date of birth must match; nobody is searched by name.')}
        </p>
        <ErrorAlert error={act.error} />
        <div>
          <Button type="submit" variant="secondary" loading={act.isPending}>
            {t('Link the patient')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CareRecordCard({ d }: { d: IncidentDetail }) {
  const act = useIncidentAction();
  const [kind, setKind] = useState<CareRecord['kind']>('OBSERVATION');
  const canRecord =
    d.canAct && ['DISPATCHED', 'ON_SCENE', 'TRANSPORTING', 'HANDED_OVER'].includes(d.status);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const v = formValues(form);
    let body: Record<string, unknown>;
    if (kind === 'OBSERVATION') {
      const data: Record<string, unknown> = {};
      for (const k of ['systolic', 'diastolic', 'heartRate', 'respiratoryRate', 'spo2', 'gcs']) {
        if (v[k]) data[k] = Number(v[k]);
      }
      for (const k of ['glucose', 'temperature']) if (v[k]) data[k] = Number(v[k]);
      if (v.onOxygen) data.onOxygen = v.onOxygen === 'true';
      body = { kind, data };
    } else if (kind === 'MEDICATION') {
      body = { kind, medication: v.medication, dose: v.dose, route: v.route || undefined };
    } else {
      body = { kind, text: v.text };
    }
    act.mutate({ id: d.id, action: 'care', body }, { onSuccess: () => form.reset() });
  }

  return (
    <Card title={t('Pre-hospital care record')}>
      {d.careRecords.length === 0 ? (
        <EmptyState title={t('Nothing recorded yet')} />
      ) : (
        <Table caption={t('Pre-hospital care record')}>
          <thead>
            <tr>
              <th scope="col">{t('Time')}</th>
              <th scope="col">{t('Type')}</th>
              <th scope="col">{t('Details')}</th>
              <th scope="col">{t('Recorded by')}</th>
            </tr>
          </thead>
          <tbody>
            {d.careRecords.map((r) => (
              <tr key={r.id}>
                <td>{formatTime(r.recordedAt)}</td>
                <td>{t(KIND_LABEL[r.kind])}</td>
                <td>{careText(r)}</td>
                <td>{r.recordedBy}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {d.earlyWarning && !d.earlyWarning.complete && (
        <Alert tone="info" title={t('Early warning score incomplete')}>
          {t(
            'Record respiration, SpO₂, oxygen, blood pressure, pulse, consciousness and temperature for a complete score.',
          )}
        </Alert>
      )}
      {canRecord && (
        <form onSubmit={onSubmit} className="stack" style={{ marginTop: '1rem' }}>
          <SelectField
            label={t('Record')}
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as CareRecord['kind'])}
            options={(Object.keys(KIND_LABEL) as CareRecord['kind'][]).map((k) => ({
              value: k,
              label: t(KIND_LABEL[k]),
            }))}
          />
          {kind === 'OBSERVATION' && (
            <div className="form-grid">
              <TextField
                label={t('Systolic BP')}
                name="systolic"
                type="number"
                min={40}
                max={300}
              />
              <TextField
                label={t('Diastolic BP')}
                name="diastolic"
                type="number"
                min={20}
                max={200}
              />
              <TextField
                label={t('Heart rate')}
                name="heartRate"
                type="number"
                min={20}
                max={300}
              />
              <TextField
                label={t('Respiratory rate')}
                name="respiratoryRate"
                type="number"
                min={4}
                max={80}
              />
              <TextField label="SpO₂ (%)" name="spo2" type="number" min={30} max={100} />
              <TextField label="GCS (3–15)" name="gcs" type="number" min={3} max={15} />
              <TextField
                label={t('Glucose (mmol/L)')}
                name="glucose"
                type="number"
                step="0.1"
                min={0.5}
                max={50}
              />
              <TextField
                label={t('Temperature (°C)')}
                name="temperature"
                type="number"
                step="0.1"
                min={25}
                max={45}
              />
              <SelectField
                label={t('Air or oxygen')}
                name="onOxygen"
                placeholder={t('Not recorded')}
                options={[
                  { value: 'false', label: t('Air') },
                  { value: 'true', label: t('Supplemental oxygen') },
                ]}
              />
            </div>
          )}
          {kind === 'MEDICATION' && (
            <div className="form-grid">
              <TextField
                label={t('Medicine')}
                name="medication"
                required
                minLength={2}
                maxLength={200}
              />
              <TextField label={t('Dose')} name="dose" required maxLength={100} />
              <TextField label={t('Route')} name="route" maxLength={50} />
            </div>
          )}
          {(kind === 'INTERVENTION' || kind === 'NOTE') && (
            <TextAreaField
              label={t('Details')}
              name="text"
              required
              minLength={2}
              maxLength={500}
              rows={2}
            />
          )}
          <ErrorAlert error={act.error} />
          <div>
            <Button type="submit" loading={act.isPending}>
              {t('Add to the record')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Row of the dispatch board list. */
export function boardRowLabel(i: BoardItem) {
  return i.patient
    ? displayName(i.patient as Parameters<typeof displayName>[0])
    : (i.patientDescription ?? t('Not identified yet'));
}
