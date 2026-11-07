import { useState, type FormEvent } from 'react';
import {
  AGE_FACTORS,
  ALERT_TONE,
  alertLabel,
  CONTACT_TONE,
  contactStateLabel,
  gestationLabel,
  KEY_TEST_TONE,
  keyTestLabel,
  keyTestStateLabel,
  LOW_RISK_FACTORS,
  OUTCOMES,
  outcomeLabel,
  PRESENTATIONS,
  presentationLabel,
  RISK_FACTORS,
  riskFactorLabel,
  URINE_PROTEIN,
  useBookPregnancy,
  useClosePregnancy,
  usePatientPregnancies,
  useRecordVisit,
  useUpdatePregnancy,
  type DatingWarning,
  type Outcome,
  type Pregnancy,
  type RiskFactor,
  type VisitAlert,
} from '../../../api/maternity';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../../format';
import { t } from '../../../i18n';

const todayIso = () => new Date().toISOString().slice(0, 10);
const num = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? undefined : Number(s);
};
const str = (v: FormDataEntryValue | null) => String(v ?? '').trim() || undefined;
const bool = (v: FormDataEntryValue | null) =>
  v === 'yes' ? true : v === 'no' ? false : undefined;

export function AlertList({ alerts }: { alerts: VisitAlert[] }) {
  if (!alerts.length) return null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.25rem' }}>
      {alerts.map((a) => (
        <Badge key={a.code} tone={ALERT_TONE[a.severity]}>
          {alertLabel(a.code)}
        </Badge>
      ))}
    </span>
  );
}

function DatingWarnings({ warnings }: { warnings: DatingWarning[] }) {
  if (!warnings.length) return null;
  return (
    <Alert tone="warning" title={t('Check the dating')}>
      {warnings.map((w) =>
        t(
          'The scan and the last menstrual period differ by {days} days. The scan due date is used.',
          { days: w.days },
        ),
      )}
    </Alert>
  );
}

function RiskFactorFields({
  initial,
  otherNote,
}: {
  initial: RiskFactor[];
  otherNote?: string | null;
}) {
  const [other, setOther] = useState(initial.includes('OTHER'));
  return (
    <fieldset className="stack" style={{ gap: '0.35rem' }}>
      <legend>{t('Risk factors')}</legend>
      <p className="muted" style={{ margin: 0 }}>
        {t(
          'Age is added automatically. Factors marked * make the pregnancy high risk (illustrative mapping until the national guideline is adopted).',
        )}
      </p>
      <div className="form-grid">
        {RISK_FACTORS.filter((f) => !AGE_FACTORS.includes(f)).map((f) => (
          <label key={f} className="checkbox">
            <input
              type="checkbox"
              name="riskFactors"
              value={f}
              defaultChecked={initial.includes(f)}
              onChange={f === 'OTHER' ? (e) => setOther(e.currentTarget.checked) : undefined}
            />
            <span>
              {riskFactorLabel(f)}
              {LOW_RISK_FACTORS.includes(f) ? '' : ' *'}
            </span>
          </label>
        ))}
      </div>
      {other && (
        <TextField
          label={t('Describe the other risk factor')}
          name="otherRiskNote"
          required
          maxLength={200}
          defaultValue={otherNote ?? ''}
        />
      )}
    </fieldset>
  );
}

