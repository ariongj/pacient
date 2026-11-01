import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { Facility, Page, StaffMember } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatDateTime, humanize } from '../../format';

type StaffRole = StaffMember['role'];

interface InviteResult {
  user: { id: string; email: string; fullName: string; role: StaffRole; facilityId: string | null };
  activationUrl?: string;
}

function useFacilities(enabled: boolean) {
  return useQuery({
    queryKey: ['facilities', { search: '', includeInactive: false }],
    queryFn: () => api<{ items: Facility[] }>('/facilities'),
    enabled,
  });
}

function ActivationLink({ result }: { result: InviteResult }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack">
      <Alert tone="success" title={`${result.user.fullName} has been invited.`}>
        They choose their own password through a single-use activation link (valid 72 hours).
      </Alert>
      {result.activationUrl ? (
        <>
          <TextField
            label="Activation link"
            readOnly
            value={result.activationUrl}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="row">
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(result.activationUrl!);
                setCopied(true);
              }}
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
            <span className="muted" role="status">
              Development only — in production the link is delivered by email.
            </span>
          </div>
        </>
      ) : (
        <p className="muted">The activation link has been sent to {result.user.email}.</p>
      )}
    </div>
  );
}

function InviteForm({ onClose }: { onClose: () => void }) {
  const user = useUser();
  const qc = useQueryClient();
  const isMinistry = user.role === 'MINISTRY';
  const roleOptions: StaffRole[] = isMinistry ? ['DIRECTOR', 'MINISTRY'] : ['DOCTOR', 'DIRECTOR'];
  const [role, setRole] = useState<StaffRole>(roleOptions[0]!);
  const facilities = useFacilities(isMinistry);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<InviteResult>('/staff/invitations', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff'] });
    },
  });

  if (mutation.data) {
    return (
      <div className="stack">
        <ActivationLink result={mutation.data} />
        <div className="form-actions">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    mutation.mutate({
      email: v.email,
      fullName: v.fullName,
      role,
      ...(isMinistry && role === 'DIRECTOR' ? { facilityId: v.facilityId } : {}),
      ...(role === 'DOCTOR'
        ? { licenseNumber: v.licenseNumber, specialty: v.specialty || null }
        : {}),
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <SelectField
          label="Role"
          name="role"
          required
          value={role}
          onChange={(e) => setRole(e.target.value as StaffRole)}
          options={roleOptions.map((r) => ({ value: r, label: humanize(r) }))}
        />
        <TextField label="Full name" name="fullName" required minLength={2} autoComplete="off" />
        <TextField label="Email" name="email" type="email" required autoComplete="off" />
        {isMinistry && role === 'DIRECTOR' && (
          <SelectField
            label="Facility"
            name="facilityId"
            required
            placeholder={facilities.isPending ? 'Loading facilities…' : 'Select a facility'}
            options={(facilities.data?.items ?? []).map((f) => ({
              value: f.id,
              label: `${f.name} (${f.code})`,
            }))}
          />
        )}
        {role === 'DOCTOR' && (
          <>
            <TextField
              label="Medical license number"
              name="licenseNumber"
              required
              maxLength={60}
            />
            <TextField
              label="Specialty"
              name="specialty"
              maxLength={120}
              placeholder="e.g. Family Medicine"
            />
          </>
        )}
      </div>
      {!isMinistry && (
        <p className="muted">
          Staff you invite are added to {user.facility?.name ?? 'your facility'}.
        </p>
      )}
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          Send invitation
        </Button>
      </div>
    </form>
  );
}

function StatusDialog({ member, onClose }: { member: StaffMember | null; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (m: StaffMember) =>
      api(`/staff/${m.id}/status`, { method: 'PATCH', body: { isActive: !m.isActive } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
  });
  const deactivating = member?.isActive ?? false;
  return (
    <Dialog
      open={member !== null}
      onClose={() => {
        mutation.reset();
        onClose();
      }}
      title={deactivating ? 'Deactivate account' : 'Reactivate account'}
    >
      {member && (
        <div className="stack">
          {deactivating ? (
            <p>
              Deactivating <strong>{member.fullName}</strong> blocks access immediately: all active
              sessions are revoked and they can no longer sign in. Their past records and audit
              history are preserved.
            </p>
          ) : (
            <p>
              Reactivating <strong>{member.fullName}</strong> lets them sign in again with their
              existing password.
            </p>
          )}
          <ErrorAlert error={mutation.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={deactivating ? 'danger' : 'primary'}
              loading={mutation.isPending}
              onClick={() => mutation.mutate(member)}
            >
              {deactivating ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function StaffPage() {
  const user = useUser();
  const isMinistry = user.role === 'MINISTRY';
  const [filters, setFilters] = useState({ role: '', search: '', facilityId: '' });
  const [page, setPage] = useState(1);
  const [inviting, setInviting] = useState(false);
  const [statusTarget, setStatusTarget] = useState<StaffMember | null>(null);
  const facilities = useFacilities(isMinistry);

  const query = useQuery({
    queryKey: ['staff', filters, page],
    queryFn: () =>
      api<Page<StaffMember>>('/staff', {
        query: {
          role: filters.role,
          search: filters.search,
          facilityId: isMinistry ? filters.facilityId : undefined,
          page,
        },
      }),
  });

  const manageable = (m: StaffMember) =>
    m.id !== user.id &&
    (isMinistry ? m.role === 'MINISTRY' || m.role === 'DIRECTOR' : m.role !== 'MINISTRY');

  const roleFilterOptions = (
    isMinistry ? ['MINISTRY', 'DIRECTOR', 'DOCTOR'] : ['DIRECTOR', 'DOCTOR']
  ).map((r) => ({
    value: r,
    label: humanize(r),
  }));

  return (
    <>
      <PageHeader
        title={isMinistry ? 'Directors & officials' : 'Staff'}
        subtitle={
          isMinistry
            ? 'Appoint facility directors and Ministry officials'
            : `Clinical and management staff of ${user.facility?.name ?? 'your facility'}`
        }
        actions={<Button onClick={() => setInviting(true)}>Invite staff member</Button>}
      />
      <Card>
        <form
          className="search-bar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const v = formValues(e.currentTarget);
            setFilters({
              role: v.role ?? '',
              search: v.search ?? '',
              facilityId: v.facilityId ?? '',
            });
            setPage(1);
          }}
        >
          <TextField
            label="Search name or email"
            name="search"
            type="search"
            defaultValue={filters.search}
          />
          <SelectField
            label="Role"
            name="role"
            placeholder="All roles"
            options={roleFilterOptions}
            defaultValue={filters.role}
          />
          {isMinistry && (
            <SelectField
              label="Facility"
              name="facilityId"
              placeholder="All facilities"
              defaultValue={filters.facilityId}
              options={(facilities.data?.items ?? []).map((f) => ({ value: f.id, label: f.name }))}
            />
          )}
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
        <QueryView query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title="No staff found" />
            ) : (
              <>
                <Table caption="Staff members">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Role</th>
                      <th scope="col">Facility</th>
                      <th scope="col">Specialty / license</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last sign-in</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.fullName}</strong>
                          {m.id === user.id && <span className="muted"> (you)</span>}
                          <div className="muted">{m.email}</div>
                        </td>
                        <td>{humanize(m.role)}</td>
                        <td>{m.facilityName ?? '—'}</td>
                        <td>
                          {m.specialty ?? '—'}
                          {m.licenseNumber && (
                            <div>
                              <code>{m.licenseNumber}</code>
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="row">
                            {m.isActive ? (
                              <Badge tone="success">Active</Badge>
                            ) : (
                              <Badge tone="danger">Deactivated</Badge>
                            )}
                            {!m.activated && <Badge tone="warning">Invitation pending</Badge>}
                          </div>
                        </td>
                        <td>{formatDateTime(m.lastLoginAt)}</td>
                        <td>
                          {manageable(m) && (
                            <Button
                              size="sm"
                              variant={m.isActive ? 'secondary' : 'ghost'}
                              onClick={() => setStatusTarget(m)}
                              aria-label={`${m.isActive ? 'Deactivate' : 'Reactivate'} ${m.fullName}`}
                            >
                              {m.isActive ? 'Deactivate' : 'Reactivate'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
              </>
            )
          }
        </QueryView>
      </Card>

      <Dialog open={inviting} onClose={() => setInviting(false)} title="Invite staff member" wide>
        <InviteForm onClose={() => setInviting(false)} />
      </Dialog>
      <StatusDialog member={statusTarget} onClose={() => setStatusTarget(null)} />
    </>
  );
}
