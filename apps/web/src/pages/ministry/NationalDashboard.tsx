import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { NationalStats } from '../../api/types';
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

export function NationalDashboard() {
  const query = useQuery({
    queryKey: ['stats', 'national'],
    queryFn: () => api<NationalStats>('/stats/national'),
  });
  return (
    <>
      <PageHeader
        title="National overview"
        subtitle="Health network activity across all facilities"
      />
      <Alert tone="info" title="Aggregate data only.">
        The Ministry has no access to identifiable patient records.
      </Alert>
      <QueryView query={query}>
        {(s) => {
          const t = s.totals;
          const adoption = t.patients ? Math.round((t.portalUsers / t.patients) * 100) : 0;
          return (
            <div className="stack">
              <Grid min={180}>
                <Stat label="Active facilities" value={formatNumber(t.facilities)} />
                <Stat label="Registered patients" value={formatNumber(t.patients)} />
                <Stat
                  label="Portal adoption"
                  value={`${adoption}%`}
                  hint={`${formatNumber(t.portalUsers)} patients with portal accounts`}
                />
                <Stat label="Active doctors" value={formatNumber(t.doctors)} />
                <Stat label="Encounters (30 days)" value={formatNumber(t.encounters30d)} />
                <Stat
                  label="Emergency access (30 days)"
                  value={formatNumber(t.emergencyAccess30d)}
                  tone={t.emergencyAccess30d > 0 ? 'danger' : undefined}
                  hint={
                    t.emergencyAccess30d > 0 ? (
                      <Link to="/ministry/audit?action=care.emergency_access.granted">
                        Review events
                      </Link>
                    ) : (
                      'Break-glass record openings'
                    )
                  }
                />
              </Grid>

              <div className="two-col">
                <Card title="Encounters by month (national)">
                  <BarChart
                    title="National encounters per month, last 12 months"
                    data={monthlyBars(s.encountersByMonth)}
                  />
                </Card>
                <Card title="Top diagnoses (patients, 12 months)">
                  {s.topDiagnoses.length === 0 ? (
                    <EmptyState title="No diagnoses recorded" />
                  ) : (
                    <>
                      <RankedBars
                        label="Top diagnoses nationally"
                        rows={s.topDiagnoses.map((d) => ({
                          key: d.icd10Code,
                          label: d.description,
                          sublabel: d.icd10Code,
                          value: d.count,
                          suppressed: d.suppressed,
                        }))}
                      />
                      <p className="muted">
                        Counts below {s.smallCellThreshold} are hidden to protect patient privacy.
                      </p>
                    </>
                  )}
                </Card>
              </div>

              <Card title="By region">
                <Table caption="Facilities, patients and encounters by region">
                  <thead>
                    <tr>
                      <th scope="col">Region</th>
                      <th scope="col" className="num">
                        Facilities
                      </th>
                      <th scope="col" className="num">
                        Patients
                      </th>
                      <th scope="col" className="num">
                        Encounters (30d)
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

              <Card title="Facilities">
                <Table caption="Activity per facility">
                  <thead>
                    <tr>
                      <th scope="col">Facility</th>
                      <th scope="col">Type</th>
                      <th scope="col">Region</th>
                      <th scope="col">Director</th>
                      <th scope="col" className="num">
                        Patients
                      </th>
                      <th scope="col" className="num">
                        Doctors
                      </th>
                      <th scope="col" className="num">
                        Encounters (30d)
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
                              <Badge>Inactive</Badge>
                            </>
                          )}
                        </td>
                        <td>{humanize(f.type)}</td>
                        <td>{f.region}</td>
                        <td>{f.directorName ?? <Badge tone="warning">No director</Badge>}</td>
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
    </>
  );
}
