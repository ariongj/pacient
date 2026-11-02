import { t } from '../../i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, downloadFile, downloadJson } from '../../api/client';
import type { CorrectionRequest, Demographics } from '../../api/types';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  StatusBadge,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, humanize } from '../../format';
import {
  DependantsCard,
  EmailPreferencesCard,
  SmsCard,
  MyGuardiansCard,
} from '../../components/AccountCards';
import { TwoStepCard } from '../../components/TwoStep';
import { useAuth } from '../../auth/AuthContext';
import { ChangePasswordCard } from '../shared/AccountPage';
import { usePatientId } from './shared';

const SECTIONS = [
  'demographics',
  'allergies',
  'diagnoses',
  'prescriptions',
  'encounters',
  'lab-results',
  'vitals',
  'other',
];

function ContactForm({ patient, onDone }: { patient: Demographics; onDone: () => void }) {
  const queryClient = useQueryClient();
  const id = usePatientId();
  const mutation = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      api('/portal/contact', { method: 'PATCH', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patient', id] });
      onDone();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, string | null> = {};
    for (const k of [
      'phone',
      'email',
      'address',
      'municipality',
      'emergencyContactName',
      'emergencyContactPhone',
    ]) {
      const v = String(f.get(k) ?? '').trim();
      body[k] = v === '' ? null : v;
    }
    mutation.mutate(body);
  }
  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <TextField
          label={t('Phone')}
          name="phone"
          type="tel"
          autoComplete="tel"
          defaultValue={patient.phone ?? ''}
        />
        <TextField
          label={t('Email')}
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={patient.email ?? ''}
        />
        <TextField
          label={t('Address')}
          name="address"
          autoComplete="street-address"
          defaultValue={patient.address ?? ''}
        />
        <TextField
          label={t('Municipality')}
          name="municipality"
          defaultValue={patient.municipality ?? ''}
        />
        <TextField
          label={t('Emergency contact name')}
          name="emergencyContactName"
          defaultValue={patient.emergencyContactName ?? ''}
        />
        <TextField
          label={t('Emergency contact phone')}
          name="emergencyContactPhone"
          type="tel"
          defaultValue={patient.emergencyContactPhone ?? ''}
        />
      </div>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Save')}
        </Button>
      </div>
    </form>
  );
}

