import { useEffect, useState } from 'react';
import {
  categoryLabel,
  harmShort,
  harmTone,
  statusLabel,
  statusTone,
  useFacilityDashboard,
  useNationalDashboard,
  useReviewers,
  useSaveReviewers,
  useSystemIncidents,
  type Bucket,
  type Cell,
} from '../../api/incidents';
import { BarChart } from '../../components/charts';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Grid,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
} from '../../components/ui';
import { formatDate, formatMonth, formatNumber } from '../../format';
import { t, tn } from '../../i18n';

const MONTH_OPTIONS = [3, 6, 12, 24].map((m) => ({
  value: String(m),
  label: tn(m, '{count} month', '{count} months'),
}));

function MonthsPicker({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <SelectField
      label={t('Period')}
      name="months"
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      options={MONTH_OPTIONS}
    />
  );
}

const cellText = (c: Cell, threshold: number) =>
  c.suppressed ? t('fewer than {n}', { n: threshold }) : formatNumber(c.count ?? 0);

function CountTable({
  caption,
  rows,
  label,
  threshold = 5,
}: {
  caption: string;
  rows: (Bucket | Cell)[];
  label: (key: string) => string;
  threshold?: number;
}) {
  if (!rows.length) return <EmptyState title={t('No incidents in this period')} />;
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th>{caption}</th>
          <th style={{ textAlign: 'right' }}>{t('Incidents')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{label(r.key)}</td>
            <td style={{ textAlign: 'right' }}>
              {'suppressed' in r && r.suppressed
                ? t('fewer than {n}', { n: threshold })
                : formatNumber(r.count ?? 0)}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Facility dashboard for the director and safety leads. */
export function FacilityDashboardView({ onOpen }: { onOpen: (id: string) => void }) {
  const [months, setMonths] = useState(12);
  const query = useFacilityDashboard(months);
  return (
    <div className="stack">
      <div style={{ maxWidth: 220 }}>
        <MonthsPicker value={months} onChange={setMonths} />
      </div>
      <QueryView query={query}>
        {(d) => (
          <div className="stack">
            <Grid>
              <Stat label={t('Reported')} value={formatNumber(d.total)} />
              <Stat
                label={t('Open reviews')}
                value={formatNumber(d.open)}
                tone={d.open ? 'warning' : undefined}
              />
              <Stat
                label={t('Median days to close')}
                value={
                  d.timeToClose.medianDays == null ? '—' : formatNumber(d.timeToClose.medianDays)
                }
                hint={tn(d.timeToClose.closed, '{count} closed review', '{count} closed reviews')}
              />
              <Stat
                label={t('Overdue actions')}
                value={formatNumber(d.overdueActions.length)}
                tone={d.overdueActions.length ? 'danger' : undefined}
              />
            </Grid>
            <Card title={t('Reports per month')}>
              <BarChart
                title={t('Reports per month')}
                data={d.byMonth.map((m) => ({ label: formatMonth(m.key), value: m.count }))}
              />
            </Card>
            <Grid min={280}>
              <Card title={t('By kind of incident')}>
                <CountTable
                  caption={t('Kind of incident')}
                  rows={d.byCategory}
                  label={categoryLabel}
                />
              </Card>
              <Card title={t('By harm')}>
                <CountTable caption={t('Harm')} rows={d.byHarm} label={harmShort} />
              </Card>
              <Card title={t('By status')}>
                <CountTable caption={t('Status')} rows={d.byStatus} label={statusLabel} />
              </Card>
              <Card title={t('By ward or unit')}>
                <CountTable
                  caption={t('Ward or unit')}
                  rows={d.byUnit}
                  label={(k) => k || t('No unit given')}
                />
              </Card>
            </Grid>
            <Card title={t('Overdue actions')}>
              {d.overdueActions.length === 0 ? (
                <EmptyState title={t('No overdue actions')} />
              ) : (
                <Table caption={t('Overdue actions')}>
                  <thead>
                    <tr>
                      <th>{t('Incident')}</th>
                      <th>{t('Action')}</th>
                      <th>{t('Owner')}</th>
                      <th>{t('Due date')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.overdueActions.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Button size="sm" variant="ghost" onClick={() => onOpen(a.incidentId)}>
                            {a.reference}
                          </Button>
                        </td>
                        <td>{a.description}</td>
                        <td>{a.ownerName ?? t('No owner')}</td>
                        <td>{formatDate(a.dueDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        )}
      </QueryView>
    </div>
  );
}

/** The director names the facility's safety leads (reviewers besides the director). */
export function ReviewersCard() {
  const query = useReviewers(true);
  const save = useSaveReviewers();
  const [selected, setSelected] = useState<string[] | null>(null);
  useEffect(() => {
    if (query.data && selected === null) setSelected(query.data.reviewers.map((r) => r.userId));
  }, [query.data, selected]);
  return (
    <Card title={t('Incident reviewers')}>
      <p className="muted">
        {t(
          'Directors always review incidents. Name safety leads (for example the medication-safety pharmacist or a senior nurse) who review alongside you. Reviewers see every report of the facility, including the patient involved.',
        )}
      </p>
      <QueryView query={query}>
        {(d) => (
          <div className="stack">
            {d.candidates.length === 0 ? (
              <EmptyState title={t('No staff to choose from')} />
            ) : (
              <div className="stack" style={{ gap: '0.4rem' }}>
                {d.candidates.map((c) => (
                  <label key={c.userId} className="checkbox">
                    <input
                      type="checkbox"
                      checked={(selected ?? []).includes(c.userId)}
                      onChange={(e) =>
                        setSelected((cur) =>
                          e.target.checked
                            ? [...(cur ?? []), c.userId]
                            : (cur ?? []).filter((x) => x !== c.userId),
                        )
                      }
                    />
                    {c.fullName} <span className="muted">({t(roleName(c.role))})</span>
                  </label>
                ))}
              </div>
            )}
            <ErrorAlert error={save.error} />
            {save.isSuccess && <Alert tone="success">{t('Reviewers saved')}</Alert>}
            <div className="form-actions">
              <Button loading={save.isPending} onClick={() => save.mutate(selected ?? [])}>
                {t('Save reviewers')}
              </Button>
            </div>
          </div>
        )}
      </QueryView>
    </Card>
  );
}

const roleName = (r: string) =>
  ({ DOCTOR: 'Doctor', NURSE: 'Nurse', PHARMACIST: 'Pharmacist', RECEPTION: 'Reception' })[r] ?? r;

/** National view for the Ministry: counts only, small cells suppressed. */
export function NationalView() {
  const [months, setMonths] = useState(12);
  const query = useNationalDashboard(months);
  return (
    <div className="stack">
      <div style={{ maxWidth: 220 }}>
        <MonthsPicker value={months} onChange={setMonths} />
      </div>
      <QueryView query={query}>
        {(d) => (
          <div className="stack">
            <Alert tone="info">
              {t(
                'Counts only – no descriptions or patients. Numbers below {n} are hidden so that rare events cannot identify anyone.',
                { n: d.smallCellThreshold },
              )}
            </Alert>
            <Grid>
              <Stat
                label={t('Reported nationally')}
                value={
                  d.total == null
                    ? t('fewer than {n}', { n: d.smallCellThreshold })
                    : formatNumber(d.total)
                }
              />
            </Grid>
            <Card title={t('Reports per month')}>
              <Table caption={t('Reports per month')}>
                <thead>
                  <tr>
                    <th>{t('Month')}</th>
                    <th style={{ textAlign: 'right' }}>{t('Incidents')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byMonth.map((m) => (
                    <tr key={m.key}>
                      <td>{formatMonth(m.key)}</td>
                      <td style={{ textAlign: 'right' }}>{cellText(m, d.smallCellThreshold)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Grid min={280}>
              <Card title={t('By kind of incident')}>
                <CountTable
                  caption={t('Kind of incident')}
                  rows={d.byCategory}
                  label={categoryLabel}
                />
              </Card>
              <Card title={t('By harm')}>
                <CountTable caption={t('Harm')} rows={d.byHarm} label={harmShort} />
              </Card>
              <Card title={t('By facility')}>
                <CountTable
                  caption={t('Facility')}
                  rows={d.byFacility}
                  label={(k) => k}
                  threshold={d.smallCellThreshold}
                />
              </Card>
            </Grid>
          </div>
        )}
      </QueryView>
    </div>
  );
}

/** System incidents for the clinical safety officer (hazard log). */
export function SystemIncidentsView() {
  const [page, setPage] = useState(1);
  const query = useSystemIncidents(page);
  return (
    <div className="stack">
      <Alert tone="info">
        {t(
          'Incidents in which the Pacient system was involved, for the clinical safety officer’s hazard log. The description, findings and lessons are shared once the facility has closed its review.',
        )}
      </Alert>
      <QueryView query={query}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t('No system incidents reported')} />
          ) : (
            <div className="stack">
              {d.items.map((i) => (
                <Card
                  key={i.id}
                  title={`${i.reference} · ${i.facilityName}`}
                  actions={
                    <span className="row">
                      <Badge tone={statusTone(i.status)}>{statusLabel(i.status)}</Badge>
                      <Badge tone={harmTone(i.reviewedHarm ?? i.harm)}>
                        {harmShort(i.reviewedHarm ?? i.harm)}
                      </Badge>
                      {i.hazardRef && <Badge tone="info">{i.hazardRef}</Badge>}
                    </span>
                  }
                >
                  <p className="muted">{formatMonth(i.occurredMonth)}</p>
                  {i.textWithheld ? (
                    <p className="muted">{t('Shared after the facility closes its review.')}</p>
                  ) : (
                    <dl className="dl">
                      <div>
                        <dt>{t('What happened')}</dt>
                        <dd>{i.description}</dd>
                      </div>
                      <div>
                        <dt>{t('Findings')}</dt>
                        <dd>{i.findings ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('What was learned')}</dt>
                        <dd>{i.lessons ?? '—'}</dd>
                      </div>
                    </dl>
                  )}
                </Card>
              ))}
              <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
            </div>
          )
        }
      </QueryView>
    </div>
  );
}
