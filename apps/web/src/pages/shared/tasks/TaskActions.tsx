import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../../api/client';
import type { CareTask } from '../../../api/types';
import { useUser } from '../../../auth/AuthContext';
import {
  Badge,
  Button,
  Dialog,
  ErrorAlert,
  StatusBadge,
  TextAreaField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';

/** Refreshes every view that may show care tasks (lists, chart tabs, home tiles). */
export function useTaskMutation(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      note,
    }: {
      id: string;
      action: 'complete' | 'cancel';
      note?: string;
    }) => api(`/care-tasks/${id}/${action}`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['careTasks'] });
      void qc.invalidateQueries({ queryKey: ['patient'] });
      onDone?.();
    },
  });
}

export function isOverdue(t: Pick<CareTask, 'status' | 'dueAt'>) {
  return t.status === 'OPEN' && t.dueAt !== null && new Date(t.dueAt).getTime() < Date.now();
}

/** Priority + overdue state, always with text (never colour alone). */
export function TaskFlags({ task }: { task: CareTask }) {
  return (
    <span className="row" style={{ gap: '0.3rem' }}>
      {task.priority === 'URGENT' && <StatusBadge value="URGENT" />}
      {isOverdue(task) && <Badge tone="danger">{t('Overdue')}</Badge>}
      {task.status !== 'OPEN' && <StatusBadge value={task.status} />}
    </span>
  );
}

export function DueText({ task }: { task: CareTask }) {
  if (!task.dueAt) return <span className="muted">{t('No due time')}</span>;
  return (
    <span className={isOverdue(task) ? 'error-text' : undefined}>{formatDateTime(task.dueAt)}</span>
  );
}

/**
 * Complete / cancel buttons with their dialogs. Completion takes an optional note; cancelling
 * requires a reason. Cancel is offered to doctors and to the task's creator (the API enforces it).
 */
export function TaskActions({ task }: { task: CareTask }) {
  const user = useUser();
  const [mode, setMode] = useState<'complete' | 'cancel' | null>(null);
  const mutation = useTaskMutation(() => setMode(null));
  if (task.status !== 'OPEN') return null;
  const mayCancel = user.role === 'DOCTOR' || task.createdById === user.id;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
    mutation.mutate({ id: task.id, action: mode!, note: note || undefined });
  }

  return (
    <>
      <div className="row" style={{ gap: '0.35rem' }}>
        <Button size="sm" onClick={() => setMode('complete')}>
          {t('Complete')}
        </Button>
        {mayCancel && (
          <Button size="sm" variant="ghost" onClick={() => setMode('cancel')}>
            {t('Cancel')}
          </Button>
        )}
      </div>
      <Dialog
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'cancel' ? t('Cancel task') : t('Complete task')}
      >
        <form onSubmit={onSubmit}>
          <p>
            <strong>{task.title}</strong>
            {task.patientName && <span className="muted"> · {task.patientName}</span>}
          </p>
          {task.details && <p className="muted">{task.details}</p>}
          <TextAreaField
            label={mode === 'cancel' ? t('Reason for cancelling') : t('Completion note (optional)')}
            name="note"
            required={mode === 'cancel'}
            minLength={mode === 'cancel' ? 3 : undefined}
            maxLength={2000}
            rows={3}
          />
          <ErrorAlert error={mutation.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setMode(null)}>
              {t('Back')}
            </Button>
            <Button
              type="submit"
              variant={mode === 'cancel' ? 'danger' : 'primary'}
              loading={mutation.isPending}
            >
              {mode === 'cancel' ? t('Cancel task') : t('Mark complete')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
