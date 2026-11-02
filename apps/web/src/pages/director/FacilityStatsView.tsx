import { t } from '../../i18n';
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
  const tot = stats.totals;
  const x = stats.exceptions;
  return (
    <div className="stack">
      <Grid min={180}>
        <Stat label={t('Registered patients')} value={formatNumber(tot.patients)} />
        <Stat
          label={t('Portal users')}
          value={formatNumber(tot.portalUsers)}
          hint={
            tot.patients
              ? t('{pct}% of patients', { pct: Math.round((tot.portalUsers / tot.patients) * 100) })
              : undefined
          }
        />
        <Stat label={t('Active doctors')} value={formatNumber(tot.activeDoctors)} />
        <Stat label={t('Encounters (30 days)')} value={formatNumber(tot.encounters30d)} />
        <Stat label={t('Upcoming appointments')} value={formatNumber(tot.upcomingAppointments)} />
        <Stat
          label={t('Pending requests')}
          value={formatNumber(tot.pendingAppointmentRequests)}
          tone={tot.pendingAppointmentRequests > 0 ? 'warning' : undefined}
          hint={t('Appointment requests awaiting confirmation')}
        />
        <Stat
          label={t('Emergency access (30 days)')}
          value={formatNumber(tot.emergencyAccess30d)}
          tone={tot.emergencyAccess30d > 0 ? 'danger' : undefined}
          hint={
            tot.emergencyAccess30d > 0 && auditPath ? (
              <Link to={`${auditPath}?action=care.emergency_access.granted`}>
                {t('Review events')}
              </Link>
            ) : (
              t('Break-glass record openings')
            )
          }
        />
      </Grid>

      <Card title={t('Operational exceptions')}>
        <p className="muted">{t('Follow-up that has not been closed within the expected time.')}</p>
        <Grid min={200}>
          <Stat
            label={t('Results unacknowledged > 48h')}
            value={formatNumber(x.resultsUnacknowledgedOver48h)}
            tone={x.resultsUnacknowledgedOver48h > 0 ? 'warning' : 'success'}
          />
          <Stat
            label={t('Notes unsigned > 72h')}
            value={formatNumber(x.notesUnsignedOver72h)}
            tone={x.notesUnsignedOver72h > 0 ? 'warning' : 'success'}
          />
          <Stat
            label={t('Open correction requests')}
            value={formatNumber(x.openCorrectionRequests)}
            tone={x.openCorrectionRequests > 0 ? 'warning' : 'success'}
          />
        </Grid>
      </Card>

      <div className="two-col">
        <Card title={t('Encounters by month')}>
          <BarChart
            title={t('Encounters per month, last 12 months')}
            data={monthlyBars(stats.encountersByMonth)}
          />
        </Card>
        <Card title={t('Encounters by type (12 months)')}>
          {stats.encountersByType.length === 0 ? (
            <EmptyState title={t('No encounters recorded')} />
          ) : (
            <RankedBars
              label={t('Encounters by type')}
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
        <Card title={t('Top diagnoses (patients, 12 months)')}>
          {stats.topDiagnoses.length === 0 ? (
            <EmptyState title={t('No diagnoses recorded')} />
          ) : (
            <>
              <RankedBars
                label={t('Top diagnoses')}
                rows={stats.topDiagnoses.map((d) => ({
                  key: d.icd10Code,
                  label: d.description,
                  sublabel: d.icd10Code,
                  value: d.count,
                  suppressed: d.suppressed,
                }))}
              />
              <p className="muted">{t('Counts below 5 are hidden to protect patient privacy.')}</p>
            </>
          )}
        </Card>
        <Card title={t('Appointments by status (from 30 days ago)')}>
          {stats.appointmentsByStatus.length === 0 ? (
            <EmptyState title={t('No appointments')} />
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

      <Card title={t('Doctor workload')}>
        {stats.doctorWorkload.length === 0 ? (
          <EmptyState title={t('No active doctors')} />
        ) : (
          <Table
            caption={t('Active doctors with patients in care and encounters in the last 30 days')}
          >
            <thead>
              <tr>
                <th scope="col">{t('Doctor')}</th>
                <th scope="col">{t('Specialty')}</th>
                <th scope="col" className="num">
                  {t('Patients in care')}
                </th>
                <th scope="col" className="num">
                  {t('Encounters (30d)')}
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.doctorWorkload.map((d) => (
                <tr key={d.doctorId}>
                  <td>{d.fullName}</td>
                  <td>{d.specialty ? t(d.specialty) : '—'}</td>
                  <td className="num">{formatNumber(d.patients)}</td>
                  <td className="num">{formatNumber(d.encounters30d)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Alert tone="neutral">
        {t(
          'Management dashboards show aggregate and operational data only. Identifiable clinical records are available exclusively to the treating care team and the patient.',
        )}
      </Alert>
    </div>
  );
}
