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
import { formatDateTime, humanize } from '../../../format';
import { DueText, TaskActions, TaskFlags } from '../../shared/tasks/TaskActions';
import { useChartMutation } from './shared';
import { useSection } from './useSection';

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
      title="Care tasks"
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          New task
        </Button>
      }
    >
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No care tasks for this patient" />
          ) : (
            <Table caption="Care tasks">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Assigned to</th>
                  <th>Created by</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.title}</strong>
                      {t.details && <div className="muted">{t.details}</div>}
                      {t.completionNote && (
                        <div className="muted">
                          {t.status === 'CANCELLED' ? 'Cancelled' : 'Done'}: {t.completionNote}
                          {t.completedByName && ` — ${t.completedByName}`}
                        </div>
                      )}
                    </td>
                    <td>
                      <TaskFlags task={t} />
                      {t.status === 'OPEN' && t.priority !== 'URGENT' && (
                        <span className="muted">Open</span>
                      )}
                    </td>
                    <td>
                      <DueText task={t} />
                    </td>
                    <td>{t.assignedToName ?? `Any ${humanize(t.assignedRole).toLowerCase()}`}</td>
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
      <Dialog open={open} onClose={() => setOpen(false)} title="New care task" wide>
        <form onSubmit={onSubmit}>
          <TextField label="Task" name="title" required minLength={3} maxLength={200} />
          <TextAreaField label="Details" name="details" maxLength={4000} rows={3} />
          <div className="form-grid">
            <SelectField
              label="Priority"
              name="priority"
              options={[
                { value: 'ROUTINE', label: 'Routine' },
                { value: 'URGENT', label: 'Urgent' },
              ]}
            />
            <TextField label="Due" name="dueAt" type="datetime-local" />
            <SelectField
              label="Assign to role"
              name="assignedRole"
              value={role}
              onChange={(e) => setRole(e.target.value as 'NURSE' | 'DOCTOR')}
              options={[
                { value: 'NURSE', label: 'Nursing team' },
                { value: 'DOCTOR', label: 'Doctors' },
              ]}
            />
            <SelectField
              label="Specific person (optional)"
              name="assignedToId"
              placeholder={`Anyone in the care team (${role === 'NURSE' ? 'nurses' : 'doctors'})`}
              options={assignees.map((m) => ({ value: m.doctorId, label: m.fullName }))}
            />
          </div>
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create task
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
