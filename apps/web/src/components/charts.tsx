import { t } from '../i18n';
import { formatMonth, formatNumber } from '../format';

/**
 * Lightweight, dependency-free bar chart. Each chart also renders an equivalent visually hidden
 * data table so screen-reader users get the same information.
 */
export function BarChart({
  title,
  data,
  height = 160,
}: {
  title: string;
  data: { label: string; value: number }[];
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barW = 100 / Math.max(1, data.length);
  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 100 ${height / 4}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}. ${t('Values in the table below.')}`}
        style={{ height }}
      >
        {data.map((d, i) => {
          const h = (d.value / max) * (height / 4 - 2);
          return (
            <rect
              key={d.label}
              x={i * barW + barW * 0.15}
              y={height / 4 - h}
              width={barW * 0.7}
              height={h}
              rx={0.6}
              className="chart-bar"
            >
              <title>{`${d.label}: ${formatNumber(d.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="chart-labels" aria-hidden="true">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export const monthlyBars = (rows: { month: string; count: number }[]) =>
  rows.map((r) => ({ label: formatMonth(r.month), value: r.count }));

/** Horizontal bars for ranked lists (e.g. top diagnoses). Suppressed cells are shown as text. */
export function RankedBars({
  rows,
  label,
  hiddenLabel,
}: {
  label: string;
  /** Text for a hidden value (default "Too few to show"). */
  hiddenLabel?: string;
  rows: {
    key: string;
    label: string;
    sublabel?: string;
    value: number | null;
    suppressed?: boolean;
  }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <ul className="ranked" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key}>
          <div className="ranked-text">
            <span>
              {r.sublabel && <code>{r.sublabel}</code>} {r.label}
            </span>
            <strong>
              {r.suppressed ? (hiddenLabel ?? t('Too few to show')) : formatNumber(r.value ?? 0)}
            </strong>
          </div>
          <div className="ranked-track" aria-hidden="true">
            <div
              className={`ranked-fill ${r.suppressed ? 'ranked-suppressed' : ''}`}
              style={{ width: r.suppressed ? '6%' : `${((r.value ?? 0) / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ extended charts */

/** Categorical palette (CSS variables, so charts follow light/dark themes). */
export const SERIES_COLORS = [
  'var(--primary)',
  'var(--info)',
  'var(--warning)',
  'var(--danger)',
  'var(--success)',
  'var(--text-muted)',
];

export interface Series {
  key: string;
  label: string;
  color?: string;
}

function Legend({ series }: { series: Series[] }) {
  return (
    <ul
      aria-hidden="true"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.4rem 1rem',
        listStyle: 'none',
        padding: 0,
        margin: '0.5rem 0 0',
        fontSize: '0.8rem',
      }}
    >
      {series.map((s, i) => (
        <li key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
              display: 'inline-block',
            }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Horizontal stacked bars (one row per category, one segment per series), e.g. referral outcomes
 * per facility. `percent` scales each row to 100 %.
 */
export function StackedBars({
  title,
  series,
  rows,
  percent = false,
}: {
  title: string;
  series: Series[];
  rows: { label: string; values: Record<string, number> }[];
  percent?: boolean;
}) {
  const totals = rows.map((r) => series.reduce((a, s) => a + (r.values[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <div role="img" aria-label={`${title}. ${t('Values in the table below.')}`}>
        {rows.map((r, ri) => {
          const total = totals[ri] ?? 0;
          const scale = percent ? Math.max(1, total) : max;
          return (
            <div key={r.label} style={{ marginBottom: '0.55rem' }}>
              <div className="ranked-text">
                <span>{r.label}</span>
                <strong>{formatNumber(total)}</strong>
              </div>
              <div
                aria-hidden="true"
                style={{
                  display: 'flex',
                  height: 12,
                  borderRadius: 999,
                  overflow: 'hidden',
                  background: 'var(--surface-2)',
                  marginTop: '0.2rem',
                }}
              >
                {series.map((s, i) => {
                  const v = r.values[s.key] ?? 0;
                  if (!v) return null;
                  return (
                    <div
                      key={s.key}
                      title={`${s.label}: ${formatNumber(v)}`}
                      style={{
                        width: `${(v / scale) * 100}%`,
                        background: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <Legend series={series} />
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{t('Category')}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              {series.map((s) => (
                <td key={s.key}>{r.values[s.key] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Line chart with point markers for trends over ordered categories (e.g. months). */
export function LineChart({
  title,
  data,
  height = 160,
  formatValue = formatNumber,
}: {
  title: string;
  data: { label: string; value: number }[];
  height?: number;
  formatValue?: (n: number) => string;
}) {
  const w = 600;
  const h = height;
  const pad = 14;
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => ({
    x: pad + i * step,
    y: h - pad - (d.value / max) * (h - pad * 2),
    ...d,
  }));
  const line = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const area = pts.length ? `${pad},${h - pad} ${line} ${pts[pts.length - 1]!.x},${h - pad}` : '';
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`${title}. ${t('Values in the table below.')}`}
        style={{ width: '100%', height }}
      >
        <line x1={pad} x2={w - pad} y1={h - pad} y2={h - pad} style={{ stroke: 'var(--border)' }} />
        {area && <polygon points={area} style={{ fill: 'var(--primary-soft)' }} />}
        <polyline
          points={line}
          style={{ fill: 'none', stroke: 'var(--primary)', strokeWidth: 2.5 }}
          strokeLinejoin="round"
        />
        {pts.map((p) => (
          <circle key={p.label} cx={p.x} cy={p.y} r={4} style={{ fill: 'var(--primary)' }}>
            <title>{`${p.label}: ${formatValue(p.value)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-labels" aria-hidden="true">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{formatValue(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Donut chart for shares of a whole, with a text legend that includes values and percentages. */
export function Donut({
  title,
  data,
  size = 150,
  centerLabel,
}: {
  title: string;
  data: { label: string; value: number; color?: string }[];
  size?: number;
  centerLabel?: string;
}) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure
      className="chart"
      style={{ margin: 0, display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        role="img"
        aria-label={`${title}. ${t('Values in the legend.')}`}
      >
        <circle
          cx={50}
          cy={50}
          r={r}
          style={{ fill: 'none', stroke: 'var(--surface-2)', strokeWidth: 14 }}
        />
        {total > 0 &&
          data.map((d, i) => {
            const len = (d.value / total) * c;
            const seg = (
              <circle
                key={d.label}
                cx={50}
                cy={50}
                r={r}
                transform="rotate(-90 50 50)"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                style={{
                  fill: 'none',
                  stroke: d.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
                  strokeWidth: 14,
                }}
              >
                <title>{`${d.label}: ${formatNumber(d.value)}`}</title>
              </circle>
            );
            offset += len;
            return seg;
          })}
        <text
          x={50}
          y={50}
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fill: 'var(--text)', fontSize: 13, fontWeight: 700 }}
        >
          {centerLabel ?? formatNumber(total)}
        </text>
      </svg>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.88rem' }}>
        {data.map((d, i) => (
          <li
            key={d.label}
            style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: 4 }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: d.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
              }}
            />
            <span>
              {d.label}: <strong>{formatNumber(d.value)}</strong>
              {total > 0 && (
                <span className="muted"> ({Math.round((d.value / total) * 100)}%)</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <figcaption className="sr-only">{title}</figcaption>
    </figure>
  );
}
