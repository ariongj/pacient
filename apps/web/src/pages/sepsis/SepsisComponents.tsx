import { useEffect, useState, type FormEvent } from 'react';
import {
  AMBER_FLAGS,
  flagLabel,
  isRedFlag,
  minutesSince,
  RED_FLAGS,
  sourceLabel,
  statusLabel,
  statusTone,
  stepLabel,
  SUSPECTED_SOURCES,
  useRecordScreen,
  useRecordStep,
  useSeniorReview,
  type SepsisFlag,
  type SepsisScreen,
  type SuspectedSource,
} from '../../api/sepsis';
import { Alert, Badge, Button, ErrorAlert, SelectField, TextAreaField } from '../../components/ui';
import { formatDateTime, formatTime } from '../../format';
import { t } from '../../i18n';

/** Re-renders every 30 seconds so bundle timers stay current. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function SepsisStatusBadge({ status }: { status: SepsisScreen['status'] }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

/** "Bundle 35 min · 4 of 6" with the overdue state in words. */
export function BundleClock({ screen, target = 60 }: { screen: SepsisScreen; target?: number }) {
  const now = useNow();
  if (!screen.bundleStartedAt) return null;
  if (screen.bundleCompletedAt) {
    const minutes = Math.round(
      (new Date(screen.bundleCompletedAt).getTime() - new Date(screen.bundleStartedAt).getTime()) /
        60_000,
    );
    return (
      <Badge tone={minutes <= target ? 'success' : 'warning'}>
        {t('Sepsis Six complete in {minutes} min', { minutes })}
      </Badge>
    );
  }
  const minutes = minutesSince(screen.bundleStartedAt, now);
  const overdue = minutes >= target;
  return (
    <Badge tone={overdue ? 'danger' : 'warning'}>
      {overdue
        ? t('Overdue: {minutes} min, {done} of 6 done', { minutes, done: screen.stepsDone })
        : t('{minutes} min of {target}, {done} of 6 done', {
            minutes,
            target,
            done: screen.stepsDone,
          })}
    </Badge>
  );
}

/**
 * The screening questions: could this be an infection, where, and which flags are present. Flags
 * suggested from the latest observations are pre-ticked; the clinician confirms them.
 */
export function ScreenForm({
  patientId,
  screenId,
  suggested,
  onDone,
}: {
  patientId: string;
  screenId?: string;
  suggested: SepsisFlag[];
  onDone: (s: SepsisScreen) => void;
}) {
  const record = useRecordScreen(patientId);
  const [infection, setInfection] = useState<'yes' | 'no' | ''>('');
  const [source, setSource] = useState<SuspectedSource | ''>('');
  const [flags, setFlags] = useState<SepsisFlag[]>(suggested);
  const [notes, setNotes] = useState('');
  const toggle = (f: SepsisFlag, on: boolean) =>
    setFlags((prev) => (on ? [...prev, f] : prev.filter((x) => x !== f)));
  const hasRed = flags.some(isRedFlag);
  const hasAmber = flags.some((f) => !isRedFlag(f));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!infection) return;
    record.mutate(
      {
        screenId,
        input: {
          suspectedInfection: infection === 'yes',
          suspectedSource: infection === 'yes' && source ? source : null,
          flags,
          notes: notes.trim() || null,
        },
      },
      { onSuccess: onDone },
    );
  }

  const flagGroup = (title: string, list: readonly SepsisFlag[]) => (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend>
        <strong>{title}</strong>
      </legend>
      {list.map((f) => (
        <label key={f} className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={flags.includes(f)}
            onChange={(e) => toggle(f, e.target.checked)}
          />
          <span>
            {flagLabel(f)}
            {suggested.includes(f) && (
              <span className="muted"> · {t('from the latest observations')}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <form className="stack" onSubmit={submit}>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>
          <strong>{t('Could this be an infection?')}</strong>
        </legend>
        {(['yes', 'no'] as const).map((v) => (
          <label key={v} className="row" style={{ gap: '0.5rem' }}>
            <input
              type="radio"
              name="infection"
              value={v}
              checked={infection === v}
              onChange={() => setInfection(v)}
              required
            />
            <span>{v === 'yes' ? t('Yes, infection is possible') : t('No')}</span>
          </label>
        ))}
      </fieldset>
      {infection === 'yes' && (
        <SelectField
          label={t('Suspected source')}
          value={source}
          onChange={(e) => setSource(e.target.value as SuspectedSource)}
          placeholder={t('Choose…')}
          options={SUSPECTED_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) }))}
        />
      )}
      {flagGroup(t('Red flags'), RED_FLAGS)}
      {flagGroup(t('Amber flags'), AMBER_FLAGS)}
      <TextAreaField
        label={t('Notes')}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={2000}
        rows={2}
      />
      {infection === 'yes' && hasRed && (
        <Alert tone="danger" title={t('Red flag sepsis')}>
          {t(
            'Start the Sepsis Six now and inform a senior clinician. All six steps within one hour.',
          )}
        </Alert>
      )}
      {infection === 'yes' && !hasRed && hasAmber && (
        <Alert tone="warning" title={t('Sepsis suspected')}>
          {t('Ask a senior clinician to review within one hour; the bundle may be needed.')}
        </Alert>
      )}
      <p className="muted">
        {t(
          'Illustrative screening tool based on the UK Sepsis Trust and NICE NG51 – follow your hospital’s adopted sepsis protocol.',
        )}
      </p>
      <ErrorAlert error={record.error} />
      <div className="form-actions">
        <Button type="submit" loading={record.isPending} disabled={!infection}>
          {t('Record the screen')}
        </Button>
      </div>
    </form>
  );
}

