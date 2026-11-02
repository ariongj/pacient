import { t } from '../../i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { CareTeamMember, Page, PatientListItem, StaffMember } from '../../api/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  Loading,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { age, formatDate, fullName, humanize } from '../../format';
import { GuardiansPanel } from '../shared/GuardiansPanel';
import { RegisterPatientForm } from './RegisterPatientForm';

function CareTeamDialog({
  patient,
  onClose,
}: {
  patient: PatientListItem | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const patientId = patient?.id ?? '';
  const team = useQuery({
    queryKey: ['careTeam', patientId],
    queryFn: () => api<{ items: CareTeamMember[] }>(`/patients/${patientId}/care-team`),
    enabled: Boolean(patient),
  });
  const doctors = useQuery({
    queryKey: ['staff', { role: 'DOCTOR', all: true }],
    queryFn: () => api<Page<StaffMember>>('/staff', { query: { role: 'DOCTOR', pageSize: 100 } }),
    enabled: Boolean(patient),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['careTeam', patientId] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };
  const assign = useMutation({
    mutationFn: (doctorId: string) =>
      api(`/patients/${patientId}/care-team`, { method: 'POST', body: { doctorId } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (doctorId: string) =>
      api(`/patients/${patientId}/care-team/${doctorId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const members = team.data?.items ?? [];
  const available = (doctors.data?.items ?? []).filter(
    (d) => d.isActive && !members.some((m) => m.doctorId === d.id),
  );

  function onAssign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { doctorId } = formValues(e.currentTarget);
    if (doctorId) assign.mutate(doctorId);
  }

  return (
    <Dialog
      open={patient !== null}
      onClose={onClose}
      title={patient ? `${t('Care team')} · ${fullName(patient)}` : t('Care team')}
    >
      <div className="stack">
        <p className="muted">
          {t(
            'Doctors in the care team can open this patient’s clinical record. Every change is audited and visible to the patient.',
          )}
        </p>
        {team.isPending ? (
          <Loading />
        ) : members.length === 0 ? (
          <EmptyState title={t('No doctors assigned yet')} />
        ) : (
          <ul className="list">
            {members.map((m) => (
              <li key={m.doctorId} className="row-between">
                <span>
                  <strong>{m.fullName}</strong>
                  <span className="muted">
                    {' '}
                    · {m.specialty ? t(m.specialty) : t('Doctor')} ·{' '}
                    {t('since {date}', { date: formatDate(m.startedAt) })}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={remove.isPending && remove.variables === m.doctorId}
                  onClick={() => remove.mutate(m.doctorId)}
                  aria-label={t('Remove {name} from care team', { name: m.fullName })}
                >
                  {t('Remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={onAssign}>
          <SelectField
            label={t('Assign a doctor')}
            name="doctorId"
            required
            placeholder={
              doctors.isPending
                ? t('Loading doctors…')
                : available.length
                  ? t('Select a doctor')
                  : t('No other active doctors')
            }
            options={available.map((d) => ({
              value: d.id,
              label: `${d.fullName}${d.specialty ? ` — ${t(d.specialty)}` : ''}`,
            }))}
          />
          <ErrorAlert error={assign.error ?? remove.error ?? team.error ?? doctors.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Close')}
            </Button>
            <Button type="submit" loading={assign.isPending} disabled={available.length === 0}>
              {t('Assign doctor')}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

function PortalInviteDialog({
  patient,
  onClose,
}: {
  patient: PatientListItem | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const invite = useMutation({
    mutationFn: (id: string) =>
      api<{ activationUrl?: string }>(`/patients/${id}/portal-invitation`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patients'] });
    },
  });
  const close = () => {
    invite.reset();
    onClose();
  };
  return (
    <Dialog open={patient !== null} onClose={close} title={t('Invite to patient portal')}>
      {patient && (
        <div className="stack">
          {invite.isSuccess ? (
            <>
              <Alert tone="success" title={t('Invitation created.')}>
                {t('The patient chooses their own password through a single-use link.')}
              </Alert>
              {invite.data?.activationUrl ? (
                <TextField
                  label={t('Activation link (development only — sent by email in production)')}
                  readOnly
                  value={invite.data.activationUrl}
                  onFocus={(e) => e.currentTarget.select()}
                />
              ) : (
                <p className="muted">
                  {t('The activation link was sent to the patient’s email address.')}
                </p>
              )}
              <div className="form-actions">
                <Button onClick={close}>{t('Done')}</Button>
              </div>
            </>
          ) : (
            <>
              <p>
                {t('Create an online portal account for {name}.', { name: fullName(patient) })}{' '}
                {t(
                  'The invitation goes to the email address on file; add one first if it is missing.',
                )}
              </p>
              <ErrorAlert error={invite.error} />
              <div className="form-actions">
                <Button variant="secondary" onClick={close}>
                  {t('Cancel')}
                </Button>
                <Button loading={invite.isPending} onClick={() => invite.mutate(patient.id)}>
                  {t('Send invitation')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function DirectorPatients() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [registering, setRegistering] = useState(false);
  const [careTeamFor, setCareTeamFor] = useState<PatientListItem | null>(null);
  const [inviteFor, setInviteFor] = useState<PatientListItem | null>(null);
  const [guardiansFor, setGuardiansFor] = useState<PatientListItem | null>(null);

  const query = useQuery({
    queryKey: ['patients', 'facility', search, page],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', { query: { scope: 'facility', search, page } }),
  });

  return (
    <>
      <PageHeader
        title={t('Registered patients')}
        subtitle={t(
          'Demographics and care-team assignments only — clinical records are visible to the care team',
        )}
        actions={<Button onClick={() => setRegistering(true)}>{t('Register patient')}</Button>}
      />
      <Card>
        <form
          className="search-bar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(formValues(e.currentTarget).search ?? '');
            setPage(1);
          }}
        >
          <TextField
            label={t('Search by name or national ID')}
            name="search"
            type="search"
            defaultValue={search}
          />
          <Button type="submit" variant="secondary">
            {t('Search')}
          </Button>
        </form>
        <QueryView query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title={t('No patients found')} />
            ) : (
              <>
                <p className="muted">{data.total} patients</p>
                <Table caption={t('Patients registered at this facility')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Name')}</th>
                      <th scope="col">{t('National ID')}</th>
                      <th scope="col">{t('Date of birth')}</th>
                      <th scope="col">{t('Sex')}</th>
                      <th scope="col">{t('Portal')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{fullName(p)}</strong>
                        </td>
                        <td>
                          <code>{p.nationalId}</code>
                        </td>
                        <td>
                          {formatDate(p.dateOfBirth)}{' '}
                          <span className="muted">({age(p.dateOfBirth)} y)</span>
                        </td>
                        <td>{humanize(p.sex)}</td>
                        <td>
                          {p.hasPortalAccount ? (
                            <Badge tone="success">{t('Active')}</Badge>
                          ) : (
                            <Badge>{t('None')}</Badge>
                          )}
                        </td>
                        <td>
                          <div className="row">
                            <Button size="sm" variant="secondary" onClick={() => setCareTeamFor(p)}>
                              {t('Care team')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setGuardiansFor(p)}
                            >
                              {t('Guardians')}
                            </Button>
                            {!p.hasPortalAccount && (
                              <Button size="sm" variant="ghost" onClick={() => setInviteFor(p)}>
                                {t('Invite to portal')}
                              </Button>
                            )}
                          </div>
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
        open={registering}
        onClose={() => setRegistering(false)}
        title={t('Register patient')}
        wide
      >
        <RegisterPatientForm onDone={() => setRegistering(false)} />
      </Dialog>
      <CareTeamDialog patient={careTeamFor} onClose={() => setCareTeamFor(null)} />
      <PortalInviteDialog patient={inviteFor} onClose={() => setInviteFor(null)} />
      <Dialog
        open={guardiansFor !== null}
        onClose={() => setGuardiansFor(null)}
        title={guardiansFor ? `${t('Guardians')} – ${fullName(guardiansFor)}` : t('Guardians')}
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
    </>
  );
}
