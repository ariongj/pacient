import { t, tn } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { NationalStats } from '../../api/types';
import { AnnouncementsCard } from '../../components/Announcements';
import { BarChart, monthlyBars, RankedBars } from '../../components/charts';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  Table,
} from '../../components/ui';
import { formatNumber, humanize } from '../../format';
import { OperationsPanel } from '../director/OperationsPanel';
import { NationalHospitalCard } from '../hospital/HospitalCards';

export function NationalDashboard() {
  const query = useQuery({
    queryKey: ['stats', 'national'],
    queryFn: () => api<NationalStats>('/stats/national'),
  });
  return (
    <>
      <PageHeader
        title={t('National overview')}
        subtitle={t('Health network activity across all facilities')}
      />
      <Alert tone="info" title={t('Aggregate data only.')}>
        {t('The Ministry has no access to identifiable patient records.')}
      </Alert>
      <QueryView query={query}>
        {(s) => {
          const tot = s.totals;
          const share = tot.patients ? (tot.portalUsers / tot.patients) * 100 : 0;
          // Below 1 % a rounded "0 %" would hide that anyone uses the portal.
          const adoption = share > 0 && share < 1 ? '<1' : String(Math.round(share));
          return (
            <div className="stack">
              <Grid min={180}>
                <Stat label={t('Active facilities')} value={formatNumber(tot.facilities)} />
                <Stat label={t('Registered patients')} value={formatNumber(tot.patients)} />
                <Stat
                  label={t('Portal adoption')}
                  value={`${adoption}%`}
                  hint={tn(
                    tot.portalUsers,
                    '{count} patient with a portal account',
                    '{count} patients with portal accounts',
                    { count: formatNumber(tot.portalUsers) },
                  )}
                />
                <Stat label={t('Active doctors')} value={formatNumber(tot.doctors)} />
                <Stat label={t('Encounters (30 days)')} value={formatNumber(tot.encounters30d)} />
                <Stat
                  label={t('Emergency access (30 days)')}
                  value={formatNumber(tot.emergencyAccess30d)}
                  tone={tot.emergencyAccess30d > 0 ? 'danger' : undefined}
                  hint={
                    tot.emergencyAccess30d > 0 ? (
                      <Link to="/ministry/audit?action=care.emergency_access.granted">
                        {t('Review events')}
                      </Link>
                    ) : (
                      t('Break-glass record openings')
                    )
                  }
                />
              </Grid>

              <div className="two-col">
                <Card title={t('Encounters by month (national)')}>
                  <BarChart
                    title={t('National encounters per month, last 12 months')}
                    data={monthlyBars(s.encountersByMonth)}
                  />
                </Card>
                <Card title={t('Top diagnoses (patients, 12 months)')}>
                  {s.topDiagnoses.length === 0 ? (
                    <EmptyState title={t('No diagnoses recorded')} />
                  ) : (
                    <>
                      <RankedBars
                        label={t('Top diagnoses nationally')}
                        rows={s.topDiagnoses.map((d) => ({
                          key: d.icd10Code,
                          label: d.description,
                          sublabel: d.icd10Code,
                          value: d.count,
                          suppressed: d.suppressed,
                        }))}
                      />
                      <p className="muted">
                        {t('Counts below {n} are hidden to protect patient privacy.', {
                          n: s.smallCellThreshold,
                        })}
                      </p>
                    </>
                  )}
                </Card>
              </div>

              <Card title={t('By region')}>
                <Table caption={t('Facilities, patients and encounters by region')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Region')}</th>
                      <th scope="col" className="num">
                        {t('Facilities')}
                      </th>
                      <th scope="col" className="num">
                        {t('Patients')}
                      </th>
                      <th scope="col" className="num">
                        {t('Encounters (30d)')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byRegion.map((r) => (
                      <tr key={r.region}>
                        <th scope="row">{r.region}</th>
                        <td className="num">{formatNumber(r.facilities)}</td>
                        <td className="num">{formatNumber(r.patients)}</td>
                        <td className="num">{formatNumber(r.encounters30d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>

              <Card title={t('Facilities')}>
                <Table caption={t('Activity per facility')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Facility')}</th>
                      <th scope="col">{t('Type')}</th>
                      <th scope="col">{t('Region')}</th>
                      <th scope="col">{t('Director')}</th>
                      <th scope="col" className="num">
                        {t('Patients')}
                      </th>
                      <th scope="col" className="num">
                        {t('Doctors')}
                      </th>
                      <th scope="col" className="num">
                        {t('Encounters (30d)')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byFacility.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <Link to={`/ministry/facilities/${f.id}`}>{f.name}</Link>{' '}
                          <code>{f.code}</code>
                          {!f.isActive && (
                            <>
                              {' '}
                              <Badge>{t('Inactive')}</Badge>
                            </>
                          )}
                        </td>
                        <td>{humanize(f.type)}</td>
                        <td>{f.region}</td>
                        <td>
                          {f.directorName ?? <Badge tone="warning">{t('No director')}</Badge>}
                        </td>
                        <td className="num">{formatNumber(f.patients)}</td>
                        <td className="num">{formatNumber(f.doctors)}</td>
                        <td className="num">{formatNumber(f.encounters30d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          );
        }}
      </QueryView>
      <div className="stack" style={{ marginTop: '1rem' }}>
        <NationalHospitalCard />
        <OperationsPanel reportsPath="/ministry/reports" />
        <Grid min={260}>
          <Card title={t('Emergency access oversight')}>
            <p className="muted">
              {t(
                'Break-glass use and how promptly facilities review it, without identifiable data.',
              )}
            </p>
            <Link to="/ministry/emergency-access">{t('Open oversight')}</Link>
          </Card>
          <Card title={t('Reports')}>
            <p className="muted">
              {t(
                'Eight aggregate reports – activity, diseases, medicines, pharmacy, vaccinations, referrals, appointments and workforce – with charts, CSV and print.',
              )}
            </p>
            <Link to="/ministry/reports">{t('Open reports')}</Link>
          </Card>
          <Card title={t('Team channels')}>
            <p className="muted">{t('Coordinate with facility directors in national channels.')}</p>
            <Link to="/channels">{t('Open channels')}</Link>
          </Card>
          <Card title={t('Announcements')}>
            <p className="muted">{t('Publish national notices to staff and patients.')}</p>
            <Link to="/ministry/announcements">{t('Manage announcements')}</Link>
          </Card>
        </Grid>
        <AnnouncementsCard />
      </div>
    </>
  );
}
