import { useState, type FormEvent } from 'react';
import {
  instrumentName,
  localText,
  SEVERITY_TONE,
  severityLabel,
  useReviewResponse,
  useSubmitResponse,
  type Advice,
  type Change,
  type Instrument,
  type InstrumentCode,
  type Response,
  type SubmitResult,
} from '../../api/proms';
import { Alert, Badge, Button, Dialog, ErrorAlert, TextAreaField } from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { t } from '../../i18n';

/** The sq/sr wording is not validated yet: said wherever questionnaire text is shown. */
export function TranslationNote() {
  return (
    <p className="muted" style={{ fontSize: '0.85rem' }}>
      {t(
        'Albanian and Serbian wording is a working translation, to be replaced by validated translations before clinical use.',
      )}
    </p>
  );
}

export function SeverityBadge({ severity }: { severity: string | null }) {
  if (!severity) return <>—</>;
  return <Badge tone={SEVERITY_TONE[severity] ?? 'neutral'}>{severityLabel(severity)}</Badge>;
}

/** "Score 12 of 27". */
export function scoreText(inst: Instrument | undefined, score: number | null) {
  if (score === null) return '—';
  return inst
    ? t('{score} of {max}', { score: formatNumber(score), max: formatNumber(inst.maxScore) })
    : formatNumber(score);
}

/** "−6 since last time (meaningful improvement)". */
export function ChangeText({ change }: { change: Change | null }) {
  if (!change) return <span className="muted">{t('First answer')}</span>;
  const diff = `${change.difference > 0 ? '+' : change.difference < 0 ? '−' : '±'}${formatNumber(
    Math.abs(change.difference),
  )}`;
  const what =
    change.direction === 'SAME'
      ? t('no change')
      : change.meaningful
        ? change.direction === 'BETTER'
          ? t('meaningful improvement')
          : t('meaningful worsening')
        : change.direction === 'BETTER'
          ? t('slightly better')
          : t('slightly worse');
  return <span>{t('{diff} since last time ({what})', { diff, what })}</span>;
}

/** What the person is told at once after answering. */
export function AdviceAlert({
  advice,
  careTeamNotified,
}: {
  advice: Advice;
  careTeamNotified?: boolean;
}) {
  if (advice === 'CRISIS') {
    return (
      <Alert tone="danger" title={t('You are not alone – please talk to someone now')}>
        <p>
          {t(
            'Your answers say you have had thoughts of being better off dead or of hurting yourself. If you might act on these thoughts or are in danger, call 112 now.',
          )}
        </p>
        <p>
          {t(
            'You can also call the mental health helpline: number to be confirmed by the Ministry of Health (placeholder in this demo).',
          )}
        </p>
        {careTeamNotified && (
          <p>
            {t(
              'Your care team has been told and will contact you. Questionnaires are not watched around the clock, so do not wait for them if you need help now.',
            )}
          </p>
        )}
      </Alert>
    );
  }
  if (advice === 'HIGH') {
    return (
      <Alert tone="warning" title={t('Please talk to your doctor soon')}>
        {t(
          'Your answers suggest that you are having a hard time. Please contact your family doctor within the next few days. If you feel unsafe, call 112.',
        )}
      </Alert>
    );
  }
  return null;
}

