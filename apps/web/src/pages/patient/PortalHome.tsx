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
import { ALLERGY_ASSESSMENT_TEXT, useCareTeam, useSummary } from './shared';

export function PortalHome() {
  const user = useUser();
  const { acting } = useAuth();
  const summary = useSummary();
  const careTeam = useCareTeam();
  const threads = useQuery({
    queryKey: ['messages', 'threads'],
    queryFn: () => api<{ items: MessageThreadSummary[] }>('/messages/threads'),
  });
  const unreadMessages = threads.data?.items.reduce((n, t) => n + t.unreadCount, 0) ?? 0;
  const upcoming = useQuery({
    queryKey: ['appointments', 'upcoming'],
    queryFn: () =>
      api<{ items: Appointment[] }>('/appointments', { query: { from: new Date().toISOString() } }),
  });

  return (
    <>
      <PageHeader
        title={
          acting ? `${acting.firstName}’s health record` : `Hello, ${user.fullName.split(' ')[0]}`
        }
        subtitle="Your health record from every facility, in one place."
      />
      <Alert tone="info">
        This portal is not for emergencies. If you need urgent help, call <strong>112</strong> or go
        to the nearest emergency department.
      </Alert>
      <div className="stack" style={{ marginBottom: '1rem' }}>
        <AnnouncementsCard />
      </div>
      <QueryView query={summary}>
        {(s) => (
          <div className="stack">
            <Grid min={180}>
              <Stat label="Visits on record" value={s.counts.encounters} />
              <Stat label="Active medications" value={s.activeMedications.length} />
              <Stat label="Ongoing conditions" value={s.activeProblems.length} />
              <Stat
                label="Allergies"
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
                label="Vaccinations"
                value={s.immunizations.length}
                hint={
                  s.immunizations[0] ? (
                    <>
                      Latest: {s.immunizations[0].vaccine} (
                      {formatDate(s.immunizations[0].administeredAt)}) ·{' '}
                      <Link to="/portal/history">View</Link>
                    </>
                  ) : undefined
                }
              />
              <Stat
                label="Unread messages"
                value={unreadMessages}
                tone={unreadMessages > 0 ? 'info' : undefined}
                hint={<Link to="/portal/messages">Open messages</Link>}
              />
            </Grid>

            <div className="two-col">
              <div className="stack">
                <Card
                  title="Upcoming appointments"
                  actions={<Link to="/portal/appointments">Manage</Link>}
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
                        <EmptyState title="No upcoming appointments">
                          <Link to="/portal/appointments">Request an appointment</Link>
                        </EmptyState>
                      );
                    }}
                  </QueryView>
                </Card>

                <Card title="Current medications">
                  {s.activeMedications.length ? (
                    <ul className="list">
                      {s.activeMedications.map((m) => (
                        <li key={m.id}>
                          <strong>{m.medication}</strong> {m.dosage} — {m.frequency}
                          <div className="muted">
                            Prescribed by {m.doctorName} since {formatDate(m.startDate)}
                            {m.instructions ? ` · ${m.instructions}` : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title="No active medications" />
                  )}
                </Card>

                <Card
                  title="Ongoing conditions"
                  actions={<Link to="/portal/history">Full history</Link>}
                >
                  {s.activeProblems.length ? (
                    <ul className="list">
                      {s.activeProblems.map((d) => (
                        <li key={d.id} className="row-between">
                          <span>
                            {d.description} <code>{d.icd10Code}</code>
                            <div className="muted">Since {formatDate(d.diagnosedAt)}</div>
                          </span>
                          <StatusBadge value={d.status} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title="No ongoing conditions recorded" />
                  )}
                </Card>
              </div>

              <div className="stack">
                <Card title="Allergies">
                  {s.allergies.length ? (
                    <ul className="list">
                      {s.allergies.map((a) => (
                        <li key={a.id}>
                          <div className="row-between">
                            <strong>{a.substance}</strong>
                            <StatusBadge value={a.severity} />
                          </div>
                          <div className="muted">
                            {a.reaction ?? 'Reaction not recorded'} ·{' '}
                            {a.verificationStatus === 'CONFIRMED'
                              ? 'Confirmed'
                              : 'Not yet confirmed'}
                            {a.source === 'PATIENT_REPORTED' ? ' · reported by you' : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{ALLERGY_ASSESSMENT_TEXT[s.patient.allergyAssessment]}</p>
                  )}
                </Card>

                <Card title="Latest measurements">
                  {s.latestVitals ? (
                    <>
                      <ul className="list">
                        {s.latestVitals.systolic && (
                          <li className="row-between">
                            Blood pressure
                            <strong>
                              {s.latestVitals.systolic}/{s.latestVitals.diastolic} mmHg
                            </strong>
                          </li>
                        )}
                        {s.latestVitals.heartRate && (
                          <li className="row-between">
                            Heart rate <strong>{s.latestVitals.heartRate} bpm</strong>
                          </li>
                        )}
                        {s.latestVitals.weightKg && (
                          <li className="row-between">
                            Weight <strong>{s.latestVitals.weightKg} kg</strong>
                          </li>
                        )}
                        {s.latestVitals.oxygenSaturation && (
                          <li className="row-between">
                            Oxygen saturation <strong>{s.latestVitals.oxygenSaturation}%</strong>
                          </li>
                        )}
                      </ul>
                      <p className="muted">Measured {formatDate(s.latestVitals.recordedAt)}</p>
                    </>
                  ) : (
                    <EmptyState title="No measurements yet" />
                  )}
                </Card>

                <Card title="Your care team">
                  <QueryView query={careTeam}>
                    {(d) =>
                      d.items.length ? (
                        <ul className="list">
                          {d.items.map((m) => (
                            <li key={m.doctorId}>
                              <strong>{m.fullName}</strong>
                              <div className="muted">{m.specialty ?? 'Doctor'}</div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <EmptyState title="No doctor assigned yet" />
                      )
                    }
                  </QueryView>
                </Card>

                <Card title="Registered at">
                  <p>{s.patient.primaryFacilityName}</p>
                  <Badge tone="info">Privacy</Badge>{' '}
                  <Link to="/portal/access-log">See who has viewed your record</Link>
                </Card>
              </div>
            </div>
          </div>
        )}
      </QueryView>
    </>
  );
}
