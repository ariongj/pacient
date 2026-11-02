import { t } from '../../i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../../api/client';
import {
  Alert,
  Button,
  compact,
  enumOptions,
  ErrorAlert,
  formValues,
  SelectField,
  TextField,
} from '../../components/ui';
import { formatDate } from '../../format';

const SEXES = ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'] as const;
const BLOOD_TYPES = ['UNKNOWN', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

interface DuplicateCandidate {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

interface RegisterResult {
  patient: { id: string; firstName: string; lastName: string };
  activationUrl?: string;
}

/** Patient registration with duplicate review: similar records are flagged, never auto-merged. */
export function RegisterPatientForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<RegisterResult>('/patients', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patients'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.code === 'POSSIBLE_DUPLICATE' &&
        Array.isArray(err.details)
      ) {
        setDuplicates(err.details as DuplicateCandidate[]);
        setConfirmed(false);
      }
    },
  });

  if (mutation.data) {
    const { patient, activationUrl } = mutation.data;
    return (
      <div className="stack">
        <Alert
          tone="success"
          title={t('{name} is registered.', { name: `${patient.firstName} ${patient.lastName}` })}
        >
          {t('Assign a doctor from the patient list to open their care relationship.')}
        </Alert>
        {activationUrl && (
          <TextField
            label={t('Portal activation link (development only — sent by email in production)')}
            readOnly
            value={activationUrl}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <div className="form-actions">
          <Button onClick={onDone}>{t('Done')}</Button>
        </div>
      </div>
    );
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const createPortalAccount = new FormData(e.currentTarget).get('createPortalAccount') === 'on';
    mutation.mutate({
      ...compact({
        nationalId: v.nationalId,
        firstName: v.firstName,
        lastName: v.lastName,
        dateOfBirth: v.dateOfBirth,
        sex: v.sex,
        bloodType: v.bloodType,
        phone: v.phone,
        email: v.email,
        address: v.address,
        municipality: v.municipality,
        emergencyContactName: v.emergencyContactName,
        emergencyContactPhone: v.emergencyContactPhone,
      }),
      createPortalAccount,
      confirmedNotDuplicate: duplicates !== null && confirmed,
    });
  }

  const duplicateError =
    mutation.error instanceof ApiError && mutation.error.code === 'POSSIBLE_DUPLICATE';

  return (
    <form ref={formRef} onSubmit={onSubmit}>
      <fieldset>
        <legend>{t('Identity')}</legend>
        <div className="form-grid">
          <TextField
            label={t('National ID')}
            name="nationalId"
            required
            inputMode="numeric"
            pattern="[0-9]{10}"
            hint={t('10 digits')}
            autoComplete="off"
          />
          <TextField label={t('First name')} name="firstName" required autoComplete="off" />
          <TextField label={t('Last name')} name="lastName" required autoComplete="off" />
          <TextField
            label={t('Date of birth')}
            name="dateOfBirth"
            type="date"
            required
            max={new Date().toISOString().slice(0, 10)}
          />
          <SelectField
            label={t('Sex')}
            name="sex"
            required
            options={enumOptions(SEXES)}
            defaultValue="UNKNOWN"
          />
          <SelectField
            label={t('Blood type')}
            name="bloodType"
            options={BLOOD_TYPES.map((b) => ({
              value: b,
              label: b === 'UNKNOWN' ? t('Unknown') : b,
            }))}
            defaultValue="UNKNOWN"
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('Contact')}</legend>
        <div className="form-grid">
          <TextField label={t('Phone')} name="phone" type="tel" autoComplete="off" />
          <TextField label={t('Email')} name="email" type="email" autoComplete="off" />
          <TextField label={t('Address')} name="address" autoComplete="off" />
          <TextField label={t('Municipality')} name="municipality" autoComplete="off" />
          <TextField
            label={t('Emergency contact name')}
            name="emergencyContactName"
            autoComplete="off"
          />
          <TextField
            label={t('Emergency contact phone')}
            name="emergencyContactPhone"
            type="tel"
            autoComplete="off"
          />
        </div>
        <label className="checkbox">
          <input type="checkbox" name="createPortalAccount" /> Invite the patient to the online
          portal (requires email)
        </label>
      </fieldset>

      {duplicates && (
        <Alert tone="warning" title={t('Possible duplicate record')}>
          <p>
            {t(
              'A patient with the same name and date of birth is already registered at this facility:',
            )}
          </p>
          <ul>
            {duplicates.map((d) => (
              <li key={d.id}>
                {d.firstName} {d.lastName}, born {formatDate(d.dateOfBirth)} (record{' '}
                <code>{d.id.slice(0, 8)}</code>)
              </li>
            ))}
          </ul>
          <p>
            {t('Verify the person’s identity document. Records are never merged automatically.')}
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            {t('I have verified this is a different person')}
          </label>
        </Alert>
      )}
      {!duplicateError && <ErrorAlert error={mutation.error} />}

      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={duplicates !== null && !confirmed}
        >
          {t('Register patient')}
        </Button>
      </div>
    </form>
  );
}
