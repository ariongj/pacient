import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useCompliance,
  useOpenReview,
  useReviewMeta,
  useReviews,
  type ReviewMeta,
  type ReviewSummary,
} from '../../api/accessreviews';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  Table,
  TabPanel,
  Tabs,
} from '../../components/ui';
import { formatDate, formatNumber } from '../../format';
import { t } from '../../i18n';
import { ReviewStatusBadge, ReviewView } from './AccessReviewComponents';

/** The last n quarters, newest first (e.g. 2026-Q4, 2026-Q3, …). */
function lastQuarters(current: string, n: number): string[] {
  let year = Number(current.slice(0, 4));
  let q = Number(current.slice(6));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${year}-Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

export function AccessReviewsPage() {
  const meta = useReviewMeta();
  const [params, setParams] = useSearchParams();
  const selected = params.get('review');
  const select = (id: string | null) => {
    const next = new URLSearchParams();
    if (id) next.set('review', id);
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={t('Access reviews')}
        subtitle={t(
          'Every quarter each account is checked: is it still needed, with the right role? Accounts nobody uses are a risk to patients’ privacy.',
        )}
      />
      <QueryView query={meta}>
        {(m) =>
          selected ? (
            <div className="stack">
              <div>
                <Button variant="ghost" onClick={() => select(null)}>
                  ← {t('All reviews')}
                </Button>
              </div>
              <ReviewView id={selected} />
            </div>
          ) : m.scope === 'MINISTRY' ? (
            <MinistryView meta={m} onOpen={select} />
          ) : (
            <OwnReviews meta={m} onOpen={select} />
          )
        }
      </QueryView>
    </>
  );
}

/** The caller's own reviews (facility, or the Ministry's) with the button to open this quarter. */
function OwnReviews({ meta, onOpen }: { meta: ReviewMeta; onOpen: (id: string) => void }) {
  const reviews = useReviews();
  const open = useOpenReview();
  return (
    <QueryView query={reviews}>
      {(items) => {
        const current = items.find((r) => r.period === meta.currentPeriod);
        return (
          <div className="stack">
            {!current && (
              <Alert tone="info">
                {t(
                  'The review for {period} opens automatically at the start of the quarter. You can open it now.',
                  { period: meta.currentPeriod },
                )}{' '}
                <Button
                  size="sm"
                  loading={open.isPending}
                  onClick={() => open.mutate(undefined, { onSuccess: (r) => onOpen(r.id) })}
                >
                  {t('Open the review now')}
                </Button>
              </Alert>
            )}
            <ErrorAlert error={open.error} />
            {current && current.status === 'OPEN' && (
              <Alert tone={current.overdue ? 'danger' : 'warning'}>
                {current.overdue
                  ? t('The review for {period} was due on {date}. Please complete it.', {
                      period: current.period,
                      date: formatDate(current.dueDate),
                    })
                  : t('The review for {period} is due by {date}.', {
                      period: current.period,
                      date: formatDate(current.dueDate),
                    })}{' '}
                <Button size="sm" onClick={() => onOpen(current.id)}>
                  {t('Continue the review')}
                </Button>
              </Alert>
            )}
            <ReviewList items={items} onOpen={onOpen} />
          </div>
        );
      }}
    </QueryView>
  );
}

function ReviewList({ items, onOpen }: { items: ReviewSummary[]; onOpen: (id: string) => void }) {
  if (!items.length) return <EmptyState title={t('No access reviews yet')} />;
  return (
    <Card title={t('Reviews')}>
      <Table caption={t('Reviews')}>
        <thead>
          <tr>
            <th scope="col">{t('Quarter')}</th>
            <th scope="col">{t('Status')}</th>
            <th scope="col">{t('Due by')}</th>
            <th scope="col" className="num">
              {t('Accounts decided')}
            </th>
            <th scope="col" className="num">
              {t('Accounts revoked')}
            </th>
            <th scope="col">
              <span className="sr-only">{t('Actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.period}</th>
              <td>
                <ReviewStatusBadge status={r.status} overdue={r.overdue} />
              </td>
              <td>{formatDate(r.dueDate)}</td>
              <td className="num">
                {formatNumber(r.decided)} / {formatNumber(r.total)}
              </td>
              <td className="num">{formatNumber(r.revoked)}</td>
              <td>
                <Button size="sm" variant="secondary" onClick={() => onOpen(r.id)}>
                  {t('Open|action')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

type MinistryTab = 'facilities' | 'own';

function MinistryView({ meta, onOpen }: { meta: ReviewMeta; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<MinistryTab>('facilities');
  return (
    <>
      <Tabs
        label={t('Access reviews')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'facilities', label: t('Facilities') },
          { id: 'own', label: t('Ministry review') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'facilities' ? (
          <ComplianceView meta={meta} onOpen={onOpen} />
        ) : (
          <div className="stack">
            <p className="muted">
              {t(
                'The Ministry reviews the accounts of Ministry officials and of every facility director.',
              )}
            </p>
            <OwnReviews meta={meta} onOpen={onOpen} />
          </div>
        )}
      </TabPanel>
    </>
  );
}

function ComplianceView({ meta, onOpen }: { meta: ReviewMeta; onOpen: (id: string) => void }) {
  const quarters = lastQuarters(meta.currentPeriod, 6);
  const [period, setPeriod] = useState(meta.currentPeriod);
  const compliance = useCompliance(period);
  return (
    <div className="stack">
      <div style={{ maxWidth: 240 }}>
        <SelectField
          label={t('Quarter')}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          options={quarters.map((q) => ({ value: q, label: q }))}
        />
      </div>
      <QueryView query={compliance}>
        {(c) => (
          <>
            <Grid min={170}>
              <Stat label={t('Facilities')} value={formatNumber(c.summary.facilities)} />
              <Stat label={t('Completed|review')} value={formatNumber(c.summary.completed)} />
              <Stat
                label={t('Overdue|review')}
                value={formatNumber(c.summary.overdue)}
                tone={c.summary.overdue ? 'danger' : undefined}
              />
              <Stat
                label={t('Not opened')}
                value={formatNumber(c.summary.notOpened)}
                tone={c.summary.notOpened ? 'warning' : undefined}
              />
              <Stat label={t('Accounts revoked')} value={formatNumber(c.summary.revoked)} />
            </Grid>
            {c.items.length === 0 ? (
              <EmptyState title={t('No facility reviews in this quarter')} />
            ) : (
              <Table caption={t('Access reviews by facility, {period}', { period: c.period })}>
                <thead>
                  <tr>
                    <th scope="col">{t('Facility')}</th>
                    <th scope="col">{t('Status')}</th>
                    <th scope="col">{t('Due by')}</th>
                    <th scope="col" className="num">
                      {t('Accounts decided')}
                    </th>
                    <th scope="col" className="num">
                      {t('Accounts revoked')}
                    </th>
                    <th scope="col">
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.items.map((r) => (
                    <tr key={r.facilityId}>
                      <th scope="row">
                        {r.facilityName}
                        {r.municipality && <div className="muted">{r.municipality}</div>}
                        {r.directors === 0 && (
                          <div className="muted">{t('No active director')}</div>
                        )}
                      </th>
                      <td>
                        <ReviewStatusBadge status={r.status} overdue={r.overdue} />
                      </td>
                      <td>{formatDate(r.dueDate)}</td>
                      <td className="num">
                        {r.reviewId ? `${formatNumber(r.decided)} / ${formatNumber(r.total)}` : '—'}
                      </td>
                      <td className="num">{r.reviewId ? formatNumber(r.revoked) : '—'}</td>
                      <td>
                        {r.reviewId && (
                          <Button size="sm" variant="secondary" onClick={() => onOpen(r.reviewId!)}>
                            {t('View')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </QueryView>
    </div>
  );
}
