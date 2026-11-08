import { useState, type FormEvent } from 'react';
import {
  episodeStatusLabel,
  FREQUENCIES,
  frequencyLabel,
  HOME_CARE_TASKS,
  taskLabel,
  useEpisode,
  useHomeCareAction,
  useTeamMembers,
  useTeams,
  visitStatusLabel,
  type EpisodeStatus,
  type Frequency,
  type HomeCareTask,
  type HomeVisit,
  type VisitStatus,
} from '../../api/homecare';
import {
  Alert,
  Badge,
  Button,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';

const EPISODE_TONE: Record<EpisodeStatus, 'info' | 'success' | 'warning' | 'neutral'> = {
  REFERRED: 'info',
  ACTIVE: 'success',
  ON_HOLD: 'warning',
  DISCHARGED: 'neutral',
};

export function EpisodeStatusBadge({ status }: { status: EpisodeStatus }) {
  return <Badge tone={EPISODE_TONE[status]}>{episodeStatusLabel(status)}</Badge>;
}

const VISIT_TONE: Record<VisitStatus, 'info' | 'success' | 'danger' | 'neutral'> = {
  PLANNED: 'info',
  DONE: 'success',
  MISSED: 'danger',
  CANCELLED: 'neutral',
};

/** Status plus the lone-working and lateness flags (text, not colour only). */
export function VisitStatusBadge({ v }: { v: HomeVisit }) {
  return (
    <span className="stack" style={{ gap: '0.2rem' }}>
      {v.checkOutOverdue ? (
        <Badge tone="danger">{t('No check-out after 2 hours')}</Badge>
      ) : v.inProgress ? (
        <Badge tone="warning">{t('In progress')}</Badge>
      ) : (
        <Badge tone={VISIT_TONE[v.status]}>{visitStatusLabel(v.status)}</Badge>
      )}
      {v.late && <Badge tone="warning">{t('Not started on time')}</Badge>}
    </span>
  );
}

export const taskList = (tasks: string[]) => (tasks.length ? tasks.map(taskLabel).join(', ') : '—');

/** Checkboxes for the home care tasks (a fieldset with a legend for screen readers). */
export function TaskChecklist({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: HomeCareTask[];
  onChange: (tasks: HomeCareTask[]) => void;
}) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 600, marginBottom: '0.35rem' }}>{legend}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem' }}>
        {HOME_CARE_TASKS.map((task) => (
          <label key={task} className="checkbox">
            <input
              type="checkbox"
              checked={value.includes(task)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, task] : value.filter((x) => x !== task))
              }
            />
            {taskLabel(task)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);
const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* ------------------------------------------------------------------ referral ------------- */

export function ReferDialog({
  patientId,
  defaultAddress,
  open,
  onClose,
  fromDischarge,
}: {
  patientId: string;
  defaultAddress: string | null;
  open: boolean;
  onClose: () => void;
  fromDischarge?: boolean;
}) {
  const teams = useTeams(open ? patientId : undefined);
  const [tasks, setTasks] = useState<HomeCareTask[]>([]);
  const refer = useHomeCareAction((body: Record<string, unknown>) => ({
    path: `/home-care/patients/${patientId}/episodes`,
    body,
  }));
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    refer.mutate(
      {
        teamUnitId: f.get('teamUnitId'),
        reason: f.get('reason'),
        tasks,
        goals: f.get('goals') || undefined,
        visitAddress: f.get('visitAddress') || undefined,
        accessNotes: f.get('accessNotes') || undefined,
      },
      {
        onSuccess: () => {
          setTasks([]);
          onClose();
        },
      },
    );
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={fromDischarge ? t('Refer to home care at discharge') : t('Refer to home care')}
      wide
    >
      <QueryView query={teams}>
        {(data) =>
          data.teams.length === 0 ? (
            <EmptyState title={t('No community nursing team')}>
              {t(
                'Neither your facility nor the patient’s registered facility has a community nursing team in Pacient.',
              )}
            </EmptyState>
          ) : (
            <form className="stack" onSubmit={onSubmit}>
              <SelectField
                label={t('Community nursing team')}
                name="teamUnitId"
                required
                options={data.teams.map((tm) => ({
                  value: tm.id,
                  label: `${tm.name} – ${tm.facilityName}`,
                }))}
              />
              <TextField
                label={t('Reason for referral')}
                name="reason"
                required
                minLength={5}
                maxLength={300}
              />
              <TaskChecklist
                legend={t('What the patient needs')}
                value={tasks}
                onChange={setTasks}
              />
              <TextAreaField
                label={t('Goals of care')}
                name="goals"
                rows={3}
                maxLength={4000}
                hint={t('What the visits should achieve, agreed with the patient.')}
              />
              <div className="form-grid">
                <TextField
                  label={t('Address for visits')}
                  name="visitAddress"
                  defaultValue={defaultAddress ?? ''}
                  required={!defaultAddress}
                  maxLength={300}
                />
                <TextField
                  label={t('Access notes')}
                  name="accessNotes"
                  maxLength={300}
                  hint={t('e.g. floor, door code, who has the key')}
                />
              </div>
              {tasks.length === 0 && <p className="muted">{t('Choose at least one need.')}</p>}
              <ErrorAlert error={refer.error} />
              <div className="form-actions">
                <Button variant="secondary" onClick={onClose}>
                  {t('Cancel')}
                </Button>
                <Button type="submit" loading={refer.isPending} disabled={tasks.length === 0}>
                  {t('Refer')}
                </Button>
              </div>
            </form>
          )
        }
      </QueryView>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ visit actions -------- */

type VisitDialog = { kind: 'complete' | 'missed' | 'cancel' | 'edit'; visit: HomeVisit } | null;

export function VisitActions({
  visit,
  onOpen,
}: {
  visit: HomeVisit;
  onOpen: (d: NonNullable<VisitDialog>) => void;
}) {
  const checkIn = useHomeCareAction(() => ({ path: `/home-care/visits/${visit.id}/check-in` }));
  if (visit.status !== 'PLANNED') return null;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
      {!visit.startedAt && (
        <Button size="sm" loading={checkIn.isPending} onClick={() => checkIn.mutate({})}>
          {t('Check in|home visit')}
        </Button>
      )}
      <Button
        size="sm"
        variant={visit.startedAt ? 'primary' : 'secondary'}
        onClick={() => onOpen({ kind: 'complete', visit })}
      >
        {visit.startedAt ? t('Check out and record') : t('Record visit')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onOpen({ kind: 'missed', visit })}>
        {t('Missed|visit action')}
      </Button>
      {!visit.startedAt && (
        <>
          <Button size="sm" variant="ghost" onClick={() => onOpen({ kind: 'edit', visit })}>
            {t('Change|visit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpen({ kind: 'cancel', visit })}>
            {t('Cancel visit')}
          </Button>
        </>
      )}
      {checkIn.error ? <ErrorAlert error={checkIn.error} /> : null}
    </span>
  );
}

const OBS_FIELDS: [string, string, number, number, string?][] = [
  ['systolic', 'Systolic BP', 40, 300],
  ['diastolic', 'Diastolic BP', 20, 200],
  ['heartRate', 'Pulse', 20, 300],
  ['respiratoryRate', 'Respiratory rate', 4, 80],
  ['oxygenSaturation', 'SpO₂ (%)', 30, 100],
  ['temperatureC', 'Temperature (°C)', 25, 45, '0.1'],
];

export function VisitDialogs({
  dialog,
  onClose,
  teamId,
}: {
  dialog: VisitDialog;
  onClose: () => void;
  teamId: string | null;
}) {
  const v = dialog?.visit;
  const [tasks, setTasks] = useState<HomeCareTask[]>([]);
  const [news, setNews] = useState<{ scale: string; score: number; risk: string } | null>(null);
  const members = useTeamMembers(dialog?.kind === 'edit' ? teamId : null);
  const action = useHomeCareAction(
    (body: { path: string; method?: 'POST' | 'PATCH'; body: unknown }) => body,
  );
  const close = () => {
    action.reset();
    setNews(null);
    onClose();
  };
  if (!dialog || !v) return null;
  const submit = (path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST') =>
    action.mutate(
      { path, method, body },
      {
        onSuccess: (r) => {
          const n = (r as { news?: { scale: string; score: number; risk: string } | null }).news;
          if (n) setNews(n);
          else close();
        },
      },
    );
  if (news) {
    return (
      <Dialog open onClose={close} title={t('Visit recorded')}>
        <Alert
          tone={news.risk === 'HIGH' || news.risk === 'MEDIUM' ? 'danger' : 'info'}
          title={`${news.scale} ${news.score}`}
        >
          {news.risk === 'HIGH' || news.risk === 'MEDIUM'
            ? t(
                'The early warning score is raised. Contact the patient’s doctor or emergency services now.',
              )
            : t('The observations were saved to the patient’s vital signs.')}
        </Alert>
        <div className="form-actions">
          <Button onClick={close}>{t('Close')}</Button>
        </div>
      </Dialog>
    );
  }
  if (dialog.kind === 'complete') {
    return (
      <Dialog open onClose={close} title={t('Record the home visit')} wide>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const observations: Record<string, unknown> = {};
            for (const [name] of OBS_FIELDS) {
              const value = String(f.get(name) ?? '');
              if (value) observations[name] = Number(value);
            }
            const consciousness = String(f.get('consciousness') ?? '');
            if (consciousness) observations.consciousness = consciousness;
            if (Object.keys(observations).length)
              observations.onSupplementalOxygen = f.get('oxygen') === 'on';
            submit(`/home-care/visits/${v.id}/complete`, {
              notes: f.get('notes'),
              tasksDone: tasks,
              observations: Object.keys(observations).length ? observations : undefined,
            });
          }}
        >
          <TaskChecklist
            legend={t('Care given')}
            value={tasks.length ? tasks : v.tasks}
            onChange={setTasks}
          />
          <TextAreaField
            label={t('Visit notes')}
            name="notes"
            required
            minLength={3}
            maxLength={4000}
            rows={4}
          />
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600 }}>{t('Observations (optional)')}</legend>
            <p className="muted">
              {t('Saved to the patient’s vital signs and scored for early warning.')}
            </p>
            <div className="form-grid">
              {OBS_FIELDS.map(([name, label, min, max, step]) => (
                <TextField
                  key={name}
                  label={t(label)}
                  name={name}
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                />
              ))}
              <SelectField
                label={t('Consciousness (ACVPU)')}
                name="consciousness"
                placeholder={t('Not recorded')}
                options={['A', 'C', 'V', 'P', 'U'].map((l) => ({ value: l, label: l }))}
              />
            </div>
            <label className="checkbox">
              <input type="checkbox" name="oxygen" /> {t('On supplemental oxygen')}
            </label>
          </fieldset>
          <ErrorAlert error={action.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={action.isPending}>
              {t('Save visit')}
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }
  if (dialog.kind === 'edit') {
    return (
      <Dialog open onClose={close} title={t('Change the visit')}>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            submit(
              `/home-care/visits/${v.id}`,
              {
                scheduledFor: toIso(String(f.get('scheduledFor') ?? '')),
                assignedToId: f.get('assignedToId') || null,
              },
              'PATCH',
            );
          }}
        >
          <TextField
            label={t('Date and time')}
            name="scheduledFor"
            type="datetime-local"
            defaultValue={localInput(new Date(v.scheduledFor))}
            required
          />
          <SelectField
            label={t('Nurse')}
            name="assignedToId"
            placeholder={t('Not assigned')}
            defaultValue={v.assignedToId ?? ''}
            options={(members.data?.items ?? []).map((m) => ({ value: m.id, label: m.name }))}
          />
          <ErrorAlert error={action.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={action.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }
  const missed = dialog.kind === 'missed';
  return (
    <Dialog
      open
      onClose={close}
      title={missed ? t('Record a missed visit') : t('Cancel the visit')}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          submit(`/home-care/visits/${v.id}/${missed ? 'missed' : 'cancel'}`, {
            reason: f.get('reason'),
          });
        }}
      >
        {missed && (
          <p className="muted">
            {t(
              'If the visit included medication, injections or palliative care, the referring doctor and the team are told.',
            )}
          </p>
        )}
        <TextAreaField
          label={t('Reason')}
          name="reason"
          required
          minLength={3}
          maxLength={300}
          rows={2}
        />
        <ErrorAlert error={action.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Back')}
          </Button>
          <Button type="submit" variant="danger" loading={action.isPending}>
            {missed ? t('Record as missed') : t('Cancel visit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ episode -------------- */

type EpisodeAction = 'plan' | 'schedule' | 'hold' | 'discharge' | null;

/** One episode: details, care plan, visits and the team's actions. */
export function EpisodeDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const episode = useEpisode(id);
  const [action, setAction] = useState<EpisodeAction>(null);
  const [visitDialog, setVisitDialog] = useState<VisitDialog>(null);
  const [tasks, setTasks] = useState<HomeCareTask[] | null>(null);
  const [frequency, setFrequency] = useState<Frequency>('ONCE');
  const accept = useHomeCareAction(() => ({ path: `/home-care/episodes/${id}/accept` }));
  const resume = useHomeCareAction(() => ({ path: `/home-care/episodes/${id}/resume` }));
  const change = useHomeCareAction(
    (body: { path: string; method?: 'POST' | 'PATCH'; body: unknown }) => body,
  );
  const members = useTeamMembers(episode.data?.isMyTeam ? episode.data.teamUnitId : null);
  const done = () => {
    setAction(null);
    setTasks(null);
    change.reset();
  };
  return (
    <Dialog open={Boolean(id)} onClose={onClose} title={t('Home care episode')} wide>
      <QueryView query={episode}>
        {(e) => {
          const open = e.status !== 'DISCHARGED';
          const team = e.isMyTeam;
          return (
            <div className="stack">
              <DefinitionList
                items={[
                  [
                    t('Patient'),
                    `${e.patient.firstName} ${e.patient.lastName} (${e.patient.nationalId})`,
                  ],
                  [t('Status'), <EpisodeStatusBadge key="s" status={e.status} />],
                  [t('Team'), `${e.teamName} – ${e.teamFacilityName}`],
                  [t('Referred by'), `${e.referredBy ?? '—'}, ${formatDate(e.createdAt)}`],
                  [t('Reason for referral'), e.reason],
                  [t('Address for visits'), e.visitAddress],
                  [t('Access notes'), e.accessNotes],
                  [t('Telephone'), e.patient.phone],
                  [t('Needs'), taskList(e.carePlan.tasks)],
                  [t('Goals of care'), e.carePlan.goals || '—'],
                  ...(e.endedAt
                    ? ([[t('Ended'), `${formatDate(e.endedAt)} – ${e.endReason ?? ''}`]] as [
                        string,
                        string,
                      ][])
                    : []),
                ]}
              />
              {open && (
                <div
                  className="form-actions"
                  style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}
                >
                  {team && e.status === 'REFERRED' && (
                    <Button loading={accept.isPending} onClick={() => accept.mutate({})}>
                      {t('Accept referral')}
                    </Button>
                  )}
                  {team && e.status === 'ACTIVE' && (
                    <Button onClick={() => setAction('schedule')}>{t('Plan visits')}</Button>
                  )}
                  <Button variant="secondary" onClick={() => setAction('plan')}>
                    {t('Edit care plan')}
                  </Button>
                  {team && e.status === 'ACTIVE' && (
                    <Button variant="secondary" onClick={() => setAction('hold')}>
                      {t('Put on hold')}
                    </Button>
                  )}
                  {team && e.status === 'ON_HOLD' && (
                    <Button
                      variant="secondary"
                      loading={resume.isPending}
                      onClick={() => resume.mutate({})}
                    >
                      {t('Resume')}
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => setAction('discharge')}>
                    {e.status === 'REFERRED'
                      ? t('Close the referral')
                      : t('Discharge from home care')}
                  </Button>
                </div>
              )}
              <ErrorAlert error={accept.error ?? resume.error} />

              {action === 'plan' && (
                <form
                  className="stack card"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    const f = new FormData(ev.currentTarget);
                    change.mutate(
                      {
                        path: `/home-care/episodes/${e.id}/care-plan`,
                        method: 'PATCH',
                        body: {
                          goals: f.get('goals'),
                          tasks: tasks ?? e.carePlan.tasks,
                          visitAddress: f.get('visitAddress') || undefined,
                          accessNotes: f.get('accessNotes') ?? null,
                        },
                      },
                      { onSuccess: done },
                    );
                  }}
                >
                  <TaskChecklist
                    legend={t('Needs')}
                    value={tasks ?? e.carePlan.tasks}
                    onChange={setTasks}
                  />
                  <TextAreaField
                    label={t('Goals of care')}
                    name="goals"
                    rows={3}
                    defaultValue={e.carePlan.goals}
                    maxLength={4000}
                  />
                  <div className="form-grid">
                    <TextField
                      label={t('Address for visits')}
                      name="visitAddress"
                      defaultValue={e.visitAddress ?? ''}
                      maxLength={300}
                    />
                    <TextField
                      label={t('Access notes')}
                      name="accessNotes"
                      defaultValue={e.accessNotes ?? ''}
                      maxLength={300}
                    />
                  </div>
                  <ErrorAlert error={change.error} />
                  <div className="form-actions">
                    <Button variant="secondary" onClick={done}>
                      {t('Cancel')}
                    </Button>
                    <Button type="submit" loading={change.isPending}>
                      {t('Save')}
                    </Button>
                  </div>
                </form>
              )}

              {action === 'schedule' && (
                <form
                  className="stack card"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    const f = new FormData(ev.currentTarget);
                    change.mutate(
                      {
                        path: `/home-care/episodes/${e.id}/visits`,
                        body: {
                          startAt: toIso(String(f.get('startAt'))),
                          frequency,
                          weeks: frequency === 'ONCE' ? 1 : Number(f.get('weeks') || 1),
                          assignedToId: f.get('assignedToId') || null,
                          tasks: tasks ?? [],
                        },
                      },
                      { onSuccess: done },
                    );
                  }}
                >
                  <div className="form-grid">
                    <TextField
                      label={t('First visit')}
                      name="startAt"
                      type="datetime-local"
                      required
                      defaultValue={localInput(new Date(Date.now() + 86_400_000))}
                    />
                    <SelectField
                      label={t('How often')}
                      name="frequency"
                      value={frequency}
                      onChange={(ev) => setFrequency(ev.target.value as Frequency)}
                      options={FREQUENCIES.map((f) => ({ value: f, label: frequencyLabel(f) }))}
                    />
                    {frequency !== 'ONCE' && (
                      <TextField
                        label={t('For how many weeks')}
                        name="weeks"
                        type="number"
                        min={1}
                        max={12}
                        defaultValue="2"
                      />
                    )}
                    <SelectField
                      label={t('Nurse')}
                      name="assignedToId"
                      placeholder={t('Not assigned')}
                      options={(members.data?.items ?? []).map((m) => ({
                        value: m.id,
                        label: m.name,
                      }))}
                    />
                  </div>
                  <TaskChecklist
                    legend={t('Tasks for these visits (default: the care plan)')}
                    value={tasks ?? []}
                    onChange={setTasks}
                  />
                  <ErrorAlert error={change.error} />
                  <div className="form-actions">
                    <Button variant="secondary" onClick={done}>
                      {t('Cancel')}
                    </Button>
                    <Button type="submit" loading={change.isPending}>
                      {t('Plan visits')}
                    </Button>
                  </div>
                </form>
              )}

              {(action === 'hold' || action === 'discharge') && (
                <form
                  className="stack card"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    const f = new FormData(ev.currentTarget);
                    change.mutate(
                      {
                        path: `/home-care/episodes/${e.id}/${action}`,
                        body: { reason: f.get('reason') },
                      },
                      { onSuccess: done },
                    );
                  }}
                >
                  <p className="muted">
                    {action === 'hold'
                      ? t(
                          'Planned visits that have not started are cancelled. Plan new visits after resuming.',
                        )
                      : t(
                          'Planned visits that have not started are cancelled and the patient is told.',
                        )}
                  </p>
                  <TextAreaField
                    label={t('Reason')}
                    name="reason"
                    required
                    minLength={3}
                    maxLength={300}
                    rows={2}
                  />
                  <ErrorAlert error={change.error} />
                  <div className="form-actions">
                    <Button variant="secondary" onClick={done}>
                      {t('Back')}
                    </Button>
                    <Button
                      type="submit"
                      variant={action === 'hold' ? 'primary' : 'danger'}
                      loading={change.isPending}
                    >
                      {action === 'hold' ? t('Put on hold') : t('Discharge from home care')}
                    </Button>
                  </div>
                </form>
              )}

              <h3>{t('Visits')}</h3>
              {e.visits.length === 0 ? (
                <EmptyState title={t('No visits planned yet')} />
              ) : (
                <VisitTable visits={e.visits} team={team && open} onOpen={setVisitDialog} />
              )}
              <VisitDialogs
                dialog={visitDialog}
                onClose={() => setVisitDialog(null)}
                teamId={e.teamUnitId}
              />
            </div>
          );
        }}
      </QueryView>
    </Dialog>
  );
}

