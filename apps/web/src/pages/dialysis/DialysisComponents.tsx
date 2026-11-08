import { useState, type FormEvent, type ReactNode } from 'react';
import {
  accessLabel,
  COMPLICATIONS,
  complicationLabel,
  DAYS,
  dayLabel,
  END_REASONS,
  endReasonLabel,
  SHIFTS,
  shiftLabel,
  useDialysisAction,
  VASCULAR_ACCESS,
  warningText,
  type Adequacy,
  type Complication,
  type Day,
  type Schedule,
  type Session,
  type SessionStatus,
  type Targets,
  type Warning,
} from '../../api/dialysis';
import {
  Badge,
  Button,
  Dialog,
  ErrorAlert,
  SelectField,
  TextAreaField,
  TextField,
  type Tone,
} from '../../components/ui';
import { formatNumber } from '../../format';
import { t } from '../../i18n';

/* ------------------------------------------------------------------- small pieces ---- */

const STATUS_TONE: Record<SessionStatus, Tone> = {
  PLANNED: 'neutral',
  IN_PROGRESS: 'info',
  COMPLETED: 'success',
  MISSED: 'danger',
  CANCELLED: 'neutral',
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const label = {
    PLANNED: t('Planned|dialysis'),
    IN_PROGRESS: t('On dialysis'),
    COMPLETED: t('Completed|dialysis'),
    MISSED: t('Missed|dialysis'),
    CANCELLED: t('Cancelled|dialysis'),
  }[status];
  return <Badge tone={STATUS_TONE[status]}>{label}</Badge>;
}

export const daysText = (days: readonly string[]) => days.map(dayLabel).join(', ');

export const scheduleText = (s: Pick<Schedule, 'days' | 'shift' | 'durationMinutes'>) =>
  `${daysText(s.days)} · ${shiftLabel(s.shift)} · ${t('{minutes} min', { minutes: s.durationMinutes })}`;

export function WarningList({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
      {warnings.map((w) => (
        <Badge
          key={w.code}
          tone={w.code === 'PRE_BP_HIGH' || w.code === 'POST_BP_LOW' ? 'danger' : 'warning'}
        >
          {warningText(w)}
        </Badge>
      ))}
    </span>
  );
}

/** URR and Kt/V with the target judgement in words (never colour alone). */
export function AdequacyText({ a, targets }: { a: Adequacy | null; targets?: Targets }) {
  if (!a || a.urr === null) return <span className="muted">{t('Not measured')}</span>;
  return (
    <span className="stack" style={{ gap: '0.15rem' }}>
      <span>
        {t('URR {urr}%', { urr: formatNumber(a.urr) })}
        {a.ktv !== null && ` · ${t('Kt/V {ktv}', { ktv: formatNumber(a.ktv) })}`}
      </span>
      {a.meetsTarget === false ? (
        <Badge tone="warning">
          {targets
            ? t('Below target (Kt/V ≥ {ktv}, URR ≥ {urr}%)', { ...targets })
            : t('Dialysis dose below target')}
        </Badge>
      ) : (
        <Badge tone="success">{t('Target reached')}</Badge>
      )}
    </span>
  );
}

export const bp = (s: number | null, d: number | null) => (s && d ? `${s}/${d}` : '—');
export const kg = (v: number | null) => (v === null ? '—' : `${formatNumber(v)} kg`);

/* ---------------------------------------------------------------------- schedules ---- */

function DayChecklist({ value, onChange }: { value: Day[]; onChange: (d: Day[]) => void }) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 600, marginBottom: '0.35rem' }}>{t('Dialysis days')}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem' }}>
        {DAYS.map((d) => (
          <label key={d} className="checkbox">
            <input
              type="checkbox"
              checked={value.includes(d)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, d] : value.filter((x) => x !== d))
              }
            />
            {dayLabel(d)}
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
        <Button size="sm" variant="ghost" onClick={() => onChange(['MON', 'WED', 'FRI'])}>
          {t('Mon, Wed, Fri')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(['TUE', 'THU', 'SAT'])}>
          {t('Tue, Thu, Sat')}
        </Button>
      </div>
    </fieldset>
  );
}

