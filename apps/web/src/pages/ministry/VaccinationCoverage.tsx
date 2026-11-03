import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import {
  ageLabel,
  doseName,
  useSchedule,
  VACCINATION_KEY,
  type Coverage,
  type CoverageRow,
  type ScheduleItem,
} from '../../api/vaccination';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  PageHeader,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatNumber } from '../../format';
import { t } from '../../i18n';

const pct = (v: number | null, low: boolean) =>
  low ? t('<5 children') : v === null ? t('Suppressed') : `${formatNumber(v)} %`;

/** CSV of the coverage table (suppressed cells stay empty). */
function downloadCsv(data: Coverage) {
  const head = [
    t('Facility'),
    t('Region'),
    t('Children'),
    ...data.total.doses.map((d) => doseName(d)),
  ];
  const line = (r: Pick<CoverageRow, 'children' | 'doses'> & { name: string; region: string }) => [
    r.name,
    r.region,
    r.children ?? '',
    ...r.doses.map((d) => (d.percent ?? '') as string | number),
  ];
  const rows = [
    ...data.rows.map((r) => line({ ...r, name: r.facilityName, region: r.region ?? '' })),
    line({ ...data.total, name: t('National total'), region: '' }),
  ];
  const esc = (v: unknown) => {
    const s = String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(
    new Blob([`${String.fromCharCode(0xfeff)}${csv}`], { type: 'text/csv;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `pacient-vaccination-coverage-${data.cohort}-${data.asOf}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Bar({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  const tone =
    percent >= 95 ? 'var(--success)' : percent >= 85 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div
      aria-hidden="true"
      style={{
        height: 6,
        background: 'var(--border)',
        borderRadius: 3,
        marginTop: 4,
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${Math.min(100, percent)}%`, height: '100%', background: tone }} />
    </div>
  );
}

/**
 * Vaccination coverage by birth cohort (Ministry: national and per facility; directors: their
 * facility), with small-cell suppression, plus the national calendar the Ministry maintains.
 */
export function VaccinationCoverage() {
  const user = useUser();
  const [cohort, setCohort] = useState('12-23m');
  const coverage = useQuery({
    queryKey: [...VACCINATION_KEY, 'coverage', cohort],
    queryFn: () => api<Coverage>('/vaccination/coverage', { query: { cohort } }),
  });

  return (
    <>
      <PageHeader
        title={t('Vaccination coverage')}
        subtitle={t('Share of children who received each key dose, by birth cohort.')}
        actions={
          coverage.data ? (
            <Button variant="secondary" size="sm" onClick={() => downloadCsv(coverage.data!)}>
              {t('Download CSV')}
            </Button>
          ) : undefined
        }
      />
      <Card>
        <SelectField
          label={t('Cohort')}
          value={cohort}
          onChange={(e) => setCohort(e.currentTarget.value)}
          options={(coverage.data?.cohorts ?? [{ key: cohort, label: cohort }]).map((c) => ({
            value: c.key,
            label: t(c.label),
          }))}
        />
        <p className="muted small">
          {t(
            'Counts below {threshold} are suppressed to protect privacy. Target: at least 95 % for each dose.',
            { threshold: coverage.data?.threshold ?? 5 },
          )}
        </p>
      </Card>
      <QueryView query={coverage}>
        {(data) =>
          data.rows.length === 0 ? (
            <Card>
              <EmptyState title={t('No children in this cohort')} />
            </Card>
          ) : (
            <Card title={t(data.cohortLabel)}>
              <Table caption={t('Vaccination coverage')}>
                <thead>
                  <tr>
                    <th>{t('Facility')}</th>
                    <th className="num">{t('Children')}</th>
                    {data.total.doses.map((d) => (
                      <th key={d.code} className="num">
                        {doseName(d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.facilityId}>
                      <td>
                        <strong>{r.facilityName}</strong>
                        {r.region && <div className="muted">{r.region}</div>}
                      </td>
                      <td className="num">
                        {r.children === null ? t('<5') : formatNumber(r.children)}
                      </td>
                      {r.doses.map((d) => (
                        <td key={d.code} className="num">
                          {pct(d.percent, d.lowCount)}
                          <Bar percent={d.percent} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {data.scope === 'NATIONAL' && (
                    <tr>
                      <td>
                        <strong>{t('National total')}</strong>
                      </td>
                      <td className="num">
                        <strong>
                          {data.total.children === null
                            ? t('<5')
                            : formatNumber(data.total.children)}
                        </strong>
                      </td>
                      {data.total.doses.map((d) => (
                        <td key={d.code} className="num">
                          <strong>{pct(d.percent, d.lowCount)}</strong>
                          <Bar percent={d.percent} />
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </Table>
            </Card>
          )
        }
      </QueryView>
      {user.role === 'MINISTRY' && <ScheduleEditor />}
    </>
  );
}

function ScheduleEditor() {
  const schedule = useSchedule();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ScheduleItem | 'new' | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing && editing !== 'new'
        ? api(`/vaccination/schedule/${editing.id}`, { method: 'PATCH', body })
        : api('/vaccination/schedule', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: VACCINATION_KEY });
      setEditing(null);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body: Record<string, unknown> = {
      vaccine: v.vaccine,
      recommendedAgeDays: Number(v.recommendedAgeDays),
      overdueAgeDays: Number(v.overdueAgeDays),
      description: v.description || null,
      isActive: v.isActive === 'true',
    };
    if (editing === 'new') {
      body.code = v.code;
      body.doseNumber = Number(v.doseNumber);
    }
    save.mutate(body);
  }

  const current = editing && editing !== 'new' ? editing : null;
  return (
    <Card
      title={t('National vaccination calendar')}
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          {t('Add dose')}
        </Button>
      }
    >
      <Alert tone="info">
        {t(
          'The calendar shipped with Pacient is illustrative. Verify every dose against the official calendar of the National Institute of Public Health of Kosovo (IKShPK) before use.',
        )}
      </Alert>
      <QueryView query={schedule}>
        {(items) => (
          <Table caption={t('National vaccination calendar')}>
            <thead>
              <tr>
                <th>{t('Dose')}</th>
                <th>{t('Recommended age')}</th>
                <th>{t('Overdue after')}</th>
                <th>{t('Status')}</th>
                <th>
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{doseName(s)}</strong> <span className="muted mono">{s.code}</span>
                    {s.description && <div className="muted">{t(s.description)}</div>}
                  </td>
                  <td>{ageLabel(s.recommendedAgeDays)}</td>
                  <td>{ageLabel(s.overdueAgeDays)}</td>
                  <td>
                    {s.isActive ? (
                      <Badge tone="success">{t('In use')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('Not in use')}</Badge>
                    )}
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                      {t('Edit')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryView>
      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={current ? t('Edit {dose}', { dose: doseName(current) }) : t('Add dose')}
        wide
      >
        <form onSubmit={onSubmit} key={current?.id ?? 'new'}>
          <div className="form-grid">
            {!current && (
              <>
                <TextField
                  label={t('Code')}
                  name="code"
                  required
                  pattern="[A-Z0-9_]{2,40}"
                  hint={t('Capital letters, digits and _, e.g. MMR_1')}
                />
                <TextField
                  label={t('Dose number')}
                  name="doseNumber"
                  type="number"
                  min={1}
                  max={10}
                  required
                />
              </>
            )}
            <TextField
              label={t('Vaccine')}
              name="vaccine"
              required
              defaultValue={current?.vaccine}
            />
            <TextField
              label={t('Recommended age (days)')}
              name="recommendedAgeDays"
              type="number"
              min={0}
              max={6570}
              required
              defaultValue={current?.recommendedAgeDays}
            />
            <TextField
              label={t('Overdue after (days)')}
              name="overdueAgeDays"
              type="number"
              min={0}
              max={6570}
              required
              defaultValue={current?.overdueAgeDays}
            />
            <SelectField
              label={t('Status')}
              name="isActive"
              defaultValue={current && !current.isActive ? 'false' : 'true'}
              options={[
                { value: 'true', label: t('In use') },
                { value: 'false', label: t('Not in use') },
              ]}
            />
          </div>
          <TextField
            label={t('Description')}
            name="description"
            maxLength={500}
            defaultValue={current?.description ?? ''}
          />
          <ErrorAlert error={save.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
