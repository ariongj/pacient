import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  END_REASONS,
  endReasonLabel,
  GROUNDS,
  groundLabel,
  involuntaryStatusLabel,
  kindLabel,
  RESTRICTIVE_KINDS,
  stepLabel,
  stepStatusLabel,
  stepTone,
  useInvoluntaryAction,
  useRestrictiveAction,
  useStartInvoluntary,
  useStartRestrictive,
  type EndReason,
  type Ground,
  type Involuntary,
  type InvoluntaryAction,
  type LegalStep,
  type RecentAdministration,
  type Restrictive,
  type RestrictiveKind,
  type StepState,
} from '../../api/mentalhealth';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  ErrorAlert,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';

/* ------------------------------------------------------------------ helpers --------------- */

/** Re-renders every 30 seconds so clocks stay current. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "in 3 h 20 min" / "2 h ago". */
export function relative(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  const mins = Math.round(Math.abs(ms) / 60_000);
  const text =
    mins >= 2 * 24 * 60
      ? t('{days} days', { days: Math.round(mins / (24 * 60)) })
      : mins >= 60
        ? t('{hours} h {minutes} min', { hours: Math.floor(mins / 60), minutes: mins % 60 })
        : t('{minutes} min', { minutes: mins });
  return ms >= 0 ? t('in {time}', { time: text }) : t('{time} ago', { time: text });
}

/** An optional "when" field (empty means now) as an ISO string. */
const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);
const toDateEnd = (date: string) => (date ? new Date(`${date}T23:59:00`).toISOString() : '');

function WhenField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <TextField
      label={t('When')}
      hint={t('Leave empty for now')}
      type="datetime-local"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const fieldset = { border: 0, padding: 0, margin: 0 } as const;

/* ------------------------------------------------------------------ legal steps ----------- */

export function StepBadge({ status }: { status: StepState['status'] }) {
  return <Badge tone={stepTone(status)}>{stepStatusLabel(status)}</Badge>;
}

/** The time a step was done, or when it is due and how far away that is. */
export function StepTiming({ step, now }: { step: StepState; now: number }) {
  if (step.doneAt) return <span className="muted">{formatDateTime(step.doneAt)}</span>;
  if (!step.dueAt || step.status === 'NOT_APPLICABLE') return <span className="muted">—</span>;
  return (
    <span className={step.status === 'OVERDUE' ? 'error-text' : 'muted'}>
      {t('Due {time}', { time: formatDateTime(step.dueAt) })} ({relative(step.dueAt, now)})
    </span>
  );
}

/** The legal steps with their state; optionally an action for each step. */
export function StepList({
  steps,
  action,
}: {
  steps: StepState[];
  action?: (s: StepState) => ReactNode;
}) {
  const now = useNow();
  return (
    <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: '0.5rem' }}>
      {steps.map((s) => (
        <li key={s.step} className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <StepBadge status={s.status} />
          <strong>{stepLabel(s.step)}</strong>
          <StepTiming step={s} now={now} />
          {action?.(s)}
        </li>
      ))}
    </ul>
  );
}

/** Which roles may record which step (the server checks again). */
function canRecord(step: LegalStep, ia: Involuntary, user: { id: string; role: string }) {
  if (ia.status !== 'ACTIVE') return false;
  switch (step) {
    case 'SECOND_OPINION':
      return user.role === 'DOCTOR' && user.id !== ia.decidedById;
    case 'RIGHTS_EXPLAINED':
    case 'REPRESENTATIVE_NOTIFIED':
      return user.role === 'DOCTOR' || user.role === 'NURSE';
    default:
      return user.role === 'DOCTOR';
  }
}