/** Starts a schedule (patientId + units) or changes an existing one (schedule). */
export function ScheduleDialog({
  open,
  onClose,
  patientId,
  units,
  schedule,
}: {
  open: boolean;
  onClose: () => void;
  patientId: string;
  units: { id: string; name: string }[];
  schedule?: Schedule | null;
}) {
  const [days, setDays] = useState<Day[]>(schedule?.days ?? ['MON', 'WED', 'FRI']);
  const save = useDialysisAction((body: Record<string, unknown>) =>
    schedule
      ? { path: `/dialysis/schedules/${schedule.id}`, method: 'PATCH', body }
      : { path: `/dialysis/patients/${patientId}/schedules`, body },
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const target = f.get('targetWeightKg');
    save.mutate(
      {
        ...(schedule
          ? {}
          : { unitId: f.get('unitId'), startedOn: f.get('startedOn') || undefined }),
        days,
        shift: f.get('shift'),
        durationMinutes: Number(f.get('durationMinutes')),
        targetWeightKg: target ? Number(target) : null,
        vascularAccess: f.get('vascularAccess'),
      },
      { onSuccess: onClose },
    );
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={schedule ? t('Change the dialysis schedule') : t('Start dialysis')}
      wide
    >
      <form className="stack" onSubmit={onSubmit}>
        {!schedule && (
          <SelectField
            label={t('Dialysis unit')}
            name="unitId"
            required
            options={units.map((u) => ({ value: u.id, label: u.name }))}
          />
        )}
        <DayChecklist value={days} onChange={setDays} />
        <div className="form-grid">
          <SelectField
            label={t('Shift')}
            name="shift"
            required
            defaultValue={schedule?.shift ?? 'MORNING'}
            options={SHIFTS.map((s) => ({ value: s, label: shiftLabel(s) }))}
          />
          <TextField
            label={t('Duration (minutes)')}
            name="durationMinutes"
            type="number"
            min={60}
            max={600}
            step={15}
            required
            defaultValue={schedule?.durationMinutes ?? 240}
          />
          <TextField
            label={t('Target (dry) weight, kg')}
            name="targetWeightKg"
            type="number"
            min={20}
            max={250}
            step={0.1}
            defaultValue={schedule?.targetWeightKg ?? ''}
          />
          <SelectField
            label={t('Vascular access')}
            name="vascularAccess"
            required
            defaultValue={schedule?.vascularAccess ?? 'FISTULA'}
            options={VASCULAR_ACCESS.map((a) => ({ value: a, label: accessLabel(a) }))}
          />
          {!schedule && <TextField label={t('First day')} name="startedOn" type="date" />}
        </div>
        <p className="muted">
          {t(
            'A shift has as many places as the unit has stations. Sessions are planned two weeks ahead.',
          )}
        </p>
        {days.length === 0 && <p className="muted">{t('Choose at least one day.')}</p>}
        <ErrorAlert error={save.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={days.length === 0}>
            {schedule ? t('Save') : t('Start dialysis')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function EndScheduleDialog({
  schedule,
  onClose,
}: {
  schedule: Schedule | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<string>('TRANSPLANT');
  const end = useDialysisAction((body: Record<string, unknown>) => ({
    path: `/dialysis/schedules/${schedule?.id}/end`,
    body,
  }));
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    end.mutate({ reason, note: f.get('note') || undefined }, { onSuccess: onClose });
  }
  return (
    <Dialog open={Boolean(schedule)} onClose={onClose} title={t('End dialysis')}>
      <form className="stack" onSubmit={onSubmit}>
        <SelectField
          label={t('Reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          options={END_REASONS.map((r) => ({ value: r, label: endReasonLabel(r) }))}
        />
        <TextField label={t('Note')} name="note" maxLength={250} required={reason === 'OTHER'} />
        <p className="muted">{t('Planned sessions from today are cancelled.')}</p>
        <ErrorAlert error={end.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={end.isPending}>
            {t('End dialysis')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------ sessions ---- */

export type SessionDialogKind = 'start' | 'end' | 'missed' | 'urea';

function Actions({
  onClose,
  pending,
  label,
  danger,
}: {
  onClose: () => void;
  pending: boolean;
  label: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="form-actions">
      <Button variant="secondary" onClick={onClose}>
        {t('Cancel')}
      </Button>
      <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
        {label}
      </Button>
    </div>
  );
}

/** Start, end, missed and late urea: one dialog component per session action. */
export function SessionDialog({
  session,
  kind,
  patientName,
  onClose,
}: {
  session: Session | null;
  kind: SessionDialogKind | null;
  patientName?: string;
  onClose: () => void;
}) {
  const [complications, setComplications] = useState<Complication[]>([]);
  const act = useDialysisAction((body: Record<string, unknown>) => ({
    path: `/dialysis/sessions/${session?.id}/${kind}`,
    method: kind === 'urea' ? 'PATCH' : 'POST',
    body,
  }));
  const close = () => {
    setComplications([]);
    act.reset();
    onClose();
  };
  const open = Boolean(session && kind);
  const num = (f: FormData, k: string) => {
    const v = f.get(k);
    return v === null || v === '' ? undefined : Number(v);
  };
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let body: Record<string, unknown>;
    if (kind === 'start') {
      body = {
        machine: f.get('machine'),
        preWeightKg: num(f, 'preWeightKg'),
        preSystolic: num(f, 'preSystolic'),
        preDiastolic: num(f, 'preDiastolic'),
      };
    } else if (kind === 'end') {
      body = {
        postWeightKg: num(f, 'postWeightKg'),
        postSystolic: num(f, 'postSystolic'),
        postDiastolic: num(f, 'postDiastolic'),
        ultrafiltrationMl: num(f, 'ultrafiltrationMl'),
        bloodFlowMlMin: num(f, 'bloodFlowMlMin'),
        preUrea: num(f, 'preUrea'),
        postUrea: num(f, 'postUrea'),
        complications,
        notes: f.get('notes') || undefined,
      };
    } else if (kind === 'urea') {
      body = { preUrea: num(f, 'preUrea'), postUrea: num(f, 'postUrea') };
    } else {
      body = { reason: f.get('reason') };
    }
    act.mutate(body, { onSuccess: close });
  }
  const title =
    kind === 'start'
      ? t('Start the session')
      : kind === 'end'
        ? t('End the session')
        : kind === 'urea'
          ? t('Add urea results')
          : t('Record a missed session');
  const ureaFields = (
    <div className="form-grid">
      <TextField
        label={t('Urea before, mmol/l')}
        name="preUrea"
        type="number"
        min={0.5}
        max={80}
        step={0.1}
        required={kind === 'urea'}
      />
      <TextField
        label={t('Urea after, mmol/l')}
        name="postUrea"
        type="number"
        min={0.5}
        max={80}
        step={0.1}
        required={kind === 'urea'}
      />
    </div>
  );
  return (
    <Dialog
      open={open}
      onClose={close}
      title={patientName ? `${title} – ${patientName}` : title}
      wide={kind === 'end'}
    >
      {session && (
        <form className="stack" onSubmit={onSubmit}>
          {kind === 'start' && (
            <>
              <div className="form-grid">
                <TextField
                  label={t('Station or machine')}
                  name="machine"
                  required
                  maxLength={40}
                  defaultValue={session.machine ?? ''}
                />
                <TextField
                  label={t('Weight before, kg')}
                  name="preWeightKg"
                  type="number"
                  min={20}
                  max={250}
                  step={0.1}
                  required
                  hint={
                    session.targetWeightKg
                      ? t('Target weight {kg} kg', { kg: formatNumber(session.targetWeightKg) })
                      : undefined
                  }
                />
                <TextField
                  label={t('Systolic before')}
                  name="preSystolic"
                  type="number"
                  min={50}
                  max={260}
                  required
                />
                <TextField
                  label={t('Diastolic before')}
                  name="preDiastolic"
                  type="number"
                  min={20}
                  max={160}
                  required
                />
              </div>
              <p className="muted">
                {t('Weight gain above {percent}% of the target weight is flagged.', {
                  percent: 4,
                })}
              </p>
            </>
          )}
          {kind === 'end' && (
            <>
              <div className="form-grid">
                <TextField
                  label={t('Weight after, kg')}
                  name="postWeightKg"
                  type="number"
                  min={20}
                  max={250}
                  step={0.1}
                  required
                  hint={
                    session.preWeightKg
                      ? t('Before: {kg} kg', { kg: formatNumber(session.preWeightKg) })
                      : undefined
                  }
                />
                <TextField
                  label={t('Systolic after')}
                  name="postSystolic"
                  type="number"
                  min={50}
                  max={260}
                  required
                />
                <TextField
                  label={t('Diastolic after')}
                  name="postDiastolic"
                  type="number"
                  min={20}
                  max={160}
                  required
                />
                <TextField
                  label={t('Ultrafiltration, ml')}
                  name="ultrafiltrationMl"
                  type="number"
                  min={0}
                  max={8000}
                  step={50}
                  required
                />
                <TextField
                  label={t('Blood flow, ml/min')}
                  name="bloodFlowMlMin"
                  type="number"
                  min={100}
                  max={600}
                  step={10}
                />
              </div>
              {ureaFields}
              <p className="muted">
                {t('Urea before and after gives URR and Kt/V; it can also be added later.')}
              </p>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
                  {t('Complications')}
                </legend>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem' }}>
                  {COMPLICATIONS.map((c) => (
                    <label key={c} className="checkbox">
                      <input
                        type="checkbox"
                        checked={complications.includes(c)}
                        onChange={(e) =>
                          setComplications(
                            e.target.checked
                              ? [...complications, c]
                              : complications.filter((x) => x !== c),
                          )
                        }
                      />
                      {complicationLabel(c)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <TextAreaField
                label={t('Notes')}
                name="notes"
                rows={3}
                maxLength={2000}
                required={complications.includes('OTHER')}
              />
            </>
          )}
          {kind === 'urea' && ureaFields}
          {kind === 'missed' && (
            <TextField label={t('Reason')} name="reason" required minLength={3} maxLength={300} />
          )}
          <ErrorAlert error={act.error} />
          <Actions
            onClose={close}
            pending={act.isPending}
            danger={kind === 'missed'}
            label={
              kind === 'start'
                ? t('Start|dialysis session')
                : kind === 'end'
                  ? t('End|dialysis session')
                  : kind === 'urea'
                    ? t('Save')
                    : t('Record as missed')
            }
          />
        </form>
      )}
    </Dialog>
  );
}
