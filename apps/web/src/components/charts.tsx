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
        aria-label={`${title}. Values in the table below.`}
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
}: {
  label: string;
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
            <strong>{r.suppressed ? 'fewer than threshold' : formatNumber(r.value ?? 0)}</strong>
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
