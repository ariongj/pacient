import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  categoryLabel,
  harmShort,
  harmTone,
  statusLabel,
  statusTone,
  useIncidentMeta,
  useMyActions,
  useMyReports,
  useQueue,
  useUpdateAction,
  type IncidentMeta,
} from '../../api/incidents';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  TabPanel,
  Table,
  Tabs,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import {
  FacilityDashboardView,
  NationalView,
  ReviewersCard,
  SystemIncidentsView,
} from './IncidentDashboards';
import { ReportForm } from './ReportForm';
import { IncidentView } from './ReviewPanel';

type TabId =
  'report' | 'mine' | 'actions' | 'queue' | 'dashboard' | 'reviewers' | 'national' | 'it';

/**
 * Patient safety incidents: every member of staff reports (optionally anonymously) and follows
 * their own reports; the facility's reviewers work the queue; the Ministry sees national counts
 * and incidents involving the system.
 */
export function IncidentsPage() {
  const meta = useIncidentMeta();
  return (
    <>
      <PageHeader
        title={t('Safety incidents')}
        subtitle={t(
          'Report incidents and near misses so that the hospital can learn from them and make care safer.',
        )}
      />
      <QueryView query={meta}>{(m) => <IncidentsBody meta={m} />}</QueryView>
    </>
  );
}

function IncidentsBody({ meta }: { meta: IncidentMeta }) {
  const [params, setParams] = useSearchParams();
  const tabs: { id: TabId; label: string }[] = [
    ...(meta.canReport
      ? ([
          { id: 'report', label: t('Report an incident') },
          { id: 'mine', label: t('My reports') },
          { id: 'actions', label: t('My actions') },
        ] as const)
      : []),
    ...(meta.canReview
      ? ([
          { id: 'queue', label: t('Review queue') },
          { id: 'dashboard', label: t('Dashboard') },
        ] as const)
      : []),
    ...(meta.canManageReviewers ? ([{ id: 'reviewers', label: t('Reviewers') }] as const) : []),
    ...(meta.isMinistry
      ? ([
          { id: 'national', label: t('National overview') },
          { id: 'it', label: t('System incidents') },
        ] as const)
      : []),
  ];
  const requested = params.get('tab') as TabId | null;
  const fallback: TabId = meta.canReview ? 'queue' : (tabs[0]?.id ?? 'report');
  const tab = tabs.some((x) => x.id === requested) ? requested! : fallback;
  const openId = params.get('id');

  const setTab = (id: TabId) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    next.delete('id');
    setParams(next, { replace: true });
  };
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next, { replace: true });
  };

  if (!tabs.length) return <EmptyState title={t('Incident reporting is for facility staff')} />;

  return (
    <div className="stack">
      <Tabs tabs={tabs} active={tab} onChange={setTab} label={t('Safety incidents')} />
      <TabPanel id={tab}>
        {tab === 'report' && <ReportForm meta={meta} onReported={() => undefined} />}
        {tab === 'mine' && <MyReports onOpen={open} />}
        {tab === 'actions' && <MyActions onOpen={meta.canReview ? open : undefined} />}
        {tab === 'queue' && <Queue meta={meta} onOpen={open} />}
        {tab === 'dashboard' && <FacilityDashboardView onOpen={open} />}
        {tab === 'reviewers' && <ReviewersCard />}
        {tab === 'national' && <NationalView />}
        {tab === 'it' && <SystemIncidentsView />}
      </TabPanel>
      <Dialog open={Boolean(openId)} onClose={() => open(null)} title={t('Incident')} wide>
        {openId && <IncidentView id={openId} meta={meta} />}
      </Dialog>
    </div>
  );
}

