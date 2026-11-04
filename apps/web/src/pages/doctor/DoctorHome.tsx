import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { CoverWorklist } from '../../api/cover';
import { modalityLabel, useImagingAction, type Modality } from '../../api/imaging';
import type { Appointment, CareTask, MessageThreadSummary, Referral } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { AnnouncementsCard } from '../../components/Announcements';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  StatusBadge,
  Table,
} from '../../components/ui';
import { formatDate, formatDateTime, formatTime, humanize } from '../../format';
import { t } from '../../i18n';
import { diseaseName, useMyCases } from '../../api/surveillance';

/** Shown when an unreviewed critical result has been escalated to colleagues (and the director). */
function EscalatedBadge({ level }: { level?: number }) {
  if (!level) return null;
  return (
    <span style={{ display: 'block', marginTop: '0.25rem' }}>
      <Badge tone="danger">{level >= 2 ? t('Escalated to director') : t('Escalated')}</Badge>
    </span>
  );
}

interface ImagingToReview {
  id: string;
  patientId: string;
  patientName: string;
  modality: Modality;
  bodyPart: string;
  impression: string | null;
  critical: boolean;
  reportedAt: string;
  orderedById: string;
  orderedBy: string;
}

/** Signed imaging reports waiting for my review (or a covered colleague's), critical first. */
function ImagingReviewCard({ items, myId }: { items: ImagingToReview[]; myId: string }) {
  const acknowledge = useImagingAction((id: string) => ({ path: `/orders/${id}/acknowledge` }));
  if (!items.length) return null;
  return (
    <Card title={t('Imaging reports to review')}>
      <ErrorAlert error={acknowledge.error} />
      <Table caption={t('Imaging reports to review')}>
        <thead>
          <tr>
            <th>{t('Patient')}</th>
            <th>{t('Examination')}</th>
            <th>{t('Impression')}</th>
            <th>{t('Reported')}</th>
            <th>
              <span className="sr-only">{t('Actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/doctor/patients/${r.patientId}?tab=imaging`}>{r.patientName}</Link>
                {r.orderedById !== myId && (
                  <div className="muted">{t('Covering for {name}', { name: r.orderedBy })}</div>
                )}
              </td>
              <td>
                {modalityLabel(r.modality)} · {r.bodyPart}
              </td>
              <td>
                {r.critical && (
                  <span style={{ display: 'block', marginBottom: '0.25rem' }}>
                    <Badge tone="danger">{t('Critical finding')}</Badge>
                  </span>
                )}
                {r.impression}
              </td>
              <td>{formatDateTime(r.reportedAt)}</td>
              <td>
                <Button
                  size="sm"
                  variant={r.critical ? 'primary' : 'secondary'}
                  loading={acknowledge.isPending && acknowledge.variables === r.id}
                  onClick={() => acknowledge.mutate(r.id)}
                >
                  {t('Acknowledge')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function DoctorHome() {
  const user = useUser();
  const qc = useQueryClient();
  const worklist = useQuery({
    queryKey: ['worklist'],
    queryFn: () => api<CoverWorklist>('/worklist'),
  });
  const from = startOfToday();
  const appointments = useQuery({
    queryKey: ['appointments', 'upcoming', from],
    queryFn: () => api<{ items: Appointment[] }>('/appointments', { query: { from } }),
  });

  const pendingReferrals = useQuery({
    queryKey: ['referrals', 'incoming', 'PENDING'],
    queryFn: () =>
      api<{ items: Referral[] }>('/referrals', {
        query: { direction: 'incoming', status: 'PENDING' },
      }),
  });
  const threads = useQuery({
    queryKey: ['messages', 'threads'],
    queryFn: () => api<{ items: MessageThreadSummary[] }>('/messages/threads'),
  });
  const tasks = useQuery({
    queryKey: ['careTasks', 'mine', 'OPEN'],
    queryFn: () =>
      api<{ items: CareTask[] }>('/care-tasks', { query: { scope: 'mine', status: 'OPEN' } }),
  });
  const openTasks = tasks.data?.items ?? [];
  const overdueTasks = openTasks.filter(
    (task) => task.dueAt && new Date(task.dueAt).getTime() < Date.now(),
  ).length;
  const referralItems = pendingReferrals.data?.items ?? [];
  const urgentReferrals = referralItems.filter((r) => r.priority === 'URGENT').length;
  const unreadMessages = (threads.data?.items ?? []).reduce((n, th) => n + th.unreadCount, 0);

  const acknowledge = useMutation({
    mutationFn: ({ patientId, id }: { patientId: string; id: string }) =>
      api(`/patients/${patientId}/lab-results/${id}/acknowledge`, { method: 'POST' }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['worklist'] });
      void qc.invalidateQueries({ queryKey: ['patient', v.patientId] });
    },
  });

  const upcoming = (appointments.data?.items ?? []).filter(
    (a) => a.status === 'CONFIRMED' || a.status === 'REQUESTED',
  );
  const todayKey = new Date().toDateString();
  const today = upcoming.filter((a) => new Date(a.scheduledAt).toDateString() === todayKey);

  return (
    <>
      <PageHeader
        title={t('Worklist')}
        subtitle={t('Good day, {name}. Follow-up stays here until it is explicitly closed.', {
          name: user.fullName,
        })}
      />
      <QueryView query={worklist}>
        {(w) => (
          <div className="stack">
            <Grid min={180}>
              <Stat
                label={t('Results to review')}
                value={w.unacknowledgedResults.length}
                tone={
                  w.unacknowledgedResults.some((r) => r.flag === 'CRITICAL')
                    ? 'danger'
                    : w.unacknowledgedResults.length
                      ? 'warning'
                      : 'success'
                }
                hint={
                  w.unacknowledgedResults.some((r) => r.flag === 'CRITICAL')
                    ? t('Includes critical results')
                    : (w.coveredResults ?? []).length
                      ? t('+ {count} you are covering', { count: (w.coveredResults ?? []).length })
                      : undefined
                }
              />
              <Stat
                label={t('Correction requests')}
                value={w.openCorrectionRequests.length}
                tone={w.openCorrectionRequests.length ? 'warning' : 'success'}
              />
              <Stat
                label={t('Notes awaiting signature')}
                value={w.draftNotes.length}
                tone={w.draftNotes.length ? 'warning' : 'success'}
              />
              <Stat label={t('Appointments today')} value={today.length} tone="info" />
              <Stat
                label={t('Pending referrals')}
                value={pendingReferrals.data ? referralItems.length : '…'}
                tone={urgentReferrals ? 'danger' : referralItems.length ? 'warning' : 'success'}
                hint={
                  <Link to="/doctor/referrals">
                    {urgentReferrals
                      ? t('{count} urgent · review', { count: urgentReferrals })
                      : t('Open referrals')}
                  </Link>
                }
              />
              <Stat
                label={t('Unread messages')}
                value={threads.data ? unreadMessages : '…'}
                tone={unreadMessages ? 'warning' : 'success'}
                hint={<Link to="/messages">{t('Open messages')}</Link>}
              />
              <Stat
                label={t('Returned by pharmacy')}
                value={w.returnedPrescriptions.length}
                tone={w.returnedPrescriptions.length ? 'danger' : 'success'}
              />
              <Stat
                label={t('Open care tasks')}
                value={tasks.data ? openTasks.length : '…'}
                tone={overdueTasks ? 'danger' : openTasks.length ? 'warning' : 'success'}
                hint={
                  <Link to="/tasks">
                    {overdueTasks ? t('{count} overdue', { count: overdueTasks }) : t('Open tasks')}
                  </Link>
                }
              />
            </Grid>

            <AnnouncementsCard />

            {w.returnedPrescriptions.length > 0 && (
              <Card title={t('Returned by pharmacy')}>
                <p className="muted">
                  {t(
                    'The pharmacy could not verify these prescriptions. Amend and resubmit, or stop them, from the patient’s Medications tab.',
                  )}
                </p>
                <ul className="list">
                  {w.returnedPrescriptions.map((r) => (
                    <li key={r.id}>
                      <div className="row-between">
                        <span>
                          <strong>{r.medication}</strong> {r.dosage} · {r.frequency} —{' '}
                          <Link to={`/doctor/patients/${r.patientId}?tab=medications`}>
                            {r.patientName}
                          </Link>
                        </span>
                        <span className="row">
                          <StatusBadge value="RETURNED" />
                          {r.returnedAt && (
                            <span className="muted">{formatDateTime(r.returnedAt)}</span>
                          )}
                        </span>
                      </div>
                      {r.pharmacistNote && <div>Pharmacist: {r.pharmacistNote}</div>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card title={t('Results awaiting review')}>
              <ErrorAlert error={acknowledge.error} />
              {w.unacknowledgedResults.length === 0 ? (
                <EmptyState title={t('No results waiting')}>
                  {t('All results you ordered have been reviewed.')}
                </EmptyState>
              ) : (
                <Table caption={t('Results awaiting review')}>
                  <thead>
                    <tr>
                      <th>{t('Patient')}</th>
                      <th>{t('Test')}</th>
                      <th>{t('Value')}</th>
                      <th>{t('Flag')}</th>
                      <th>{t('Status')}</th>
                      <th>{t('Collected')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.unacknowledgedResults.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={`/doctor/patients/${r.patientId}?tab=results`}>
                            {r.patientName}
                          </Link>
                        </td>
                        <td>{r.testName}</td>
                        <td>
                          {r.value} {r.unit ?? ''}
                        </td>
                        <td>
                          <StatusBadge value={r.flag} />
                          <EscalatedBadge level={r.escalationLevel} />
                        </td>
                        <td>
                          <StatusBadge value={r.status} />
                        </td>
                        <td>{formatDateTime(r.collectedAt)}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={acknowledge.isPending && acknowledge.variables?.id === r.id}
                            onClick={() => acknowledge.mutate({ patientId: r.patientId, id: r.id })}
                          >
                            {t('Acknowledge')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <ImagingReviewCard
              items={(w as { imagingToReview?: ImagingToReview[] }).imagingToReview ?? []}
              myId={user.id}
            />

            <CaseReportsCard />

            {(w.coveredResults ?? []).length > 0 && (
              <Card
                title={t('Covering for {names}', {
                  names: [...new Set((w.coveredResults ?? []).map((r) => r.orderedBy))].join(', '),
                })}
                actions={<Link to="/doctor/cover">{t('Cover & absence')}</Link>}
              >
                <p className="muted">
                  {t(
                    'Results ordered by colleagues you are covering for. Review them as you would your own; the ordering doctor sees who acknowledged them.',
                  )}
                </p>
                <Table caption={t('Results of colleagues you are covering for')}>
                  <thead>
                    <tr>
                      <th>{t('Patient')}</th>
                      <th>{t('Test')}</th>
                      <th>{t('Value')}</th>
                      <th>{t('Flag')}</th>
                      <th>{t('Ordered by')}</th>
                      <th>{t('Collected')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(w.coveredResults ?? []).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={`/doctor/patients/${r.patientId}?tab=results`}>
                            {r.patientName}
                          </Link>
                        </td>
                        <td>{r.testName}</td>
                        <td>
                          {r.value} {r.unit ?? ''}
                        </td>
                        <td>
                          <StatusBadge value={r.flag} />
                          <EscalatedBadge level={r.escalationLevel} />
                        </td>
                        <td>{r.orderedBy}</td>
                        <td>{formatDateTime(r.collectedAt)}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={acknowledge.isPending && acknowledge.variables?.id === r.id}
                            onClick={() => acknowledge.mutate({ patientId: r.patientId, id: r.id })}
                          >
                            {t('Acknowledge')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}

            <div className="two-col">
              <Card title={t('Open correction requests')}>
                {w.openCorrectionRequests.length === 0 ? (
                  <EmptyState title={t('No open requests')} />
                ) : (
                  <ul className="list">
                    {w.openCorrectionRequests.map((c) => (
                      <li key={c.id}>
                        <div className="row-between">
                          <Link to={`/doctor/patients/${c.patientId}?tab=corrections`}>
                            {c.patientName}
                          </Link>
                          <span className="muted">{formatDate(c.createdAt)}</span>
                        </div>
                        <div className="muted">Section: {humanize(c.section)}</div>
                        <div>{c.description}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title={t('Draft notes awaiting signature')}>
                {w.draftNotes.length === 0 ? (
                  <EmptyState title={t('All notes signed')} />
                ) : (
                  <ul className="list">
                    {w.draftNotes.map((n) => (
                      <li key={n.id}>
                        <div className="row-between">
                          <Link to={`/doctor/patients/${n.patientId}?tab=visits`}>
                            {n.patientName}
                          </Link>
                          <span className="muted">{formatDate(n.startedAt)}</span>
                        </div>
                        <div className="muted">
                          {humanize(n.type)} · {n.reason}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        )}
      </QueryView>

      <div style={{ marginTop: '1rem' }}>
        <Card
          title={t('Upcoming appointments')}
          actions={<Link to="/doctor/schedule">{t('Full schedule')}</Link>}
        >
          <QueryView query={appointments}>
            {() =>
              upcoming.length === 0 ? (
                <EmptyState title={t('No upcoming appointments')} />
              ) : (
                <ul className="list">
                  {upcoming.slice(0, 8).map((a) => (
                    <li key={a.id} className="row-between">
                      <span>
                        <strong>
                          {formatDate(a.scheduledAt)} {formatTime(a.scheduledAt)}
                        </strong>{' '}
                        · <Link to={`/doctor/patients/${a.patientId}`}>{a.patientName}</Link> ·{' '}
                        {a.reason}
                      </span>
                      <StatusBadge value={a.status} />
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryView>
        </Card>
      </div>
    </>
  );
}

/** Notifiable disease case reports the doctor still has to complete (hidden when none). */
function CaseReportsCard() {
  const mine = useMyCases();
  const drafts = (mine.data?.items ?? []).filter((c) => c.status === 'DRAFT');
  if (!drafts.length) return null;
  return (
    <Card
      title={t('Case reports to complete')}
      actions={<Link to="/surveillance">{t('Open case reports')}</Link>}
    >
      <ul className="list">
        {drafts.slice(0, 5).map((c) => (
          <li key={c.id}>
            <strong>{diseaseName(c.disease.name)}</strong> · {c.patient.name}
            {c.disease.urgency === 'IMMEDIATE' && (
              <span className="muted"> · {t('Report within 24 hours')}</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
