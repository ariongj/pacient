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
          label="Phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          defaultValue={patient.phone ?? ''}
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={patient.email ?? ''}
        />
        <TextField
          label="Address"
          name="address"
          autoComplete="street-address"
          defaultValue={patient.address ?? ''}
        />
        <TextField
          label="Municipality"
          name="municipality"
          defaultValue={patient.municipality ?? ''}
        />
        <TextField
          label="Emergency contact name"
          name="emergencyContactName"
          defaultValue={patient.emergencyContactName ?? ''}
        />
        <TextField
          label="Emergency contact phone"
          name="emergencyContactPhone"
          type="tel"
          defaultValue={patient.emergencyContactPhone ?? ''}
        />
      </div>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          Save
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
      title="Correction requests"
      actions={
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Request a correction
        </Button>
      }
    >
      <p className="muted">
        If something in your record looks wrong, tell your care team. A doctor reviews every
        request; your record is never changed without a clinician’s review.
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
                  <div className="muted">Submitted {formatDate(c.createdAt)}</div>
                  {c.response && (
                    <div className="addendum">
                      <strong>Response from {c.resolvedBy}</strong> ({formatDate(c.resolvedAt)}):{' '}
                      {c.response}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No correction requests" />
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title="Request a correction">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create.mutate({ section: f.get('section'), description: f.get('description') });
          }}
        >
          <SelectField
            label="Which part of your record?"
            name="section"
            required
            options={SECTIONS.map((s) => ({ value: s, label: humanize(s) }))}
          />
          <TextAreaField
            label="What should be corrected?"
            name="description"
            required
            minLength={10}
            maxLength={4000}
            hint="Describe what is wrong and what you believe is correct (at least 10 characters)."
          />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Submit request
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
        title={acting ? `${acting.firstName}’s details` : 'My details'}
        subtitle={acting ? 'You are managing these details as their guardian.' : undefined}
      />
      <div className="stack">
        <QueryView query={summary}>
          {({ patient: p }) => (
            <Card
              title="Personal information"
              actions={
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Update contact details
                </Button>
              }
            >
              <DefinitionList
                items={[
                  ['Name', `${p.firstName} ${p.lastName}`],
                  ['National ID', p.nationalId],
                  ['Date of birth', formatDate(p.dateOfBirth)],
                  ['Sex', humanize(p.sex)],
                  ['Blood type', p.bloodType === 'UNKNOWN' ? 'Unknown' : p.bloodType],
                  ['Registered at', p.primaryFacilityName],
                  ['Phone', p.phone],
                  ['Email', p.email],
                  ['Address', [p.address, p.municipality].filter(Boolean).join(', ') || null],
                  [
                    'Emergency contact',
                    p.emergencyContactName
                      ? `${p.emergencyContactName} (${p.emergencyContactPhone ?? 'no phone'})`
                      : null,
                  ],
                ]}
              />
              <p className="muted" style={{ marginTop: '1rem' }}>
                Name, date of birth and national ID can only be corrected by your facility — use a
                correction request below.
              </p>
              <Dialog
                open={editing}
                onClose={() => setEditing(false)}
                title="Update contact details"
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
          <Card title={acting ? 'Download the record' : 'Download my record'}>
            <p className="muted">
              You have the right to a copy of your health record. The download is a machine-readable
              JSON file containing your released information. Store it securely.
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
              Download (JSON)
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
              Download for another provider (HL7 FHIR)
            </Button>
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              FHIR is the international standard format other hospitals and health apps can import.
            </p>
          </Card>
        )}

        {acting ? (
          <Alert tone="info">
            Your own sign-in, two-step and email settings are under <strong>My details</strong> when
            you switch back to your own record.
          </Alert>
        ) : (
          <>
            <TwoStepCard />
            <EmailPreferencesCard />
            <ChangePasswordCard />
          </>
        )}
        <Alert tone="neutral">
          Signing in on a shared computer? Always sign out when you finish.
        </Alert>
      </div>
    </>
  );
}
