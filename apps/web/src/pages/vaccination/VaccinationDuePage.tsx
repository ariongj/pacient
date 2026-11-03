import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import {
  ageFromDob,
  DOSE_STATE_TONE,
  doseName,
  doseStateLabel,
  VACCINATION_KEY,
  type DueList,
} from '../../api/vaccination';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, fullName } from '../../format';
import { t } from '../../i18n';
import './vaccination.css';

type Filter = '' | 'OVERDUE' | 'DUE' | 'UPCOMING';

/**
 * Children registered at the facility with vaccinations overdue, due now or coming up – the
 * nurse's and front desk's list for calling families and booking vaccination appointments.
 */
export function VaccinationDuePage() {
  const user = useUser();
  const [status, setStatus] = useState<Filter>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: [...VACCINATION_KEY, 'due', { status, q, page }],
    queryFn: () =>
      api<DueList>('/vaccination/due', {
        query: { ...(status ? { status } : {}), ...(q ? { q } : {}), page, pageSize: 25 },
      }),
  });
  const chartBase =
    user.role === 'DOCTOR' ? '/doctor/patients' : user.role === 'NURSE' ? '/nurse/patients' : null;

  return (
    <>
      <PageHeader
        title={t('Vaccinations due')}
        subtitle={t('Children registered at {facility} who need a vaccination.', {
          facility: user.facility?.name ?? '',
        })}
      />
      <Card>
        <div className="form-grid">
          <SelectField
            label={t('Show')}
            value={status}
            onChange={(e) => {
              setStatus(e.currentTarget.value as Filter);
              setPage(1);
            }}
            options={[
              { value: '', label: t('Overdue, due now and next 14 days') },
              { value: 'OVERDUE', label: t('Overdue') },
              { value: 'DUE', label: t('Due now') },
              { value: 'UPCOMING', label: t('Next 14 days') },
            ]}
          />
          <TextField
            label={t('Search child')}
            placeholder={t('Name or national ID')}
            value={q}
            onChange={(e) => {
              setQ(e.currentTarget.value);
              setPage(1);
            }}
          />
        </div>
      </Card>
      <QueryView query={list}>
        {(data) => (
          <div className="stack">
            <Grid min={160}>
              <Stat label={t('Children')} value={data.counts.children} />
              <Stat
                label={t('With overdue doses')}
                value={data.counts.overdue}
                tone={data.counts.overdue ? 'danger' : undefined}
              />
              <Stat
                label={t('Due now')}
                value={data.counts.due}
                tone={data.counts.due ? 'warning' : undefined}
              />
              <Stat label={t('Coming up')} value={data.counts.upcoming} />
            </Grid>
            <Card>
              {data.items.length === 0 ? (
                <EmptyState title={t('No children need a vaccination')} />
              ) : (
                <Table caption={t('Vaccinations due')}>
                  <thead>
                    <tr>
                      <th>{t('Child')}</th>
                      <th>{t('Age')}</th>
                      <th>{t('Doses')}</th>
                      <th>{t('Contact')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((c) => (
                      <tr key={c.patient.id}>
                        <td>
                          <strong>{fullName(c.patient)}</strong>
                          <div className="muted mono">{c.patient.nationalId}</div>
                        </td>
                        <td>
                          {ageFromDob(c.patient.dateOfBirth)}
                          <div className="muted">{formatDate(c.patient.dateOfBirth)}</div>
                        </td>
                        <td>
                          <div className="vacc-doselist">
                            {c.doses.map((d) => (
                              <Badge key={d.scheduleItemId} tone={DOSE_STATE_TONE[d.state]}>
                                {doseName(d)} – {doseStateLabel(d.state)}
                                {d.state === 'UPCOMING' ? ` ${formatDate(d.dueDate)}` : ''}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td>
                          {c.hasGuardian ? (
                            <Badge tone="success">{t('Guardian in portal')}</Badge>
                          ) : c.hasContact ? (
                            <Badge tone="info">{t('Phone or email')}</Badge>
                          ) : (
                            <Badge tone="warning">{t('No contact details')}</Badge>
                          )}
                        </td>
                        <td>
                          {chartBase ? (
                            <Link to={`${chartBase}/${c.patient.id}?tab=vaccinations`}>
                              {t('Record dose')}
                            </Link>
                          ) : (
                            <Link to="/reception/appointments">{t('Book appointment')}</Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </Card>
          </div>
        )}
      </QueryView>
    </>
  );
}
