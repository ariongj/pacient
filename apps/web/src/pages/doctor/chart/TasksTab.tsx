import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../../api/client';
import type { CareTask, CareTeamMember } from '../../../api/types';
import {
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { DueText, TaskActions, TaskFlags } from '../../shared/tasks/TaskActions';
import { useChartMutation } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';

/** Care tasks for one patient: every task has an owner (a person or a role) and an explicit state. */
export function TasksTab({ patientId }: { patientId: string }) {
  const list = useSection<CareTask>(patientId, 'care-tasks');
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<'NURSE' | 'DOCTOR'>('NURSE');
  const team = useQuery({
    queryKey: ['patient', patientId, 'care-team'],
    queryFn: () =>
      api<{ items: CareTeamMember[] }>(`/patients/${patientId}/care-team`).then((r) => r.items),
    enabled: open,
  });
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/care-tasks', method: 'POST', body }),
    () => setOpen(false),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = compact(formValues(e.currentTarget));
    create.mutate({ ...v, dueAt: v.dueAt ? new Date(v.dueAt).toISOString() : undefined });
  }

  const assignees = (team.data ?? []).filter((m) => (m.role ?? 'DOCTOR') === role);

  return (
    <Card
      title={t('Care tasks')}
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          {t('New task')}
        </Button>
      }
    >
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No care tasks for this patient')} />
          ) : (
            <Table caption={t('Care tasks')}>
              <thead>
                <tr>
                  <th>{t('Task')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Due')}</th>
                  <th>{t('Assigned to')}</th>
                  <th>{t('Created by')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <strong>{task.title}</strong>
                      {task.details && <div className="muted">{task.details}</div>}
                      {task.completionNote && (
                        <div className="muted">
                          {task.status === 'CANCELLED' ? t('Cancelled') : t('Done')}:{' '}
                          {task.completionNote}
                          {task.completedByName && ` — ${task.completedByName}`}
                        </div>
                      )}
                    </td>
                    <td>
                      <TaskFlags task={task} />
                      {task.status === 'OPEN' && task.priority !== 'URGENT' && (
                        <span className="muted">{t('Open')}</span>
                      )}
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
      <Dialog open={open} onClose={() => setOpen(false)} title={t('New care task')} wide>
        <form onSubmit={onSubmit}>
          <TextField label={t('Task')} name="title" required minLength={3} maxLength={200} />
          <TextAreaField label={t('Details')} name="details" maxLength={4000} rows={3} />
          <div className="form-grid">
            <SelectField
              label={t('Priority')}
              name="priority"
              options={[
                { value: 'ROUTINE', label: t('Routine') },
                { value: 'URGENT', label: t('Urgent') },
              ]}
            />
            <TextField label={t('Due')} name="dueAt" type="datetime-local" />
            <SelectField
              label={t('Assign to role')}
              name="assignedRole"
              value={role}
              onChange={(e) => setRole(e.target.value as 'NURSE' | 'DOCTOR')}
              options={[
                { value: 'NURSE', label: t('Nursing team') },
                { value: 'DOCTOR', label: t('Doctors') },
              ]}
            />
            <SelectField
              label={t('Specific person (optional)')}
              name="assignedToId"
              placeholder={
                role === 'NURSE'
                  ? t('Anyone in the care team (nurses)')
                  : t('Anyone in the care team (doctors)')
              }
              options={assignees.map((m) => ({ value: m.doctorId, label: m.fullName }))}
            />
          </div>
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Create task')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
