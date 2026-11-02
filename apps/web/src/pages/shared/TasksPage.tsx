import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { CareTask } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Card,
  EmptyState,
  PageHeader,
  QueryView,
  SelectField,
  TabPanel,
  Table,
  Tabs,
} from '../../components/ui';
import { formatDateTime, humanize } from '../../format';
import { DueText, TaskActions, TaskFlags } from './tasks/TaskActions';

type Scope = 'mine' | 'team';
type Status = CareTask['status'];

/** Care tasks across the clinician's patients (doctors and nurses). */
export function TasksPage() {
  const user = useUser();
  const base = user.role === 'NURSE' ? '/nurse' : '/doctor';
  const [scope, setScope] = useState<Scope>('mine');
  const [status, setStatus] = useState<Status>('OPEN');
  const list = useQuery({
    queryKey: ['careTasks', scope, status],
    queryFn: () => api<{ items: CareTask[] }>('/care-tasks', { query: { scope, status } }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Care tasks"
        subtitle="Every task has an owner and stays open until someone explicitly completes or cancels it."
      />
      <Card>
        <div className="row-between">
          <Tabs<Scope>
            label="Task scope"
            active={scope}
            onChange={setScope}
            tabs={[
              { id: 'mine', label: 'Assigned to me' },
              { id: 'team', label: 'My patients’ tasks' },
            ]}
          />
          <div style={{ minWidth: 180 }}>
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
              options={[
                { value: 'OPEN', label: 'Open' },
                { value: 'DONE', label: 'Done' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ]}
            />
          </div>
        </div>
        <TabPanel id={scope}>
          <QueryView query={list}>
            {(d) =>
              d.items.length === 0 ? (
                <EmptyState title={status === 'OPEN' ? 'Nothing outstanding' : 'No tasks'}>
                  {scope === 'mine'
                    ? 'Tasks assigned to you, or to your role in your patients’ care teams, appear here.'
                    : 'Tasks for patients in your care teams appear here.'}
                </EmptyState>
              ) : (
                <Table caption="Care tasks">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Patient</th>
                      <th>Flags</th>
                      <th>Due</th>
                      <th>Assigned to</th>
                      <th>Created by</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.title}</strong>
                          {t.details && <div className="muted">{t.details}</div>}
                        </td>
                        <td>
                          <Link to={`${base}/patients/${t.patientId}?tab=tasks`}>
                            {t.patientName}
                          </Link>
                        </td>
                        <td>
                          <TaskFlags task={t} />
                        </td>
                        <td>
                          <DueText task={t} />
                        </td>
                        <td>
                          {t.assignedToName ?? `Any ${humanize(t.assignedRole).toLowerCase()}`}
                        </td>
                        <td>
                          {t.createdByName}
                          <div className="muted">{formatDateTime(t.createdAt)}</div>
                        </td>
                        <td>
                          <TaskActions task={t} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )
            }
          </QueryView>
        </TabPanel>
      </Card>
    </>
  );
}
