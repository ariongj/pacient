import { useState, type FormEvent } from 'react';
import {
  FLAG_TONE,
  flagLabel,
  glucoseContextLabel,
  kindLabel,
  limitLabel,
  limitLinesOf,
  READING_KINDS,
  readingValue,
  reasonLabel,
  seriesOf,
  UNITS,
  useRemoteDefinitions,
  useReviewReading,
  type Advice,
  type Flag,
  type Limits,
  type PlanInput,
  type Reading,
  type ReadingKind,
} from '../../api/remote';
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
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { t } from '../../i18n';

const DAY = 86_400_000;

export function FlagBadge({ flag }: { flag: Flag }) {
  return <Badge tone={FLAG_TONE[flag]}>{flagLabel(flag)}</Badge>;
}

export function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return <div className="muted">{reasons.map(reasonLabel).join(' · ')}</div>;
}

/* ------------------------------------------------------------------------- trend chart -- */

const LINE_COLORS = ['var(--primary)', 'var(--info)'];
const FLAG_COLORS: Record<Flag, string> = {
  NORMAL: 'var(--primary)',
  OUT_OF_RANGE: 'var(--warning)',
  URGENT: 'var(--danger)',
};

/**
 * Readings of one kind over time, scaled to their own range (not from zero) with the personal
 * limits drawn as dashed lines. Flagged points are larger and coloured; the values are also in a
 * table for screen readers.
 */