/** One questionnaire to fill in, one radio group per question. */
export function QuestionnaireForm({
  instrument,
  assignmentId,
  onDone,
  onCancel,
}: {
  instrument: Instrument;
  assignmentId: string;
  onDone: (result: SubmitResult) => void;
  onCancel: () => void;
}) {
  const submit = useSubmitResponse();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const neverDrinks = instrument.code === 'AUDITC' && answers.q1 === 0;
  const required = instrument.items.map((i) => i.code).filter((c) => !(neverDrinks && c !== 'q1'));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const left = required.filter((c) => answers[c] === undefined);
    setMissing(left);
    if (left.length) return;
    const body = neverDrinks ? { q1: 0 } : answers;
    submit.mutate(
      { instrument: instrument.code, assignmentId, answers: body },
      { onSuccess: onDone },
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <p>
        <strong>{localText(instrument.stem)}</strong>
      </p>
      <TranslationNote />
      {instrument.items.map((item, idx) => {
        if (neverDrinks && item.code !== 'q1') return null;
        const err = missing.includes(item.code);
        return (
          <fieldset
            key={item.code}
            aria-invalid={err || undefined}
            style={err ? { borderColor: 'var(--danger)' } : undefined}
          >
            <legend>
              {idx + 1}. {localText(item.text)}
            </legend>
            {err && <p className="error-text">{t('Please choose an answer.')}</p>}
            <div className="stack" style={{ gap: '0.35rem' }}>
              {item.options.map((o) => (
                <label key={o.value} className="checkbox">
                  <input
                    type="radio"
                    name={`${instrument.code}-${item.code}`}
                    checked={answers[item.code] === o.value}
                    onChange={() => setAnswers((a) => ({ ...a, [item.code]: o.value }))}
                  />
                  <span>{localText(o.text)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
      {missing.length > 0 && (
        <Alert tone="warning">{t('Please answer every question before sending.')}</Alert>
      )}
      <ErrorAlert error={submit.error} />
      <div className="row">
        <Button type="submit" loading={submit.isPending}>
          {t('Send my answers')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  );
}

const BAND_FILL: Record<string, string> = {
  success: 'var(--success-soft)',
  neutral: 'var(--info-soft)',
  info: 'var(--info-soft)',
  warning: 'var(--warning-soft)',
  danger: 'var(--danger-soft)',
};

/** Scores over time with the instrument's severity bands drawn behind (table for screen readers). */
export function ScoreTrend({
  instrument,
  responses,
}: {
  instrument: Instrument;
  responses: Pick<Response, 'id' | 'score' | 'severity' | 'submittedAt'>[];
}) {
  const rows = responses
    .filter((r) => r.score !== null)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const title = t('{name}: scores over time', { name: instrumentName(instrument.code) });
  if (!rows.length) return <p className="muted">{t('No answers yet.')}</p>;
  const w = 640;
  const h = 200;
  const padL = 40;
  const padR = 12;
  const padY = 10;
  const first = new Date(rows[0]!.submittedAt).getTime();
  const last = new Date(rows[rows.length - 1]!.submittedAt).getTime();
  const span = Math.max(last - first, 86_400_000);
  const x = (at: string) =>
    rows.length === 1
      ? (padL + w - padR) / 2
      : padL + ((new Date(at).getTime() - first) / span) * (w - padL - padR);
  const y = (v: number) =>
    h -
    padY -
    ((v - instrument.minScore) / (instrument.maxScore - instrument.minScore)) * (h - padY * 2);
  const line = rows.map((r) => `${x(r.submittedAt)},${y(r.score!)}`).join(' ');
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`${title}. ${t('Values in the table below.')}`}
        style={{ width: '100%', height: h }}
      >
        {instrument.bands.map((b, i, all) => {
          // Each band reaches halfway to its neighbours, so the bands touch.
          const lower = i === 0 ? instrument.minScore : (all[i - 1]!.max + b.min) / 2;
          const upper = i === all.length - 1 ? instrument.maxScore : (b.max + all[i + 1]!.min) / 2;
          return (
            <g key={b.code}>
              <rect
                x={padL}
                width={w - padL - padR}
                y={y(upper)}
                height={Math.max(0, y(lower) - y(upper))}
                style={{ fill: BAND_FILL[SEVERITY_TONE[b.code] ?? 'neutral'] }}
              />
              <text
                x={padL - 6}
                y={y(b.min) + 4}
                textAnchor="end"
                style={{ fontSize: 11, fill: 'var(--text-muted)' }}
              >
                {formatNumber(b.min)}
              </text>
            </g>
          );
        })}
        <polyline
          points={line}
          style={{ fill: 'none', stroke: 'var(--primary)', strokeWidth: 2.5 }}
          strokeLinejoin="round"
        />
        {rows.map((r) => (
          <circle
            key={r.id}
            cx={x(r.submittedAt)}
            cy={y(r.score!)}
            r={4.5}
            style={{ fill: 'var(--primary)' }}
          >
            <title>{`${formatDate(r.submittedAt)}: ${formatNumber(r.score!)} (${severityLabel(r.severity)})`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-labels" aria-hidden="true">
        <span>{formatDate(rows[0]!.submittedAt)}</span>
        {rows.length > 1 && <span>{formatDate(rows[rows.length - 1]!.submittedAt)}</span>}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.4rem' }}>
        {instrument.bands.map((b) => (
          <span key={b.code} className="muted" style={{ fontSize: '0.8rem' }}>
            <SeverityBadge severity={b.code} /> {formatNumber(b.min)}–{formatNumber(b.max)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{formatDate(r.submittedAt)}</th>
              <td>{formatNumber(r.score!)}</td>
              <td>{severityLabel(r.severity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Item-by-item answers (for the care team). */
export function AnswersList({
  instrument,
  answers,
}: {
  instrument: Instrument;
  answers: Record<string, number>;
}) {
  return (
    <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
      {instrument.items.map((item) => {
        const v = answers[item.code];
        const opt = item.options.find((o) => o.value === v);
        const selfHarm = instrument.code === 'PHQ9' && item.code === 'q9' && (v ?? 0) > 0;
        return (
          <li key={item.code} style={selfHarm ? { color: 'var(--danger)' } : undefined}>
            {localText(item.text)}: <strong>{opt ? localText(opt.text) : '—'}</strong>{' '}
            <span className="muted">({v ?? '—'})</span>
            {selfHarm && (
              <>
                {' '}
                <Badge tone="danger">{t('Safety question')}</Badge>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function ReviewDialog({
  item,
  patientName,
  instrument,
  onClose,
}: {
  item: {
    id: string;
    instrument: InstrumentCode;
    score: number | null;
    severity: string | null;
    safetyFlag?: boolean;
    submittedAt: string;
  } | null;
  patientName?: string;
  instrument?: Instrument;
  onClose: () => void;
}) {
  const review = useReviewResponse();
  return (
    <Dialog open={!!item} onClose={onClose} title={t('Review questionnaire answers')}>
      {item && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
            review.mutate({ id: item.id, note }, { onSuccess: onClose });
          }}
        >
          <div>
            {patientName && <strong>{patientName}</strong>}
            <div>
              {instrumentName(item.instrument)}: {scoreText(instrument, item.score)}{' '}
              <SeverityBadge severity={item.severity} />
              {item.safetyFlag && (
                <>
                  {' '}
                  <Badge tone="danger">{t('Needs attention today')}</Badge>
                </>
              )}
            </div>
            <div className="muted">{formatDateTime(item.submittedAt)}</div>
          </div>
          {item.safetyFlag && (
            <Alert tone="warning">
              {t(
                'Contact the patient today and follow the local protocol for suicide risk assessment before marking these answers as reviewed.',
              )}
            </Alert>
          )}
          <TextAreaField
            name="note"
            label={t('Note (optional)')}
            maxLength={500}
            placeholder={t('e.g. called the patient, appointment booked, safety plan agreed')}
          />
          <ErrorAlert error={review.error} />
          <div className="row">
            <Button type="submit" loading={review.isPending}>
              {t('Mark as reviewed')}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
