import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  kindLabel,
  READING_KINDS,
  readingValue,
  useRemoteStats,
  useReviewList,
  useSilentPatients,
  useSuggestions,
  type ReviewItem,
} from '../../api/remote';
import { registerLabel } from '../../api/registers';
import { useUser } from '../../auth/AuthContext';
import { BarChart } from '../../components/charts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Tabs,
  TabPanel,
  Table,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, fullName } from '../../format';
import { t, tn } from '../../i18n';
import { FlagBadge, Reasons, ReviewDialog } from './RemoteComponents';

type TabId = 'review' | 'silent' | 'suggestions';

function useChartBase() {
  const user = useUser();
  return user.role === 'NURSE' ? '/nurse/patients' : '/doctor/patients';
}

/* ------------------------------------------------------------------------- review list -- */

function ReviewTab({ highlight }: { highlight: string | null }) {
  const chartBase = useChartBase();
  const [flag, setFlag] = useState<'ALL' | 'URGENT' | 'OUT_OF_RANGE'>('ALL');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState<ReviewItem | null>(null);
  const list = useReviewList({ flag, kind: kind || undefined, page });
  return (
    <div className="stack">
      <Card>
        <div className="form-grid">
          <SelectField
            label={t('Show')}
            value={flag}
            onChange={(e) => {
              setFlag(e.currentTarget.value as typeof flag);
              setPage(1);
            }}
            options={[
              { value: 'ALL', label: t('All flagged readings') },
              { value: 'URGENT', label: t('Urgent only') },
              { value: 'OUT_OF_RANGE', label: t('Outside the limits only') },
            ]}
          />
          <SelectField
            label={t('Measurement')}
            value={kind}
            onChange={(e) => {
              setKind(e.currentTarget.value);
              setPage(1);
            }}
            options={[
              { value: '', label: t('All measurements') },
              ...READING_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
            ]}
          />
        </div>
      </Card>
      <QueryView query={list}>
        {(data) => (
          <>
            <Grid min={180}>
              <Stat
                label={t('Urgent, not reviewed')}
                value={formatNumber(data.counts.urgent)}
                tone={data.counts.urgent ? 'danger' : undefined}
              />
              <Stat
                label={t('Outside the limits, not reviewed')}
                value={formatNumber(data.counts.outOfRange)}
                tone={data.counts.outOfRange ? 'warning' : undefined}
              />
            </Grid>
            <Card>
              {data.items.length === 0 ? (
                <EmptyState title={t('Nothing to review')}>
                  {t('Flagged home readings of patients in your care appear here, urgent first.')}
                </EmptyState>
              ) : (
                <Table caption={t('Home readings to review')}>
                  <thead>
                    <tr>
                      <th>{t('Patient')}</th>
                      <th>{t('Reading')}</th>
                      <th>{t('Result|reading')}</th>
                      <th>{t('Measured')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((r) => (
                      <tr
                        key={r.id}
                        style={
                          r.id === highlight
                            ? { outline: '2px solid var(--danger)', outlineOffset: -2 }
                            : undefined
                        }
                      >
                        <td>
                          <Link to={`${chartBase}/${r.patient.id}?tab=remote`}>
                            {fullName(r.patient)}
                          </Link>
                          <div className="muted mono">{r.patient.nationalId}</div>
                          {r.patient.phone && <div className="muted">{r.patient.phone}</div>}
                        </td>
                        <td>
                          {kindLabel(r.kind)}: <strong>{readingValue(r.kind, r.values)}</strong>
                          {r.note && <div className="muted">“{r.note}”</div>}
                          {!r.planned && (
                            <div className="muted">{t('Not part of a monitoring plan')}</div>
                          )}
                        </td>
                        <td>
                          <FlagBadge flag={r.flag} />
                          <Reasons reasons={r.reasons} />
                        </td>
                        <td>{formatDateTime(r.measuredAt)}</td>
                        <td>
                          <Button size="sm" onClick={() => setReviewing(r)}>
                            {t('Review')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </Card>
          </>
        )}
      </QueryView>
      <ReviewDialog
        reading={reviewing}
        patientName={reviewing ? fullName(reviewing.patient) : undefined}
        onClose={() => setReviewing(null)}
      />
    </div>
  );
}

/* --------------------------------------------------------------------- silent patients -- */

function SilentTab() {
  const chartBase = useChartBase();
  const list = useSilentPatients();
  return (
    <QueryView query={list}>
      {(data) => (
        <Card>
          {data.items.length === 0 ? (
            <EmptyState title={t('Everyone is sending readings')}>
              {t(
                'Enrolled patients who have sent nothing for longer than their plan allows appear here.',
              )}
            </EmptyState>
          ) : (
            <Table caption={t('Patients who stopped sending readings')}>
              <thead>
                <tr>
                  <th>{t('Patient')}</th>
                  <th>{t('Measurements')}</th>
                  <th>{t('Last reading')}</th>
                  <th>{t('Days without readings')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.planId}>
                    <td>
                      <Link to={`${chartBase}/${s.patient.id}?tab=remote`}>
                        {fullName(s.patient)}
                      </Link>
                      <div className="muted mono">{s.patient.nationalId}</div>
                      {s.patient.phone && <div className="muted">{s.patient.phone}</div>}
                    </td>
                    <td>
                      {s.kinds.map(kindLabel).join(', ')}
                      {s.frequency && <div className="muted">{s.frequency}</div>}
                    </td>
                    <td>
                      {s.lastReadingAt
                        ? formatDateTime(s.lastReadingAt)
                        : t('None since {date}', { date: formatDate(s.planStartedAt) })}
                    </td>
                    <td>
                      {tn(s.daysSilent, '{count} day', '{count} days')}
                      <div className="muted">
                        {t('Follow up after {count}', { count: s.silentAfterDays })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </QueryView>
  );
}

/* ------------------------------------------------------------------------- suggestions -- */

function SuggestionsTab() {
  const chartBase = useChartBase();
  const list = useSuggestions();
  return (
    <QueryView query={list}>
      {(data) => (
        <Card>
          <p className="muted">
            {t(
              'Patients in your care on the hypertension, diabetes, heart failure or COPD register who are not monitored at home. Open the chart to enrol them.',
            )}
          </p>
          {data.items.length === 0 ? (
            <EmptyState title={t('No suggestions')} />
          ) : (
            <Table caption={t('Suggested for home monitoring')}>
              <thead>
                <tr>
                  <th>{t('Patient')}</th>
                  <th>{t('Register')}</th>
                  <th>{t('Suggested measurements')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.patient.id}>
                    <td>
                      <Link to={`${chartBase}/${s.patient.id}?tab=remote`}>
                        {fullName(s.patient)}
                      </Link>
                      <div className="muted mono">{s.patient.nationalId}</div>
                    </td>
                    <td>{s.registers.map(registerLabel).join(', ')}</td>
                    <td>{s.kinds.map(kindLabel).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </QueryView>
  );
}

/* ---------------------------------------------------------------------- director view -- */

function DirectorStats() {
  const stats = useRemoteStats();
  return (
    <QueryView query={stats}>
      {(s) => (
        <div className="stack">
          <Grid min={180}>
            <Stat label={t('Patients enrolled')} value={formatNumber(s.enrolledPatients)} />
            <Stat
              label={t('Readings in the last 8 weeks')}
              value={formatNumber(s.weekly.reduce((a, w) => a + w.readings, 0))}
            />
            <Stat
              label={t('Flagged readings reviewed within 24 h')}
              value={s.review.pct === null ? '—' : `${formatNumber(s.review.pct)} %`}
              hint={t('{reviewed} of {flagged} in the last 30 days', {
                reviewed: formatNumber(s.review.reviewedWithin24h),
                flagged: formatNumber(s.review.flagged),
              })}
              tone={s.review.pct !== null && s.review.pct < 80 ? 'warning' : undefined}
            />
            <Stat
              label={t('Flagged, still not reviewed')}
              value={formatNumber(s.review.stillPending)}
              tone={s.review.stillPending ? 'warning' : undefined}
            />
          </Grid>
          <Card title={t('Readings per week')}>
            {s.weekly.length === 0 ? (
              <EmptyState title={t('No readings yet')} />
            ) : (
              <BarChart
                title={t('Readings per week')}
                data={s.weekly.map((w) => ({
                  label: t('Week of {date}', { date: formatDate(w.week) }),
                  value: w.readings,
                }))}
              />
            )}
          </Card>
          <Card title={t('Patients enrolled by measurement')}>
            {s.byKind.length === 0 ? (
              <EmptyState title={t('No one enrolled yet')} />
            ) : (
              <Table caption={t('Patients enrolled by measurement')}>
                <thead>
                  <tr>
                    <th>{t('Measurement')}</th>
                    <th>{t('Patients')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byKind.map((k) => (
                    <tr key={k.kind}>
                      <td>{kindLabel(k.kind)}</td>
                      <td>{formatNumber(k.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <p className="muted">
            {t(
              'Counts only, for plans registered at your facility. No patient names or values are shown.',
            )}
          </p>
        </div>
      )}
    </QueryView>
  );
}

/* ------------------------------------------------------------------------------- page -- */

export function RemoteMonitoringPage() {
  const user = useUser();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<TabId>('review');
  const highlight = params.get('reading');
  const director = user.role === 'DIRECTOR';
  return (
    <>
      <PageHeader
        title={t('Remote monitoring')}
        subtitle={
          director
            ? t('Home monitoring at your facility')
            : t('Home readings from patients in your care')
        }
      />
      {director ? (
        <DirectorStats />
      ) : (
        <div className="stack">
          {highlight && (
            <Alert tone="danger" title={t('Urgent home reading')}>
              {t('Contact the patient today. The reading is highlighted in the list below.')}
            </Alert>
          )}
          <Tabs
            label={t('Remote monitoring')}
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'review', label: t('To review') },
              { id: 'silent', label: t('Stopped sending') },
              { id: 'suggestions', label: t('Suggestions') },
            ]}
          />
          <TabPanel id={tab}>
            {tab === 'review' && <ReviewTab highlight={highlight} />}
            {tab === 'silent' && <SilentTab />}
            {tab === 'suggestions' && <SuggestionsTab />}
          </TabPanel>
        </div>
      )}
    </>
  );
}
