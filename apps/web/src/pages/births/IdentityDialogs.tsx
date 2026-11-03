import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import {
  DELIVERY_TYPES,
  deliveryLabel,
  displayName,
  type Sex,
  type TemporaryKind,
} from '../../api/identity';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Dialog,
  ErrorAlert,
  formValues,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { age, humanize } from '../../format';
import { t } from '../../i18n';

const SEXES: Sex[] = ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'];
const sexOptions = () => SEXES.map((s) => ({ value: s, label: humanize(s) }));

/** Refreshes every view that shows temporary records, births or patient lists. */
function useInvalidateIdentity() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['identity'] });
    void qc.invalidateQueries({ queryKey: ['patients'] });
    void qc.invalidateQueries({ queryKey: ['patient'] });
  };
}

export interface CreatedPatient {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: Sex;
  temporaryIdentity: TemporaryKind | null;
}

/** Registers a patient who cannot be identified yet (no documents, unconscious, confused). */
export function UnknownPatientDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (p: CreatedPatient) => void;
}) {
  const invalidate = useInvalidateIdentity();
  const [created, setCreated] = useState<CreatedPatient | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<CreatedPatient>('/identity/temporary', { method: 'POST', body }),
    onSuccess: (p) => {
      invalidate();
      setCreated(p);
      onCreated?.(p);
    },
  });

  function close() {
    setCreated(null);
    create.reset();
    onClose();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({
      sex: v.sex,
      identityNote: v.identityNote,
      ...(v.estimatedAge ? { estimatedAge: Number(v.estimatedAge) } : {}),
    });
  }

  return (
    <Dialog open={open} onClose={close} title={t('Register unknown patient')}>
      {created ? (
        <div className="stack">
          <Alert tone="success" title={t('Temporary record created')}>
            {t(
              'Write the temporary number on the wristband. Confirm the identity as soon as documents or relatives are available.',
            )}
          </Alert>
          <p>
            <strong>{displayName(created)}</strong> · {t('Temporary number')}{' '}
            <code>{created.nationalId}</code>
          </p>
          <div className="form-actions">
            <Button onClick={close}>{t('Done')}</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit}>
          <p className="muted">
            {t(
              'Use this only when the person cannot be identified. Search for an existing record first – a temporary record that later turns out to be a duplicate has to be merged.',
            )}
          </p>
          <div className="form-grid">
            <SelectField
              label={t('Sex')}
              name="sex"
              required
              options={sexOptions()}
              defaultValue="UNKNOWN"
            />
            <TextField
              label={t('Estimated age (years)')}
              name="estimatedAge"
              type="number"
              min={0}
              max={120}
              inputMode="numeric"
              hint={t('The date of birth is recorded as 1 January of the estimated year.')}
            />
          </div>
          <TextAreaField
            label={t('Description')}
            name="identityNote"
            required
            minLength={3}
            maxLength={300}
            rows={3}
            hint={t(
              'How to recognise the person and how they arrived, e.g. “Man, about 40, brought by ambulance from the bus station”.',
            )}
          />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Create temporary record')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Replaces a temporary number with the person's national ID and real details. */
export function ConfirmIdentityDialog({
  patient,
  onClose,
}: {
  patient: {
    id: string;
    nationalId: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: Sex | string;
    temporaryIdentity: TemporaryKind | null;
  } | null;
  onClose: () => void;
}) {
  const user = useUser();
  const invalidate = useInvalidateIdentity();
  const confirm = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/identity/${patient!.id}/confirm`, { method: 'POST', body }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const exists = confirm.error instanceof ApiError && confirm.error.code === 'IDENTITY_EXISTS';
  const newborn = patient?.temporaryIdentity === 'NEWBORN';

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    confirm.mutate(v);
  }

  return (
    <Dialog
      open={Boolean(patient)}
      onClose={() => {
        confirm.reset();
        onClose();
      }}
      title={newborn ? t('Enter the national ID from the civil registry') : t('Confirm identity')}
    >
      {patient && (
        <form onSubmit={onSubmit}>
          <p className="muted">
            {t('Temporary number')} <code>{patient.nationalId}</code> · {displayName(patient)}
          </p>
          <div className="form-grid">
            <TextField
              label={t('National ID')}
              name="nationalId"
              required
              inputMode="numeric"
              pattern="\d{10}"
              maxLength={10}
              hint={t('10 digits, from the identity card or the birth certificate')}
            />
            <SelectField
              label={t('Sex')}
              name="sex"
              required
              options={sexOptions()}
              defaultValue={patient.sex}
            />
            <TextField
              label={t('First name')}
              name="firstName"
              required
              maxLength={100}
              defaultValue={patient.temporaryIdentity === 'UNIDENTIFIED' ? '' : patient.firstName}
            />
            <TextField
              label={t('Last name')}
              name="lastName"
              required
              maxLength={100}
              defaultValue={patient.temporaryIdentity === 'UNIDENTIFIED' ? '' : patient.lastName}
            />
            <TextField
              label={t('Date of birth')}
              name="dateOfBirth"
              type="date"
              required
              defaultValue={newborn ? patient.dateOfBirth : ''}
            />
          </div>
          {exists ? (
            <Alert tone="warning" title={t('This person already has a record')}>
              {t(
                'The national ID belongs to an existing record. Nothing was changed. The two records must be merged so that all entries are kept together.',
              )}{' '}
              {user.role === 'DIRECTOR' ? (
                <Link to="/director/duplicates">{t('Open duplicate records')}</Link>
              ) : (
                t('Ask the facility director to merge them.')
              )}
            </Alert>
          ) : (
            <ErrorAlert error={confirm.error} />
          )}
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={confirm.isPending}>
              {t('Confirm identity')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

interface PatientHit {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  temporaryIdentity?: TemporaryKind | null;
}

function MotherPicker({
  value,
  onChange,
}: {
  value: PatientHit | null;
  onChange: (p: PatientHit | null) => void;
}) {
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const search = useQuery({
    queryKey: ['patients', 'mother-search', submitted],
    enabled: submitted.length >= 2,
    queryFn: () =>
      api<{ items: PatientHit[] }>('/patients', {
        query: { scope: 'facility', search: submitted, pageSize: 10 },
      }).then((r) => r.items.filter((p) => p.sex !== 'MALE' && !p.temporaryIdentity)),
  });
  if (value) {
    return (
      <div className="row-between" style={{ marginBottom: '0.75rem' }}>
        <span>
          {t('Mother')}: <strong>{displayName(value)}</strong>{' '}
          <span className="muted">
            {t('{age} y', { age: age(value.dateOfBirth) })} · <code>{value.nationalId}</code>
          </span>
        </span>
        <Button size="sm" variant="secondary" onClick={() => onChange(null)}>
          {t('Change')}
        </Button>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
      <div className="search-bar">
        <TextField
          label={t('Mother')}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setSubmitted(term.trim());
            }
          }}
          placeholder={t('Name or national ID')}
        />
        <Button variant="secondary" onClick={() => setSubmitted(term.trim())}>
          {t('Search')}
        </Button>
      </div>
      <ErrorAlert error={search.error} />
      {search.data && search.data.length === 0 && (
        <p className="muted">{t('No matching patients')}</p>
      )}
      {search.data && search.data.length > 0 && (
        <ul className="list">
          {search.data.map((p) => (
            <li key={p.id} className="row-between">
              <span>
                <strong>{displayName(p)}</strong>{' '}
                <span className="muted">
                  {t('{age} y', { age: age(p.dateOfBirth) })} · <code>{p.nationalId}</code>
                </span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => onChange(p)}>
                {t('Choose')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const apgarOptions = () =>
  Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: String(i) }));

function nowLocalInput() {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Registers a birth: the newborn's record, linked to the mother, with the birth details. */
export function RegisterBirthDialog({
  open,
  onClose,
  mother: fixedMother,
}: {
  open: boolean;
  onClose: () => void;
  /** When opened from the mother's chart. */
  mother?: PatientHit | null;
}) {
  const invalidate = useInvalidateIdentity();
  const [mother, setMother] = useState<PatientHit | null>(fixedMother ?? null);
  const [weight, setWeight] = useState('');
  const [weeks, setWeeks] = useState('39');
  const [result, setResult] = useState<{
    newborn: CreatedPatient;
    guardianshipCreated: boolean;
  } | null>(null);
  const register = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ newborn: CreatedPatient; guardianshipCreated: boolean }>('/identity/births', {
        method: 'POST',
        body,
      }),
    onSuccess: (r) => {
      invalidate();
      setResult(r);
    },
  });
  const chosen = fixedMother ?? mother;

  function close() {
    setResult(null);
    register.reset();
    if (!fixedMother) setMother(null);
    setWeight('');
    setWeeks('39');
    onClose();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!chosen) return;
    const v = formValues(e.currentTarget);
    const num = (k: string) => (v[k] ? Number(v[k]) : undefined);
    register.mutate({
      motherPatientId: chosen.id,
      bornAt: new Date(v.bornAt!).toISOString(),
      sex: v.sex,
      deliveryType: v.deliveryType,
      gestationalWeeks: num('gestationalWeeks'),
      gestationalDays: num('gestationalDays') ?? 0,
      birthWeightGrams: num('birthWeightGrams'),
      lengthCm: num('lengthCm'),
      headCircumferenceCm: num('headCircumferenceCm'),
      apgar1: num('apgar1'),
      apgar5: num('apgar5'),
      apgar10: num('apgar10'),
      birthOrder: num('birthOrder') ?? 1,
      firstName: v.firstName || undefined,
      notes: v.notes || undefined,
    });
  }

  const grams = Number(weight);
  const weightWarning =
    weight && grams > 0
      ? grams < 2500
        ? t('Low birth weight (under 2500 g) – check that the weight is correct.')
        : grams > 4500
          ? t('High birth weight (over 4500 g) – check that the weight is correct.')
          : null
      : null;
  const preterm = Number(weeks) > 0 && Number(weeks) < 37;

  return (
    <Dialog open={open} onClose={close} title={t('Register birth')} wide>
      {result ? (
        <div className="stack">
          <Alert tone="success" title={t('Birth registered')}>
            {t(
              'The baby’s record was created with a temporary number until the civil registry issues a national ID.',
            )}
            {result.guardianshipCreated &&
              ` ${t('The mother can follow her baby’s record in the patient portal.')}`}
          </Alert>
          <p>
            <strong>
              {result.newborn.firstName} {result.newborn.lastName}
            </strong>{' '}
            · {t('Temporary number')} <code>{result.newborn.nationalId}</code>
          </p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setResult(null)}>
              {t('Register another baby (twins)')}
            </Button>
            <Button onClick={close}>{t('Done')}</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit}>
          {fixedMother ? (
            <p>
              {t('Mother')}: <strong>{displayName(fixedMother)}</strong>
            </p>
          ) : (
            <MotherPicker value={mother} onChange={setMother} />
          )}
          <div className="form-grid">
            <TextField
              label={t('Time of birth')}
              name="bornAt"
              type="datetime-local"
              required
              defaultValue={nowLocalInput()}
            />
            <SelectField
              label={t('Sex')}
              name="sex"
              required
              options={sexOptions()}
              defaultValue="FEMALE"
            />
            <SelectField
              label={t('Delivery')}
              name="deliveryType"
              required
              options={DELIVERY_TYPES.map((d) => ({ value: d, label: deliveryLabel(d) }))}
            />
            <TextField
              label={t('Birth order')}
              name="birthOrder"
              type="number"
              min={1}
              max={8}
              defaultValue="1"
              hint={t('1 for a single baby; 1, 2 … for twins')}
            />
            <TextField
              label={t('Gestation – weeks')}
              name="gestationalWeeks"
              type="number"
              min={20}
              max={45}
              required
              value={weeks}
              onChange={(e) => setWeeks(e.target.value)}
            />
            <TextField
              label={t('Gestation – days')}
              name="gestationalDays"
              type="number"
              min={0}
              max={6}
              defaultValue="0"
            />
            <TextField
              label={t('Birth weight (g)')}
              name="birthWeightGrams"
              type="number"
              min={200}
              max={7000}
              required
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
            <TextField
              label={t('Length (cm)')}
              name="lengthCm"
              type="number"
              min={20}
              max={70}
              step="0.5"
            />
            <TextField
              label={t('Head circumference (cm)')}
              name="headCircumferenceCm"
              type="number"
              min={15}
              max={50}
              step="0.5"
            />
            <SelectField
              label={t('Apgar at 1 minute')}
              name="apgar1"
              required
              options={apgarOptions()}
              defaultValue="8"
            />
            <SelectField
              label={t('Apgar at 5 minutes')}
              name="apgar5"
              required
              options={apgarOptions()}
              defaultValue="9"
            />
            <SelectField
              label={t('Apgar at 10 minutes')}
              name="apgar10"
              options={apgarOptions()}
              placeholder={t('Not recorded')}
            />
            <TextField
              label={t('First name (optional)')}
              name="firstName"
              maxLength={100}
              hint={t('Leave empty if the parents have not chosen a name yet.')}
            />
          </div>
          {weightWarning && <Alert tone="warning">{weightWarning}</Alert>}
          {preterm && (
            <Alert tone="warning">
              {t('Preterm birth (under 37 weeks) – make sure the neonatal team is informed.')}
            </Alert>
          )}
          <TextAreaField label={t('Notes')} name="notes" maxLength={2000} rows={3} />
          <ErrorAlert error={register.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={register.isPending} disabled={!chosen}>
              {t('Register birth')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
