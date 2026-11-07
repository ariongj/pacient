import { useState, type FormEvent } from 'react';
import {
  DONATION_DECISIONS,
  decisionLabel,
  organLabel,
  ORGANS,
  type DonationDecision,
  type DonationInput,
  type Organ,
} from '../../api/directives';
import { Button, Dialog, ErrorAlert, TextAreaField } from '../../components/ui';
import { t } from '../../i18n';

/** The organ donation decision form (portal and in person). */
export function DonationForm({
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
  inPerson = false,
}: {
  initial?: { decision: DonationDecision; organs: Organ[] | null } | null;
  submitting: boolean;
  error: unknown;
  onSubmit: (body: DonationInput) => void;
  onCancel: () => void;
  inPerson?: boolean;
}) {
  const [decision, setDecision] = useState<DonationDecision | ''>(initial?.decision ?? '');
  const [organs, setOrgans] = useState<Organ[]>(initial?.organs ?? []);
  const [familyInformed, setFamilyInformed] = useState(false);
  const [present, setPresent] = useState(false);
  const [note, setNote] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!decision) return;
    onSubmit({
      decision,
      ...(decision === 'DONOR_SOME' ? { organs } : {}),
      familyInformed,
      ...(note.trim() ? { faithOrBeliefNote: note.trim() } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="stack">
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>
          <strong>{t('Decision')}</strong>
        </legend>
        {DONATION_DECISIONS.map((d) => (
          <label key={d} className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="decision"
              value={d}
              checked={decision === d}
              onChange={() => setDecision(d)}
              required
            />
            <span>{decisionLabel(d)}</span>
          </label>
        ))}
      </fieldset>
      {decision === 'DONOR_SOME' && (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>
            <strong>{t('Organs and tissue I want to donate')}</strong>
          </legend>
          {ORGANS.map((o) => (
            <label key={o} className="row" style={{ gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={organs.includes(o)}
                onChange={(e) =>
                  setOrgans((prev) =>
                    e.target.checked ? [...prev, o] : prev.filter((x) => x !== o),
                  )
                }
              />
              <span>{organLabel(o)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="row" style={{ gap: '0.5rem' }}>
        <input
          type="checkbox"
          checked={familyInformed}
          onChange={(e) => setFamilyInformed(e.target.checked)}
        />
        <span>
          {inPerson ? t('The family knows about this decision') : t('My family knows my decision')}
        </span>
      </label>
      <TextAreaField
        label={t('Faith or belief (optional)')}
        hint={t('Anything the care team should respect, for example religious practices.')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={300}
        rows={2}
      />
      {inPerson && (
        <label className="row" style={{ gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={present}
            onChange={(e) => setPresent(e.target.checked)}
            required
          />
          <span>
            {t(
              'The person is here, has stated this decision themselves and agrees that I record it.',
            )}
          </span>
        </label>
      )}
      <ErrorAlert error={error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="submit"
          loading={submitting}
          disabled={!decision || (decision === 'DONOR_SOME' && organs.length === 0)}
        >
          {t('Save decision')}
        </Button>
      </div>
    </form>
  );
}

/** A dialog asking for a reason (revoking or withdrawing). */
export function ReasonDialog({
  open,
  title,
  intro,
  submitLabel,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  intro?: string;
  submitLabel: string;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(reason.trim());
        }}
        className="stack"
      >
        {intro && <p>{intro}</p>}
        <TextAreaField
          label={t('Reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={5}
          maxLength={500}
          rows={3}
        />
        <ErrorAlert error={error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={submitting}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
