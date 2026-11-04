import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import type { AdministrationStatus, Prescription } from '../../../api/types';
import {
  isWristbandCode,
  MIN_SCAN_OVERRIDE,
  useBcmaCompliance,
  useBcmaVerify,
  type BcmaCheck,
  type BcmaProblem,
  type ScannedAdministration,
} from '../../../api/bcma';
import { BarcodeScanner } from '../../../components/BarcodeScanner';
import {
  Alert,
  Badge,
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { useChartMutation } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';

const STATUS_OPTIONS: { value: AdministrationStatus; label: string }[] = [
  { value: 'GIVEN', label: 'Given' },
  { value: 'WITHHELD', label: 'Withheld (clinical decision)' },
  { value: 'REFUSED', label: 'Refused by patient' },
  { value: 'OMITTED', label: 'Omitted (missed / unavailable)' },
];

/** Problems the server returned with a refused save (409 stop or 400 reason required). */
function problemsOf(error: unknown): BcmaProblem[] {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') return [];
  const p = (error.details as { problems?: unknown }).problems;
  return Array.isArray(p) ? (p as BcmaProblem[]) : [];
}

function ProblemList({ problems }: { problems: BcmaProblem[] }) {
  const stops = problems.filter((p) => !p.overridable);
  const warnings = problems.filter((p) => p.overridable);
  return (
    <>
      {stops.length > 0 && (
        <div className="alert alert-danger bcma-stop" role="alert" style={{ borderWidth: 3 }}>
          <strong style={{ fontSize: '1.25rem' }}>⛔ {t('STOP – do not give')}</strong>
          <ul>
            {stops.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
          <div>{t('This cannot be overridden. Check the patient and the medicine and scan again.')}</div>
        </div>
      )}
      {warnings.length > 0 && (
        <Alert tone="warning" title={t('Check before giving')}>
          <ul>
            {warnings.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </Alert>
      )}
    </>
  );
}

function ScanBadges({ a }: { a: ScannedAdministration }) {
  if (a.status !== 'GIVEN') return <span className="muted">—</span>;
  const both = a.patientScanned && a.medicationScanned;
  return (
    <div className="stack" style={{ gap: '0.25rem' }}>
      {both ? (
        <Badge tone="success">{t('Scanned')}</Badge>
      ) : a.patientScanned ? (
        <Badge tone="warning">{t('Wristband only')}</Badge>
      ) : a.medicationScanned ? (
        <Badge tone="warning">{t('Pack only')}</Badge>
      ) : (
        <Badge tone="warning">{t('Not scanned')}</Badge>
      )}
      {a.scanOverrideReason && (
        <span className="muted" title={t('Override reason')}>
          {t('Override: {reason}', { reason: a.scanOverrideReason })}
        </span>
      )}
    </div>
  );
}

/**
 * Barcode-checked administration at the bedside: wristband → medicine pack → checks → confirm.
 * A wrong patient or a wrong medicine stops the dose; anything not scanned, and any warning,
 * needs a written reason.
 */
function ScanToGiveDialog({
  patientId,
  rx,
  onClose,
}: {
  patientId: string;
  rx: Prescription;
  onClose: () => void;
}) {
  const verify = useBcmaVerify(patientId);
  const [token, setToken] = useState<string | null>(null);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [skipPatient, setSkipPatient] = useState(false);
  const [skipPack, setSkipPack] = useState(false);
  const [check, setCheck] = useState<BcmaCheck | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const record = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/medication-administrations', method: 'POST', body }),
    onClose,
  );

  const run = (patientToken: string | null, medicationBarcode: string | null) =>
    verify.mutate(
      {
        prescriptionId: rx.id,
        patientToken: patientToken ?? undefined,
        medicationBarcode: medicationBarcode ?? undefined,
      },
      { onSuccess: setCheck },
    );

  const stops = (check?.problems ?? []).filter((p) => !p.overridable);
  const patientStop = stops.some((p) => p.code === 'WRONG_PATIENT' || p.code === 'INVALID_TOKEN');
  const drugStop = stops.some((p) => p.code === 'WRONG_DRUG');
  const step: 'patient' | 'pack' | 'confirm' =
    (!token && !skipPatient) || patientStop ? 'patient' : (!barcode && !skipPack) || drugStop ? 'pack' : 'confirm';

  function onPatientScan(v: string) {
    if (!isWristbandCode(v)) {
      setHint(t('This is not a wristband code. Scan the patient’s wristband first.'));
      return;
    }
    setHint(null);
    setToken(v);
    run(v, barcode);
  }
  function onPackScan(v: string) {
    if (isWristbandCode(v)) {
      setHint(t('That was a wristband. Now scan the medicine pack.'));
      return;
    }
    setHint(null);
    setBarcode(v);
    run(token, v);
  }

  const warnings = (check?.problems ?? []).filter((p) => p.overridable);
  const patientOk = Boolean(check?.patientConfirmed);
  const packOk = Boolean(check?.medicationConfirmed);
  const needsReason = !patientOk || !packOk || warnings.length > 0;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = compact(formValues(e.currentTarget));
    record.mutate({
      prescriptionId: rx.id,
      status: 'GIVEN',
      doseGiven: v.doseGiven,
      notes: v.notes,
      patientScanned: patientOk,
      medicationScanned: packOk,
      scanToken: token ?? undefined,
      barcode: barcode ?? undefined,
      scanOverrideReason: needsReason ? v.scanOverrideReason : undefined,
    });
  }

  const serverProblems = problemsOf(record.error);

  return (
    <div className="stack">
      <p>
        <strong>{rx.medication}</strong> — {rx.dosage}, {rx.frequency}{' '}
        <span className="muted">({rx.route})</span>
      </p>
      <ol className="bcma-steps" aria-label={t('Steps')}>
        <li aria-current={step === 'patient' ? 'step' : undefined}>
          {t('1. Wristband')} {patientOk ? '✓' : skipPatient ? t('(not scanned)') : ''}
        </li>
        <li aria-current={step === 'pack' ? 'step' : undefined}>
          {t('2. Medicine pack')} {packOk ? '✓' : skipPack ? t('(not scanned)') : ''}
        </li>
        <li aria-current={step === 'confirm' ? 'step' : undefined}>{t('3. Check and confirm')}</li>
      </ol>

      {check && <ProblemList problems={check.problems} />}
      {hint && <Alert tone="warning">{hint}</Alert>}
      <ErrorAlert error={verify.error} />

      {step === 'patient' && (
        <>
          <BarcodeScanner
            key={`patient-${token ?? ''}`}
            label={t('Scan the patient’s wristband')}
            onScan={onPatientScan}
            autoFocus
            disabled={verify.isPending}
          />
          <div className="form-actions">
            <Button
              variant="ghost"
              disabled={patientStop}
              onClick={() => {
                setToken(null);
                setSkipPatient(true);
                setCheck(null);
                run(null, barcode);
              }}
            >
              {t('Wristband cannot be scanned')}
            </Button>
          </div>
        </>
      )}

      {step === 'pack' && (
        <>
          <BarcodeScanner
            key={`pack-${barcode ?? ''}`}
            label={t('Scan the medicine pack')}
            onScan={onPackScan}
            autoFocus
            disabled={verify.isPending}
            scanned={patientOk ? t('Patient confirmed') : null}
          />
          <div className="form-actions">
            <Button
              variant="ghost"
              disabled={drugStop}
              onClick={() => {
                setBarcode(null);
                setSkipPack(true);
                run(token, null);
              }}
            >
              {t('Pack cannot be scanned')}
            </Button>
          </div>
        </>
      )}

      {step === 'confirm' && check && (
        <form onSubmit={onSubmit} className="stack">
          <ul className="list">
            <li>
              {patientOk ? '✓' : '✗'} {t('Patient')}:{' '}
              {patientOk ? t('wristband matches this chart') : t('not scanned')}
            </li>
            <li>
              {packOk ? '✓' : '✗'} {t('Medicine')}:{' '}
              {packOk && check.scannedItem
                ? [check.scannedItem.name, check.scannedItem.strength].filter(Boolean).join(' ')
                : t('not scanned')}
            </li>
            {check.lastGivenAt && (
              <li className="muted">
                {t('Last given {time}', { time: formatDateTime(check.lastGivenAt) })}
              </li>
            )}
          </ul>
          <div className="form-grid">
            <TextField label={t('Dose given')} name="doseGiven" defaultValue={rx.dosage} maxLength={100} />
          </div>
          {needsReason && (
            <TextAreaField
              label={t('Reason for giving without a complete check')}
              name="scanOverrideReason"
              required
              minLength={MIN_SCAN_OVERRIDE}
              maxLength={300}
              rows={2}
              hint={t('At least {count} characters. The reason is recorded in the audit log.', {
                count: MIN_SCAN_OVERRIDE,
              })}
            />
          )}
          <TextAreaField label={t('Notes')} name="notes" maxLength={2000} rows={2} />
          <ProblemList problems={serverProblems.filter((p) => !p.overridable)} />
          <ErrorAlert error={record.error} />
          <div className="form-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setToken(null);
                setBarcode(null);
                setSkipPatient(false);
                setSkipPack(false);
                setCheck(null);
              }}
            >
              {t('Start again')}
            </Button>
            <Button type="submit" loading={record.isPending} variant={needsReason ? 'danger' : 'primary'}>
              {needsReason ? t('Give with reason') : t('Confirm dose given')}
            </Button>
          </div>
        </form>
      )}

      {step !== 'confirm' && (
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}

function ComplianceNote({ patientId }: { patientId: string }) {
  const q = useBcmaCompliance(patientId);
  const c = q.data?.compliance;
  if (!q.data?.unit || !c) return null;
  const pct = c.compliancePct;
  const tone = pct === null ? 'neutral' : pct >= 95 ? 'success' : pct >= 80 ? 'warning' : 'danger';
  return (
    <p className="row" aria-live="polite">
      <Badge tone={tone}>
        {pct === null
          ? t('No doses given yet')
          : t('Scanning {pct}%', { pct: pct.toLocaleString(undefined, { maximumFractionDigits: 1 }) })}
      </Badge>
      <span className="muted">
        {t('{unit}, last {days} days: {scanned} of {given} doses given with both scans; {overridden} overrides', {
          unit: q.data.unit.name,
          days: c.days,
          scanned: c.bothScanned,
          given: c.given,
          overridden: c.overridden,
        })}
      </span>
    </p>
  );
}

/**
 * Medication administration record. Every dose – given or not – is recorded explicitly with its
 * author; administration is never assumed from a prescription or a dispense. Doses are given
 * after scanning the wristband and the medicine pack.
 */
export function MarTab({ patientId }: { patientId: string }) {
  const rx = useSection<Prescription>(patientId, 'prescriptions');
  const mar = useSection<ScannedAdministration>(patientId, 'medication-administrations');
  const [recording, setRecording] = useState<Prescription | null>(null);
  const [scanning, setScanning] = useState<Prescription | null>(null);
  const [status, setStatus] = useState<AdministrationStatus>('WITHHELD');
  const record = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({
      path: '/medication-administrations',
      method: 'POST',
      body,
    }),
    () => setRecording(null),
  );

  const administrable = (rx.data ?? []).filter(
    (p) =>
      p.status === 'ACTIVE' &&
      (p.pharmacyStatus === 'VERIFIED' || p.pharmacyStatus === 'DISPENSED'),
  );
  const awaiting = (rx.data ?? []).filter(
    (p) =>
      p.status === 'ACTIVE' && (p.pharmacyStatus === 'PENDING' || p.pharmacyStatus === 'RETURNED'),
  );

  function open(p: Prescription) {
    setStatus('WITHHELD');
    record.reset();
    setRecording(p);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = compact(formValues(e.currentTarget));
    record.mutate({
      ...v,
      prescriptionId: recording!.id,
      administeredAt: v.administeredAt ? new Date(v.administeredAt).toISOString() : undefined,
    });
  }

  return (
    <div className="stack">
      <Card title={t('Active medicines')}>
        <p className="muted">
          {t(
            'Only prescriptions verified by the pharmacy can be administered. Record every dose explicitly – including doses withheld, refused or omitted, with the reason.',
          )}
        </p>
        <ComplianceNote patientId={patientId} />
        <QueryView query={rx}>
          {() =>
            administrable.length === 0 ? (
              <EmptyState title={t('No pharmacy-verified medicines to administer')} />
            ) : (
              <ul className="list">
                {administrable.map((p) => (
                  <li key={p.id} className="row-between">
                    <span>
                      <strong>{p.medication}</strong> {p.dosage} · {p.frequency}{' '}
                      <span className="muted">({p.route})</span>
                      {p.instructions && <div className="muted">{p.instructions}</div>}
                    </span>
                    <span className="row">
                      <StatusBadge value={p.pharmacyStatus} />
                      <Button size="sm" onClick={() => setScanning(p)}>
                        {t('Scan to give')}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => open(p)}>
                        {t('Record dose')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
        {awaiting.length > 0 && (
          <Alert tone="warning" title={t('Awaiting pharmacy')}>
            {awaiting.map((p) => `${p.medication} (${p.pharmacyStatus.toLowerCase()})`).join(', ')}{' '}
            cannot be administered until verified.
          </Alert>
        )}
      </Card>

      <Card title={t('Administration record')}>
        <QueryView query={mar}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No doses recorded')} />
            ) : (
              <Table caption={t('Medication administration record')}>
                <thead>
                  <tr>
                    <th>{t('Time')}</th>
                    <th>{t('Medicine')}</th>
                    <th>{t('Outcome')}</th>
                    <th>{t('Dose / reason')}</th>
                    <th>{t('Barcode check')}</th>
                    <th>{t('Recorded by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.administeredAt)}</td>
                      <td>
                        {a.medication}
                        <div className="muted">Prescribed: {a.dosage}</div>
                      </td>
                      <td>
                        <StatusBadge value={a.status} />
                      </td>
                      <td>
                        {a.doseGiven && <div>{a.doseGiven}</div>}
                        {a.reason && <div>{a.reason}</div>}
                        {a.notes && <div className="muted">{a.notes}</div>}
                      </td>
                      <td>
                        <ScanBadges a={a} />
                      </td>
                      <td>{a.recordedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>

      <Dialog open={scanning !== null} onClose={() => setScanning(null)} title={t('Scan to give')} wide>
        {scanning && (
          <ScanToGiveDialog key={scanning.id} patientId={patientId} rx={scanning} onClose={() => setScanning(null)} />
        )}
      </Dialog>

      <Dialog open={recording !== null} onClose={() => setRecording(null)} title={t('Record dose')}>
        {recording && (
          <form onSubmit={onSubmit}>
            <p>
              <strong>{recording.medication}</strong> — {recording.dosage}, {recording.frequency}
            </p>
            <SelectField
              label={t('Outcome')}
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as AdministrationStatus)}
              options={STATUS_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            />
            {status === 'GIVEN' && (
              <Alert tone="warning" title={t('Giving without scanning')}>
                {t('Use “Scan to give” whenever possible. A dose recorded as given without scanning the wristband and the pack needs a reason, which is audited.')}
              </Alert>
            )}
            <div className="form-grid">
              <TextField
                label={t('Dose given')}
                name="doseGiven"
                defaultValue={status === 'GIVEN' ? recording.dosage : ''}
                maxLength={100}
                disabled={status !== 'GIVEN'}
              />
              <TextField
                label={t('Time')}
                name="administeredAt"
                type="datetime-local"
                hint={t('Leave empty for now')}
              />
            </div>
            {status !== 'GIVEN' && (
              <TextAreaField
                label={t('Reason')}
                name="reason"
                required
                minLength={3}
                maxLength={500}
                rows={2}
                hint={t('Required when a dose is not given, e.g. “BP 92/60 – doctor informed”.')}
              />
            )}
            {status === 'GIVEN' && (
              <TextAreaField
                label={t('Reason for giving without a complete check')}
                name="scanOverrideReason"
                required
                minLength={MIN_SCAN_OVERRIDE}
                maxLength={300}
                rows={2}
                hint={t('At least {count} characters. The reason is recorded in the audit log.', {
                  count: MIN_SCAN_OVERRIDE,
                })}
              />
            )}
            <TextAreaField label={t('Notes')} name="notes" maxLength={2000} rows={2} />
            <ProblemList problems={problemsOf(record.error)} />
            <ErrorAlert error={record.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setRecording(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={record.isPending}>
                {t('Save to record')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
