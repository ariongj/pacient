import { useState, type FormEvent, type ReactNode } from 'react';
import {
  eventLabel,
  kindLabel,
  priorityHint,
  priorityLabel,
  removalLabel,
  specialtyLabel,
  useAddToWaitingList,
  useWaitingAction,
  useWaitingEntry,
  useWaitingReference,
  waitingStatusLabel,
  type WaitingAction,
  type WaitingEntry,
  type WaitingPriority,
  type WaitingStatus,
} from '../../api/waiting';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  DefinitionList,
  Dialog,
  ErrorAlert,
  QueryView,
  SelectField,
  TextAreaField,
  TextField,
  formValues,
  type Tone,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';

const PRIORITY_TONE: Record<WaitingPriority, Tone> = {
  URGENT: 'danger',
  PRIORITY: 'warning',
  ROUTINE: 'neutral',
};
const STATUS_TONE: Record<WaitingStatus, Tone> = {
  WAITING: 'info',
  SCHEDULED: 'success',
  SUSPENDED: 'warning',
  COMPLETED: 'neutral',
  REMOVED: 'neutral',
};

export function PriorityBadge({ priority }: { priority: WaitingPriority }) {
  return <Badge tone={PRIORITY_TONE[priority]}>{priorityLabel(priority)}</Badge>;
}

