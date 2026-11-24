import { Link, useSearchParams } from 'react-router-dom';
import {
  categoryLabel,
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  statusLabel,
  useRequestInbox,
  type InboxFilters,
  type RequestCategory,
} from '../../../api/operatorRequests';
import {
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { PriorityBadge, RequestStatusBadge } from '../../requests/parts';

/** The status filter in the address: none means not resolved, ALL means every status. */
function statusFilter(value: string | null): InboxFilters['status'] {
  if (value === 'ALL') return '';
  return (REQUEST_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as InboxFilters['status'])
    : 'UNRESOLVED';
}

/**
 * Requests from facilities to the operator (/admin/requests): filters by status, category and
 * facility, kept in the address so a filtered inbox can be bookmarked. Unresolved and high
 * priority come first. Round 2, builder G.
 */
export function RequestsInbox() {
  const [params, setParams] = useSearchParams();
  const filters: InboxFilters = {
    status: statusFilter(params.get('status')),
    category: (params.get('category') ?? '') as RequestCategory | '',
    facilityId: params.get('facilityId') ?? '',
  };
  const page = Number(params.get('page') ?? 1) || 1;
  const inbox = useRequestInbox(filters, page);
  const set = (key: string, value: string) => {
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== 'page') params.delete('page');
    setParams(params, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={t('Requests')}
        subtitle={t(
          'What facilities ask the operator: answer them and keep their status up to date. Requests are never about a patient.',
        )}
      />
      <QueryView query={inbox}>
        {(d) => (
          <div className="stack">
            <Grid min={170}>
              <Stat
                label={t('Open|requests')}
                value={d.counts.OPEN}
                tone={d.counts.OPEN > 0 ? 'info' : undefined}
              />
              <Stat
                label={t('Waiting for the facility|request status')}
                value={d.counts.WAITING_CUSTOMER}
              />
              <Stat
                label={t('High priority, unresolved')}
                value={d.counts.highOpen}
                tone={d.counts.highOpen > 0 ? 'danger' : undefined}
              />
              <Stat label={t('Resolved|request status')} value={d.counts.RESOLVED} />
            </Grid>
            <Card>
              <div className="form-grid">
                <SelectField
                  label={t('Status')}
                  value={filters.status || 'ALL'}
                  onChange={(e) =>
                    set('status', e.target.value === 'UNRESOLVED' ? '' : e.target.value)
                  }
                  options={[
                    { value: 'UNRESOLVED', label: t('Not resolved') },
                    { value: 'ALL', label: t('All') },
                    ...REQUEST_STATUSES.map((s) => ({ value: s, label: statusLabel(s, 'admin') })),
                  ]}
                />
                <SelectField
                  label={t('Category')}
                  value={filters.category}
                  onChange={(e) => set('category', e.target.value)}
                  options={[
                    { value: '', label: t('All') },
                    ...REQUEST_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })),
                  ]}
                />
                <SelectField
                  label={t('Facility')}
                  value={filters.facilityId}
                  onChange={(e) => set('facilityId', e.target.value)}
                  options={[
                    { value: '', label: t('All') },
                    ...d.facilities.map((f) => ({ value: f.id, label: f.name })),
                  ]}
                />
              </div>
              {d.items.length === 0 ? (
                <EmptyState title={t('No requests here')} />
              ) : (
                <>
                  <Table caption={t('Requests')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('Request')}</th>
                        <th scope="col">{t('Facility')}</th>
                        <th scope="col">{t('Category')}</th>
                        <th scope="col">{t('Status')}</th>
                        <th scope="col">{t('Last change')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.items.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link to={`/admin/requests/${r.id}`}>{r.subject}</Link>
                            <div className="muted">
                              <code>{r.reference}</code> · {r.requesterName}
                            </div>
                          </td>
                          <td>
                            <Link to={`/admin/organizations/${r.facilityId}`}>
                              {r.facilityName}
                            </Link>
                          </td>
                          <td>{categoryLabel(r.category)}</td>
                          <td>
                            <div className="row">
                              <RequestStatusBadge status={r.status} audience="admin" />
                              <PriorityBadge priority={r.priority} />
                            </div>
                            {!r.firstResponseAt && r.status !== 'RESOLVED' && (
                              <div className="muted">{t('Not answered yet')}</div>
                            )}
                          </td>
                          <td>{formatDateTime(r.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Pagination
                    page={d.page}
                    totalPages={d.totalPages}
                    onChange={(p) => set('page', String(p))}
                  />
                </>
              )}
            </Card>
          </div>
        )}
      </QueryView>
    </>
  );
}
