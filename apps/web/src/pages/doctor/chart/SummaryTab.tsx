import type { ClinicalSummary } from '../../../api/types';
import { Card, DefinitionList, EmptyState, Grid, Stat, StatusBadge } from '../../../components/ui';
import { formatDate, formatDateTime, humanize } from '../../../format';
import { t } from '../../../i18n';
import { RecentChangesSection } from '../../history/RecordHistory';

export function SummaryTab({ summary }: { summary: ClinicalSummary }) {
  const v = summary.latestVitals;
  const p = summary.patient;
  return (
    <div className="stack">
      <Grid min={160}>
        <Stat label={t('Visits')} value={summary.counts.encounters} />
        <Stat label={t('Active problems')} value={summary.activeProblems.length} />
        <Stat label={t('Active medications')} value={summary.activeMedications.length} />
        <Stat label={t('Vaccinations')} value={summary.immunizations?.length ?? 0} />
        <Stat
          label={t('Open correction requests')}
          value={summary.counts.openCorrectionRequests}
          tone={summary.counts.openCorrectionRequests ? 'warning' : undefined}
        />
      </Grid>
      <div className="two-col">
        <div className="stack">
          <Card title={t('Active problems')}>
            {summary.activeProblems.length === 0 ? (
              <EmptyState title={t('No active problems recorded')} />
            ) : (
              <ul className="list">
                {summary.activeProblems.map((d) => (
                  <li key={d.id} className="row-between">
                    <span>
                      <code>{d.icd10Code}</code> {d.description}
                    </span>
                    <span className="row">
                      <StatusBadge value={d.status} />
                      <span className="muted">{formatDate(d.diagnosedAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('Active medications')}>
            {summary.activeMedications.length === 0 ? (
              <EmptyState title={t('No active medications')} />
            ) : (
              <ul className="list">
                {summary.activeMedications.map((m) => (
                  <li key={m.id}>
                    <strong>{m.medication}</strong> {m.dosage} · {m.frequency} · {m.route}
                    <div className="muted">
                      {t('Since {date}', { date: formatDate(m.startDate) })} · {m.doctorName}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('Recent visits')}>
            {summary.recentEncounters.length === 0 ? (
              <EmptyState title={t('No visits yet')} />
            ) : (
              <ul className="list">
                {summary.recentEncounters.map((e) => (
                  <li key={e.id} className="row-between">
                    <span>
                      <strong>{formatDate(e.startedAt)}</strong> · {humanize(e.type)} · {e.reason}
                      <div className="muted">
                        {e.doctorName} · {e.facilityName}
                      </div>
                    </span>
                    <StatusBadge value={e.noteStatus} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title={t('Latest vital signs')}>
            {v ? (
              <>
                <DefinitionList
                  items={[
                    [
                      t('Blood pressure'),
                      v.systolic ? `${v.systolic}/${v.diastolic ?? '—'} mmHg` : '—',
                    ],
                    [t('Heart rate'), v.heartRate ? `${v.heartRate} bpm` : '—'],
                    [t('Temperature'), v.temperatureC ? `${v.temperatureC} °C` : '—'],
                    ['SpO₂', v.oxygenSaturation ? `${v.oxygenSaturation} %` : '—'],
                    [t('Weight'), v.weightKg ? `${v.weightKg} kg` : '—'],
                    [t('Height'), v.heightCm ? `${v.heightCm} cm` : '—'],
                  ]}
                />
                <p className="muted" style={{ marginTop: '0.5rem' }}>
                  {formatDateTime(v.recordedAt)} · {v.recordedBy}
                </p>
              </>
            ) : (
              <EmptyState title={t('No vital signs recorded')} />
            )}
          </Card>
          <Card title={t('Recent results')}>
            {summary.recentLabResults.length === 0 ? (
              <EmptyState title={t('No results')} />
            ) : (
              <ul className="list">
                {summary.recentLabResults.slice(0, 6).map((r) => (
                  <li key={r.id} className="row-between">
                    <span>
                      {r.testName}: <strong>{r.value}</strong> {r.unit ?? ''}
                      <div className="muted">{formatDate(r.collectedAt)}</div>
                    </span>
                    <StatusBadge value={r.flag} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('Contact')}>
            <DefinitionList
              items={[
                [t('Phone'), p.phone],
                [t('Email'), p.email],
                [t('Address'), [p.address, p.municipality].filter(Boolean).join(', ') || null],
                [
                  t('Emergency contact'),
                  p.emergencyContactName
                    ? `${p.emergencyContactName}${p.emergencyContactPhone ? ` · ${p.emergencyContactPhone}` : ''}`
                    : null,
                ],
                [t('Registered at'), p.primaryFacilityName],
              ]}
            />
          </Card>
        </div>
      </div>
      <RecentChangesSection patientId={p.id} />
    </div>
  );
}