export function VisitTable({
  visits,
  team,
  onOpen,
}: {
  visits: HomeVisit[];
  team: boolean | undefined;
  onOpen: (d: NonNullable<VisitDialog>) => void;
}) {
  return (
    <Table caption={t('Visits')}>
      <thead>
        <tr>
          <th>{t('Planned for')}</th>
          <th>{t('Nurse')}</th>
          <th>{t('Tasks')}</th>
          <th>{t('Status')}</th>
          <th>{t('Notes')}</th>
          {team && (
            <th>
              <span className="sr-only">{t('Actions')}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {visits.map((v) => (
          <tr key={v.id}>
            <td>
              {formatDateTime(v.scheduledFor)}
              {v.startedAt && (
                <div className="muted">
                  {t('Started {time}', { time: formatDateTime(v.startedAt) })}
                  {v.finishedAt &&
                    ` · ${t('finished {time}', { time: formatDateTime(v.finishedAt) })}`}
                </div>
              )}
            </td>
            <td>{v.assignedTo ?? '—'}</td>
            <td>{taskList(v.tasks)}</td>
            <td>
              <VisitStatusBadge v={v} />
            </td>
            <td>
              {v.notes ?? v.missedReason ?? '—'}
              {v.recordedBy && <div className="muted">{v.recordedBy}</div>}
            </td>
            {team && (
              <td>
                <VisitActions visit={v} onOpen={onOpen} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