/** The Sepsis Six steps with times and one-click recording. */
export function BundlePanel({
  patientId,
  screen,
  canReview,
  target = 60,
}: {
  patientId: string;
  screen: SepsisScreen;
  canReview: boolean;
  target?: number;
}) {
  const step = useRecordStep(patientId);
  const review = useSeniorReview(patientId);
  const active = screen.status === 'RED_FLAG' || screen.status === 'SEPSIS_SUSPECTED';
  return (
    <div className="stack">
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <SepsisStatusBadge status={screen.status} />
        <BundleClock screen={screen} target={target} />
        {screen.escalatedAt && <Badge tone="danger">{t('Escalated to the doctors')}</Badge>}
      </div>
      <ol className="stack" style={{ paddingLeft: '1.2rem', margin: 0 }}>
        {screen.steps.map((s) => (
          <li key={s.step}>
            <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
              <span>{stepLabel(s.step)}</span>
              {s.at ? (
                <span className="muted">
                  ✓ {formatTime(s.at)}
                  {s.by ? ` · ${s.by}` : ''}
                </span>
              ) : active ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={step.isPending && step.variables?.step === s.step}
                  onClick={() => step.mutate({ screenId: screen.id, step: s.step })}
                >
                  {t('Done now')}
                </Button>
              ) : (
                <span className="muted">—</span>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
        {screen.seniorReviewAt ? (
          <span className="muted">
            {t('Senior review at {time}', { time: formatDateTime(screen.seniorReviewAt) })}
          </span>
        ) : (
          canReview &&
          active && (
            <Button
              size="sm"
              variant="secondary"
              loading={review.isPending}
              onClick={() => review.mutate(screen.id)}
            >
              {t('Record senior review')}
            </Button>
          )
        )}
      </div>
      <ErrorAlert error={step.error ?? review.error} />
    </div>
  );
}

/** Flags of a recorded screen, red ones first. */
export function FlagList({ flags }: { flags: SepsisFlag[] }) {
  if (!flags.length) return <span className="muted">{t('No flags')}</span>;
  const sorted = [...flags].sort((a, b) => Number(isRedFlag(b)) - Number(isRedFlag(a)));
  return (
    <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
      {sorted.map((f) => (
        <li key={f}>
          {isRedFlag(f) ? <strong>{flagLabel(f)}</strong> : flagLabel(f)}
          {isRedFlag(f) && <span className="muted"> ({t('red flag')})</span>}
        </li>
      ))}
    </ul>
  );
}