function BookDialog({
  patientId,
  onClose,
  onWarnings,
}: {
  patientId: string;
  onClose: () => void;
  onWarnings: (w: DatingWarning[]) => void;
}) {
  const book = useBookPregnancy(patientId, (r) => {
    onWarnings(r.warnings);
    onClose();
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    book.mutate({
      lmpDate: str(f.get('lmpDate')),
      scanEdd: str(f.get('scanEdd')),
      gravida: Number(f.get('gravida')),
      para: Number(f.get('para')),
      riskFactors: f.getAll('riskFactors').map(String) as RiskFactor[],
      otherRiskNote: str(f.get('otherRiskNote')),
    });
  }
  return (
    <Dialog open onClose={onClose} title={t('Book a pregnancy')} wide>
      <form onSubmit={onSubmit} className="stack">
        <div className="form-grid">
          <TextField
            label={t('First day of the last menstrual period')}
            name="lmpDate"
            type="date"
            max={todayIso()}
          />
          <TextField
            label={t('Due date from the dating scan')}
            name="scanEdd"
            type="date"
            hint={t('When both are entered the scan is used.')}
          />
          <TextField
            label={t('Gravida (pregnancies including this one)')}
            name="gravida"
            type="number"
            min={1}
            max={30}
            required
            defaultValue={1}
          />
          <TextField
            label={t('Para (previous births from 24 weeks)')}
            name="para"
            type="number"
            min={0}
            max={29}
            required
            defaultValue={0}
          />
        </div>
        <RiskFactorFields initial={[]} />
        <ErrorAlert error={book.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={book.isPending}>
            {t('Book the pregnancy')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditDialog({
  patientId,
  pregnancy,
  onClose,
  onWarnings,
}: {
  patientId: string;
  pregnancy: Pregnancy;
  onClose: () => void;
  onWarnings: (w: DatingWarning[]) => void;
}) {
  const update = useUpdatePregnancy(patientId, (r) => {
    onWarnings(r.warnings);
    onClose();
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const lmpDate = str(f.get('lmpDate'));
    const scanEdd = str(f.get('scanEdd'));
    const datingChanged =
      (lmpDate ?? null) !== pregnancy.lmpDate ||
      (pregnancy.eddMethod === 'ULTRASOUND' ? scanEdd !== pregnancy.eddDate : Boolean(scanEdd));
    update.mutate({
      id: pregnancy.id,
      body: {
        ...(datingChanged ? { dating: { lmpDate, scanEdd } } : {}),
        gravida: Number(f.get('gravida')),
        para: Number(f.get('para')),
        riskFactors: f.getAll('riskFactors').map(String),
        otherRiskNote: str(f.get('otherRiskNote')) ?? null,
        reason: str(f.get('reason')),
      },
    });
  }
  return (
    <Dialog open onClose={onClose} title={t('Change the booking')} wide>
      <form onSubmit={onSubmit} className="stack">
        <div className="form-grid">
          <TextField
            label={t('First day of the last menstrual period')}
            name="lmpDate"
            type="date"
            max={todayIso()}
            defaultValue={pregnancy.lmpDate ?? ''}
          />
          <TextField
            label={t('Due date from the dating scan')}
            name="scanEdd"
            type="date"
            defaultValue={pregnancy.eddMethod === 'ULTRASOUND' ? pregnancy.eddDate : ''}
          />
          <TextField
            label={t('Gravida (pregnancies including this one)')}
            name="gravida"
            type="number"
            min={1}
            max={30}
            required
            defaultValue={pregnancy.gravida}
          />
          <TextField
            label={t('Para (previous births from 24 weeks)')}
            name="para"
            type="number"
            min={0}
            max={29}
            required
            defaultValue={pregnancy.para}
          />
        </div>
        <RiskFactorFields
          initial={pregnancy.riskFactors ?? []}
          otherNote={pregnancy.otherRiskNote}
        />
        <TextField label={t('Reason for the change')} name="reason" maxLength={300} />
        <ErrorAlert error={update.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={update.isPending}>
            {t('Save changes')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function YesNo({ label, name }: { label: string; name: string }) {
  return (
    <SelectField
      label={label}
      name={name}
      placeholder={t('Not recorded')}
      options={[
        { value: 'yes', label: t('Yes') },
        { value: 'no', label: t('No') },
      ]}
    />
  );
}

function VisitDialog({
  patientId,
  pregnancy,
  onClose,
  onAlerts,
}: {
  patientId: string;
  pregnancy: Pregnancy;
  onClose: () => void;
  onAlerts: (a: VisitAlert[]) => void;
}) {
  const record = useRecordVisit(patientId, (r) => {
    onAlerts(r.alerts);
    onClose();
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const at = str(f.get('visitAt'));
    record.mutate({
      id: pregnancy.id,
      body: {
        visitAt: at ? new Date(at).toISOString() : undefined,
        systolic: num(f.get('systolic')),
        diastolic: num(f.get('diastolic')),
        weightKg: num(f.get('weightKg')),
        fundalHeightCm: num(f.get('fundalHeightCm')),
        fetalHeartRate: num(f.get('fetalHeartRate')),
        presentation: str(f.get('presentation')),
        urineProtein: str(f.get('urineProtein')),
        oedema: bool(f.get('oedema')),
        fetalMovements: bool(f.get('fetalMovements')),
        notes: str(f.get('notes')),
        nextVisitDate: str(f.get('nextVisitDate')),
      },
    });
  }
  const late = pregnancy.gestationDays >= 36 * 7;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Antenatal visit – {ga}', { ga: gestationLabel(pregnancy.gestation) })}
      wide
    >
      <form onSubmit={onSubmit} className="stack">
        <div className="form-grid">
          <TextField
            label={t('Date and time')}
            name="visitAt"
            type="datetime-local"
            hint={t('Leave empty for now')}
          />
          <TextField
            label={t('Systolic (mmHg)')}
            name="systolic"
            type="number"
            min={50}
            max={260}
          />
          <TextField
            label={t('Diastolic (mmHg)')}
            name="diastolic"
            type="number"
            min={30}
            max={160}
          />
          <TextField
            label={t('Weight (kg)')}
            name="weightKg"
            type="number"
            step="0.1"
            min={25}
            max={250}
          />
          <TextField
            label={t('Fundal height (cm)')}
            name="fundalHeightCm"
            type="number"
            step="0.5"
            min={5}
            max={60}
          />
          <TextField
            label={t('Fetal heart rate (bpm)')}
            name="fetalHeartRate"
            type="number"
            min={50}
            max={240}
          />
          <SelectField
            label={t('Presentation')}
            name="presentation"
            placeholder={t('Not recorded')}
            hint={late ? t('Record the presentation from 36 weeks') : undefined}
            options={PRESENTATIONS.map((p) => ({ value: p, label: presentationLabel(p) }))}
          />
          <SelectField
            label={t('Protein in urine')}
            name="urineProtein"
            placeholder={t('Not recorded')}
            options={URINE_PROTEIN.map((p) => ({
              value: p,
              label: p === 'NEGATIVE' ? t('Negative') : p === 'TRACE' ? t('Trace') : p,
            }))}
          />
          <YesNo label={t('Oedema')} name="oedema" />
          <YesNo label={t('Fetal movements felt as usual')} name="fetalMovements" />
          <TextField
            label={t('Next visit')}
            name="nextVisitDate"
            type="date"
            min={todayIso()}
            hint={t('The mother is reminded three days before.')}
          />
        </div>
        <TextAreaField label={t('Notes')} name="notes" maxLength={2000} rows={3} />
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

function CloseDialog({
  patientId,
  pregnancy,
  onClose,
}: {
  patientId: string;
  pregnancy: Pregnancy;
  onClose: () => void;
}) {
  const close = useClosePregnancy(patientId, onClose);
  const [outcome, setOutcome] = useState<Outcome>('MISCARRIAGE');
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const at = str(f.get('endedAt'));
    close.mutate({
      id: pregnancy.id,
      outcome,
      endedAt: at ? new Date(`${at}T12:00:00`).toISOString() : undefined,
      note: str(f.get('note')),
    });
  }
  return (
    <Dialog open onClose={onClose} title={t('Record the outcome of the pregnancy')}>
      <form onSubmit={onSubmit} className="stack">
        <Alert tone="info">
          {t('A birth is recorded from the Births page; it closes the pregnancy automatically.')}
        </Alert>
        <SelectField
          label={t('Outcome')}
          name="outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.currentTarget.value as Outcome)}
          options={OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) }))}
        />
        <TextField
          label={t('Date')}
          name="endedAt"
          type="date"
          max={todayIso()}
          hint={t('Leave empty for today')}
        />
        <TextAreaField
          label={outcome === 'TRANSFERRED_OUT' ? t('Transferred to') : t('Note')}
          name="note"
          required={outcome === 'TRANSFERRED_OUT'}
          maxLength={500}
          rows={2}
        />
        <ErrorAlert error={close.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={close.isPending}>
            {t('Close the pregnancy record')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function bp(v: { systolic: number | null; diastolic: number | null }) {
  return v.systolic !== null && v.diastolic !== null ? `${v.systolic}/${v.diastolic}` : '—';
}

export function VisitsTable({
  pregnancy,
  showNotes,
}: {
  pregnancy: Pregnancy;
  showNotes: boolean;
}) {
  if (!pregnancy.visits.length) return <EmptyState title={t('No antenatal visits recorded yet')} />;
  return (
    <Table caption={t('Antenatal visits')}>
      <thead>
        <tr>
          <th>{t('Date')}</th>
          <th>{t('Weeks')}</th>
          <th>{t('Blood pressure')}</th>
          <th>{t('Weight')}</th>
          {showNotes && <th>{t('Fundal height')}</th>}
          {showNotes && <th>{t('Fetal heart rate')}</th>}
          {showNotes && <th>{t('Urine protein')}</th>}
          {showNotes && <th>{t('Notes')}</th>}
        </tr>
      </thead>
      <tbody>
        {pregnancy.visits.map((v) => (
          <tr key={v.id}>
            <td>{formatDateTime(v.visitAt)}</td>
            <td>{v.gestation}</td>
            <td>{bp(v)}</td>
            <td>{v.weightKg ? `${formatNumber(Number(v.weightKg))} kg` : '—'}</td>
            {showNotes && (
              <td>{v.fundalHeightCm ? `${formatNumber(Number(v.fundalHeightCm))} cm` : '—'}</td>
            )}
            {showNotes && <td>{v.fetalHeartRate ?? '—'}</td>}
            {showNotes && (
              <td>
                {v.urineProtein === 'NEGATIVE'
                  ? t('Negative')
                  : v.urineProtein === 'TRACE'
                    ? t('Trace')
                    : (v.urineProtein ?? '—')}
              </td>
            )}
            {showNotes && (
              <td>
                <AlertList alerts={v.alerts} />
                {v.presentation && <div className="muted">{presentationLabel(v.presentation)}</div>}
                {v.notes && <div>{v.notes}</div>}
                {v.recordedBy && <div className="muted">{v.recordedBy}</div>}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function ScheduleTable({ pregnancy }: { pregnancy: Pregnancy }) {
  return (
    <Table caption={t('Recommended antenatal contacts (WHO 2016)')}>
      <thead>
        <tr>
          <th>{t('Week')}</th>
          <th>{t('Around')}</th>
          <th>{t('Status')}</th>
        </tr>
      </thead>
      <tbody>
        {pregnancy.schedule.map((c) => (
          <tr key={c.week}>
            <td>{c.week}</td>
            <td>{formatDate(c.targetDate)}</td>
            <td>
              <Badge tone={CONTACT_TONE[c.state]}>{contactStateLabel(c.state)}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function KeyTestsTable({ pregnancy }: { pregnancy: Pregnancy }) {
  return (
    <Table caption={t('Key tests in pregnancy')}>
      <thead>
        <tr>
          <th>{t('Test')}</th>
          <th>{t('When')}</th>
          <th>{t('Status')}</th>
        </tr>
      </thead>
      <tbody>
        {pregnancy.keyTests.map((k) => (
          <tr key={k.code}>
            <td>{keyTestLabel(k.code)}</td>
            <td>
              {k.fromWeek === 0
                ? t('At booking')
                : t('Weeks {from}–{to}', { from: k.fromWeek, to: k.dueByWeek })}
            </td>
            <td>
              <Badge tone={KEY_TEST_TONE[k.state]}>{keyTestStateLabel(k.state)}</Badge>
              {k.doneAtGestation && (
                <span className="muted"> · {gestationLabel(k.doneAtGestation)}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function OngoingCard({
  patientId,
  pregnancy,
  canEdit,
}: {
  patientId: string;
  pregnancy: Pregnancy;
  canEdit: boolean;
}) {
  const [dialog, setDialog] = useState<'visit' | 'edit' | 'close' | null>(null);
  const [warnings, setWarnings] = useState<DatingWarning[]>([]);
  const [alerts, setAlerts] = useState<VisitAlert[] | null>(null);
  const last = pregnancy.visits[0];
  const p = pregnancy;
  return (
    <>
      <Card
        title={
          <>
            {t('Pregnancy – {ga}', { ga: gestationLabel(p.gestation) })}{' '}
            {p.riskLevel === 'HIGH' ? (
              <Badge tone="danger">{t('High risk')}</Badge>
            ) : (
              <Badge tone="success">{t('Low risk')}</Badge>
            )}{' '}
            {p.postTerm && <Badge tone="danger">{t('Past 42 weeks')}</Badge>}
            {p.nearEdd && !p.postTerm && <Badge tone="info">{t('Due within 14 days')}</Badge>}
          </>
        }
        actions={
          canEdit && (
            <span style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              <Button size="sm" onClick={() => setDialog('visit')}>
                {t('Record a visit')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDialog('edit')}>
                {t('Change the booking')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog('close')}>
                {t('Record the outcome')}
              </Button>
            </span>
          )
        }
      >
        <DatingWarnings warnings={warnings} />
        {alerts && alerts.length > 0 && (
          <Alert
            tone={alerts.some((a) => a.severity === 'SEVERE') ? 'danger' : 'warning'}
            title={t('Visit saved – check these findings')}
          >
            <AlertList alerts={alerts} />
          </Alert>
        )}
        {!alerts && last && last.alerts.some((a) => a.severity !== 'INFO') && (
          <Alert tone="warning" title={t('Findings at the last visit')}>
            <AlertList alerts={last.alerts} />
          </Alert>
        )}
        <DefinitionList
          items={[
            [
              t('Due date'),
              <>
                {formatDate(p.eddDate)}{' '}
                <span className="muted">
                  ({p.eddMethod === 'ULTRASOUND' ? t('dating scan') : t('last menstrual period')})
                </span>
              </>,
            ],
            [t('Gravida / para'), `G${p.gravida} P${p.para}`],
            [
              t('Booked'),
              t('{date} at {ga}', {
                date: formatDate(p.bookedAt),
                ga: gestationLabel(p.bookingGestation),
              }),
            ],
            [t('Booking facility'), p.facilityName],
            [
              t('Risk factors'),
              p.riskFactors?.length
                ? p.riskFactors
                    .map((f) =>
                      f === 'OTHER' && p.otherRiskNote
                        ? `${riskFactorLabel(f)}: ${p.otherRiskNote}`
                        : riskFactorLabel(f),
                    )
                    .join(', ')
                : t('None recorded'),
            ],
            [t('Next visit'), p.nextVisitDate ? formatDate(p.nextVisitDate) : '—'],
          ]}
        />
      </Card>
      <Card title={t('Antenatal visits')}>
        <VisitsTable pregnancy={p} showNotes />
      </Card>
      <div
        className="grid-2"
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
        }}
      >
        <Card title={t('Contacts')}>
          <ScheduleTable pregnancy={p} />
        </Card>
        <Card title={t('Key tests')}>
          <p className="muted">
            {t('Matched with results already in the record (laboratory and ultrasound).')}
          </p>
          <KeyTestsTable pregnancy={p} />
        </Card>
      </div>
      {dialog === 'visit' && (
        <VisitDialog
          patientId={patientId}
          pregnancy={p}
          onClose={() => setDialog(null)}
          onAlerts={setAlerts}
        />
      )}
      {dialog === 'edit' && (
        <EditDialog
          patientId={patientId}
          pregnancy={p}
          onClose={() => setDialog(null)}
          onWarnings={setWarnings}
        />
      )}
      {dialog === 'close' && (
        <CloseDialog patientId={patientId} pregnancy={p} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

/**
 * Pregnancy: the ongoing pregnancy (dating, risk, visits with alerts, WHO contact schedule, key
 * tests) and earlier pregnancies; booking, visits and outcomes by the care team.
 */
export function PregnancyTab({ patientId }: { patientId: string }) {
  const query = usePatientPregnancies(patientId);
  const [booking, setBooking] = useState(false);
  const [warnings, setWarnings] = useState<DatingWarning[]>([]);
  return (
    <QueryView query={query}>
      {(data) => {
        const ongoing = data.items.find((p) => p.status === 'ONGOING');
        const earlier = data.items.filter((p) => p.status !== 'ONGOING');
        return (
          <div className="stack">
            <DatingWarnings warnings={warnings} />
            {ongoing ? (
              <OngoingCard patientId={patientId} pregnancy={ongoing} canEdit={data.canEdit} />
            ) : (
              <Card
                actions={
                  data.canBook &&
                  data.canEdit && (
                    <Button size="sm" onClick={() => setBooking(true)}>
                      {t('Book a pregnancy')}
                    </Button>
                  )
                }
              >
                <EmptyState title={t('No ongoing pregnancy')}>
                  {t(
                    'Book the pregnancy at the first antenatal contact: dating, obstetric history and risk factors.',
                  )}
                </EmptyState>
              </Card>
            )}
            {earlier.length > 0 && (
              <Card title={t('Earlier pregnancies')}>
                <Table caption={t('Earlier pregnancies')}>
                  <thead>
                    <tr>
                      <th>{t('Due date')}</th>
                      <th>{t('Outcome')}</th>
                      <th>{t('Date')}</th>
                      <th>{t('Visits')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {earlier.map((p) => (
                      <tr key={p.id}>
                        <td>{formatDate(p.eddDate)}</td>
                        <td>
                          {outcomeLabel(p.status)}
                          {p.outcomeNote && <div className="muted">{p.outcomeNote}</div>}
                        </td>
                        <td>{formatDate(p.endedAt)}</td>
                        <td>{p.visits.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
            {booking && (
              <BookDialog
                patientId={patientId}
                onClose={() => setBooking(false)}
                onWarnings={setWarnings}
              />
            )}
          </div>
        );
      }}
    </QueryView>
  );
}