/** The form for recording one legal step. */
function StepForm({
  ia,
  step,
  patientId,
  maxDays,
  onDone,
}: {
  ia: Involuntary;
  step: LegalStep;
  patientId: string;
  maxDays: number;
  onDone: () => void;
}) {
  const mutation = useInvoluntaryAction(patientId);
  const [at, setAt] = useState('');
  const [confirms, setConfirms] = useState<'yes' | 'no' | ''>('');
  const [voluntary, setVoluntary] = useState(false);
  const [text, setText] = useState('');
  const [decision, setDecision] = useState<'CONFIRMED' | 'REJECTED' | ''>('');
  const [until, setUntil] = useState('');
  const maxDate = new Date(Date.now() + maxDays * 86_400_000).toISOString().slice(0, 10);

  function submit(e: FormEvent) {
    e.preventDefault();
    const when = toIso(at);
    let action: InvoluntaryAction;
    switch (step) {
      case 'SECOND_OPINION':
        if (!confirms) return;
        action = {
          path: 'second-opinion',
          body: { confirms: confirms === 'yes', staysVoluntarily: voluntary, at: when },
        };
        break;
      case 'RIGHTS_EXPLAINED':
        action = { path: 'rights', body: { at: when } };
        break;
      case 'REPRESENTATIVE_NOTIFIED':
        action = { path: 'representative', body: { name: text.trim(), at: when } };
        break;
      case 'COURT_NOTIFIED':
        action = { path: 'court-notification', body: { reference: text.trim(), at: when } };
        break;
      case 'COURT_DECISION':
        if (!decision) return;
        action = {
          path: 'court-decision',
          body: {
            decision,
            authorisedUntil: decision === 'CONFIRMED' ? toDateEnd(until) : undefined,
            at: when,
          },
        };
        break;
      case 'AUTHORISATION_REVIEW':
        action = {
          path: 'authorisation',
          body: {
            authorisedUntil: toDateEnd(until),
            reference: text.trim() || undefined,
            at: when,
          },
        };
        break;
    }
    mutation.mutate({ id: ia.id, action }, { onSuccess: onDone });
  }

  return (
    <form className="stack" onSubmit={submit}>
      {step === 'SECOND_OPINION' && (
        <>
          <p className="muted">
            {t(
              'A second doctor, independent of the decision, examines the patient and decides whether the grounds are met.',
            )}
          </p>
          <fieldset className="stack" style={fieldset}>
            <legend>
              <strong>{t('Are the grounds for an involuntary admission met?')}</strong>
            </legend>
            {(['yes', 'no'] as const).map((v) => (
              <label key={v} className="row" style={{ gap: '0.5rem' }}>
                <input
                  type="radio"
                  name="confirms"
                  checked={confirms === v}
                  onChange={() => setConfirms(v)}
                  required
                />
                {v === 'yes' ? t('Yes, I confirm it') : t('No, I do not confirm it')}
              </label>
            ))}
          </fieldset>
          {confirms === 'no' && (
            <>
              <Alert
                tone="info"
                title={t('The patient will be released from the involuntary admission')}
              >
                {t(
                  'If the patient agrees to stay for treatment, record them as a voluntary patient.',
                )}
              </Alert>
              <label className="row" style={{ gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={voluntary}
                  onChange={(e) => setVoluntary(e.target.checked)}
                />
                {t('The patient agrees to stay as a voluntary patient')}
              </label>
            </>
          )}
        </>
      )}
      {step === 'RIGHTS_EXPLAINED' && (
        <p>
          {t(
            'Confirm that the patient was told, in a way they understand, why they are kept in hospital, their rights, and how to challenge the decision before the court.',
          )}
        </p>
      )}
      {step === 'REPRESENTATIVE_NOTIFIED' && (
        <TextField
          label={t('Who was informed')}
          hint={t('Name and relationship, e.g. legal guardian or family member')}
          required
          minLength={2}
          maxLength={200}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {step === 'COURT_NOTIFIED' && (
        <TextField
          label={t('Court reference')}
          required
          minLength={2}
          maxLength={60}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {step === 'COURT_DECISION' && (
        <>
          <SelectField
            label={t('Decision')}
            required
            value={decision}
            placeholder={t('Choose')}
            onChange={(e) => setDecision(e.target.value as typeof decision)}
            options={[
              { value: 'CONFIRMED', label: t('Authorised by the court') },
              { value: 'REJECTED', label: t('Not authorised by the court') },
            ]}
          />
          {decision === 'CONFIRMED' && (
            <TextField
              label={t('Authorised until')}
              type="date"
              required
              max={maxDate}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          )}
          {decision === 'REJECTED' && (
            <Alert
              tone="info"
              title={t('The patient will be released from the involuntary admission')}
            >
              {t(
                'If the patient agrees to stay for treatment, they continue as a voluntary patient.',
              )}
            </Alert>
          )}
        </>
      )}
      {step === 'AUTHORISATION_REVIEW' && (
        <>
          <p className="muted">
            {t(
              'Record a new court decision that extends the authorisation, or end the involuntary admission.',
            )}
          </p>
          <TextField
            label={t('Authorised until')}
            type="date"
            required
            max={maxDate}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
          <TextField
            label={t('Court reference')}
            maxLength={60}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </>
      )}
      <WhenField value={at} onChange={setAt} />
      <ErrorAlert error={mutation.error} />
      <div className="row">
        <Button type="submit" loading={mutation.isPending}>
          {t('Save')}
        </Button>
      </div>
    </form>
  );
}

function EndForm({
  ia,
  patientId,
  onDone,
}: {
  ia: Involuntary;
  patientId: string;
  onDone: () => void;
}) {
  const mutation = useInvoluntaryAction(patientId);
  const [reason, setReason] = useState<EndReason | ''>('');
  const [note, setNote] = useState('');
  const [at, setAt] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason) return;
        mutation.mutate(
          {
            id: ia.id,
            action: {
              path: 'end',
              body: { reason, note: note.trim() || undefined, at: toIso(at) },
            },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <SelectField
        label={t('Reason')}
        required
        value={reason}
        placeholder={t('Choose')}
        onChange={(e) => setReason(e.target.value as EndReason)}
        options={END_REASONS.map((r) => ({ value: r, label: endReasonLabel(r) }))}
      />
      <TextField
        label={t('Note')}
        required={reason === 'OTHER'}
        maxLength={280}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <WhenField value={at} onChange={setAt} />
      <ErrorAlert error={mutation.error} />
      <div className="row">
        <Button type="submit" loading={mutation.isPending}>
          {t('End the involuntary admission')}
        </Button>
      </div>
    </form>
  );
}

/** One involuntary admission: grounds, assessment (chart only), legal steps and actions. */
export function InvoluntaryPanel({
  ia,
  patientId,
  maxDays,
  showAssessment = true,
}: {
  ia: Involuntary;
  patientId: string;
  maxDays: number;
  showAssessment?: boolean;
}) {
  const user = useUser();
  const [open, setOpen] = useState<LegalStep | 'END' | null>(null);
  const active = ia.status === 'ACTIVE';
  return (
    <div className="stack">
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <Badge tone={active ? (ia.overdueSteps.length ? 'danger' : 'info') : 'neutral'}>
          {involuntaryStatusLabel(ia.status)}
        </Badge>
        <span>
          {t('Since {time}, decided by {name}', {
            time: formatDateTime(ia.startedAt),
            name: ia.decidedBy ?? '—',
          })}
        </span>
        {ia.overdueSteps.length > 0 && (
          <Badge tone="danger">
            {t('{count} legal steps overdue', { count: ia.overdueSteps.length })}
          </Badge>
        )}
      </div>
      <div>
        <strong>{t('Grounds')}:</strong> {ia.grounds.map((g) => groundLabel(g)).join('; ')}
      </div>
      {showAssessment && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{ia.assessment}</p>}
      {ia.secondOpinion && (
        <div className="muted">
          {ia.secondOpinion.confirms
            ? t('Confirmed by {name} on {time}', {
                name: ia.secondOpinion.by ?? '—',
                time: formatDateTime(ia.secondOpinion.at),
              })
            : t('Not confirmed by {name} on {time}', {
                name: ia.secondOpinion.by ?? '—',
                time: formatDateTime(ia.secondOpinion.at),
              })}
        </div>
      )}
      {ia.court.reference && (
        <div className="muted">
          {t('Court reference: {reference}', { reference: ia.court.reference })}
          {ia.court.authorisedUntil &&
            ` · ${t('authorised until {date}', { date: formatDate(ia.court.authorisedUntil) })}`}
        </div>
      )}
      {ia.representative.name && (
        <div className="muted">{t('Informed: {name}', { name: ia.representative.name })}</div>
      )}
      <StepList
        steps={ia.steps}
        action={(s) =>
          s.status !== 'DONE' && s.status !== 'NOT_APPLICABLE' && canRecord(s.step, ia, user) ? (
            <Button
              size="sm"
              variant={s.status === 'OVERDUE' ? 'primary' : 'secondary'}
              onClick={() => setOpen(s.step)}
            >
              {s.step === 'AUTHORISATION_REVIEW' ? t('Record an extension') : t('Record')}
            </Button>
          ) : null
        }
      />
      {!active && (
        <div className="muted">
          {t('Ended {time}: {reason}', {
            time: formatDateTime(ia.endedAt),
            reason: endReasonLabel(ia.endReason),
          })}
        </div>
      )}
      {active && user.role === 'DOCTOR' && (
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setOpen('END')}>
            {t('End the involuntary admission')}
          </Button>
        </div>
      )}
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === 'END' ? t('End the involuntary admission') : open ? stepLabel(open) : ''}
      >
        {open === 'END' ? (
          <EndForm ia={ia} patientId={patientId} onDone={() => setOpen(null)} />
        ) : open ? (
          <StepForm
            ia={ia}
            step={open}
            patientId={patientId}
            maxDays={maxDays}
            onDone={() => setOpen(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

export function StartInvoluntaryForm({
  patientId,
  onDone,
}: {
  patientId: string;
  onDone: () => void;
}) {
  const mutation = useStartInvoluntary(patientId);
  const [grounds, setGrounds] = useState<Ground[]>([]);
  const [assessment, setAssessment] = useState('');
  const [at, setAt] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!grounds.length) return;
        mutation.mutate(
          { grounds, assessment: assessment.trim(), startedAt: toIso(at) },
          { onSuccess: onDone },
        );
      }}
    >
      <Alert tone="info" title={t('This starts the legal clock')}>
        {t(
          'An involuntary admission is a last resort, when less restrictive care is not possible. The second examination, the patient’s rights, the representative and the court each have a time limit.',
        )}
      </Alert>
      <fieldset className="stack" style={fieldset}>
        <legend>
          <strong>{t('Legal grounds')}</strong>
        </legend>
        {GROUNDS.map((g) => (
          <label key={g} className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={grounds.includes(g)}
              onChange={(e) =>
                setGrounds((prev) =>
                  e.target.checked ? [...prev, g] : prev.filter((x) => x !== g),
                )
              }
            />
            {groundLabel(g)}
          </label>
        ))}
        {grounds.length === 0 && mutation.isIdle && (
          <small className="muted">{t('Choose at least one legal ground')}</small>
        )}
      </fieldset>
      <TextAreaField
        label={t('Assessment')}
        hint={t('What you found and why less restrictive care is not enough')}
        required
        minLength={20}
        maxLength={5000}
        value={assessment}
        onChange={(e) => setAssessment(e.target.value)}
      />
      <WhenField value={at} onChange={setAt} />
      <ErrorAlert error={mutation.error} />
      <div className="row">
        <Button type="submit" loading={mutation.isPending} disabled={!grounds.length}>
          {t('Record the involuntary admission')}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ restrictive ----------- */

export function ObservationClock({ r }: { r: Restrictive }) {
  const now = useNow(15_000);
  if (r.endedAt) {
    return (
      <Badge tone={r.debriefOverdue ? 'danger' : r.debriefAt ? 'success' : 'warning'}>
        {r.debriefAt
          ? t('Debrief held')
          : r.debriefOverdue
            ? t('Debrief overdue')
            : t('Debrief due {time}', { time: relative(r.debriefDueAt!, now) })}
      </Badge>
    );
  }
  if (!r.nextObservationDueAt) return <Badge tone="info">{t('In progress')}</Badge>;
  const overdue = new Date(r.nextObservationDueAt).getTime() < now;
  return (
    <Badge tone={overdue ? 'danger' : 'info'}>
      {overdue
        ? t('Observation overdue since {time}', { time: relative(r.nextObservationDueAt, now) })
        : t('Next observation {time}', { time: relative(r.nextObservationDueAt, now) })}
    </Badge>
  );
}

function ObservationForm({
  r,
  patientId,
  onDone,
}: {
  r: Restrictive;
  patientId: string;
  onDone: () => void;
}) {
  const mutation = useRestrictiveAction(patientId);
  const [note, setNote] = useState('');
  const [vitals, setVitals] = useState(false);
  const [at, setAt] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(
          {
            id: r.id,
            action: {
              path: 'observations',
              body: { note: note.trim(), vitalsChecked: vitals, at: toIso(at) },
            },
          },
          {
            onSuccess: () => {
              setNote('');
              setVitals(false);
              setAt('');
              onDone();
            },
          },
        );
      }}
    >
      <TextField
        label={t('Observation')}
        hint={t('Breathing, circulation, distress, needs (water, toilet)')}
        required
        minLength={2}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <label className="row" style={{ gap: '0.5rem' }}>
        <input type="checkbox" checked={vitals} onChange={(e) => setVitals(e.target.checked)} />
        {t('Vital signs checked')}
      </label>
      <WhenField value={at} onChange={setAt} />
      <ErrorAlert error={mutation.error} />
      <div className="row">
        <Button type="submit" loading={mutation.isPending}>
          {t('Add the observation')}
        </Button>
      </div>
    </form>
  );
}

function EndRestrictiveForm({
  r,
  patientId,
  onDone,
}: {
  r: Restrictive;
  patientId: string;
  onDone: () => void;
}) {
  const mutation = useRestrictiveAction(patientId);
  const [injuries, setInjuries] = useState('');
  const [at, setAt] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(
          {
            id: r.id,
            action: { path: 'end', body: { injuries: injuries.trim() || null, at: toIso(at) } },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <TextField
        label={t('Injuries to the patient or staff')}
        hint={t('Leave empty if there were none')}
        maxLength={300}
        value={injuries}
        onChange={(e) => setInjuries(e.target.value)}
      />
      <WhenField value={at} onChange={setAt} />
      <ErrorAlert error={mutation.error} />
      <div className="row">
        <Button type="submit" loading={mutation.isPending}>
          {t('End it')}
        </Button>
      </div>
    </form>
  );
}

function DebriefForm({
  r,
  patientId,
  onDone,
}: {
  r: Restrictive;
  patientId: string;
  onDone: () => void;
}) {
  const mutation = useRestrictiveAction(patientId);
  const [note, setNote] = useState('');
  const [at, setAt] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(
          { id: r.id, action: { path: 'debrief', body: { note: note.trim(), at: toIso(at) } } },
          { onSuccess: onDone },
        );
      }}
    >
      <p className="muted">
        {t(
          'Talk with the patient (and, if they wish, their family) and the staff involved: what led to it, how it felt, and what could prevent it next time.',
        )}
      </p>
      <TextAreaField
        label={t('Debrief summary')}
        required
        minLength={10}
        maxLength={3000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <WhenField value={at} onChange={setAt} />
      <ErrorAlert error={mutation.error} />
      <div className="row">
        <Button type="submit" loading={mutation.isPending}>
          {t('Save the debrief')}
        </Button>
      </div>
    </form>
  );
}

/** A restrictive intervention with its observation log and the next action. */
export function RestrictivePanel({
  r,
  patientId,
  canAct,
}: {
  r: Restrictive;
  patientId: string;
  canAct: boolean;
}) {
  const [open, setOpen] = useState<'OBS' | 'END' | 'DEBRIEF' | null>(null);
  const continuous = r.kind !== 'RAPID_TRANQUILLISATION';
  return (
    <div className="stack">
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>{kindLabel(r.kind)}</strong>
        <ObservationClock r={r} />
        <span className="muted">
          {t('Started {time} by {name}', {
            time: formatDateTime(r.startedAt),
            name: r.orderedBy ?? '—',
          })}
        </span>
        {r.endedAt && (
          <span className="muted">
            {t('Ended {time} ({minutes} min)', {
              time: formatDateTime(r.endedAt),
              minutes: r.durationMinutes ?? 0,
            })}
          </span>
        )}
      </div>
      <p style={{ margin: 0 }}>{r.reason}</p>
      {r.injuries && (
        <Alert tone="warning" title={t('Injuries')}>
          {r.injuries}
        </Alert>
      )}
      {r.observations.length > 0 && (
        <details open={!r.endedAt}>
          <summary>{t('Observations ({count})', { count: r.observations.length })}</summary>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, gap: '0.25rem' }}>
            {r.observations.map((o, i) => (
              <li key={i}>
                <span className="muted">{formatDateTime(o.at)}</span> · {o.by ?? '—'}
                {o.administrationId
                  ? ` · ${t('Medication administration recorded')}`
                  : ` · ${o.note ?? ''}`}
                {o.vitalsChecked && ` · ${t('vital signs checked')}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.debriefNote && (
        <div>
          <strong>{t('Debrief')}</strong> ({formatDateTime(r.debriefAt)}):{' '}
          <span style={{ whiteSpace: 'pre-wrap' }}>{r.debriefNote}</span>
        </div>
      )}
      {canAct && (
        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          {!r.endedAt && (
            <>
              <Button
                size="sm"
                variant={r.observationOverdue ? 'primary' : 'secondary'}
                onClick={() => setOpen('OBS')}
              >
                {t('Add an observation')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setOpen('END')}>
                {continuous ? t('End it') : t('Record the end of monitoring')}
              </Button>
            </>
          )}
          {r.endedAt && !r.debriefAt && (
            <Button
              size="sm"
              variant={r.debriefOverdue ? 'primary' : 'secondary'}
              onClick={() => setOpen('DEBRIEF')}
            >
              {t('Record the debrief')}
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={
          open === 'OBS'
            ? t('Add an observation')
            : open === 'END'
              ? t('End {kind}', { kind: kindLabel(r.kind) })
              : t('Record the debrief')
        }
      >
        {open === 'OBS' && (
          <ObservationForm r={r} patientId={patientId} onDone={() => setOpen(null)} />
        )}
        {open === 'END' && (
          <EndRestrictiveForm r={r} patientId={patientId} onDone={() => setOpen(null)} />
        )}
        {open === 'DEBRIEF' && (
          <DebriefForm r={r} patientId={patientId} onDone={() => setOpen(null)} />
        )}
      </Dialog>
    </div>
  );
}

export function StartRestrictiveForm({
  patientId,
  administrations,
  onDone,
}: {
  patientId: string;
  administrations: RecentAdministration[];
  onDone: () => void;
}) {
  const mutation = useStartRestrictive(patientId);
  const [kind, setKind] = useState<RestrictiveKind | ''>('');
  const [given, setGiven] = useState('');
  const [reason, setReason] = useState('');
  const [at, setAt] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!kind) return;
        mutation.mutate(
          {
            kind,
            reason: reason.trim(),
            startedAt: toIso(at),
            medicationAdministrationId:
              kind === 'RAPID_TRANQUILLISATION' && given ? given : undefined,
          },
          { onSuccess: onDone },
        );
      }}
    >
      <Alert tone="info" title={t('Only when there is no safer alternative')}>
        {t(
          'Use the least restrictive measure for the shortest time. Restraint and seclusion need an observation at least every 15 minutes, and a debrief with the patient within 72 hours after it ends.',
        )}
      </Alert>
      <SelectField
        label={t('Type')}
        required
        value={kind}
        placeholder={t('Choose')}
        onChange={(e) => setKind(e.target.value as RestrictiveKind)}
        options={RESTRICTIVE_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
      />
      {kind === 'RAPID_TRANQUILLISATION' && (
        <SelectField
          label={t('Medicine given')}
          hint={t('Record the medicine itself on the medication chart as usual.')}
          value={given}
          placeholder={
            administrations.length
              ? t('Not linked|medicine')
              : t('No medicine given in the last 24 hours')
          }
          onChange={(e) => setGiven(e.target.value)}
          options={administrations.map((a) => ({
            value: a.id,
            label: `${a.medication}${a.doseGiven ? ` ${a.doseGiven}` : ''}, ${a.route} · ${formatDateTime(a.administeredAt)}`,
          }))}
        />
      )}
      <TextAreaField
        label={t('Why it was necessary')}
        hint={t('The immediate risk and what was tried first')}
        required
        minLength={10}
        maxLength={2000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <WhenField value={at} onChange={setAt} />
      <ErrorAlert error={mutation.error} />
      <div className="row">
        <Button type="submit" loading={mutation.isPending}>
          {t('Record it')}
        </Button>
      </div>
    </form>
  );
}