export function WaitingStatusBadge({ status }: { status: WaitingStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{waitingStatusLabel(status)}</Badge>;
}

/** "62 of 90 days" with a breach badge when past the maximum. */
export function WaitBadge({
  e,
}: {
  e: Pick<WaitingEntry, 'waitingDays' | 'maxDays' | 'breached'>;
}) {
  return (
    <span className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
      <span>{t('{days} of {max} days', { days: e.waitingDays, max: e.maxDays })}</span>
      {e.breached && <Badge tone="danger">{t('Over the maximum wait')}</Badge>}
    </span>
  );
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

/** Entry details, history and the actions the user's role allows. */
export function WaitingEntryDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const entry = useWaitingEntry(id);
  return (
    <Dialog open={id !== null} onClose={onClose} title={t('Waiting list entry')} wide>
      <QueryView query={entry}>
        {(e) => (
          <div className="stack">
            <DefinitionList
              items={[
                [t('Patient'), e.patient ? `${e.patient.name} (${e.patient.nationalId})` : '—'],
                [t('Specialty'), specialtyLabel(e.specialty)],
                [t('Type'), kindLabel(e.kind)],
                [
                  t('Procedure'),
                  e.procedureCode ? `${e.procedureName} (${e.procedureCode})` : e.procedureName,
                ],
                [t('Priority'), <PriorityBadge key="p" priority={e.priority} />],
                [t('Status'), <WaitingStatusBadge key="s" status={e.status} />],
                [t('Added'), `${formatDate(e.addedAt)} · ${e.addedByName ?? '—'}`],
                [t('Waiting time'), <WaitBadge key="w" e={e} />],
                [t('Target date'), formatDate(e.targetDate)],
                ...(e.suspendedDays
                  ? ([[t('Days postponed'), String(e.suspendedDays)]] as [string, string][])
                  : []),
                ...(e.scheduledFor
                  ? ([
                      [
                        t('Scheduled for'),
                        <span key="sf" className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                          {formatDateTime(e.scheduledFor)}
                          {e.scheduledAfterTarget && (
                            <Badge tone="warning">{t('After the target date')}</Badge>
                          )}
                        </span>,
                      ],
                    ] as [string, ReactNode][])
                  : []),
                ...(e.clinicalReason
                  ? ([[t('Clinical reason'), e.clinicalReason]] as [string, string][])
                  : []),
              ]}
            />
            <EntryActions entry={e} />
            <section>
              <h3>{t('History')}</h3>
              <ol className="stack" style={{ gap: '0.35rem', paddingLeft: '1.2rem' }}>
                {e.events.map((ev) => (
                  <li key={ev.id}>
                    <strong>{eventLabel(ev.event)}</strong> · {formatDateTime(ev.createdAt)}
                    {ev.actorName ? ` · ${ev.actorName}` : ''}
                    {ev.reason && <div className="muted">{ev.reason}</div>}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

type Pending = WaitingAction | null;

function EntryActions({ entry }: { entry: WaitingEntry }) {
  const user = useUser();
  const action = useWaitingAction();
  const ref = useWaitingReference();
  const [open, setOpen] = useState<Pending>(null);
  const canOperate = user.role === 'DOCTOR' || user.role === 'RECEPTION';
  const isDoctor = user.role === 'DOCTOR';
  if (!canOperate) return null;
  const active = ['WAITING', 'SCHEDULED', 'SUSPENDED'].includes(entry.status);
  if (!active) return null;

  const run = (a: WaitingAction, body?: Record<string, unknown>) =>
    action.mutate(
      { id: entry.id, action: a, body },
      {
        onSuccess: () => setOpen(null),
      },
    );

  const submit = (a: WaitingAction) => (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const v = formValues(ev.currentTarget);
    if (a === 'schedule') run(a, { scheduledFor: toIso(v.scheduledFor ?? '') });
    else if (a === 'priority') run(a, { priority: v.priority, reason: v.reason });
    else if (a === 'remove') run(a, { reasonCode: v.reasonCode, reason: v.reason || undefined });
    else if (a === 'complete') run(a, v.completedAt ? { completedAt: toIso(v.completedAt) } : {});
    else run(a, { reason: v.reason });
  };

  const reasons = (ref.data?.removalReasons ?? []).filter((r) => isDoctor || !r.clinical);

  return (
    <section className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        {entry.status !== 'SUSPENDED' && (
          <Button size="sm" onClick={() => setOpen('schedule')}>
            {entry.status === 'SCHEDULED' ? t('Reschedule') : t('Schedule|action')}
          </Button>
        )}
        {entry.status === 'SCHEDULED' && (
          <Button size="sm" variant="secondary" onClick={() => setOpen('unschedule')}>
            {t('Cancel the date')}
          </Button>
        )}
        {entry.status !== 'SUSPENDED' ? (
          <Button size="sm" variant="secondary" onClick={() => setOpen('suspend')}>
            {t('Postpone (patient’s request)')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={action.isPending}
            onClick={() => run('resume')}
          >
            {t('Resume')}
          </Button>
        )}
        {isDoctor && (
          <Button size="sm" variant="secondary" onClick={() => setOpen('priority')}>
            {t('Change priority')}
          </Button>
        )}
        {entry.status !== 'SUSPENDED' && (
          <Button size="sm" variant="secondary" onClick={() => setOpen('complete')}>
            {t('Mark as treated')}
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => setOpen('remove')}>
          {t('Remove from the list')}
        </Button>
      </div>
      {open === null && <ErrorAlert error={action.error} />}

      {open && (
        <form className="card stack" onSubmit={submit(open)}>
          {open === 'schedule' && (
            <TextField
              label={t('Date and time')}
              name="scheduledFor"
              type="datetime-local"
              required
              hint={t(
                'Target date {date}. The patient is told the date and the facility, never the procedure.',
                { date: formatDate(entry.targetDate) },
              )}
            />
          )}
          {open === 'priority' && (
            <SelectField
              label={t('New priority')}
              name="priority"
              required
              defaultValue={entry.priority}
              options={(ref.data?.priorities ?? []).map((p) => ({
                value: p.code,
                label: priorityHint(p.code, p.maxDays),
              }))}
            />
          )}
          {open === 'remove' && (
            <SelectField
              label={t('Reason for removal')}
              name="reasonCode"
              required
              options={reasons.map((r) => ({ value: r.code, label: removalLabel(r.code) }))}
            />
          )}
          {open === 'complete' && (
            <TextField
              label={t('Treated on')}
              name="completedAt"
              type="datetime-local"
              hint={t('Leave empty for now')}
            />
          )}
          {(open === 'unschedule' ||
            open === 'suspend' ||
            open === 'priority' ||
            open === 'remove') && (
            <TextAreaField
              label={t('Reason')}
              name="reason"
              required={open !== 'remove'}
              minLength={open === 'remove' ? undefined : 3}
              maxLength={500}
              rows={2}
              hint={
                open === 'suspend'
                  ? t('The waiting-time clock pauses until the entry is resumed.')
                  : undefined
              }
            />
          )}
          <ErrorAlert error={action.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={action.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Add a patient to a waiting list of the doctor's facility (from the chart). */
export function AddToWaitingListDialog({
  patientId,
  open,
  onClose,
}: {
  patientId: string;
  open: boolean;
  onClose: () => void;
}) {
  const ref = useWaitingReference();
  const add = useAddToWaitingList();
  const [priority, setPriority] = useState<WaitingPriority>('ROUTINE');
  const onSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const v = formValues(ev.currentTarget);
    add.mutate(
      {
        patientId,
        specialty: v.specialty,
        kind: v.kind,
        procedureName: v.procedureName,
        procedureCode: v.procedureCode || undefined,
        priority: v.priority,
        clinicalReason: v.clinicalReason || undefined,
      },
      { onSuccess: onClose },
    );
  };
  const max = ref.data?.priorities.find((p) => p.code === priority)?.maxDays;
  return (
    <Dialog open={open} onClose={onClose} title={t('Add to a waiting list')} wide>
      <form onSubmit={onSubmit} className="stack">
        <div className="form-grid">
          <SelectField
            label={t('Specialty')}
            name="specialty"
            required
            placeholder={t('Choose…')}
            options={(ref.data?.specialties ?? [])
              .map((s) => ({ value: s.code, label: specialtyLabel(s.code) }))
              .sort((a, b) => a.label.localeCompare(b.label))}
          />
          <SelectField
            label={t('Type')}
            name="kind"
            defaultValue="PROCEDURE"
            options={(['PROCEDURE', 'OUTPATIENT'] as const).map((k) => ({
              value: k,
              label: kindLabel(k),
            }))}
          />
          <TextField
            label={t('Procedure or consultation')}
            name="procedureName"
            required
            minLength={3}
            maxLength={200}
          />
          <TextField label={t('Procedure code (optional)')} name="procedureCode" maxLength={20} />
          <SelectField
            label={t('Priority')}
            name="priority"
            required
            value={priority}
            onChange={(e) => setPriority(e.target.value as WaitingPriority)}
            options={(ref.data?.priorities ?? []).map((p) => ({
              value: p.code,
              label: priorityHint(p.code, p.maxDays),
            }))}
          />
        </div>
        {max !== undefined && (
          <Alert tone="info">
            {t('Target: treated within {days} days of today (maximum waiting time).', {
              days: max,
            })}
          </Alert>
        )}
        <TextAreaField
          label={t('Clinical reason')}
          name="clinicalReason"
          maxLength={2000}
          rows={3}
          hint={t('Visible to the treating care team only.')}
        />
        <ErrorAlert error={add.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={add.isPending}>
            {t('Add to the list')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
