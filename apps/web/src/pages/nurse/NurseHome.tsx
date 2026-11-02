import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { CareTask, Page, PatientListItem } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { AnnouncementsCard } from '../../components/Announcements';
import {
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  Stat,
  StatusBadge,
} from '../../components/ui';
import { age, formatTime, fullName, humanize } from '../../format';
import { DueText, isOverdue, TaskActions, TaskFlags } from '../shared/tasks/TaskActions';
import { useCheckIn, useDaySchedule } from './appointments';
import { t } from '../../i18n';

/** Shift overview: my tasks, patients waiting, and my patients. */
export function NurseHome() {
  const user = useUser();
  const tasks = useQuery({
    queryKey: ['careTasks', 'mine', 'OPEN'],
    queryFn: () =>
      api<{ items: CareTask[] }>('/care-tasks', { query: { scope: 'mine', status: 'OPEN' } }),
  });
  const patients = useQuery({
    queryKey: ['patients', 'mine', '', 1, 'nurse-home'],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', { query: { scope: 'mine', pageSize: 8 } }),
  });
  const today = useDaySchedule();
  const checkIn = useCheckIn();

  const openTasks = tasks.data?.items ?? [];
  const overdue = openTasks.filter(isOverdue).length;
  const urgent = openTasks.filter((task) => task.priority === 'URGENT').length;
  const appts = today.data?.items ?? [];
  const waiting = appts.filter((a) => a.status === 'CHECKED_IN');
  const expected = appts.filter((a) => a.status === 'CONFIRMED');

  return (
    <>
      <PageHeader
        title={t('Shift overview')}
        subtitle={`${user.fullName}${user.facility ? ` · ${user.facility.name}` : ''}`}
        actions={
          <Link to="/tasks" className="btn btn-secondary btn-md">
            {t('All care tasks')}
          </Link>
        }
      />
      <div className="stack">
        <div className="kpi-grid">
          <Stat label={t('My open tasks')} value={tasks.data ? openTasks.length : '…'} />
          <Stat
            label={t('Overdue')}
            value={tasks.data ? overdue : '…'}
            tone={overdue ? 'danger' : 'success'}
          />
          <Stat
            label={t('Urgent')}
            value={tasks.data ? urgent : '…'}
            tone={urgent ? 'warning' : 'success'}
          />
          <Stat
            label={t('Patients in my care')}
            value={patients.data ? patients.data.total : '…'}
            tone="info"
          />
          <Stat
            label={t('Checked in, waiting')}
            value={today.data ? waiting.length : '…'}
            tone={waiting.length ? 'warning' : undefined}
            hint={
              today.data ? t('{count} still expected today', { count: expected.length }) : undefined
            }
          />
        </div>

        <div className="two-col">
          <Card title={t('My tasks')} actions={<Link to="/tasks">{t('View all')}</Link>}>
            <QueryView query={tasks}>
              {(d) =>
                d.items.length === 0 ? (
                  <EmptyState title={t('No open tasks')}>
                    {t('Nothing assigned to you right now.')}
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {d.items.slice(0, 10).map((task) => (
                      <li key={task.id}>
                        <div className="row-between">
                          <span>
                            <strong>{task.title}</strong> ·{' '}
                            <Link to={`/nurse/patients/${task.patientId}?tab=tasks`}>
                              {task.patientName}
                            </Link>
                          </span>
                          <TaskFlags task={task} />
                        </div>
                        {task.details && <div className="muted">{task.details}</div>}
                        <div className="row-between">
                          <span className="muted">
                            {t('Due')} <DueText task={task} /> ·{' '}
                            {t('from {name}', { name: task.createdByName })}
                          </span>
                          <TaskActions task={task} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              }
            </QueryView>
          </Card>

          <div className="stack">
            <Card
              title={t('Patients waiting')}
              actions={<Link to="/nurse/schedule">{t('Clinic schedule')}</Link>}
            >
              <ErrorAlert error={checkIn.error} />
              <QueryView query={today}>
                {() =>
                  waiting.length + expected.length === 0 ? (
                    <EmptyState title={t('No clinic appointments today')} />
                  ) : (
                    <ul className="list">
                      {waiting.map((a) => (
                        <li key={a.id} className="row-between">
                          <span>
                            <span className="mono">{formatTime(a.scheduledAt)}</span>{' '}
                            <Link to={`/nurse/patients/${a.patientId}`}>{a.patientName}</Link>
                            <div className="muted">
                              {a.doctorName} · {a.reason}
                            </div>
                          </span>
                          <StatusBadge value={a.status} />
                        </li>
                      ))}
                      {expected.map((a) => (
                        <li key={a.id} className="row-between">
                          <span>
                            <span className="mono">{formatTime(a.scheduledAt)}</span>{' '}
                            {a.patientName}
                            <div className="muted">
                              {a.doctorName} · {a.reason}
                            </div>
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={checkIn.isPending && checkIn.variables === a.id}
                            onClick={() => checkIn.mutate(a.id)}
                          >
                            {t('Check in')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )
                }
              </QueryView>
            </Card>

            <Card
              title={t('My patients')}
              actions={<Link to="/nurse/patients">{t('All patients')}</Link>}
            >
              <QueryView query={patients}>
                {(d) =>
                  d.items.length === 0 ? (
                    <EmptyState title={t('No patients in your care')}>
                      {t('Join a care team from the patient list.')}
                    </EmptyState>
                  ) : (
                    <ul className="list">
                      {d.items.map((p) => (
                        <li key={p.id} className="row-between">
                          <Link to={`/nurse/patients/${p.id}`}>{fullName(p)}</Link>
                          <span className="muted">
                            {t('{age} y', { age: age(p.dateOfBirth) })} · {humanize(p.sex)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )
                }
              </QueryView>
            </Card>
          </div>
        </div>

        <AnnouncementsCard />
      </div>
    </>
  );
}
