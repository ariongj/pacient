import { useState, type FormEvent } from 'react';
import {
  priorityFor,
  priorityLabel,
  priorityTone,
  useCreateCall,
  type CallAnswers,
  type EmsPriority,
} from '../../api/ems';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  ErrorAlert,
  formValues,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { t } from '../../i18n';

const QUESTIONS: { key: keyof CallAnswers; label: string; danger: boolean }[] = [
  { key: 'conscious', label: 'Is the person conscious?', danger: false },
  { key: 'breathingNormally', label: 'Are they breathing normally?', danger: false },
  { key: 'chestPain', label: 'Chest pain?', danger: true },
  { key: 'majorBleeding', label: 'Major bleeding?', danger: true },
  { key: 'strokeSigns', label: 'Signs of a stroke (face, arm, speech)?', danger: true },
  {
    key: 'seriousInjury',
    label: 'Serious injury (fall from height, traffic collision)?',
    danger: true,
  },
  { key: 'severePain', label: 'Severe pain?', danger: true },
];

/** Record an emergency call with the structured questions that suggest its category. */
export function NewCallDialog({
  serviceId,
  open,
  onClose,
  onCreated,
}: {
  serviceId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [answers, setAnswers] = useState<CallAnswers>({ conscious: true, breathingNormally: true });
  const [override, setOverride] = useState<EmsPriority | ''>('');
  const create = useCreateCall();
  const computed = priorityFor(answers);
  const priority = override || computed;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate(
      {
        serviceId,
        callerName: v.callerName || undefined,
        callerPhone: v.callerPhone || undefined,
        address: v.address,
        municipality: v.municipality || undefined,
        complaint: v.complaint,
        patientDescription: v.patientDescription || undefined,
        answers,
        ...(override && override !== computed
          ? { priority: override, priorityReason: v.priorityReason }
          : {}),
      },
      {
        onSuccess: (row) => {
          setAnswers({ conscious: true, breathingNormally: true });
          setOverride('');
          onCreated(row.id);
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('New emergency call')} wide>
      <form onSubmit={onSubmit} className="stack">
        <div className="form-grid">
          <TextField label={t('Caller')} name="callerName" maxLength={200} autoComplete="off" />
          <TextField
            label={t('Caller’s phone')}
            name="callerPhone"
            type="tel"
            maxLength={40}
            autoComplete="off"
          />
          <TextField label={t('Address')} name="address" required minLength={3} maxLength={300} />
          <TextField label={t('Municipality')} name="municipality" maxLength={100} />
        </div>
        <TextField
          label={t('What happened (main complaint)')}
          name="complaint"
          required
          minLength={3}
          maxLength={300}
        />
        <TextField
          label={t('Description of the person (if not known)')}
          name="patientDescription"
          maxLength={300}
          hint={t('e.g. “man about 60”. The patient can be identified later.')}
        />
        <fieldset className="stack">
          <legend>{t('Questions to the caller')}</legend>
          {QUESTIONS.map((q) => (
            <label key={q.key} className="checkbox">
              <input
                type="checkbox"
                checked={Boolean(answers[q.key])}
                onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.checked })}
              />
              {t(q.label)}
            </label>
          ))}
        </fieldset>
        <Alert tone={priorityTone(computed)} title={t('Suggested category')}>
          <Badge tone={priorityTone(computed)}>{priorityLabel(computed)}</Badge>{' '}
          {t('Categories are illustrative until the national dispatch protocol is adopted.')}
        </Alert>
        <div className="form-grid">
          <SelectField
            label={t('Category to dispatch')}
            name="priority"
            value={override}
            onChange={(e) => setOverride(e.target.value as EmsPriority | '')}
            placeholder={t('As suggested')}
            options={(['P1', 'P2', 'P3'] as const).map((p) => ({
              value: p,
              label: priorityLabel(p),
            }))}
          />
          {override && override !== computed && (
            <TextAreaField
              label={t('Reason for changing the category')}
              name="priorityReason"
              required
              minLength={5}
              maxLength={300}
              rows={2}
            />
          )}
        </div>
        <p className="muted">
          {t('Category to dispatch')}: <strong>{priorityLabel(priority)}</strong>
        </p>
        <ErrorAlert error={create.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('Record the call')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
