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
import { formatDateTime } from '../../format';
import { DueText, TaskActions, TaskFlags } from './tasks/TaskActions';
import { t } from '../../i18n';

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
        title={t('Care tasks')}
        subtitle={t(
          'Every task has an owner and stays open until someone explicitly completes or cancels it.',
        )}
      />
      <Card>
        <div className="row-between">
          <Tabs<Scope>
            label={t('Task scope')}
            active={scope}
            onChange={setScope}
            tabs={[
              { id: 'mine', label: t('Assigned to me') },
              { id: 'team', label: t('My patients’ tasks') },
            ]}
          />
          <div style={{ minWidth: 180 }}>
            <SelectField
              label={t('Status')}
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
              options={[
                { value: 'OPEN', label: t('Open') },
                { value: 'DONE', label: t('Done') },
                { value: 'CANCELLED', label: t('Cancelled') },
              ]}
            />
          </div>
        </div>
        <TabPanel id={scope}>
          <QueryView query={list}>
            {(d) =>
              d.items.length === 0 ? (
                <EmptyState title={status === 'OPEN' ? t('Nothing outstanding') : t('No tasks')}>
                  {scope === 'mine'
                    ? t(
                        'Tasks assigned to you, or to your role in your patients’ care teams, appear here.',
                      )
                    : t('Tasks for patients in your care teams appear here.')}
                </EmptyState>
              ) : (
                <Table caption={t('Care tasks')}>
                  <thead>
                    <tr>
                      <th>{t('Task')}</th>
                      <th>{t('Patient')}</th>
                      <th>{t('Flags')}</th>
                      <th>{t('Due')}</th>
                      <th>{t('Assigned to')}</th>
                      <th>{t('Created by')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <strong>{task.title}</strong>
                          {task.details && <div className="muted">{task.details}</div>}
                        </td>
                        <td>
                          <Link to={`${base}/patients/${task.patientId}?tab=tasks`}>
                            {task.patientName}
                          </Link>
                        </td>
                        <td>
                          <TaskFlags task={task} />
                        </td>
                        <td>
                          <DueText task={task} />
                        </td>
                        <td>
                          {task.assignedToName ??
                            (task.assignedRole === 'NURSE' ? t('Any nurse') : t('Any doctor'))}
                        </td>
                        <td>
                          {task.createdByName}
                          <div className="muted">{formatDateTime(task.createdAt)}</div>
                        </td>
                        <td>
                          <TaskActions task={task} />
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
