import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import {
  CHECKLIST,
  procedureLabel,
  patientLabel,
  useTheatreAction,
  useTheatres,
  type ChecklistStep,
  type SurgicalCase,
} from '../../api/theatre';
import {
  Alert,
  Button,
  Dialog,
  ErrorAlert,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';

/** "2026-11-05T09:30" in local time, for datetime-local inputs. */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ schedule --------------- */

export function ScheduleDialog({
  item,
  defaultDate,
  onClose,
}: {
  item: SurgicalCase | null;
  defaultDate?: string;
  onClose: () => void;
}) {
  const theatres = useTheatres();
  const [force, setForce] = useState(false);
  const schedule = useTheatreAction(
    (body: Record<string, unknown>) => ({ path: `/cases/${item!.id}/schedule`, body }),
    onClose,
  );
  if (!item) return null;
  const err = schedule.error instanceof ApiError ? schedule.error : null;
  const conflictDetails = (err?.details ?? null) as {
    procedure?: string;
    scheduledStart?: string;
  } | null;
  const needsWaiver = !item.consentRecordId && item.priority !== 'ELECTIVE';
  const blockedByConsent = !item.consentRecordId && item.priority === 'ELECTIVE';
  const start = defaultDate
    ? `${defaultDate}T08:00`
    : toLocalInput(new Date(Date.now() + 60 * 60_000));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      theatreUnitId: f.get('theatreUnitId'),
      scheduledStart: new Date(String(f.get('scheduledStart'))).toISOString(),
      estimatedMinutes: Number(f.get('estimatedMinutes')),
    };
    const waiver = String(f.get('consentWaiverReason') ?? '').trim();
    if (waiver) body.consentWaiverReason = waiver;
    if (force) {
      body.force = true;
      body.forceReason = String(f.get('forceReason') ?? '').trim();
    }
    schedule.mutate(body);
  }

  return (
    <Dialog open onClose={onClose} title={t('Schedule operation')} wide>
      <p>
        <strong>{patientLabel(item)}</strong> · {procedureLabel(item)}
      </p>
      {blockedByConsent && (
        <Alert tone="warning" title={t('Treatment consent missing')}>
          {t(
            'An elective operation can only be scheduled once the patient’s treatment consent is recorded. Ask the surgeon to record it in the patient’s chart (Consent tab).',
          )}
        </Alert>
      )}
      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <SelectField
            label={t('Operating theatre')}
            name="theatreUnitId"
            required
            defaultValue={item.theatreUnitId ?? ''}
            placeholder={t('Choose a theatre')}
            options={(theatres.data?.items ?? []).map((th) => ({ value: th.id, label: th.name }))}
          />
          <TextField
            label={t('Start')}
            name="scheduledStart"
            type="datetime-local"
            required
            defaultValue={item.scheduledStart ? toLocalInput(new Date(item.scheduledStart)) : start}
          />
          <TextField
            label={t('Estimated duration (minutes)')}
            name="estimatedMinutes"
            type="number"
            min={5}
            max={1440}
            required
            defaultValue={item.estimatedMinutes}
          />
        </div>
        {needsWaiver && (
          <TextAreaField
            label={t('No treatment consent is recorded – why must the operation go ahead?')}
            name="consentWaiverReason"
            rows={2}
            minLength={10}
            maxLength={500}
            required
          />
        )}
        {err?.code === 'THEATRE_BOOKED' && (
          <Alert tone="danger" title={t('The theatre is already booked at that time')}>
            {conflictDetails?.procedure}
            {conflictDetails?.scheduledStart
              ? ` · ${formatDateTime(conflictDetails.scheduledStart)}`
              : ''}
          </Alert>
        )}
        {err?.code === 'SURGEON_DOUBLE_BOOKED' && (
          <Alert
            tone="warning"
            title={t('A surgeon of this operation is already booked at that time')}
          >
            {conflictDetails?.procedure}
            {conflictDetails?.scheduledStart
              ? ` · ${formatDateTime(conflictDetails.scheduledStart)}`
              : ''}
            <label className="checkbox" style={{ marginTop: '0.5rem' }}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>{t('Book anyway')}</span>
            </label>
          </Alert>
        )}
        {force && (
          <TextField
            label={t('Reason for the double booking')}
            name="forceReason"
            required
            minLength={5}
            maxLength={500}
          />
        )}
        {err && !['THEATRE_BOOKED', 'SURGEON_DOUBLE_BOOKED'].includes(err.code) && (
          <ErrorAlert error={schedule.error} />
        )}
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={schedule.isPending} disabled={blockedByConsent}>
            {t('Schedule operation')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ WHO checklist ---------- */

const STEP_PATH: Record<ChecklistStep, string> = {
  signIn: 'sign-in',
  timeOut: 'time-out',
  signOut: 'sign-out',
};

export function ChecklistDialog({
  item,
  step,
  onClose,
}: {
  item: SurgicalCase | null;
  step: ChecklistStep | null;
  onClose: () => void;
}) {
  const action = useTheatreAction(
    (body: Record<string, unknown>) => ({ path: `/cases/${item!.id}/${STEP_PATH[step!]}`, body }),
    onClose,
  );
  if (!item || !step) return null;
  const def = CHECKLIST[step];

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    for (const it of def.items) {
      if (it.kind === 'confirm') body[it.key] = f.get(it.key) === 'on';
      else if (it.kind === 'choice') {
        const v = f.get(it.key);
        body[it.key] = v === 'true' ? true : v === 'false' ? false : v;
      } else {
        const v = String(f.get(it.key) ?? '').trim();
        if (v) body[it.key] = v;
      }
    }
    action.mutate(body);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t('WHO surgical safety checklist')} – ${def.title()}`}
      wide
    >
      <p className="muted">
        {def.hint()} · <strong>{patientLabel(item)}</strong> · {procedureLabel(item)}
      </p>
      <form onSubmit={onSubmit}>
        <div className="stack" style={{ gap: '0.75rem' }}>
          {def.items.map((it) =>
            it.kind === 'confirm' ? (
              <label key={it.key} className="checkbox">
                <input type="checkbox" name={it.key} required />
                <span>{it.label()}</span>
              </label>
            ) : it.kind === 'choice' ? (
              <fieldset key={it.key}>
                <legend>{it.label()}</legend>
                <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
                  {it.options.map((o) => (
                    <label key={o.value} className="checkbox">
                      <input type="radio" name={it.key} value={o.value} required />
                      <span>{o.label()}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <TextAreaField
                key={it.key}
                label={it.label()}
                name={it.key}
                rows={2}
                maxLength={1000}
              />
            ),
          )}
        </div>
        <p className="muted">{t('Your name and the time are recorded with this step.')}</p>
        <ErrorAlert error={action.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={action.isPending}>
            {t('Confirm {step}', { step: def.title() })}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ complete --------------- */

export function CompleteDialog({
  item,
  onClose,
}: {
  item: SurgicalCase | null;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const complete = useTheatreAction(
    (body: Record<string, unknown>) => ({ path: `/cases/${item!.id}/complete`, body }),
    onClose,
  );
  if (!item) return null;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const f = new FormData(e.currentTarget);
    const loss = String(f.get('estimatedBloodLossMl') ?? '').trim();
    complete.mutate({
      operationNote: String(f.get('operationNote') ?? ''),
      complications: String(f.get('complications') ?? '').trim() || null,
      estimatedBloodLossMl: loss ? Number(loss) : null,
    });
  }

  return (
    <Dialog open onClose={onClose} title={t('Operation note')} wide>
      <p>
        <strong>{patientLabel(item)}</strong> · {procedureLabel(item)}
      </p>
      <form onSubmit={onSubmit}>
        <TextAreaField
          label={t('Operation note')}
          name="operationNote"
          rows={10}
          minLength={20}
          maxLength={20000}
          required
          hint={t(
            'Findings, procedure performed, closure, specimens and instructions after the operation.',
          )}
        />
        <div className="form-grid">
          <TextField label={t('Complications')} name="complications" maxLength={2000} />
          <TextField
            label={t('Estimated blood loss (ml)')}
            name="estimatedBloodLossMl"
            type="number"
            min={0}
            max={20000}
          />
        </div>
        {confirming && (
          <Alert tone="warning" title={t('Sign the operation note?')}>
            {t('A signed operation note cannot be changed afterwards.')}
          </Alert>
        )}
        <ErrorAlert error={complete.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={complete.isPending}>
            {confirming ? t('Sign and complete') : t('Review and sign')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ postpone / cancel ------ */

export function ReasonDialog({
  item,
  kind,
  onClose,
}: {
  item: SurgicalCase | null;
  kind: 'postpone' | 'cancel' | null;
  onClose: () => void;
}) {
  const action = useTheatreAction(
    (reason: string) => ({ path: `/cases/${item!.id}/${kind}`, body: { reason } }),
    onClose,
  );
  if (!item || !kind) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === 'postpone' ? t('Postpone operation') : t('Cancel operation')}
    >
      <p>
        <strong>{patientLabel(item)}</strong> · {procedureLabel(item)}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action.mutate(String(new FormData(e.currentTarget).get('reason') ?? ''));
        }}
      >
        <TextAreaField
          label={t('Reason')}
          name="reason"
          rows={3}
          minLength={5}
          maxLength={500}
          required
        />
        <ErrorAlert error={action.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Back')}
          </Button>
          <Button type="submit" variant="danger" loading={action.isPending}>
            {kind === 'postpone' ? t('Postpone') : t('Cancel operation')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ note view -------------- */

export function NoteView({ item }: { item: SurgicalCase }) {
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <p className="muted" style={{ margin: 0 }}>
        {t('Signed by {name} on {date}', {
          name: item.noteSignedBy ?? item.surgeon,
          date: formatDateTime(item.noteSignedAt),
        })}
      </p>
      <div style={{ whiteSpace: 'pre-wrap' }}>{item.operationNote}</div>
      {item.complications && (
        <p style={{ margin: 0 }}>
          <strong>{t('Complications')}:</strong> {item.complications}
        </p>
      )}
      {item.estimatedBloodLossMl != null && (
        <p style={{ margin: 0 }}>
          <strong>{t('Estimated blood loss (ml)')}:</strong> {item.estimatedBloodLossMl}
        </p>
      )}
    </div>
  );
}