function MyReports({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const query = useMyReports(page);
  return (
    <Card title={t('My reports')}>
      <p className="muted">
        {t('Reports you made under your name. Anonymous reports are not listed here.')}
      </p>
      <QueryView query={query}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t('You have not reported any incidents yet')} />
          ) : (
            <>
              <Table caption={t('My reports')}>
                <thead>
                  <tr>
                    <th>{t('Reference|incident number')}</th>
                    <th>{t('When it happened')}</th>
                    <th>{t('Kind of incident')}</th>
                    <th>{t('Harm')}</th>
                    <th>{t('Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => onOpen(r.id)}>
                          {r.reference}
                        </Button>
                      </td>
                      <td>{formatDateTime(r.occurredAt)}</td>
                      <td>{categoryLabel(r.category)}</td>
                      <td>
                        <Badge tone={harmTone(r.harm)}>{harmShort(r.harm)}</Badge>
                      </td>
                      <td>
                        <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

function MyActions({ onOpen }: { onOpen?: (id: string) => void }) {
  const query = useMyActions();
  const change = useUpdateAction();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card title={t('Actions assigned to me')}>
      <QueryView query={query}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No actions assigned to you')} />
          ) : (
            <Table caption={t('Actions assigned to me')}>
              <thead>
                <tr>
                  <th>{t('Action')}</th>
                  <th>{t('Incident')}</th>
                  <th>{t('Due date')}</th>
                  <th>
                    <span className="sr-only">{t('Done')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.completedAt ? '✓ ' : ''}
                      {a.description}
                    </td>
                    <td>
                      {onOpen ? (
                        <Button size="sm" variant="ghost" onClick={() => onOpen(a.incidentId)}>
                          {a.reference}
                        </Button>
                      ) : (
                        a.reference
                      )}{' '}
                      <span className="muted">{categoryLabel(a.category)}</span>
                    </td>
                    <td>
                      {a.dueDate ? formatDate(a.dueDate) : '—'}{' '}
                      {!a.completedAt && a.dueDate && a.dueDate < today && (
                        <Badge tone="danger">{t('Overdue')}</Badge>
                      )}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={change.isPending}
                        onClick={() =>
                          change.mutate({ id: a.id, body: { completed: !a.completedAt } })
                        }
                      >
                        {a.completedAt ? t('Reopen action') : t('Mark done')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <ErrorAlert error={change.error} />
    </Card>
  );
}

function Queue({ meta, onOpen }: { meta: IncidentMeta; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState('OPEN');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const query = useQueue({ status: status || undefined, category: category || undefined, page });
  return (
    <Card title={t('Review queue')}>
      <div className="search-bar">
        <SelectField
          label={t('Status')}
          name="status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          options={[
            { value: 'OPEN', label: t('Open (not closed)') },
            { value: '', label: t('All') },
            ...meta.statuses.map((s) => ({ value: s, label: statusLabel(s) })),
          ]}
        />
        <SelectField
          label={t('Kind of incident')}
          name="category"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
          options={[
            { value: '', label: t('All') },
            ...meta.categories.map((c) => ({ value: c, label: categoryLabel(c) })),
          ]}
        />
      </div>
      <QueryView query={query}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t('No incidents match')} />
          ) : (
            <>
              <Table caption={t('Review queue')}>
                <thead>
                  <tr>
                    <th>{t('Reference|incident number')}</th>
                    <th>{t('Reported')}</th>
                    <th>{t('Kind of incident')}</th>
                    <th>{t('Harm')}</th>
                    <th>{t('Ward or unit')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Reviewer')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => onOpen(i.id)}>
                          {i.reference}
                        </Button>
                        {i.anonymous && <span className="muted"> · {t('Anonymous')}</span>}
                      </td>
                      <td>{formatDateTime(i.reportedAt)}</td>
                      <td>{categoryLabel(i.category)}</td>
                      <td>
                        <Badge tone={harmTone(i.reviewedHarm ?? i.harm)}>
                          {harmShort(i.reviewedHarm ?? i.harm)}
                        </Badge>
                      </td>
                      <td>{i.unitName ?? '—'}</td>
                      <td>
                        <Badge tone={statusTone(i.status)}>{statusLabel(i.status)}</Badge>
                        {i.openActions > 0 && (
                          <span className="muted">
                            {' '}
                            · {t('{count} open actions', { count: i.openActions })}
                          </span>
                        )}
                      </td>
                      <td>{i.reviewerName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}
