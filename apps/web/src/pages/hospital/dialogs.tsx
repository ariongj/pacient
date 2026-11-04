import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import {
  dispositionLabel,
  sourceLabel,
  useHospitalDoctors,
  useHospitalMutation,
  useUnits,
  WARD_TYPES,
  type AdmissionSource,
  type Disposition,
} from '../../api/hospital';
import type { Page, PatientListItem } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Dialog,
  ErrorAlert,
  Loading,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, fullName } from '../../format';
import { t } from '../../i18n';

const SOURCES: AdmissionSource[] = ['ELECTIVE', 'EMERGENCY', 'TRANSFER', 'BIRTH'];
const DISPOSITIONS: Disposition[] = ['HOME', 'TRANSFER', 'AGAINST_ADVICE', 'DECEASED', 'OTHER'];

/** Unit + bed pickers fed by GET /hospital/units (available beds only). */
function UnitBedFields({
  unitId,
  bedId,
  onUnit,
  onBed,
  excludeBedId,
}: {
  unitId: string;
  bedId: string;
  onUnit: (id: string) => void;
  onBed: (id: string) => void;
  excludeBedId?: string | null;
}) {
  const units = useUnits(WARD_TYPES);
  if (units.isPending) return <Loading label={t('Loading wards…')} />;
  const items = units.data ?? [];
  const unit = items.find((u) => u.id === unitId);
  const free = (unit?.beds ?? []).filter((b) => b.status === 'AVAILABLE' && b.id !== excludeBedId);
  return (
    <div className="form-grid">
      <SelectField
        label={t('Ward')}
        required
        value={unitId}
        placeholder={t('Choose a ward')}
        onChange={(e) => {
          onUnit(e.currentTarget.value);
          onBed('');
        }}
        options={items.map((u) => ({
          value: u.id,
          label: t('{name} – {available} of {total} beds free', {
            name: u.name,
            available: u.available,
            total: u.total,
          }),
        }))}
      />
      <SelectField
        label={t('Bed')}
        value={bedId}
        disabled={!unit}
        placeholder={free.length ? t('Choose a bed') : t('No bed (waiting for a bed / rooming-in)')}
        onChange={(e) => onBed(e.currentTarget.value)}
        options={free.map((b) => ({ value: b.id, label: b.label }))}
        hint={
          unit && !free.length
            ? t('No free bed on this ward – the patient can be admitted without a bed for now.')
            : undefined
        }
      />
    </div>
  );
}

