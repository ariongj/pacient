import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { PatientWithPortal } from '../../api/patients';
import type { Page, PatientListItem } from '../../api/types';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  Pagination,
  QueryView,
  Table,
  TextField,
} from '../../components/ui';
import { age, formatDate, fullName, humanize } from '../../format';
import { GuardiansPanel } from '../shared/GuardiansPanel';
import {
  PortalActions,
  PortalBadge,
  PortalInviteDialog,
  TwoStepResetDialog,
} from '../shared/PortalAccount';
import { BookAppointmentDialog, type PatientRef } from './BookAppointmentDialog';
import { t } from '../../i18n';
import { UnknownPatientDialog } from '../births/IdentityDialogs';

interface PatientDetail {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  municipality: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  hasPortalAccount: boolean;
}

const CONTACT_FIELDS: { name: keyof PatientDetail; label: string; type?: string }[] = [
  { name: 'phone', label: 'Phone', type: 'tel' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'address', label: 'Address' },
  { name: 'municipality', label: 'Municipality' },
  { name: 'emergencyContactName', label: 'Emergency contact name' },
  { name: 'emergencyContactPhone', label: 'Emergency contact phone', type: 'tel' },
];

function ContactDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['patient', patientId, 'demographics'],
    queryFn: () => api<PatientDetail>(`/patients/${patientId}`),
  });
  const mutation = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      api(`/patients/${patientId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patient', patientId] });
      queryClient.invalidateQueries({ queryKey: ['patients'] });
      onClose();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, string | null> = {};
    for (const { name } of CONTACT_FIELDS) {
      const v = String(f.get(name) ?? '').trim();
      body[name] = v === '' ? null : v;
    }
    mutation.mutate(body);
  }

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const p = q.data;
  return (
    <form onSubmit={onSubmit}>
      <p>
        <strong>{fullName(p)}</strong>
      </p>
      <div className="form-grid">
        {CONTACT_FIELDS.map((f) => (
          <TextField
            key={f.name}
            label={t(f.label)}
            name={f.name}
            type={f.type ?? 'text'}
            defaultValue={(p[f.name] as string | null) ?? ''}
          />
        ))}
      </div>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Save')}
        </Button>
      </div>
    </form>
  );
}

export function ReceptionPatients() {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [inviting, setInviting] = useState<PatientWithPortal | null>(null);
  const [twoStepFor, setTwoStepFor] = useState<PatientWithPortal | null>(null);
  const [booking, setBooking] = useState<PatientRef | null>(null);
  const [guardiansFor, setGuardiansFor] = useState<PatientListItem | null>(null);
  const [registeringUnknown, setRegisteringUnknown] = useState(false);

  const q = useQuery({
    queryKey: ['patients', 'facility', submitted, page],
    queryFn: () =>
      api<Page<PatientWithPortal>>('/patients', {
        query: { scope: 'facility', search: submitted || undefined, page, pageSize: 20 },
      }),
  });

  return (
    <>
      <PageHeader
        title={t('Patients')}
        subtitle={t('Registration and contact details for patients of your facility')}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRegisteringUnknown(true)}>
              {t('Register unknown patient')}
            </Button>
            <Link to="/reception/patients/new" className="btn btn-primary btn-md">
              {t('Register patient')}
            </Link>
          </>
        }
      />
      <UnknownPatientDialog
        open={registeringUnknown}
        onClose={() => setRegisteringUnknown(false)}
      />
      <Alert tone="info">
        {t(
          'Reception works with identity, contact details and scheduling only. Clinical information is not available in this workspace.',
        )}
      </Alert>
      <Card>
        <form
          className="search-bar"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(search.trim());
            setPage(1);
          }}
        >
          <TextField
            label={t('Search')}
            hint={t('Name or national ID')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            {t('Search')}
          </Button>
        </form>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <>
                <Table caption={t('Registered patients')}>
                  <thead>
                    <tr>
                      <th>{t('Name')}</th>
                      <th>{t('National ID')}</th>
                      <th>{t('Date of birth')}</th>
                      <th>{t('Sex')}</th>
                      <th>{t('Portal')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>
                            {p.temporaryIdentity === 'UNIDENTIFIED'
                              ? fullName(p)
                              : `${p.lastName}, ${p.firstName}`}
                          </strong>
                        </td>
                        <td className="mono">{p.nationalId}</td>
                        <td>
                          {formatDate(p.dateOfBirth)}{' '}
                          <span className="muted">
                            ({t('{age} y', { age: age(p.dateOfBirth) })})
                          </span>
                        </td>
                        <td>{humanize(p.sex)}</td>
                        <td>
                          <PortalBadge patient={p} />
                        </td>
                        <td>
                          <div className="row">
                            <Button
                              size="sm"
                              onClick={() =>
                                setBooking({ id: p.id, name: `${p.firstName} ${p.lastName}` })
                              }
                            >
                              {t('Book')}
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setEditing(p.id)}>
                              {t('Edit contact')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setGuardiansFor(p)}
                            >
                              {t('Guardians')}
                            </Button>
                            <PortalActions
                              patient={p}
                              onInvite={() => setInviting(p)}
                              onResetTwoStep={() => setTwoStepFor(p)}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
              </>
            ) : (
              <EmptyState title={t('No patients found')}>
                <Link to="/reception/patients/new">{t('Register a new patient')}</Link>
              </EmptyState>
            )
          }
        </QueryView>
      </Card>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('Edit contact details')}
        wide
      >
        {editing && <ContactDialog patientId={editing} onClose={() => setEditing(null)} />}
      </Dialog>
      <PortalInviteDialog patient={inviting} onClose={() => setInviting(null)} />
      <TwoStepResetDialog patient={twoStepFor} onClose={() => setTwoStepFor(null)} />
      <Dialog
        open={guardiansFor !== null}
        onClose={() => setGuardiansFor(null)}
        title={
          guardiansFor
            ? t('Guardians – {name}', {
                name: `${guardiansFor.firstName} ${guardiansFor.lastName}`,
              })
            : t('Guardians')
        }
        wide
      >
        {guardiansFor && (
          <GuardiansPanel
            patientId={guardiansFor.id}
            patientDateOfBirth={guardiansFor.dateOfBirth}
            canManage
          />
        )}
      </Dialog>
      <BookAppointmentDialog
        open={booking !== null}
        onClose={() => setBooking(null)}
        patient={booking ?? undefined}
      />
    </>
  );
}
