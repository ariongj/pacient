import { t } from '../../i18n';
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
import { formatDate, formatDateTime, humanize } from '../../format';
import { stateLabel, stateTone, type LicenceState } from '../../api/licences';

type StaffRole = StaffMember['role'];
/** Staff rows carry the state of the linked professional licence (clinical staff only). */
type StaffRow = StaffMember & {
  licence?: {
    licenceNumber: string | null;
    state: LicenceState;
    validUntil: string | null;
  } | null;
};

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
      <Alert tone="success" title={t('{name} has been invited.', { name: result.user.fullName })}>
        {t('They choose their own password through a single-use activation link (valid 72 hours).')}
      </Alert>
      {result.activationUrl ? (
        <>
          <TextField
            label={t('Activation link')}
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
              {copied ? `${t('Copied')} ✓` : t('Copy link')}
            </Button>
            <span className="muted" role="status">
              {t('Development only — in production the link is delivered by email.')}
            </span>
          </div>
        </>
      ) : (
        <p className="muted">
          {t('The activation link has been sent to {email}.', { email: result.user.email })}
        </p>
      )}
    </div>
  );
}

function InviteForm({ onClose }: { onClose: () => void }) {
  const user = useUser();
  const qc = useQueryClient();
  const isMinistry = user.role === 'MINISTRY';
  const roleOptions: StaffRole[] = isMinistry
    ? ['DIRECTOR', 'MINISTRY']
    : ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'LAB_TECHNICIAN', 'IT_SUPPORT', 'DIRECTOR'];
  const [role, setRole] = useState<StaffRole>(roleOptions[0]!);
  const licensed = role === 'DOCTOR' || role === 'NURSE' || role === 'PHARMACIST';
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
          <Button onClick={onClose}>{t('Done')}</Button>
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
      ...(licensed ? { licenseNumber: v.licenseNumber, specialty: v.specialty || null } : {}),
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <SelectField
          label={t('Role')}
          name="role"
          required
          value={role}
          onChange={(e) => setRole(e.target.value as StaffRole)}
          options={roleOptions.map((r) => ({ value: r, label: humanize(r) }))}
        />
        <TextField
          label={t('Full name')}
          name="fullName"
          required
          minLength={2}
          autoComplete="off"
        />
        <TextField label={t('Email')} name="email" type="email" required autoComplete="off" />
        {role === 'LAB_TECHNICIAN' && (
          <p className="muted" style={{ gridColumn: '1 / -1' }}>
            {t(
              'Laboratory technicians work the laboratory worklist of this facility: specimens, result entry and validation. They cannot open patient records.',
            )}
          </p>
        )}
        {role === 'IT_SUPPORT' && (
          <p className="muted" style={{ gridColumn: '1 / -1' }}>
            {t(
              'IT support handles account and access requests of this facility. They never see patient data, and role changes stay with the director.',
            )}
          </p>
        )}
        {isMinistry && role === 'DIRECTOR' && (
          <SelectField
            label={t('Facility')}
            name="facilityId"
            required
            placeholder={facilities.isPending ? t('Loading facilities…') : t('Select a facility')}
            options={(facilities.data?.items ?? []).map((f) => ({
              value: f.id,
              label: `${f.name} (${f.code})`,
            }))}
          />
        )}
        {licensed && (
          <>
            <TextField
              label={t('Professional licence number')}
              name="licenseNumber"
              required
              maxLength={60}
            />
            <TextField
              label={t('Specialty')}
              name="specialty"
              maxLength={120}
              placeholder={
                role === 'DOCTOR'
                  ? t('e.g. Family Medicine')
                  : role === 'NURSE'
                    ? t('e.g. Registered Nurse')
                    : t('e.g. Hospital Pharmacist')
              }
            />
          </>
        )}
      </div>
      {!isMinistry && (
        <p className="muted">
          {t('Staff you invite are added to {facility}.', {
            facility: user.facility?.name ?? t('your facility'),
          })}
        </p>
      )}
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Send invitation')}
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
      title={deactivating ? t('Deactivate account') : t('Reactivate account')}
    >
      {member && (
        <div className="stack">
          {deactivating ? (
            <p>
              {t(
                'Deactivating {name} blocks access immediately: all active sessions are revoked and they can no longer sign in. Their past records and audit history are preserved.',
                { name: member.fullName },
              )}
            </p>
          ) : (
            <p>
              {t('Reactivating {name} lets them sign in again with their existing password.', {
                name: member.fullName,
              })}
            </p>
          )}
          <ErrorAlert error={mutation.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              variant={deactivating ? 'danger' : 'primary'}
              loading={mutation.isPending}
              onClick={() => mutation.mutate(member)}
            >
              {deactivating ? t('Deactivate') : t('Reactivate')}
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
    isMinistry
      ? [
          'MINISTRY',
          'DIRECTOR',
          'DOCTOR',
          'NURSE',
          'PHARMACIST',
          'RECEPTION',
          'LAB_TECHNICIAN',
          'IT_SUPPORT',
        ]
      : ['DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'LAB_TECHNICIAN', 'IT_SUPPORT']
  ).map((r) => ({
    value: r,
    label: humanize(r),
  }));

  return (
    <>
      <PageHeader
        title={isMinistry ? t('Directors & officials') : t('Staff')}
        subtitle={
          isMinistry
            ? t('Appoint facility directors and Ministry officials')
            : t('Clinical and management staff of {facility}', {
                facility: user.facility?.name ?? t('your facility'),
              })
        }
        actions={<Button onClick={() => setInviting(true)}>{t('Invite staff member')}</Button>}
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
            label={t('Search name or email')}
            name="search"
            type="search"
            defaultValue={filters.search}
          />
          <SelectField
            label={t('Role')}
            name="role"
            placeholder={t('All roles')}
            options={roleFilterOptions}
            defaultValue={filters.role}
          />
          {isMinistry && (
            <SelectField
              label={t('Facility')}
              name="facilityId"
              placeholder={t('All facilities')}
              defaultValue={filters.facilityId}
              options={(facilities.data?.items ?? []).map((f) => ({ value: f.id, label: f.name }))}
            />
          )}
          <Button type="submit" variant="secondary">
            {t('Filter')}
          </Button>
        </form>
        <QueryView query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title={t('No staff found')} />
            ) : (
              <>
                <Table caption={t('Staff members')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Name')}</th>
                      <th scope="col">{t('Role')}</th>
                      <th scope="col">{t('Facility')}</th>
                      <th scope="col">{t('Specialty / license')}</th>
                      <th scope="col">{t('Status')}</th>
                      <th scope="col">{t('Last sign-in')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.items as StaffRow[]).map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.fullName}</strong>
                          {m.id === user.id && <span className="muted"> {t('(you)')}</span>}
                          <div className="muted">{m.email}</div>
                        </td>
                        <td>{humanize(m.role)}</td>
                        <td>{m.facilityName ?? '—'}</td>
                        <td>
                          {m.specialty ? t(m.specialty) : '—'}
                          {m.licenseNumber && (
                            <div>
                              <code>{m.licenseNumber}</code>
                            </div>
                          )}
                          {m.licence && (
                            <div>
                              <Badge tone={stateTone(m.licence.state)}>
                                {stateLabel(m.licence.state)}
                              </Badge>
                              {m.licence.validUntil && m.licence.state !== 'MISSING' && (
                                <span className="muted">
                                  {' '}
                                  {t('until {date}', { date: formatDate(m.licence.validUntil) })}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="row">
                            {m.isActive ? (
                              <Badge tone="success">{t('Active')}</Badge>
                            ) : (
                              <Badge tone="danger">{t('Deactivated')}</Badge>
                            )}
                            {!m.activated && (
                              <Badge tone="warning">{t('Invitation pending')}</Badge>
                            )}
                          </div>
                        </td>
                        <td>{formatDateTime(m.lastLoginAt)}</td>
                        <td>
                          {manageable(m) && (
                            <Button
                              size="sm"
                              variant={m.isActive ? 'secondary' : 'ghost'}
                              onClick={() => setStatusTarget(m)}
                              aria-label={`${m.isActive ? t('Deactivate') : t('Reactivate')} ${m.fullName}`}
                            >
                              {m.isActive ? t('Deactivate') : t('Reactivate')}
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

      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        title={t('Invite staff member')}
        wide
      >
        <InviteForm onClose={() => setInviting(false)} />
      </Dialog>
      <StatusDialog member={statusTarget} onClose={() => setStatusTarget(null)} />
    </>
  );
}
