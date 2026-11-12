import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { Demographics } from '../../api/types';
import {
  Alert,
  Button,
  Card,
  compact,
  enumOptions,
  ErrorAlert,
  formValues,
  PageHeader,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { useUser } from '../../auth/AuthContext';
import { formatDate } from '../../format';
import { BookAppointmentDialog } from '../reception/BookAppointmentDialog';
import { t } from '../../i18n';

const SEX = ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'] as const;
const BLOOD = ['UNKNOWN', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

interface Candidate {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

interface RegisterResult {
  patient: Demographics;
  activationUrl?: string;
}

export function RegisterPatient() {
  const qc = useQueryClient();
  // Shared by doctors and reception; reception has no chart, so links go back to the patient list.
  const isReception = useUser().role === 'RECEPTION';
  const listPath = isReception ? '/reception/patients' : '/doctor/patients';
  const recordPath = (id: string) => (isReception ? listPath : `/doctor/patients/${id}`);
  const formRef = useRef<HTMLFormElement>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [booking, setBooking] = useState(false);

  const register = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<RegisterResult>('/patients', { method: 'POST', body }),
    onSuccess: (data) => {
      setResult(data);
      setCandidates(null);
      void qc.invalidateQueries({ queryKey: ['patients'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'POSSIBLE_DUPLICATE') {
        setCandidates((err.details as Candidate[]) ?? []);
        setConfirmed(false);
      }
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { createPortalAccount, ...v } = formValues(e.currentTarget);
    register.mutate({
      ...compact(v),
      createPortalAccount: createPortalAccount === 'on',
      confirmedNotDuplicate: candidates !== null && confirmed,
    });
  }

  if (result) {
    return (
      <>
        <PageHeader title={t('Patient registered')} />
        <Card>
          <Alert
            tone="success"
            title={t('{name} has been registered.', {
              name: `${result.patient.firstName} ${result.patient.lastName}`,
            })}
          >
            {isReception
              ? t('The patient is registered at your facility. The next step is an appointment.')
              : t('You have been added to the patient’s care team.')}
          </Alert>
          {result.activationUrl && (
            <Alert tone="info" title={t('Portal activation link')}>
              <p>
                {t(
                  'Give this single-use link to the patient so they can choose their own password. In production it is delivered by email and is not shown here.',
                )}
              </p>
              <code style={{ wordBreak: 'break-all' }}>{result.activationUrl}</code>
            </Alert>
          )}
          <div className="row">
            {isReception ? (
              <>
                <Button onClick={() => setBooking(true)}>{t('Book appointment')}</Button>
                <Link to={listPath} className="btn btn-secondary btn-md">
                  {t('Back to patients')}
                </Link>
              </>
            ) : (
              <Link to={recordPath(result.patient.id)} className="btn btn-primary btn-md">
                {t('Open chart')}
              </Link>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setResult(null);
                setConfirmed(false);
              }}
            >
              {t('Register another patient')}
            </Button>
          </div>
        </Card>
        {isReception && (
          <BookAppointmentDialog
            open={booking}
            onClose={() => setBooking(false)}
            patient={{
              id: result.patient.id,
              name: `${result.patient.firstName} ${result.patient.lastName}`,
            }}
          />
        )}
      </>
    );
  }

  const isDuplicateError =
    register.error instanceof ApiError && register.error.code === 'POSSIBLE_DUPLICATE';

  return (
    <>
      <PageHeader
        title={t('Register patient')}
        subtitle={
          isReception
            ? t('The patient is registered at your facility.')
            : t('The patient is registered at your facility and you join their care team.')
        }
      />
      <Card>
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
                maxLength={10}
                hint={t('10 digits')}
                autoComplete="off"
              />
              <TextField label={t('First name')} name="firstName" required maxLength={100} />
              <TextField label={t('Last name')} name="lastName" required maxLength={100} />
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
                options={enumOptions(SEX)}
                placeholder={t('Select…')}
              />
              <SelectField
                label={t('Blood type')}
                name="bloodType"
                options={BLOOD.map((b) => ({
                  value: b,
                  label: b === 'UNKNOWN' ? t('Unknown') : b,
                }))}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend>{t('Contact')}</legend>
            <div className="form-grid">
              <TextField
                label={t('Phone')}
                name="phone"
                type="tel"
                autoComplete="off"
                maxLength={40}
              />
              <TextField
                label={t('Email')}
                name="email"
                type="email"
                autoComplete="off"
                maxLength={254}
              />
              <TextField label={t('Address')} name="address" maxLength={300} />
              <TextField label={t('Municipality')} name="municipality" maxLength={100} />
              <TextField
                label={t('Emergency contact name')}
                name="emergencyContactName"
                maxLength={200}
              />
              <TextField
                label={t('Emergency contact phone')}
                name="emergencyContactPhone"
                type="tel"
                maxLength={40}
              />
            </div>
            <label className="checkbox" style={{ marginTop: '0.75rem' }}>
              <input type="checkbox" name="createPortalAccount" />{' '}
              {t('Invite the patient to the portal (requires an email address)')}
            </label>
          </fieldset>

          {candidates && (
            <Alert tone="warning" title={t('Possible duplicate record')}>
              <p>
                {t(
                  'A patient with the same name and date of birth is already registered at your facility. Records are never merged automatically. Check the existing record before creating a new one.',
                )}
              </p>
              <Table caption={t('Possible duplicate patients')}>
                <thead>
                  <tr>
                    <th>{t('Name')}</th>
                    <th>{t('Date of birth')}</th>
                    <th>
                      <span className="sr-only">{t('Open|action')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.firstName} {c.lastName}
                      </td>
                      <td>{formatDate(c.dateOfBirth)}</td>
                      <td>
                        <Link to={recordPath(c.id)}>
                          {isReception ? t('Find in patient list') : t('Open existing record')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t('I have reviewed these records and this is a different person')}
              </label>
            </Alert>
          )}

          {!isDuplicateError && <ErrorAlert error={register.error} />}
          <div className="form-actions">
            <Link to={listPath} className="btn btn-secondary btn-md">
              {t('Cancel')}
            </Link>
            <Button
              type="submit"
              loading={register.isPending}
              disabled={candidates !== null && !confirmed}
            >
              {candidates ? t('Register as a new patient') : t('Register patient')}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