export function TrendChart({
  kind,
  readings,
  limits,
  days = 30,
}: {
  kind: ReadingKind;
  readings: Reading[];
  limits: Limits;
  days?: number;
}) {
  const now = Date.now();
  const from = now - days * DAY;
  const rows = readings
    .filter((r) => r.kind === kind && new Date(r.measuredAt).getTime() >= from)
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  const series = seriesOf(kind);
  const lines = limitLinesOf(kind, limits);
  const title = t('{kind}, last {days} days', { kind: kindLabel(kind), days });
  if (!rows.length) {
    return (
      <p className="muted">
        {t('No {kind} readings in the last {days} days.', {
          kind: kindLabel(kind).toLowerCase(),
          days,
        })}
      </p>
    );
  }
  const values = rows.flatMap((r) =>
    series.map((s) => r.values[s.key]).filter((v): v is number => typeof v === 'number'),
  );
  const all = [...values, ...lines.map((l) => l.value)];
  let min = Math.min(...all);
  let max = Math.max(...all);
  const margin = (max - min || Math.abs(max) || 1) * 0.1;
  min -= margin;
  max += margin;
  const w = 640;
  const h = 200;
  const padL = 44;
  const padR = 12;
  const padY = 12;
  const x = (at: string) =>
    padL + ((new Date(at).getTime() - from) / (now - from)) * (w - padL - padR);
  const y = (v: number) => h - padY - ((v - min) / (max - min)) * (h - padY * 2);
  const ticks = [min + margin, (min + max) / 2, max - margin];
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`${title}. ${t('Values in the table below.')}`}
        style={{ width: '100%', height: h }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--border)' }} />
            <text
              x={padL - 6}
              y={y(v) + 4}
              textAnchor="end"
              style={{ fontSize: 11, fill: 'var(--text-muted)' }}
            >
              {formatNumber(Math.round(v * 10) / 10)}
            </text>
          </g>
        ))}
        {lines.map((l) => (
          <line
            key={l.label}
            x1={padL}
            x2={w - padR}
            y1={y(l.value)}
            y2={y(l.value)}
            strokeDasharray="6 4"
            style={{
              stroke: l.tone === 'danger' ? 'var(--danger)' : 'var(--warning)',
              strokeWidth: 1.5,
            }}
          >
            <title>{`${l.label}: ${formatNumber(l.value)}`}</title>
          </line>
        ))}
        {series.map((s, i) => {
          const pts = rows.filter((r) => typeof r.values[s.key] === 'number');
          return (
            <g key={s.key}>
              <polyline
                points={pts
                  .map((r) => `${x(r.measuredAt)},${y(r.values[s.key] as number)}`)
                  .join(' ')}
                style={{ fill: 'none', stroke: LINE_COLORS[i], strokeWidth: 2 }}
                strokeLinejoin="round"
              />
              {pts.map((r) => (
                <circle
                  key={r.id}
                  cx={x(r.measuredAt)}
                  cy={y(r.values[s.key] as number)}
                  r={r.flag === 'NORMAL' ? 3 : 5}
                  style={{ fill: r.flag === 'NORMAL' ? LINE_COLORS[i] : FLAG_COLORS[r.flag] }}
                >
                  <title>{`${formatDateTime(r.measuredAt)}: ${readingValue(kind, r.values)} – ${flagLabel(r.flag)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <div
        className="row muted"
        aria-hidden="true"
        style={{ fontSize: '0.8rem', justifyContent: 'space-between' }}
      >
        <span>{formatDate(new Date(from).toISOString())}</span>
        {series.length > 1 && (
          <span>
            {series.map((s, i) => (
              <span key={s.key} style={{ marginRight: '1rem' }}>
                <span style={{ color: LINE_COLORS[i] }}>━</span> {s.label}
              </span>
            ))}
          </span>
        )}
        {lines.length > 0 && <span>┄ {t('Personal limits')}</span>}
        <span>{t('Today')}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{t('Measured')}</th>
            <th scope="col">{t('Value')}</th>
            <th scope="col">{t('Result|reading')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{formatDateTime(r.measuredAt)}</th>
              <td>{readingValue(kind, r.values)}</td>
              <td>{flagLabel(r.flag)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/* --------------------------------------------------------------------- patient advice -- */

/**
 * What the patient sees straight after entering a reading. Urgent wording asks people to act on
 * how they feel (112 for warning signs) and not to wait for the care team, who are told as well.
 */
export function AdviceAlert({ advice }: { advice: Advice }) {
  if (advice === 'URGENT_LOW_GLUCOSE') {
    return (
      <Alert tone="danger" title={t('Your blood sugar is very low')}>
        <p>
          {t(
            'Take fast-acting sugar now: for example a glass (150 ml) of fruit juice or 3–4 glucose tablets. Measure again after 15 minutes and repeat if it is still below 4 mmol/L, then eat a snack.',
          )}
        </p>
        <p>
          <strong>
            {t(
              'If the person is drowsy, confused or cannot swallow safely, call 112 now. Do not drive.',
            )}
          </strong>
        </p>
        <p>{t('Your care team has been notified, but they may not see it straight away.')}</p>
      </Alert>
    );
  }
  if (advice === 'URGENT') {
    return (
      <Alert tone="danger" title={t('This reading needs urgent attention')}>
        <p>
          <strong>
            {t(
              'If you feel unwell – chest pain, shortness of breath, severe headache, weakness or numbness, confusion or fainting – call 112 now.',
            )}
          </strong>
        </p>
        <p>
          {t(
            'If you feel well, rest for 5 minutes and measure again. If the value stays like this, call your family doctor today.',
          )}
        </p>
        <p>{t('Your care team has been notified, but they may not see it straight away.')}</p>
      </Alert>
    );
  }
  if (advice === 'OUT_OF_RANGE') {
    return (
      <Alert tone="warning" title={t('This reading is outside the limits your doctor set')}>
        {t(
          'Your care team will look at it. Keep measuring as agreed, and contact your doctor if you feel unwell.',
        )}
      </Alert>
    );
  }
  return (
    <Alert tone="success" title={t('Reading saved')}>
      {t('Thank you. The reading is within your limits.')}
    </Alert>
  );
}

/* ---------------------------------------------------------------------- reading form -- */

const toLocalInput = (d: Date) => {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};

/** The values the portal asks for, per kind. */
export function ReadingFields({ kind }: { kind: ReadingKind }) {
  const num = (name: string, label: string, step = '1', required = true) => (
    <TextField
      key={name}
      name={name}
      label={label}
      type="number"
      inputMode="decimal"
      step={step}
      required={required}
    />
  );
  switch (kind) {
    case 'BLOOD_PRESSURE':
      return (
        <>
          {num('systolic', t('Systolic (upper) mmHg'))}
          {num('diastolic', t('Diastolic (lower) mmHg'))}
          {num('pulse', t('Pulse per minute (optional)'), '1', false)}
        </>
      );
    case 'GLUCOSE':
      return (
        <>
          {num('value', t('Blood glucose mmol/L'), '0.1')}
          <SelectField
            name="context"
            label={t('When was it measured?')}
            defaultValue="FASTING"
            options={['FASTING', 'BEFORE_MEAL', 'AFTER_MEAL', 'BEDTIME', 'RANDOM'].map((c) => ({
              value: c,
              label: glucoseContextLabel(c),
            }))}
          />
        </>
      );
    case 'SPO2':
      return (
        <>
          {num('value', t('Oxygen saturation %'))}
          {num('pulse', t('Pulse per minute (optional)'), '1', false)}
        </>
      );
    case 'WEIGHT':
      return num('value', t('Weight kg'), '0.1');
    case 'TEMPERATURE':
      return num('value', t('Temperature °C'), '0.1');
    case 'HEART_RATE':
      return num('value', t('Pulse per minute'));
    case 'PEAK_FLOW':
      return num('value', t('Peak flow L/min'));
  }
}

/** Reads the kind's values from the form (numbers, plus the glucose context). */
export function readValues(kind: ReadingKind, data: FormData): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const key of ['systolic', 'diastolic', 'pulse', 'value']) {
    const raw = String(data.get(key) ?? '')
      .trim()
      .replace(',', '.');
    if (raw !== '') out[key] = Number(raw);
  }
  if (kind === 'GLUCOSE') out.context = String(data.get('context') ?? 'RANDOM');
  return out;
}

export function MeasuredAtField() {
  const now = new Date();
  return (
    <TextField
      name="measuredAt"
      type="datetime-local"
      label={t('Measured at')}
      defaultValue={toLocalInput(now)}
      max={toLocalInput(now)}
      min={toLocalInput(new Date(now.getTime() - 7 * DAY))}
      hint={t('Readings from the last 7 days can be entered.')}
      required
    />
  );
}

/* ------------------------------------------------------------------------- plan form -- */

/** Enrol / edit form: measurements, personal limits (prefilled with the defaults), frequency. */
export function PlanForm({
  initial,
  suggestedKinds,
  onSubmit,
  pending,
  error,
  submitLabel,
}: {
  initial?: {
    kinds: ReadingKind[];
    limits: Limits;
    frequency: string | null;
    instructions: string | null;
  };
  suggestedKinds?: ReadingKind[];
  onSubmit: (input: PlanInput) => void;
  pending: boolean;
  error: unknown;
  submitLabel: string;
}) {
  const defs = useRemoteDefinitions();
  const [kinds, setKinds] = useState<ReadingKind[]>(
    initial?.kinds ?? suggestedKinds ?? ['BLOOD_PRESSURE'],
  );
  const toggle = (k: ReadingKind) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  const defaults = defs.data?.defaults ?? {};
  const limitKeys = [
    ...kinds.flatMap(
      (k) => defs.data?.kinds.find((d) => d.kind === k)?.thresholds.map((x) => x.key) ?? [],
    ),
    'silentAfterDays',
  ];
  const valueOf = (key: string) => initial?.limits[key] ?? defaults[key];

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const thresholds: Limits = {};
    for (const key of limitKeys) {
      const raw = String(data.get(`limit.${key}`) ?? '')
        .trim()
        .replace(',', '.');
      if (raw !== '') thresholds[key] = Number(raw);
    }
    onSubmit({
      kinds,
      thresholds,
      frequency: String(data.get('frequency') ?? '').trim() || null,
      instructions: String(data.get('instructions') ?? '').trim() || null,
    });
  }

  return (
    <form onSubmit={submit} className="stack">
      <fieldset>
        <legend>{t('Measurements at home')}</legend>
        <div className="row">
          {READING_KINDS.map((k) => (
            <label key={k} className="row" style={{ gap: '0.35rem' }}>
              <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggle(k)} />
              {kindLabel(k)} <span className="muted">({UNITS[k]})</span>
              {suggestedKinds?.includes(k) && <Badge tone="info">{t('Suggested')}</Badge>}
            </label>
          ))}
        </div>
      </fieldset>
      {kinds.length > 0 && (
        <fieldset>
          <legend>{t('Personal alert limits')}</legend>
          <p className="muted">
            {t(
              'Prefilled with illustrative defaults – adjust them for this patient. Readings beyond a review limit go to the review list; beyond an urgent limit the care team is notified at once and the patient is told to seek help.',
            )}
          </p>
          <div className="form-grid">
            {limitKeys.map((key) => (
              <TextField
                key={`${key}-${kinds.join()}`}
                name={`limit.${key}`}
                label={limitLabel(key)}
                type="number"
                step="any"
                inputMode="decimal"
                defaultValue={valueOf(key) ?? ''}
                hint={
                  key.startsWith('peakFlow')
                    ? t('Set from the patient’s own best value.')
                    : undefined
                }
              />
            ))}
          </div>
        </fieldset>
      )}
      <TextField
        name="frequency"
        label={t('How often')}
        placeholder={t('e.g. twice daily, morning and evening')}
        maxLength={100}
        defaultValue={initial?.frequency ?? ''}
      />
      <TextAreaField
        name="instructions"
        label={t('Instructions for the patient')}
        maxLength={2000}
        defaultValue={initial?.instructions ?? ''}
      />
      <ErrorAlert error={error} />
      <div className="row">
        <Button type="submit" loading={pending} disabled={!kinds.length}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------------- review dialog -- */

export function ReviewDialog({
  reading,
  patientName,
  onClose,
}: {
  reading: {
    id: string;
    kind: ReadingKind;
    values: Record<string, number | string>;
    flag: Flag;
    reasons: string[];
    measuredAt: string;
    note: string | null;
  } | null;
  patientName?: string;
  onClose: () => void;
}) {
  const review = useReviewReading();
  return (
    <Dialog open={!!reading} onClose={onClose} title={t('Review home reading')}>
      {reading && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
            review.mutate({ id: reading.id, note }, { onSuccess: onClose });
          }}
        >
          <div>
            {patientName && <strong>{patientName}</strong>}
            <div>
              {kindLabel(reading.kind)}: {readingValue(reading.kind, reading.values)}{' '}
              <FlagBadge flag={reading.flag} />
            </div>
            <div className="muted">{formatDateTime(reading.measuredAt)}</div>
            <Reasons reasons={reading.reasons} />
            {reading.note && <p>“{reading.note}”</p>}
          </div>
          <TextAreaField
            name="note"
            label={t('Note (optional)')}
            maxLength={500}
            placeholder={t('e.g. called the patient, medication adjusted, recheck in 2 days')}
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
