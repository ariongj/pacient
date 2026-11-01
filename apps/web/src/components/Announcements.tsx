import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Announcement } from '../api/types';
import { formatDate } from '../format';
import { Badge, Card, QueryView } from './ui';

/** Current announcements for the signed-in user (national + their facility, right audience). */
export function AnnouncementsCard({ limit = 3 }: { limit?: number }) {
  const q = useQuery({
    queryKey: ['announcements', 'feed'],
    queryFn: () => api<{ items: Announcement[] }>('/announcements'),
  });
  if (q.data && q.data.items.length === 0) return null;
  return (
    <Card title="Announcements">
      <QueryView query={q}>
        {(d) => (
          <ul className="list">
            {d.items.slice(0, limit).map((a) => (
              <li key={a.id} className="announcement">
                <div className="row-between">
                  <strong>{a.title}</strong>
                  <Badge tone="info">
                    {a.scope === 'NATIONAL' ? 'Ministry of Health' : a.facilityName}
                  </Badge>
                </div>
                <p style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p>
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {formatDate(a.publishedAt)}
                  {a.expiresAt ? ` · until ${formatDate(a.expiresAt)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </Card>
  );
}
