import { t } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Appointment, MessageThreadSummary } from '../../api/types';
import { useAuth, useUser } from '../../auth/AuthContext';
import { AnnouncementsCard } from '../../components/Announcements';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  StatusBadge,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { allergyAssessmentText, useCareTeam, useSummary } from './shared';

export function PortalHome() {
  const user = useUser();
  const { acting } = useAuth();
  const summary = useSummary();
  const careTeam = useCareTeam();
  const threads = useQuery({
    queryKey: ['messages', 'threads'],
    queryFn: () => api<{ items: MessageThreadSummary[] }>('/messages/threads'),
  });
  const unreadMessages = threads.data?.items.reduce((n, th) => n + th.unreadCount, 0) ?? 0;
  const upcoming = useQuery({
    queryKey: ['appointments', 'upcoming'],
    queryFn: () =>
      api<{ items: Appointment[] }>('/appointments', { query: { from: new Date().toISOString() } }),
  });

  return (
    <>
      <PageHeader
        title={
          acting
            ? t('{name}’s health record', { name: acting.firstName })
            : t('Hello, {name}', { name: user.fullName.split(' ')[0] })
        }
        subtitle={t('Your health record from every facility, in one place.')}
      />
      <Alert tone="info">
        {t('This portal is not for emergencies. If you need urgent help, call')}{' '}
        <strong>112</strong> {t('or go to the nearest emergency department.')}
      </Alert>
      <div className="stack" style={{ marginBottom: '1rem' }}>
        <AnnouncementsCard />
      </div>
      <QueryView query={summary}>
        {(s) => (
          <div className="stack">
            <Grid min={180}>
              <Stat label={t('Visits on record')} value={s.counts.encounters} />
              <Stat label={t('Active medications')} value={s.activeMedications.length} />
              <Stat label={t('Ongoing conditions')} value={s.activeProblems.length} />
              <Stat
                label={t('Allergies')}
                value={
                  s.allergies.filter((a) =>
                    ['CONFIRMED', 'UNCONFIRMED'].includes(a.verificationStatus),
                  ).length
                }
                tone={
                  s.allergies.some((a) => a.severity === 'LIFE_THREATENING') ? 'danger' : undefined
                }
              />
              <Stat
                label={t('Vaccinations')}
                value={s.immunizations.length}
                hint={
                  s.immunizations[0] ? (
                    <>
                      {t('Latest: {vaccine} ({date})', {
                        vaccine: s.immunizations[0].vaccine,
                        date: formatDate(s.immunizations[0].administeredAt),
                      })}{' '}
                      · <Link to="/portal/history">{t('View')}</Link>
                    </>
                  ) : undefined
                }
              />
              <Stat
                label={t('Unread messages')}
                value={unreadMessages}
                tone={unreadMessages > 0 ? 'info' : undefined}
                hint={<Link to="/portal/messages">{t('Open messages')}</Link>}
              />
            </Grid>

            <div className="two-col">
              <div className="stack">
                <Card
                  title={t('Upcoming appointments')}
                  actions={<Link to="/portal/appointments">{t('Manage')}</Link>}
                >
                  <QueryView query={upcoming}>
                    {(d) => {
                      const items = d.items.filter(
                        (a) => a.status === 'REQUESTED' || a.status === 'CONFIRMED',
                      );
                      return items.length ? (
                        <ul className="list">
                          {items.slice(0, 4).map((a) => (
                            <li key={a.id} className="row-between">
                              <span>
                                <strong>{formatDateTime(a.scheduledAt)}</strong>
                                <br />
                                <span className="muted">
                                  {a.doctorName} · {a.facilityName} — {a.reason}
                                </span>
                              </span>
                              <StatusBadge value={a.status} />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <EmptyState title={t('No upcoming appointments')}>
                          <Link to="/portal/appointments">{t('Request an appointment')}</Link>
                        </EmptyState>
                      );
                    }}
                  </QueryView>
                </Card>

                <Card title={t('Current medications')}>
                  {s.activeMedications.length ? (
                    <ul className="list">
                      {s.activeMedications.map((m) => (
                        <li key={m.id}>
                          <strong>{m.medication}</strong> {m.dosage} — {m.frequency}
                          <div className="muted">
                            {t('Prescribed by {doctor} since {date}', {
                              doctor: m.doctorName,
                              date: formatDate(m.startDate),
                            })}
                            {m.instructions ? ` · ${m.instructions}` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title={t('No active medications')} />
                  )}
                </Card>

                <Card
                  title={t('Ongoing conditions')}
                  actions={<Link to="/portal/history">{t('Full history')}</Link>}
                >
                  {s.activeProblems.length ? (
                    <ul className="list">
                      {s.activeProblems.map((d) => (
                        <li key={d.id} className="row-between">
                          <span>
                            {d.description} <code>{d.icd10Code}</code>
                            <div className="muted">
                              {t('Since {date}', { date: formatDate(d.diagnosedAt) })}
                            </div>
                          </span>
                          <StatusBadge value={d.status} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title={t('No ongoing conditions recorded')} />
                  )}
                </Card>
              </div>

              <div className="stack">
                <Card title={t('Allergies')}>
                  {s.allergies.length ? (
                    <ul className="list">
                      {s.allergies.map((a) => (
                        <li key={a.id}>
                          <div className="row-between">
                            <strong>{a.substance}</strong>
                            <StatusBadge value={a.severity} />
                          </div>
                          <div className="muted">
                            {a.reaction ?? t('Reaction not recorded')} ·{' '}
                            {a.verificationStatus === 'CONFIRMED'
                              ? t('Confirmed')
                              : t('Not yet confirmed')}
                            {a.source === 'PATIENT_REPORTED' ? ` · ${t('reported by you')}` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{allergyAssessmentText(s.patient.allergyAssessment)}</p>
                  )}
                </Card>

                <Card title={t('Latest measurements')}>
                  {s.latestVitals ? (
                    <>
                      <ul className="list">
                        {s.latestVitals.systolic && (
                          <li className="row-between">
                            {t('Blood pressure')}
                            <strong>
                              {s.latestVitals.systolic}/{s.latestVitals.diastolic} mmHg
                            </strong>
                          </li>
                        )}
                        {s.latestVitals.heartRate && (
                          <li className="row-between">
                            {t('Heart rate')} <strong>{s.latestVitals.heartRate} bpm</strong>
                          </li>
                        )}
                        {s.latestVitals.weightKg && (
                          <li className="row-between">
                            {t('Weight')} <strong>{s.latestVitals.weightKg} kg</strong>
                          </li>
                        )}
                        {s.latestVitals.oxygenSaturation && (
                          <li className="row-between">
                            {t('Oxygen saturation')}{' '}
                            <strong>{s.latestVitals.oxygenSaturation}%</strong>
                          </li>
                        )}
                      </ul>
                      <p className="muted">
                        {t('Measured {date}', { date: formatDate(s.latestVitals.recordedAt) })}
                      </p>
                    </>
                  ) : (
                    <EmptyState title={t('No measurements yet')} />
                  )}
                </Card>

                <Card title={t('Your care team')}>
                  <QueryView query={careTeam}>
                    {(d) =>
                      d.items.length ? (
                        <ul className="list">
                          {d.items.map((m) => (
                            <li key={m.doctorId}>
                              <strong>{m.fullName}</strong>
                              <div className="muted">{m.specialty ?? t('Doctor')}</div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <EmptyState title={t('No doctor assigned yet')} />
                      )
                    }
                  </QueryView>
                </Card>

                <Card title={t('Registered at')}>
                  <p>{s.patient.primaryFacilityName}</p>
                  <Badge tone="info">{t('Privacy')}</Badge>{' '}
                  <Link to="/portal/access-log">{t('See who has viewed your record')}</Link>
                </Card>
              </div>
            </div>
          </div>
        )}
      </QueryView>
    </>
  );
}
