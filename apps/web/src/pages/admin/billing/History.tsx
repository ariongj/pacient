import { useState } from 'react';
import {
  describeEvent,
  eventLabel,
  subscriptionStatusLabel,
  type SubscriptionEvent,
} from '../../../api/subscriptions';
import { Button, EmptyState } from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';

const FIRST = 15;

/**
 * The subscription history, newest first. The administrator sees who made each change and the
 * internal notes; a facility's directors see "the service operator" and no internal notes.
 */
export function SubscriptionHistory({
  events,
  audience,
}: {
  events: SubscriptionEvent[];
  audience: 'admin' | 'director';
}) {
  const [all, setAll] = useState(false);
  if (events.length === 0) return <EmptyState title={t('No history yet')} />;
  const shown = all ? events : events.slice(0, FIRST);
  const who = (e: SubscriptionEvent) =>
    audience === 'admin'
      ? (e.actor?.fullName ?? t('Automatic'))
      : e.byOperator
        ? t('The service operator')
        : t('Automatic');
  return (
    <>
      <ol className="timeline">
        {shown.map((e) => {
          const detail = describeEvent(e);
          const statusChange = e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus;
          return (
            <li key={e.id}>
              <div className="timeline-date">
                {formatDateTime(e.createdAt)} · {who(e)}
              </div>
              <strong>{eventLabel(e.type, e.data)}</strong>
              {statusChange && (
                <span className="muted">
                  {' '}
                  · {subscriptionStatusLabel(e.fromStatus!)} →{' '}
                  {subscriptionStatusLabel(e.toStatus!)}
                </span>
              )}
              {detail && <div>{detail}</div>}
              {e.note && <div className="note">{e.note}</div>}
            </li>
          );
        })}
      </ol>
      {events.length > FIRST && (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
          {all ? t('Show fewer') : t('Show all {count} entries', { count: events.length })}
        </Button>
      )}
    </>
  );
}