function Corrections() {
  const id = usePatientId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['patient', id, 'correction-requests'],
    queryFn: () => api<{ items: CorrectionRequest[] }>(`/patients/${id}/correction-requests`),
  });
  const create = useMutation({
    mutationFn: (body: object) =>
      api(`/patients/${id}/correction-requests`, { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patient', id, 'correction-requests'] });
      setOpen(false);
    },
  });
  return (
    <Card
      title={t('Correction requests')}
      actions={
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t('Request a correction')}
        </Button>
      }
    >
      <p className="muted">
        {t(
          'If something in your record looks wrong, tell your care team. A doctor reviews every request; your record is never changed without a clinician’s review.',
        )}
      </p>
      <QueryView query={q}>
        {(d) =>
          d.items.length ? (
            <ul className="list">
              {d.items.map((c) => (
                <li key={c.id}>
                  <div className="row-between">
                    <strong>{humanize(c.section)}</strong>
                    <StatusBadge value={c.status} />
                  </div>
                  <p>{c.description}</p>
                  <div className="muted">
                    {t('Submitted {date}', { date: formatDate(c.createdAt) })}
                  </div>
                  {c.response && (
                    <div className="addendum">
                      <strong>{t('Response from {name}', { name: c.resolvedBy })}</strong> (
                      {formatDate(c.resolvedAt)}): {c.response}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t('No correction requests')} />
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Request a correction')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create.mutate({ section: f.get('section'), description: f.get('description') });
          }}
        >
          <SelectField
            label={t('Which part of your record?')}
            name="section"
            required
            options={SECTIONS.map((s) => ({ value: s, label: humanize(s) }))}
          />
          <TextAreaField
            label={t('What should be corrected?')}
            name="description"
            required
            minLength={10}
            maxLength={4000}
            hint={t(
              'Describe what is wrong and what you believe is correct (at least 10 characters).',
            )}
          />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Submit request')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

export function PortalAccount() {
  const id = usePatientId();
  const { acting } = useAuth();
  // Demographics (not the clinical summary), so appointments-only guardians can use this page too.
  const summary = useQuery({
    queryKey: ['patient', id, 'demographics'],
    queryFn: async () => ({ patient: await api<Demographics>(`/patients/${id}`) }),
  });
  const [editing, setEditing] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);

  return (
    <>
      <PageHeader
        title={acting ? t('{name}’s details', { name: acting.firstName }) : t('My details')}
        subtitle={acting ? t('You are managing these details as their guardian.') : undefined}
      />
      <div className="stack">
        <QueryView query={summary}>
          {({ patient: p }) => (
            <Card
              title={t('Personal information')}
              actions={
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  {t('Update contact details')}
                </Button>
              }
            >
              <DefinitionList
                items={[
                  [t('Name'), `${p.firstName} ${p.lastName}`],
                  [t('National ID'), p.nationalId],
                  [t('Date of birth'), formatDate(p.dateOfBirth)],
                  [t('Sex'), humanize(p.sex)],
                  [t('Blood type'), p.bloodType === 'UNKNOWN' ? t('Unknown') : p.bloodType],
                  [t('Registered at'), p.primaryFacilityName],
                  [t('Phone'), p.phone],
                  [t('Email'), p.email],
                  [t('Address'), [p.address, p.municipality].filter(Boolean).join(', ') || null],
                  [
                    t('Emergency contact'),
                    p.emergencyContactName
                      ? `${p.emergencyContactName} (${p.emergencyContactPhone ?? t('no phone')})`
                      : null,
                  ],
                ]}
              />
              <p className="muted" style={{ marginTop: '1rem' }}>
                {t(
                  'Name, date of birth and national ID can only be corrected by your facility — use a correction request below.',
                )}
              </p>
              <Dialog
                open={editing}
                onClose={() => setEditing(false)}
                title={t('Update contact details')}
                wide
              >
                <ContactForm patient={p} onDone={() => setEditing(false)} />
              </Dialog>
            </Card>
          )}
        </QueryView>

        {!acting && <DependantsCard />}
        {!acting && (
          <QueryView query={summary}>
            {({ patient: p }) => <MyGuardiansCard patientId={id} dateOfBirth={p.dateOfBirth} />}
          </QueryView>
        )}

        {acting?.scope !== 'APPOINTMENTS' && <Corrections />}

        {acting?.scope !== 'APPOINTMENTS' && (
          <Card title={acting ? t('Download the record') : t('Download my record')}>
            <p className="muted">
              {t(
                'You have the right to a copy of your health record. The download is a machine-readable JSON file containing your released information. Store it securely.',
              )}
            </p>
            <ErrorAlert error={exportError} />
            <Button
              variant="secondary"
              loading={exporting}
              onClick={async () => {
                setExporting(true);
                setExportError(null);
                try {
                  await downloadJson(`/patients/${id}/export`, 'my-medical-record.json');
                } catch (err) {
                  setExportError(err);
                } finally {
                  setExporting(false);
                }
              }}
            >
              {t('Download (JSON)')}
            </Button>{' '}
            <Button
              variant="secondary"
              onClick={async () => {
                setExportError(null);
                try {
                  await downloadFile(`/fhir/Patient/${id}/$everything`, 'my-record.fhir.json');
                } catch (err) {
                  setExportError(err);
                }
              }}
            >
              {t('Download for another provider (HL7 FHIR)')}
            </Button>
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              {t(
                'FHIR is the international standard format other hospitals and health apps can import.',
              )}
            </p>
          </Card>
        )}

        {acting ? (
          <Alert tone="info">
            {t('Your own sign-in, two-step and email settings are under')}{' '}
            <strong>{t('My details')}</strong> {t('when you switch back to your own record.')}
          </Alert>
        ) : (
          <>
            <TwoStepCard />
            <EmailPreferencesCard />
            <SmsCard />
            <ChangePasswordCard />
          </>
        )}
        <Alert tone="neutral">
          {t('Signing in on a shared computer? Always sign out when you finish.')}
        </Alert>
      </div>
    </>
  );
}
