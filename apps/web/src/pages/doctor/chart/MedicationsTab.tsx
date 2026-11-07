import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { useSafetyCheck, useStoredAlerts, type SafetyAlert } from '../../../api/safety';
import {
  DOSE_UNITS,
  doseText,
  FREQUENCY_CODES,
  frequencyLabel,
  ROUTES,
  routeLabel,
  unitLabel,
  type DoseSummary,
  type DosingPatient,
  type DoseUnit,
  type FrequencyCode,
  type StructuredDose,
  type StructuredPrescriptionFields,
} from '../../../api/dosing';
import { SafetyAlertList, StoredAlertSummary } from '../../tools/SafetyAlerts';
import { itemName, type CatalogItem } from '../../../api/stock';
import { CatalogPicker } from '../../pharmacy/CatalogPicker';
import type { Allergy, Encounter, Prescription } from '../../../api/types';
import {
  Alert,
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
import { formatDate } from '../../../format';
import { EncounterSelect, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { getLocale, t } from '../../../i18n';
import {
  useCancelEPrescription,
  useIssueEPrescription,
  usePatientEPrescriptions,
  type EPrescription,
} from '../../../api/erx';
import {
  CodeQr,
  CodeText,
  DispensingTable,
  ErxStatusBadge,
  ErxSummary,
} from '../../erx/ErxComponents';

/** Prescription row with the national e-prescription fields. */
type RxRow = Prescription & {
  ePrescriptionCode?: string | null;
  repeatsAllowed?: number;
  communityValidUntil?: string | null;
};

/** Repeats offered when sending to a community pharmacy (controlled medicines: none, 7 days). */
const REPEAT_OPTIONS = [0, 1, 2, 3, 5, 11];

/** The value after it has stopped changing for `ms` (avoids a safety check per keystroke). */
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function MedicationsTab({
  patientId,
  encounters,
  allergies,
}: {
  patientId: string;
  encounters: Encounter[];
  allergies: Allergy[];
}) {
  const list = useSection<Prescription>(patientId, 'prescriptions');
  const [open, setOpen] = useState(false);
  /** Optional national catalogue item: fills the medication name and lets the pharmacy track stock. */
  const [catalogItem, setCatalogItem] = useState<CatalogItem | null>(null);
  const [medication, setMedication] = useState('');
  /** Reasons to proceed despite blocking safety alerts, by alert code. */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /** Structured dose builder (free text remains available for unusual regimens). */
  const [builder, setBuilder] = useState<DoseBuilderState>(EMPTY_BUILDER);
  /** Issue as a national e-prescription for any community pharmacy. */
  const [erx, setErx] = useState({ enabled: false, repeats: '0', validDays: '' });
  const [erxDetail, setErxDetail] = useState<EPrescription | null>(null);
  const [cancelling, setCancelling] = useState<RxRow | null>(null);
  const [sending, setSending] = useState<RxRow | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const ePrescriptions = usePatientEPrescriptions(patientId);
  const erxById = new Map((ePrescriptions.data ?? []).map((e) => [e.prescriptionId, e]));
  const cancelErx = useCancelEPrescription(patientId);
  const issueErx = useIssueEPrescription(patientId);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/prescriptions', method: 'POST', body }),
    () => {
      setOpen(false);
      setCatalogItem(null);
      setMedication('');
      setReasons({});
      setBuilder(EMPTY_BUILDER);
      setErx({ enabled: false, repeats: '0', validDays: '' });
    },
  );
  const createdCode =
    (create.data as { ePrescriptionCode?: string | null } | undefined)?.ePrescriptionCode ?? null;
  useEffect(() => {
    if (createdCode) setIssuedCode(createdCode);
  }, [createdCode]);
  const update = useChartMutation(patientId, ({ id, status }: { id: string; status: string }) => ({
    path: `/prescriptions/${id}`,
    method: 'PATCH',
    body: { status },
  }));
  const { isDoctor, isNurse } = useChartRole();
  const debouncedMedication = useDebounced(medication);
  const dose = toStructuredDose(builder);
  const debouncedDoseKey = useDebounced(dose ? JSON.stringify(dose) : '');
  const debouncedDose = useMemo(
    () => (debouncedDoseKey ? (JSON.parse(debouncedDoseKey) as StructuredDose) : null),
    [debouncedDoseKey],
  );
  const check = useSafetyCheck(
    patientId,
    debouncedMedication,
    catalogItem?.id ?? null,
    open && isDoctor,
    debouncedDose,
  );
  const stored = useStoredAlerts(patientId, isDoctor || isNurse);
  // If the server found blocking alerts the live check had not shown yet, use its list.
  const blockedByServer =
    create.error instanceof ApiError && create.error.code === 'SAFETY_ALERTS'
      ? ((create.error.details as { alerts?: SafetyAlert[] } | undefined)?.alerts ?? null)
      : null;
  const alerts = blockedByServer ?? check.data?.alerts ?? [];
  const [resubmitting, setResubmitting] = useState<Prescription | null>(null);
  const resubmit = useChartMutation(
    patientId,
    ({ id, body }: { id: string; body: Record<string, unknown> }) => ({
      path: `/prescriptions/${id}/resubmit`,
      method: 'POST',
      body,
    }),
    () => setResubmitting(null),
  );
  const activeAllergies = allergies.filter(
    (a) => a.verificationStatus === 'CONFIRMED' || a.verificationStatus === 'UNCONFIRMED',
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const overrides = alerts
      .filter((a) => a.blocking && (reasons[a.code] ?? '').trim().length >= 10)
      .map((a) => ({ code: a.code, reason: reasons[a.code]!.trim() }));
    create.mutate({
      ...compact({
        ...withoutErxFields(formValues(e.currentTarget)),
        catalogItemId: catalogItem?.id ?? undefined,
      }),
      ...(builder.freeText ? {} : (dose ?? {})),
      ...(overrides.length ? { overrides } : {}),
      ...(erx.enabled
        ? {
            ePrescription: {
              repeats: Number(erx.repeats),
              ...(erx.validDays ? { validDays: Number(erx.validDays) } : {}),
            },
          }
        : {}),
    });
  }

  return (
    <Card
      title={t('Medications')}
      actions={
        <span className="row">
          <Link to={`/tools/interactions?patient=${patientId}`}>{t('Interaction checker')}</Link>
          {isDoctor && (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t('Prescribe')}
            </Button>
          )}
        </span>
      }
    >
      <p className="muted">
        {t(
          'New prescriptions go to the pharmacy for verification before they can be dispensed or administered.',
        )}{' '}
        {t(
          'An e-prescription is dispensed by any community pharmacy with the patient’s code and national ID.',
        )}
      </p>
      {issuedCode && (
        <Alert tone="success" title={t('E-prescription issued')}>
          <div className="row" style={{ flexWrap: 'wrap', gap: '1rem' }}>
            <CodeQr code={issuedCode} size={96} />
            <div>
              <CodeText code={issuedCode} />
              <div className="muted">
                {t(
                  'The patient finds the code in the portal; give it to them on paper if they do not use the portal.',
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setIssuedCode(null)}>
                {t('Close')}
              </Button>
            </div>
          </div>
        </Alert>
      )}
      <ErrorAlert error={update.error} />
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No prescriptions')} />
          ) : (
            <Table caption={t('Prescriptions')}>
              <thead>
                <tr>
                  <th>{t('Medication')}</th>
                  <th>{t('Dose & frequency')}</th>
                  <th>{t('Period')}</th>
                  <th>{t('Prescriber')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Pharmacy')}</th>
                  {isDoctor && (
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.medication}</strong>
                      <div className="muted">{p.route}</div>
                      {p.instructions && <div className="muted">{p.instructions}</div>}
                      <StoredAlertSummary alerts={stored.data?.[p.id]} />
                    </td>
                    <td>
                      {p.dosage} · {p.frequency}
                      {(p as Prescription & StructuredPrescriptionFields).frequencyCode && (
                        <div className="muted">
                          {(p as Prescription & StructuredPrescriptionFields).frequencyCode}
                        </div>
                      )}
                    </td>
                    <td>
                      {formatDate(p.startDate)} –{' '}
                      {p.endDate ? formatDate(p.endDate) : t('ongoing|period')}
                    </td>
                    <td>{p.doctorName}</td>
                    <td>
                      <StatusBadge value={p.status} />
                    </td>
                    <td>
                      {(p as RxRow).ePrescriptionCode ? (
                        <ErxCell e={erxById.get(p.id)} onOpen={(e) => setErxDetail(e)} />
                      ) : (
                        p.pharmacyStatus && <StatusBadge value={p.pharmacyStatus} />
                      )}
                      {p.pharmacistNote && (
                        <div className="muted" style={{ maxWidth: '22rem' }}>
                          {t('Pharmacist: {note}', { note: p.pharmacistNote })}
                        </div>
                      )}
                    </td>
                    {isDoctor && (
                      <td>
                        {p.status === 'ACTIVE' && (
                          <div className="row">
                            {p.pharmacyStatus === 'RETURNED' && (
                              <Button size="sm" onClick={() => setResubmitting(p)}>
                                {t('Resubmit')}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: p.id, status: 'COMPLETED' })}
                            >
                              {t('Complete')}
                            </Button>
                            {(p as RxRow).ePrescriptionCode ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setCancelling(p as RxRow)}
                              >
                                {t('Cancel e-prescription')}
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setSending(p as RxRow)}
                                >
                                  {t('Send as e-prescription')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={update.isPending}
                                  onClick={() => update.mutate({ id: p.id, status: 'CANCELLED' })}
                                >
                                  {t('Stop')}
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog
        open={erxDetail !== null}
        onClose={() => setErxDetail(null)}
        title={t('E-prescription')}
        wide
      >
        {erxDetail && (
          <div className="stack">
            <div className="row" style={{ flexWrap: 'wrap', gap: '1rem' }}>
              {erxDetail.code && <CodeQr code={erxDetail.code} size={120} />}
              <div className="stack" style={{ gap: '0.3rem' }}>
                <strong>{erxDetail.medication}</strong>
                {erxDetail.code && <CodeText code={erxDetail.code} />}
                <ErxSummary e={erxDetail} />
              </div>
            </div>
            <DispensingTable items={erxDetail.dispensings} caption={t('Dispensing history')} />
          </div>
        )}
      </Dialog>
      <Dialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={t('Cancel e-prescription')}
      >
        {cancelling && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const reason = formValues(e.currentTarget).reason ?? '';
              cancelErx.mutate(
                { prescriptionId: cancelling.id, reason },
                { onSuccess: () => setCancelling(null) },
              );
            }}
          >
            <p>
              {t(
                'No pharmacy will be able to dispense {medication} any more. Supplies already handed over stay in the history. The patient is told.',
                { medication: cancelling.medication },
              )}
            </p>
            <TextAreaField
              label={t('Reason')}
              name="reason"
              required
              minLength={5}
              maxLength={500}
              rows={2}
            />
            <ErrorAlert error={cancelErx.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setCancelling(null)}>
                {t('Back')}
              </Button>
              <Button type="submit" variant="danger" loading={cancelErx.isPending}>
                {t('Cancel e-prescription')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog
        open={sending !== null}
        onClose={() => setSending(null)}
        title={t('Send as e-prescription')}
      >
        {sending && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = formValues(e.currentTarget);
              issueErx.mutate(
                {
                  prescriptionId: sending.id,
                  repeats: Number(v.repeats ?? 0),
                  ...(v.validDays ? { validDays: Number(v.validDays) } : {}),
                },
                {
                  onSuccess: (issued) => {
                    setSending(null);
                    setIssuedCode(issued.code);
                  },
                },
              );
            }}
          >
            <p>
              {t('{medication} can then be dispensed at any community pharmacy.', {
                medication: sending.medication,
              })}
            </p>
            <ErxFields />
            <ErrorAlert error={issueErx.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setSending(null)}>
                {t('Back')}
              </Button>
              <Button type="submit" loading={issueErx.isPending}>
                {t('Send as e-prescription')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog
        open={resubmitting !== null}
        onClose={() => setResubmitting(null)}
        title={t('Resubmit to pharmacy')}
        wide
      >
        {resubmitting && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              resubmit.mutate({
                id: resubmitting.id,
                body: compact(formValues(e.currentTarget)),
              });
            }}
          >
            <Alert
              tone="warning"
              title={t('Returned: {medication}', { medication: resubmitting.medication })}
            >
              {resubmitting.pharmacistNote ?? t('The pharmacy returned this prescription.')}
            </Alert>
            <p className="muted">
              {t(
                'Adjust the plan if needed and explain how the pharmacist’s concern was addressed. If the medicine is no longer appropriate, stop the prescription instead.',
              )}
            </p>
            <div className="form-grid">
              <TextField
                label={t('Dosage')}
                name="dosage"
                defaultValue={resubmitting.dosage}
                maxLength={100}
              />
              <TextField
                label={t('Frequency')}
                name="frequency"
                defaultValue={resubmitting.frequency}
                maxLength={100}
              />
            </div>
            <TextAreaField
              label={t('Instructions for the patient')}
              name="instructions"
              defaultValue={resubmitting.instructions ?? ''}
              maxLength={2000}
              rows={2}
            />
            <TextAreaField
              label={t('Note to the pharmacist')}
              name="note"
              required
              minLength={3}
              maxLength={1000}
              rows={3}
            />
            <ErrorAlert error={resubmit.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setResubmitting(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={resubmit.isPending}>
                {t('Resubmit')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('New prescription')} wide>
        <form onSubmit={onSubmit}>
          {activeAllergies.length > 0 && (
            <Alert tone="danger" title={t('Recorded allergies')}>
              {activeAllergies
                .map((a) => `${a.substance} (${a.severity.toLowerCase().replace('_', ' ')})`)
                .join(', ')}
            </Alert>
          )}
          <CatalogPicker
            label={t('Medicine from the national catalogue (optional)')}
            value={catalogItem}
            onChange={(item) => {
              setCatalogItem(item);
              if (item) setMedication(itemName(item));
            }}
            hint={t('Choosing a catalogue item lets the pharmacy dispense it from stock.')}
          />
          <div className="form-grid">
            <TextField
              label={t('Medication')}
              name="medication"
              required
              minLength={2}
              maxLength={200}
              value={medication}
              onChange={(e) => setMedication(e.target.value)}
            />
            <TextField
              label={t('Start date')}
              name="startDate"
              type="date"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
            />
            <TextField label={t('End date')} name="endDate" type="date" />
          </div>
          <DoseBuilder
            state={builder}
            onChange={setBuilder}
            patient={check.data?.patient ?? null}
            summary={builder.freeText ? null : (check.data?.dose ?? null)}
            patientId={patientId}
          />
          <fieldset className="stack">
            <legend>{t('Community pharmacy')}</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={erx.enabled}
                onChange={(e) => setErx((x) => ({ ...x, enabled: e.target.checked }))}
              />{' '}
              {t('E-prescription for a community pharmacy')}
            </label>
            {erx.enabled && (
              <div className="form-grid">
                <SelectField
                  label={t('Repeat supplies')}
                  name="erxRepeats"
                  value={erx.repeats}
                  onChange={(e) => setErx((x) => ({ ...x, repeats: e.target.value }))}
                  options={REPEAT_OPTIONS.map((n) => ({
                    value: String(n),
                    label: n === 0 ? t('None (one supply)') : t('{n} repeats', { n }),
                  }))}
                />
                <TextField
                  label={t('Valid for (days)')}
                  name="erxValidDays"
                  type="number"
                  min={1}
                  max={365}
                  value={erx.validDays}
                  onChange={(e) => setErx((x) => ({ ...x, validDays: e.target.value }))}
                  hint={t(
                    'Default 30 days per supply. Controlled medicines (opioids, benzodiazepines): no repeats, at most 7 days.',
                  )}
                />
              </div>
            )}
          </fieldset>
          <EncounterSelect encounters={encounters} />
          <TextAreaField
            label={t('Instructions for the patient')}
            name="instructions"
            maxLength={2000}
            rows={3}
          />
          <section aria-live="polite">
            {check.isFetching && <p className="muted">{t('Checking medication safety…')}</p>}
            {alerts.length > 0 && (
              <>
                <h3>{t('Medication safety')}</h3>
                {alerts.some((a) => a.blocking) && (
                  <Alert tone="danger" title={t('Serious safety alerts')}>
                    {t(
                      'Choose another medicine, or record for each serious alert why it is safe to proceed.',
                    )}
                  </Alert>
                )}
                <SafetyAlertList
                  alerts={alerts}
                  reasons={reasons}
                  onReason={(code, reason) => setReasons((r) => ({ ...r, [code]: reason }))}
                />
              </>
            )}
            {!check.isFetching &&
              check.data &&
              alerts.length === 0 &&
              debouncedMedication.trim().length >= 3 && (
                <p className="muted">{t('No safety alerts found by the automated checks.')}</p>
              )}
          </section>
          {!blockedByServer && <ErrorAlert error={create.error} />}
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Prescribe')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

/* ------------------------------------------------------------------ e-prescriptions -------- */

/** The e-prescription controls are state, not prescription fields. */
function withoutErxFields(v: Record<string, string>) {
  const { erxRepeats: _repeats, erxValidDays: _validDays, ...rest } = v;
  return rest;
}

/** Repeats and validity when sending an existing prescription as an e-prescription. */
function ErxFields() {
  return (
    <div className="form-grid">
      <SelectField
        label={t('Repeat supplies')}
        name="repeats"
        defaultValue="0"
        options={REPEAT_OPTIONS.map((n) => ({
          value: String(n),
          label: n === 0 ? t('None (one supply)') : t('{n} repeats', { n }),
        }))}
      />
      <TextField
        label={t('Valid for (days)')}
        name="validDays"
        type="number"
        min={1}
        max={365}
        hint={t(
          'Default 30 days per supply. Controlled medicines (opioids, benzodiazepines): no repeats, at most 7 days.',
        )}
      />
    </div>
  );
}

/** Status of an e-prescription in the prescriptions table. */
function ErxCell({
  e,
  onOpen,
}: {
  e: EPrescription | undefined;
  onOpen: (e: EPrescription) => void;
}) {
  if (!e) return <span className="muted">{t('E-prescription')}</span>;
  return (
    <div className="stack" style={{ gap: '0.2rem' }}>
      <span className="row" style={{ gap: '0.3rem', flexWrap: 'wrap' }}>
        <ErxStatusBadge status={e.status} />
        {e.code && <span className="mono">{e.code}</span>}
      </span>
      <span className="muted">
        {t('{dispensed} of {total} supplies dispensed', {
          dispensed: e.suppliesDispensed,
          total: e.suppliesTotal,
        })}
      </span>
      <Button size="sm" variant="ghost" onClick={() => onOpen(e)}>
        {t('Details|e-prescription')}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ structured dose builder -- */

interface DoseBuilderState {
  freeText: boolean;
  amount: string;
  unit: DoseUnit;
  route: string;
  frequencyCode: FrequencyCode;
  asNeeded: boolean;
  maxDoses: string;
  durationDays: string;
}

const EMPTY_BUILDER: DoseBuilderState = {
  freeText: false,
  amount: '',
  unit: 'mg',
  route: 'oral',
  frequencyCode: 'TID',
  asNeeded: false,
  maxDoses: '',
  durationDays: '',
};

const toNumber = (v: string) => {
  const n = Number(v.replace(',', '.'));
  return v.trim() && Number.isFinite(n) && n > 0 ? n : null;
};

/** The structured dose to send, or null while it is incomplete (or free text is used). */
function toStructuredDose(b: DoseBuilderState): StructuredDose | null {
  if (b.freeText) return null;
  const amount = toNumber(b.amount);
  if (!amount) return null;
  const prn = b.frequencyCode === 'PRN';
  const maxDoses = toNumber(b.maxDoses);
  if (prn && !maxDoses) return null;
  const duration = toNumber(b.durationDays);
  return {
    doseAmount: amount,
    doseUnit: b.unit,
    frequencyCode: b.frequencyCode,
    route: b.route,
    ...(prn || b.asNeeded ? { asNeeded: true } : {}),
    ...((prn || b.asNeeded) && maxDoses ? { maxDosesPer24h: Math.round(maxDoses) } : {}),
    ...(duration ? { durationDays: Math.round(duration) } : {}),
  };
}

const NOT_COMPUTED: Record<NonNullable<DoseSummary['notComputed']>, string> = {
  NEEDS_WEIGHT: 'A weight is needed to work out this dose.',
  NEEDS_STRENGTH:
    'The strength is unknown: choose the medicine from the catalogue or give the dose in mg.',
  UNIT_MISMATCH: 'The unit does not match the medicine’s form (e.g. ml for tablets).',
};

/**
 * Dose amount + unit, route, frequency, as needed and duration, with a live preview of the text the
 * prescription will carry and the patient facts dose checks use (age group, latest weight).
 */
function DoseBuilder({
  state,
  onChange,
  patient,
  summary,
  patientId,
}: {
  state: DoseBuilderState;
  onChange: (s: DoseBuilderState) => void;
  patient: DosingPatient | null;
  summary: DoseSummary | null;
  patientId: string;
}) {
  const set = (patch: Partial<DoseBuilderState>) => onChange({ ...state, ...patch });
  const dose = toStructuredDose(state);
  const paediatric = patient?.ageGroup === 'CHILD' || patient?.ageGroup === 'NEONATE';
  const preview = dose ? doseText(dose, patient?.weightKg ?? null) : null;
  const prn = state.frequencyCode === 'PRN';

  return (
    <fieldset className="stack">
      <legend>{t('Dose')}</legend>
      {(paediatric || state.unit === 'mg/kg') &&
        (patient?.weightKg ? (
          <p className="muted">
            {t('Weight for dosing: {weight} kg (recorded {date}).', {
              weight: patient.weightKg,
              date: patient.weightRecordedAt ? formatDate(patient.weightRecordedAt) : '–',
            })}{' '}
            <Link to={`/doctor/patients/${patientId}?tab=vitals`}>{t('Record weight')}</Link>
          </p>
        ) : (
          <Alert tone="warning" title={t('No weight recorded')}>
            {t('Weight-based dosing needs a current weight.')}{' '}
            <Link to={`/doctor/patients/${patientId}?tab=vitals`}>{t('Record weight')}</Link>
          </Alert>
        ))}
      {state.freeText ? (
        <div className="form-grid">
          <TextField
            label={t('Dosage')}
            name="dosage"
            required
            maxLength={100}
            hint={t('e.g. 5 mg')}
          />
          <TextField
            label={t('Frequency')}
            name="frequency"
            required
            maxLength={100}
            hint={t('e.g. once daily')}
          />
          <TextField label={t('Route')} name="route" defaultValue="oral" maxLength={50} />
        </div>
      ) : (
        <div className="form-grid">
          <TextField
            label={t('Dose amount')}
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            required
            value={state.amount}
            onChange={(e) => set({ amount: e.target.value })}
          />
          <SelectField
            label={t('Unit')}
            value={state.unit}
            onChange={(e) => set({ unit: e.target.value as DoseUnit })}
            options={DOSE_UNITS.map((u) => ({ value: u, label: unitLabel(u) }))}
          />
          <SelectField
            label={t('Route')}
            name="route"
            value={state.route}
            onChange={(e) => set({ route: e.target.value })}
            options={ROUTES.map((r) => ({ value: r, label: routeLabel(r) }))}
          />
          <SelectField
            label={t('Frequency')}
            value={state.frequencyCode}
            onChange={(e) => set({ frequencyCode: e.target.value as FrequencyCode })}
            options={FREQUENCY_CODES.map((c) => ({ value: c, label: frequencyLabel(c) }))}
          />
          {(prn || state.asNeeded) && (
            <TextField
              label={t('Maximum doses in 24 hours')}
              type="number"
              min="1"
              max="24"
              step="1"
              required={prn}
              value={state.maxDoses}
              onChange={(e) => set({ maxDoses: e.target.value })}
            />
          )}
          <TextField
            label={t('Duration (days)')}
            type="number"
            min="1"
            max="3650"
            step="1"
            value={state.durationDays}
            onChange={(e) => set({ durationDays: e.target.value })}
            hint={t('Sets the end date when none is given.')}
          />
        </div>
      )}
      <div className="row">
        {!state.freeText && !prn && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={state.asNeeded}
              onChange={(e) => set({ asNeeded: e.target.checked })}
            />
            {t('As needed (PRN)')}
          </label>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={state.freeText}
            onChange={(e) => set({ freeText: e.target.checked })}
          />
          {t('Enter the dose as free text')}
        </label>
      </div>
      {state.freeText ? (
        <p className="muted">{t('Free-text doses are not checked against dose limits.')}</p>
      ) : (
        preview && (
          <p aria-live="polite">
            <strong>{t('Prescription text')}:</strong> {preview.dosage} · {preview.frequency}
          </p>
        )
      )}
      {summary && <DoseSummaryView summary={summary} />}
    </fieldset>
  );
}

/** Server quantities ("2.5 mg") with the reader's decimal separator. */
const localQuantity = (q: string | null) =>
  q === null ? '–' : getLocale() === 'en' ? q : q.replace(/(\d)\.(\d)/g, '$1,$2');

function DoseSummaryView({ summary }: { summary: DoseSummary }) {
  if (summary.notComputed) return <p className="muted">{t(NOT_COMPUTED[summary.notComputed])}</p>;
  if (!summary.ingredients.length) return null;
  return (
    <Table caption={t('Dose check')}>
      <thead>
        <tr>
          <th>{t('Ingredient')}</th>
          <th>{t('Per dose')}</th>
          <th>{t('Per day')}</th>
          <th>{t('Limit')}</th>
        </tr>
      </thead>
      <tbody>
        {summary.ingredients.map((i) => (
          <tr key={i.ingredient}>
            <td>{i.ingredient}</td>
            <td>{localQuantity(i.singleDose)}</td>
            <td>{localQuantity(i.dailyDose)}</td>
            <td>
              {i.checked
                ? t('max {single} per dose, {daily} per day', {
                    single: localQuantity(i.maxSingle),
                    daily: localQuantity(i.maxDaily),
                  })
                : t('No dose rule')}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
