import { useState } from 'react';
import {
  downloadExport,
  EXPORTS,
  exportLabel,
  periodOf,
  type ExportName,
  type PeriodKind,
} from '../../../api/billingcorrections';
import { Button, Dialog, ErrorAlert, SelectField } from '../../../components/ui';
import { formatDate, formatMonth } from '../../../format';
import { t } from '../../../i18n';

const kosovoToday = () => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Belgrade',
      year: 'numeric',
      month: 'numeric',
    })
      .formatToParts(new Date())
      .map((x) => [x.type, Number(x.value)]),
  );
  return { year: p.year!, month: p.month! };
};

const kindLabel = (k: PeriodKind) =>
  ({ month: t('Month'), quarter: t('Quarter'), year: t('Year') })[k];

/** Month / quarter / year pickers and the four CSV files for the period. */
function ExportForm() {
  const today = kosovoToday();
  // The month before is what an accountant usually asks for.
  const january = today.month === 1;
  const [kind, setKind] = useState<PeriodKind>('month');
  const [year, setYear] = useState(january ? today.year - 1 : today.year);
  const [index, setIndex] = useState(january ? 12 : today.month - 1);
  const [busy, setBusy] = useState<ExportName | null>(null);
  const [error, setError] = useState<unknown>(null);
  const period = periodOf(kind, year, kind === 'year' ? 1 : index);
  const years = Array.from({ length: 6 }, (_, i) => today.year - i);

  async function download(name: ExportName) {
    setBusy(name);
    setError(null);
    try {
      await downloadExport(name, period);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="form-grid">
        <SelectField
          label={t('Period')}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as PeriodKind;
            // Month ↔ quarter keeps the same part of the year.
            if (next === 'quarter' && kind === 'month') setIndex(Math.ceil(index / 3));
            if (next === 'month' && kind === 'quarter') setIndex(index * 3);
            if (next !== 'year' && kind === 'year') setIndex(1);
            setKind(next);
          }}
          options={(['month', 'quarter', 'year'] as const).map((k) => ({
            value: k,
            label: kindLabel(k),
          }))}
        />
        <SelectField
          label={t('Year')}
          value={String(year)}
          onChange={(e) => setYear(Number(e.target.value))}
          options={years.map((y) => ({ value: String(y), label: String(y) }))}
        />
        {kind === 'month' && (
          <SelectField
            label={t('Month')}
            value={String(index)}
            onChange={(e) => setIndex(Number(e.target.value))}
            options={Array.from({ length: 12 }, (_, i) => ({
              value: String(i + 1),
              label: formatMonth(`${year}-${String(i + 1).padStart(2, '0')}`),
            }))}
          />
        )}
        {kind === 'quarter' && (
          <SelectField
            label={t('Quarter')}
            value={String(index)}
            onChange={(e) => setIndex(Number(e.target.value))}
            options={[1, 2, 3, 4].map((q) => ({
              value: String(q),
              label: t('Quarter {number}', { number: q }),
            }))}
          />
        )}
      </div>
      <p aria-live="polite">
        {t('From {from} to {to}', {
          from: formatDate(`${period.from}T12:00:00Z`),
          to: formatDate(`${period.to}T12:00:00Z`),
        })}
      </p>
      <div className="row" role="group" aria-label={t('Download')}>
        {EXPORTS.map((name) => (
          <Button
            key={name}
            variant="secondary"
            loading={busy === name}
            disabled={busy !== null && busy !== name}
            onClick={() => void download(name)}
          >
            {exportLabel(name)}
          </Button>
        ))}
      </div>
      <ErrorAlert error={error} />
      <p className="muted">
        {t(
          'CSV files (UTF-8, comma-separated) for a spreadsheet or accounting software: calendar days in Kosovo, amounts in euros with a decimal point. Payments are listed by payment date, reversals as negative amounts on the day they were reversed. Each download asks for your password and is recorded.',
        )}
      </p>
    </div>
  );
}

/** "Export for the accountant" on the invoices page (administrator). */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('Export for the accountant')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Export for the accountant')}>
        <ExportForm />
      </Dialog>
    </>
  );
}
