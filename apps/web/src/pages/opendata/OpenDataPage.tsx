import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  openDataIndexUrl,
  openDataUrl,
  useOpenDataIndex,
  useOpenDataset,
  type CellValue,
  type ColumnType,
  type DataRow,
  type OpenDataset,
} from '../../api/opendata';
import { RankedBars } from '../../components/charts';
import {
  Alert,
  Card,
  ErrorAlert,
  Loading,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { t, useLocale } from '../../i18n';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';

/** Column shown as bars under the table, per dataset (none for the facilities directory). */
const CHART_COLUMN: Record<string, string> = {
  'waiting-times': 'medianDays',
  'vaccination-coverage': 'coveragePct',
  'notifiable-diseases': 'cases',
  'notifiable-diseases-municipality': 'cases',
  mortality: 'deaths',
  'bed-occupancy': 'occupancyPct',
  'emergency-waiting': 'medianMinutes',
  'screening-coverage': 'coveragePct',
};
const PAGE = 100;
const CHART_ROWS = 20;
/** Rows worth charting: for deaths, the monthly totals (all causes) rather than every chapter. */
const CHART_ROWS_FILTER: Record<string, (r: DataRow) => boolean> = {
  mortality: (r) => r.chapter === '',
};

/**
 * Public open-data page (no sign-in): national health statistics for citizens and journalists,
 * with tables, simple charts, CSV/JSON downloads and an explanation of how small numbers are
 * protected.
 */
export function OpenDataPage() {
  const { locale } = useLocale();
  const index = useOpenDataIndex();
  const [params, setParams] = useSearchParams();
  const ids = index.data?.datasets.map((d) => d.id) ?? [];
  const requested = params.get('dataset');
  const selected = requested && ids.includes(requested) ? requested : (ids[0] ?? null);
  const dataset = useOpenDataset(selected, locale);

  useEffect(() => {
    document.title = `${t('Open health data')} · Pacient`;
  }, [locale]);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        {t('Skip to main content')}
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <span>
            <strong>Pacient</strong>
            <span className="brand-sub">{t('Open health data')}</span>
          </span>
        </div>
        <LanguageSwitcher />
      </header>
      <main id="main" tabIndex={-1} style={{ margin: '0 auto' }}>
        <div className="page-header">
          <div>
            <h1>{t('Open health data')}</h1>
            <p className="muted" style={{ maxWidth: '60rem' }}>
              {t(
                'National health statistics from Pacient for citizens, journalists and researchers. Only totals are published – never information about a person.',
              )}
            </p>
          </div>
        </div>

        {index.isLoading && <Loading />}
        {index.error && <ErrorAlert error={index.error} />}
        {index.data && (
          <div className="stack">
            <Card>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 20rem' }}>
                  <SelectField
                    label={t('Dataset')}
                    name="dataset"
                    value={selected ?? ''}
                    onChange={(e) => setParams({ dataset: e.target.value }, { replace: true })}
                    options={index.data.datasets.map((d) => ({
                      value: d.id,
                      label: d.title[locale],
                    }))}
                  />
                </div>
                {selected && (
                  <div className="row" style={{ paddingBottom: '0.25rem' }}>
                    <a
                      className="btn btn-secondary btn-sm"
                      href={openDataUrl(selected, 'csv', locale)}
                      download
                    >
                      {t('Download CSV')}
                    </a>
                    <a
                      className="btn btn-ghost btn-sm"
                      href={openDataUrl(selected, 'json', locale)}
                    >
                      {t('Download JSON')}
                    </a>
                  </div>
                )}
              </div>
            </Card>

            {dataset.isLoading && <Loading />}
            {dataset.error && <ErrorAlert error={dataset.error} />}
            {dataset.data && <DatasetView key={dataset.data.dataset} data={dataset.data} />}

            <Card title={t('Protecting privacy')}>
              <div className="stack" style={{ gap: '0.5rem' }}>
                <p>
                  {t(
                    'Numbers from 1 to {max} are never published, because they could point to a person. They are shown as “{mark}” and left empty in downloads.',
                    { max: index.data.smallCellThreshold - 1, mark: '–' },
                  )}
                </p>
                <p>
                  {t(
                    'Where a hidden number could be worked out from a total, a second number is hidden too (secondary suppression). Percentages and times worked out from hidden numbers are hidden with them.',
                  )}
                </p>
                <p className="muted">
                  {t(
                    'Figures come from records kept in Pacient and can change as late records arrive. Each dataset is refreshed at most every 10 minutes.',
                  )}
                </p>
              </div>
            </Card>

            <Card title={t('Licence and reuse')}>
              <p>
                {t('Licence|open data')}:{' '}
                <a href={index.data.licence.url} rel="license noreferrer" target="_blank">
                  {index.data.licence.name}
                </a>
                . {index.data.licence.note[locale]}
              </p>
              <p className="muted">
                {t('Developers can read every dataset as JSON from the API:')}{' '}
                <a href={openDataIndexUrl()}>
                  <code>{openDataIndexUrl()}</code>
                </a>
              </p>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}

function DatasetView({ data }: { data: OpenDataset }) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const textColumns = data.columns.filter((c) => c.type === 'text');
  const rows = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((r) =>
      textColumns.some((c) =>
        String(r[c.key] ?? '')
          .toLocaleLowerCase()
          .includes(q),
      ),
    );
  }, [data.rows, filter, textColumns]);
  const shown = showAll ? rows : rows.slice(0, PAGE);
  const suppressedCount = data.rows.filter((r) => r.suppressed).length;
  const chartKey = CHART_COLUMN[data.dataset];
  const chartColumn = data.columns.find((c) => c.key === chartKey);
  const chartFilter = CHART_ROWS_FILTER[data.dataset];
  const chartRows = chartFilter ? rows.filter(chartFilter) : rows;

  return (
    <>
      <Card title={data.title}>
        <div className="stack" style={{ gap: '0.75rem' }}>
          <p>{data.description}</p>
          <dl className="row" style={{ gap: '0.25rem 1.5rem', margin: 0 }}>
            {data.period && (
              <div>
                <dt className="muted">{t('Period')}</dt>
                <dd style={{ margin: 0 }}>{periodText(data.period)}</dd>
              </div>
            )}
            <div>
              <dt className="muted">{t('Published')}</dt>
              <dd style={{ margin: 0 }}>{formatDateTime(data.generatedAt)}</dd>
            </div>
            <div>
              <dt className="muted">{t('Rows')}</dt>
              <dd style={{ margin: 0 }}>{formatNumber(data.rows.length)}</dd>
            </div>
            <div>
              <dt className="muted">{t('Rows with hidden numbers')}</dt>
              <dd style={{ margin: 0 }}>{formatNumber(suppressedCount)}</dd>
            </div>
          </dl>
          <div>
            <h3 style={{ fontSize: '1rem', margin: '0 0 0.25rem' }}>{t('Methodology')}</h3>
            <p className="muted" style={{ margin: 0 }}>
              {data.methodology}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <div className="stack" style={{ gap: '0.75rem' }}>
          {textColumns.length > 0 && data.rows.length > 10 && (
            <div style={{ maxWidth: '24rem' }}>
              <TextField
                label={t('Filter rows')}
                name="filter"
                type="search"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setShowAll(false);
                }}
                hint={t('Matches any text column, e.g. a municipality or facility.')}
              />
            </div>
          )}
          {rows.length === 0 ? (
            <Alert tone="info" title={t('No rows to show')} />
          ) : (
            <Table caption={data.title}>
              <thead>
                <tr>
                  {data.columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      style={c.type === 'text' ? undefined : { textAlign: 'right' }}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, i) => (
                  <tr key={i}>
                    {data.columns.map((c, ci) =>
                      ci === 0 ? (
                        <th key={c.key} scope="row" style={{ fontWeight: 500 }}>
                          <Cell value={row[c.key] ?? null} type={c.type} row={row} />
                        </th>
                      ) : (
                        <td
                          key={c.key}
                          style={c.type === 'text' ? undefined : { textAlign: 'right' }}
                        >
                          <Cell value={row[c.key] ?? null} type={c.type} row={row} />
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {rows.length > shown.length && (
            <div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowAll(true)}
              >
                {t('Show all {count} rows', { count: formatNumber(rows.length) })}
              </button>
            </div>
          )}
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
            <span aria-hidden="true">–</span> {t('Too few to show')}
          </p>
        </div>
      </Card>

      {chartColumn && chartRows.length > 0 && (
        <Card title={chartColumn.label}>
          <RankedBars
            label={chartColumn.label}
            rows={chartRows.slice(0, CHART_ROWS).map((r, i) => ({
              key: String(i),
              label: textColumns
                .map((c) => r[c.key])
                .filter((v) => v !== null && v !== '')
                .join(' · '),
              value: typeof r[chartColumn.key] === 'number' ? (r[chartColumn.key] as number) : null,
              suppressed: r[chartColumn.key] === null,
            }))}
          />
          {chartRows.length > CHART_ROWS && (
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              {t('The chart shows the first {count} rows; use the filter to choose others.', {
                count: CHART_ROWS,
              })}
            </p>
          )}
        </Card>
      )}
    </>
  );
}

function Cell({ value, type, row }: { value: CellValue; type: ColumnType; row: DataRow }) {
  if (value === null) {
    if (row.suppressed && type !== 'text') {
      return (
        <>
          <span aria-hidden="true">–</span>
          <span className="sr-only">{t('Too few to show')}</span>
        </>
      );
    }
    return <span className="muted">—</span>;
  }
  if (typeof value === 'boolean') return <>{value ? t('Yes') : t('No')}</>;
  if (typeof value === 'number')
    return <>{type === 'percent' ? `${formatNumber(value)} %` : formatNumber(value)}</>;
  return <>{value}</>;
}

function periodText(p: { from: string; to: string }) {
  const show = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v) : v);
  return p.from === p.to ? show(p.from) : `${show(p.from)} – ${show(p.to)}`;
}
