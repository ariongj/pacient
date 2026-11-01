import { Link } from 'react-router-dom';
import type { FacilityStats } from '../../api/types';
import { BarChart, monthlyBars, RankedBars } from '../../components/charts';
import { Alert, Card, EmptyState, Grid, Stat, StatusBadge, Table } from '../../components/ui';
import { formatNumber, humanize } from '../../format';

/** Presentational facility dashboard shared by the Director and the Ministry drill-down. */
export function FacilityStatsView({
  stats,
  auditPath,
}: {
  stats: FacilityStats;
  auditPath?: string;
}) {
  const t = stats.totals;
  const x = stats.exceptions;
  return (
    <div className="stack">
      <Grid min={180}>
        <Stat label="Registered patients" value={formatNumber(t.patients)} />
        <Stat
          label="Portal users"
          value={formatNumber(t.portalUsers)}
          hint={
            t.patients
              ? `${Math.round((t.portalUsers / t.patients) * 100)}% of patients`
              : undefined
          }
        />
        <Stat label="Active doctors" value={formatNumber(t.activeDoctors)} />
        <Stat label="Encounters (30 days)" value={formatNumber(t.encounters30d)} />
        <Stat label="Upcoming appointments" value={formatNumber(t.upcomingAppointments)} />
        <Stat
          label="Pending requests"
          value={formatNumber(t.pendingAppointmentRequests)}
          tone={t.pendingAppointmentRequests > 0 ? 'warning' : undefined}
          hint="Appointment requests awaiting confirmation"
        />
        <Stat
          label="Emergency access (30 days)"
          value={formatNumber(t.emergencyAccess30d)}
          tone={t.emergencyAccess30d > 0 ? 'danger' : undefined}
          hint={
            t.emergencyAccess30d > 0 && auditPath ? (
              <Link to={`${auditPath}?action=care.emergency_access.granted`}>Review events</Link>
            ) : (
              'Break-glass record openings'
            )
          }
        />
      </Grid>

      <Card title="Operational exceptions">
        <p className="muted">Follow-up that has not been closed within the expected time.</p>
        <Grid min={200}>
          <Stat
            label="Results unacknowledged > 48h"
            value={formatNumber(x.resultsUnacknowledgedOver48h)}
            tone={x.resultsUnacknowledgedOver48h > 0 ? 'warning' : 'success'}
          />
          <Stat
            label="Notes unsigned > 72h"
            value={formatNumber(x.notesUnsignedOver72h)}
            tone={x.notesUnsignedOver72h > 0 ? 'warning' : 'success'}
          />
          <Stat
            label="Open correction requests"
            value={formatNumber(x.openCorrectionRequests)}
            tone={x.openCorrectionRequests > 0 ? 'warning' : 'success'}
          />
        </Grid>
      </Card>

      <div className="two-col">
        <Card title="Encounters by month">
          <BarChart
            title="Encounters per month, last 12 months"
            data={monthlyBars(stats.encountersByMonth)}
          />
        </Card>
        <Card title="Encounters by type (12 months)">
          {stats.encountersByType.length === 0 ? (
            <EmptyState title="No encounters recorded" />
          ) : (
            <RankedBars
              label="Encounters by type"
              rows={stats.encountersByType.map((r) => ({
                key: r.type,
                label: humanize(r.type),
                value: r.count,
              }))}
            />
          )}
        </Card>
      </div>

      <div className="two-col">
        <Card title="Top diagnoses (patients, 12 months)">
          {stats.topDiagnoses.length === 0 ? (
            <EmptyState title="No diagnoses recorded" />
          ) : (
            <>
              <RankedBars
                label="Top diagnoses"
                rows={stats.topDiagnoses.map((d) => ({
                  key: d.icd10Code,
                  label: d.description,
                  sublabel: d.icd10Code,
                  value: d.count,
                  suppressed: d.suppressed,
                }))}
              />
              <p className="muted">Counts below 5 are hidden to protect patient privacy.</p>
            </>
          )}
        </Card>
        <Card title="Appointments by status (from 30 days ago)">
          {stats.appointmentsByStatus.length === 0 ? (
            <EmptyState title="No appointments" />
          ) : (
            <ul className="list">
              {stats.appointmentsByStatus.map((a) => (
                <li key={a.status} className="row-between">
                  <StatusBadge value={a.status} />
                  <strong>{formatNumber(a.count)}</strong>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Doctor workload">
        {stats.doctorWorkload.length === 0 ? (
          <EmptyState title="No active doctors" />
        ) : (
          <Table caption="Active doctors with patients in care and encounters in the last 30 days">
            <thead>
              <tr>
                <th scope="col">Doctor</th>
                <th scope="col">Specialty</th>
                <th scope="col" className="num">
                  Patients in care
                </th>
                <th scope="col" className="num">
                  Encounters (30d)
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.doctorWorkload.map((d) => (
                <tr key={d.doctorId}>
                  <td>{d.fullName}</td>
                  <td>{d.specialty ?? '—'}</td>
                  <td className="num">{formatNumber(d.patients)}</td>
                  <td className="num">{formatNumber(d.encounters30d)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Alert tone="neutral">
        Management dashboards show aggregate and operational data only. Identifiable clinical
        records are available exclusively to the treating care team and the patient.
      </Alert>
    </div>
  );
}
