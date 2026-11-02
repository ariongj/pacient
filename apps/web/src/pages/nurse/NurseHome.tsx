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
  const urgent = openTasks.filter((t) => t.priority === 'URGENT').length;
  const appts = today.data?.items ?? [];
  const waiting = appts.filter((a) => a.status === 'CHECKED_IN');
  const expected = appts.filter((a) => a.status === 'CONFIRMED');

  return (
    <>
      <PageHeader
        title="Shift overview"
        subtitle={`${user.fullName}${user.facility ? ` · ${user.facility.name}` : ''}`}
        actions={
          <Link to="/tasks" className="btn btn-secondary btn-md">
            All care tasks
          </Link>
        }
      />
      <div className="stack">
        <div className="kpi-grid">
          <Stat label="My open tasks" value={tasks.data ? openTasks.length : '…'} />
          <Stat
            label="Overdue"
            value={tasks.data ? overdue : '…'}
            tone={overdue ? 'danger' : 'success'}
          />
          <Stat
            label="Urgent"
            value={tasks.data ? urgent : '…'}
            tone={urgent ? 'warning' : 'success'}
          />
          <Stat
            label="Patients in my care"
            value={patients.data ? patients.data.total : '…'}
            tone="info"
          />
          <Stat
            label="Checked in, waiting"
            value={today.data ? waiting.length : '…'}
            tone={waiting.length ? 'warning' : undefined}
            hint={today.data ? `${expected.length} still expected today` : undefined}
          />
        </div>

        <div className="two-col">
          <Card title="My tasks" actions={<Link to="/tasks">View all</Link>}>
            <QueryView query={tasks}>
              {(d) =>
                d.items.length === 0 ? (
                  <EmptyState title="No open tasks">Nothing assigned to you right now.</EmptyState>
                ) : (
                  <ul className="list">
                    {d.items.slice(0, 10).map((t) => (
                      <li key={t.id}>
                        <div className="row-between">
                          <span>
                            <strong>{t.title}</strong> ·{' '}
                            <Link to={`/nurse/patients/${t.patientId}?tab=tasks`}>
                              {t.patientName}
                            </Link>
                          </span>
                          <TaskFlags task={t} />
                        </div>
                        {t.details && <div className="muted">{t.details}</div>}
                        <div className="row-between">
                          <span className="muted">
                            Due <DueText task={t} /> · from {t.createdByName}
                          </span>
                          <TaskActions task={t} />
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
              title="Patients waiting"
              actions={<Link to="/nurse/schedule">Clinic schedule</Link>}
            >
              <ErrorAlert error={checkIn.error} />
              <QueryView query={today}>
                {() =>
                  waiting.length + expected.length === 0 ? (
                    <EmptyState title="No clinic appointments today" />
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
                            Check in
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )
                }
              </QueryView>
            </Card>

            <Card title="My patients" actions={<Link to="/nurse/patients">All patients</Link>}>
              <QueryView query={patients}>
                {(d) =>
                  d.items.length === 0 ? (
                    <EmptyState title="No patients in your care">
                      Join a care team from the patient list.
                    </EmptyState>
                  ) : (
                    <ul className="list">
                      {d.items.map((p) => (
                        <li key={p.id} className="row-between">
                          <Link to={`/nurse/patients/${p.id}`}>{fullName(p)}</Link>
                          <span className="muted">
                            {age(p.dateOfBirth)} y · {humanize(p.sex)}
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