/** Admit a patient (doctors). Optional presets from the bed board or an emergency attendance. */
export function AdmitDialog({
  open,
  onClose,
  preset,
}: {
  open: boolean;
  onClose: () => void;
  preset?: {
    unitId?: string;
    bedId?: string;
    patient?: { id: string; firstName: string; lastName: string };
    edVisitId?: string;
    reason?: string;
  };
}) {
  const user = useUser();
  const [patient, setPatient] = useState(preset?.patient ?? null);
  const [search, setSearch] = useState('');
  const [unitId, setUnitId] = useState(preset?.unitId ?? '');
  const [bedId, setBedId] = useState(preset?.bedId ?? '');
  /** After admission: offer to print the wristband straight away. */
  const [admitted, setAdmitted] = useState<{ id: string; firstName: string; lastName: string } | null>(
    null,
  );
  const doctors = useHospitalDoctors();
  useEffect(() => {
    if (open) {
      setAdmitted(null);
      setPatient(preset?.patient ?? null);
      setUnitId(preset?.unitId ?? '');
      setBedId(preset?.bedId ?? '');
      setSearch('');
    }
  }, [open, preset?.patient, preset?.unitId, preset?.bedId]);

  const found = useQuery({
    queryKey: ['patients', 'admit-search', search],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', {
        query: { scope: 'facility', search, pageSize: 8 },
      }),
    enabled: open && !patient && search.trim().length >= 2,
  });

  const admit = useHospitalMutation(
    (body: Record<string, unknown>) => api('/hospital/admissions', { method: 'POST', body }),
    { patientId: patient?.id, onDone: () => setAdmitted(patient) },
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!patient) return;
    const f = new FormData(e.currentTarget);
    const expected = String(f.get('expectedDischargeAt') ?? '');
    admit.mutate({
      patientId: patient.id,
      unitId,
      bedId: bedId || null,
      attendingDoctorId: String(f.get('attendingDoctorId') || user.id),
      source: preset?.edVisitId ? 'EMERGENCY' : String(f.get('source')),
      reason: String(f.get('reason') ?? '').trim(),
      expectedDischargeAt: expected ? new Date(`${expected}T12:00:00`).toISOString() : null,
      edVisitId: preset?.edVisitId ?? null,
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('Admit a patient')} wide>
      {admitted ? (
        <div className="stack">
          <Alert tone="success" title={t('{name} has been admitted', { name: fullName(admitted) })}>
            {t('Print the wristband now – it is scanned before every dose.')}
          </Alert>
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Later')}
            </Button>
            <Link className="btn btn-primary btn-md" to={`/wristband/${admitted.id}`} onClick={onClose}>
              {t('Print wristband')}
            </Link>
          </div>
        </div>
      ) : (
      <form onSubmit={onSubmit} className="stack">
        {patient ? (
          <div className="row-between">
            <span>
              {t('Patient')}: <strong>{fullName(patient)}</strong>
            </span>
            {!preset?.patient && (
              <Button size="sm" variant="secondary" onClick={() => setPatient(null)}>
                {t('Change')}
              </Button>
            )}
          </div>
        ) : (
          <div className="stack" style={{ gap: '0.5rem' }}>
            <TextField
              label={t('Find the patient')}
              placeholder={t('Name or national ID')}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              autoFocus
            />
            {found.data?.items.length === 0 && <p className="muted">{t('No patients found')}</p>}
            <ul className="list">
              {found.data?.items.map((p) => (
                <li key={p.id} className="row-between">
                  <span>
                    <strong>{fullName(p)}</strong>{' '}
                    <span className="muted">
                      {p.nationalId} · {formatDate(p.dateOfBirth)}
                    </span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setPatient(p)}>
                    {t('Select')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <UnitBedFields unitId={unitId} bedId={bedId} onUnit={setUnitId} onBed={setBedId} />
        <div className="form-grid">
          <SelectField
            label={t('Attending doctor')}
            name="attendingDoctorId"
            defaultValue={user.id}
            options={(doctors.data ?? []).map((d) => ({
              value: d.id,
              label: d.specialty ? `${d.fullName} · ${t(d.specialty)}` : d.fullName,
            }))}
          />
          {!preset?.edVisitId && (
            <SelectField
              label={t('Admission type')}
              name="source"
              defaultValue="ELECTIVE"
              options={SOURCES.map((s) => ({ value: s, label: sourceLabel(s) }))}
            />
          )}
          <TextField label={t('Expected discharge')} name="expectedDischargeAt" type="date" />
        </div>
        <TextAreaField
          label={t('Reason for admission')}
          name="reason"
          required
          minLength={3}
          maxLength={500}
          rows={3}
          defaultValue={preset?.reason}
          hint={t('Visible only to the care team and staff of the ward.')}
        />
        {preset?.edVisitId && (
          <Alert tone="info">
            {t('The emergency attendance is closed as “admitted” when you confirm.')}
          </Alert>
        )}
        <ErrorAlert error={admit.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={admit.isPending} disabled={!patient || !unitId}>
            {t('Admit')}
          </Button>
        </div>
      </form>
      )}
    </Dialog>
  );
}

export function TransferDialog({
  open,
  onClose,
  admissionId,
  patientId,
  currentBedId,
}: {
  open: boolean;
  onClose: () => void;
  admissionId: string;
  patientId: string;
  currentBedId?: string | null;
}) {
  const [unitId, setUnitId] = useState('');
  const [bedId, setBedId] = useState('');
  const transfer = useHospitalMutation(
    (body: Record<string, unknown>) =>
      api(`/hospital/admissions/${admissionId}/transfer`, { method: 'POST', body }),
    { patientId, onDone: onClose },
  );
  return (
    <Dialog open={open} onClose={onClose} title={t('Transfer to another bed or ward')} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
          transfer.mutate({ unitId, bedId: bedId || null, reason });
        }}
      >
        <UnitBedFields
          unitId={unitId}
          bedId={bedId}
          onUnit={setUnitId}
          onBed={setBedId}
          excludeBedId={currentBedId}
        />
        <TextField
          label={t('Reason for the transfer')}
          name="reason"
          required
          minLength={3}
          maxLength={300}
        />
        <p className="muted">{t('The current bed is marked for cleaning.')}</p>
        <ErrorAlert error={transfer.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={transfer.isPending} disabled={!unitId}>
            {t('Transfer')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Discharge with a signed summary, prefilled from the record (doctors). */
export function DischargeDialog({
  open,
  onClose,
  admissionId,
  patientId,
}: {
  open: boolean;
  onClose: () => void;
  admissionId: string;
  patientId: string;
}) {
  const draft = useQuery({
    queryKey: ['hospital', 'summary-draft', admissionId],
    queryFn: () =>
      api<{ dischargeSummary: string; signed: boolean; generated?: boolean }>(
        `/hospital/admissions/${admissionId}/summary-draft`,
      ),
    enabled: open,
    staleTime: 0,
  });
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (draft.data) setText(draft.data.dischargeSummary ?? '');
  }, [draft.data]);
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  const save = useHospitalMutation(
    (dischargeSummary: string) =>
      api(`/hospital/admissions/${admissionId}/summary`, {
        method: 'PUT',
        body: { dischargeSummary },
      }),
    { patientId },
  );
  const discharge = useHospitalMutation(
    (body: Record<string, unknown>) =>
      api(`/hospital/admissions/${admissionId}/discharge`, { method: 'POST', body }),
    { patientId, onDone: onClose },
  );

  return (
    <Dialog open={open} onClose={onClose} title={t('Discharge and discharge summary')} wide>
      {draft.isPending ? (
        <Loading label={t('Preparing the discharge summary…')} />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!confirming) {
              setConfirming(true);
              return;
            }
            const f = new FormData(e.currentTarget);
            discharge.mutate({
              disposition: String(f.get('disposition')),
              dischargeSummary: text,
              followUp: String(f.get('followUp') ?? '').trim() || undefined,
            });
          }}
        >
          {draft.data?.generated && (
            <Alert tone="info">
              {t(
                'This draft was prepared from the record (diagnoses, medication, results, imaging). Check and complete it before signing.',
              )}
            </Alert>
          )}
          <TextAreaField
            label={t('Discharge summary')}
            className="summary-editor"
            value={text}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setConfirming(false);
            }}
            required
            minLength={20}
            maxLength={20_000}
          />
          <div className="form-grid">
            <SelectField
              label={t('Discharged to')}
              name="disposition"
              defaultValue="HOME"
              options={DISPOSITIONS.map((d) => ({ value: d, label: dispositionLabel(d) }))}
            />
            <TextField label={t('Follow-up (optional)')} name="followUp" maxLength={1000} />
          </div>
          {confirming && (
            <Alert tone="warning" title={t('Sign and discharge?')}>
              {t(
                'Signing makes the summary part of the legal record – it cannot be changed afterwards. The bed is marked for cleaning.',
              )}
            </Alert>
          )}
          <ErrorAlert error={save.error ?? discharge.error} />
          {save.isSuccess && !save.isPending && <Alert tone="success" title={t('Draft saved')} />}
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              variant="secondary"
              loading={save.isPending}
              disabled={!text.trim()}
              onClick={() => save.mutate(text)}
            >
              {t('Save draft')}
            </Button>
            <Button
              type="submit"
              variant={confirming ? 'danger' : 'primary'}
              loading={discharge.isPending}
            >
              {confirming ? t('Sign and discharge') : t('Discharge…')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Small action buttons for a bed's status (nurses, reception, directors). */
export function BedStatusActions({
  bedId,
  status,
}: {
  bedId: string;
  status: 'AVAILABLE' | 'CLEANING' | 'OUT_OF_SERVICE' | 'OCCUPIED';
}) {
  const set = useHospitalMutation((next: string) =>
    api(`/hospital/beds/${bedId}`, { method: 'PATCH', body: { status: next } }),
  );
  if (status === 'OCCUPIED') return null;
  return (
    <>
      {status !== 'AVAILABLE' && (
        <Button
          size="sm"
          variant="secondary"
          loading={set.isPending && set.variables === 'AVAILABLE'}
          onClick={() => set.mutate('AVAILABLE')}
        >
          {status === 'CLEANING' ? t('Cleaned') : t('Back in service')}
        </Button>
      )}
      {status === 'AVAILABLE' && (
        <Button
          size="sm"
          variant="ghost"
          loading={set.isPending && set.variables === 'OUT_OF_SERVICE'}
          onClick={() => {
            if (window.confirm(t('Take this bed out of service?'))) set.mutate('OUT_OF_SERVICE');
          }}
        >
          {t('Out of service')}
        </Button>
      )}
      {set.error ? (
        <span className="muted" role="alert">
          {set.error instanceof Error ? t(set.error.message) : t('Something went wrong')}
        </span>
      ) : null}
    </>
  );
}
