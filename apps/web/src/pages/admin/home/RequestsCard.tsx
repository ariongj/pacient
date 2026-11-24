import { Link } from 'react-router-dom';
import { categoryLabel, useRequestInbox } from '../../../api/operatorRequests';
import { Card, Grid, Stat } from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import { PriorityBadge, RequestStatusBadge } from '../../requests/parts';

/**
 * Platform overview (AdminHome): requests to the operator – open and waiting counts and the
 * latest unresolved ones, with a link to the inbox. Fetches its own data and renders nothing when
 * no request is unresolved; it sits between other cards of the page, so it has its own bottom
 * margin. Round 2, builder G.
 */
export function RequestsCard() {
  const query = useRequestInbox({ status: 'UNRESOLVED', category: '', facilityId: '' }, 1, 5);
  const d = query.data;
  if (!d || d.counts.OPEN + d.counts.WAITING_CUSTOMER === 0) return null;
  return (
    <div style={{ marginBottom: '1rem' }}>
      <Card
        title={t('Requests from facilities')}
        actions={<Link to="/admin/requests">{t('Open the requests')}</Link>}
      >
        <Grid min={160}>
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
        </Grid>
        <ul
          className="stack"
          style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0', gap: '0.5rem' }}
        >
          {d.items.map((r) => (
            <li key={r.id}>
              <Link to={`/admin/requests/${r.id}`}>{r.subject}</Link>{' '}
              <span className="muted">
                · {r.facilityName} · {categoryLabel(r.category)} · {formatDateTime(r.updatedAt)}
              </span>{' '}
              <RequestStatusBadge status={r.status} audience="admin" />{' '}
              <PriorityBadge priority={r.priority} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
