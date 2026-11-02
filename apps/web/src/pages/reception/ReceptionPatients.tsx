import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Page, PatientListItem } from '../../api/types';
import {
  Alert,
  Badge,
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
import { age, formatDate, humanize } from '../../format';
import { BookAppointmentDialog, type PatientRef } from './BookAppointmentDialog';

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
        <strong>
          {p.firstName} {p.lastName}
        </strong>
      </p>
      <div className="form-grid">
        {CONTACT_FIELDS.map((f) => (
          <TextField
            key={f.name}
            label={f.label}
            name={f.name}
            type={f.type ?? 'text'}
            defaultValue={(p[f.name] as string | null) ?? ''}
          />
        ))}
      </div>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

function InviteDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      api<{ activationUrl?: string }>(`/patients/${patientId}/portal-invitation`, {
        method: 'POST',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['patients'] }),
  });
  return (
    <div className="stack">
      {mutation.isSuccess ? (
        <Alert tone="success" title="Portal invitation created">
          {mutation.data.activationUrl ? (
            <>
              <p>
                Activation link (development only – in production it is sent to the patient by
                email):
              </p>
              <code style={{ wordBreak: 'break-all' }}>{mutation.data.activationUrl}</code>
            </>
          ) : (
            <p>The patient will receive an email with a link to activate the account.</p>
          )}
        </Alert>
      ) : (
        <>
          <p>
            The patient receives a single-use link to set their own password. An email address must
            be on file.
          </p>
          <ErrorAlert error={mutation.error} />
        </>
      )}
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {mutation.isSuccess ? 'Close' : 'Cancel'}
        </Button>
        {!mutation.isSuccess && (
          <Button loading={mutation.isPending} onClick={() => mutation.mutate()}>
            Send invitation
          </Button>
        )}
      </div>
    </div>
  );
}

export function ReceptionPatients() {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);
  const [booking, setBooking] = useState<PatientRef | null>(null);

  const q = useQuery({
    queryKey: ['patients', 'facility', submitted, page],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', {
        query: { scope: 'facility', search: submitted || undefined, page, pageSize: 20 },
      }),
  });

  return (
    <>
      <PageHeader
        title="Patients"
        subtitle="Registration and contact details for patients of your facility"
        actions={
          <Link to="/reception/patients/new" className="btn btn-primary btn-md">
            Register patient
          </Link>
        }
      />
      <Alert tone="info">
        Reception works with identity, contact details and scheduling only. Clinical information is
        not available in this workspace.
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
            label="Search"
            hint="Name or national ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <>
                <Table caption="Registered patients">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>National ID</th>
                      <th>Date of birth</th>
                      <th>Sex</th>
                      <th>Portal</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>
                            {p.lastName}, {p.firstName}
                          </strong>
                        </td>
                        <td className="mono">{p.nationalId}</td>
                        <td>
                          {formatDate(p.dateOfBirth)}{' '}
                          <span className="muted">({age(p.dateOfBirth)} y)</span>
                        </td>
                        <td>{humanize(p.sex)}</td>
                        <td>
                          {p.hasPortalAccount ? (
                            <Badge tone="success">Active</Badge>
                          ) : (
                            <Badge tone="neutral">None</Badge>
                          )}
                        </td>
                        <td>
                          <div className="row">
                            <Button
                              size="sm"
                              onClick={() =>
                                setBooking({ id: p.id, name: `${p.firstName} ${p.lastName}` })
                              }
                            >
                              Book
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setEditing(p.id)}>
                              Edit contact
                            </Button>
                            {!p.hasPortalAccount && (
                              <Button size="sm" variant="ghost" onClick={() => setInviting(p.id)}>
                                Invite to portal
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
              </>
            ) : (
              <EmptyState title="No patients found">
                <Link to="/reception/patients/new">Register a new patient</Link>
              </EmptyState>
            )
          }
        </QueryView>
      </Card>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit contact details"
        wide
      >
        {editing && <ContactDialog patientId={editing} onClose={() => setEditing(null)} />}
      </Dialog>
      <Dialog
        open={inviting !== null}
        onClose={() => setInviting(null)}
        title="Invite to patient portal"
      >
        {inviting && <InviteDialog patientId={inviting} onClose={() => setInviting(null)} />}
      </Dialog>
      <BookAppointmentDialog
        open={booking !== null}
        onClose={() => setBooking(null)}
        patient={booking ?? undefined}
      />
    </>
  );
}
