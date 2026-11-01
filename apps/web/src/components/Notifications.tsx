import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { AppNotification, Page } from '../api/types';
import { formatDateTime } from '../format';
import { Button, Card, EmptyState, PageHeader, Pagination, QueryView } from './ui';

type NotificationPage = Page<AppNotification> & { unreadCount: number };

function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string | 'all') =>
      api(id === 'all' ? '/notifications/read-all' : `/notifications/${id}/read`, {
        method: 'POST',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

/** Header bell with unread count; polls every minute while the tab is open. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const markRead = useMarkRead();
  const count = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => api<{ unreadCount: number }>('/notifications/unread-count'),
    refetchInterval: 60_000,
  });
  const latest = useQuery({
    queryKey: ['notifications', 'latest'],
    queryFn: () => api<NotificationPage>('/notifications', { query: { pageSize: 8 } }),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const unread = count.data?.unreadCount ?? 0;
  return (
    <div className="bell" ref={ref}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span className="bell-count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="notif-panel" role="region" aria-label="Notifications">
          <div className="row-between" style={{ padding: '0.6rem 0.9rem' }}>
            <strong>Notifications</strong>
            {unread > 0 && (
              <Button variant="ghost" size="sm" onClick={() => markRead.mutate('all')}>
                Mark all read
              </Button>
            )}
          </div>
          <QueryView query={latest}>
            {(d) =>
              d.items.length ? (
                <ul>
                  {d.items.map((n) => (
                    <li key={n.id}>
                      <Link
                        to={n.link ?? '/notifications'}
                        className={n.readAt ? '' : 'notif-unread'}
                        onClick={() => {
                          if (!n.readAt) markRead.mutate(n.id);
                          setOpen(false);
                        }}
                      >
                        {n.title}
                        <div className="muted" style={{ fontWeight: 400, fontSize: '0.8rem' }}>
                          {formatDateTime(n.createdAt)}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="You're all caught up" />
              )
            }
          </QueryView>
          <div style={{ padding: '0.6rem 0.9rem' }}>
            <Link to="/notifications" onClick={() => setOpen(false)}>
              See all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export function NotificationsPage() {
  const [page, setPage] = useState(1);
  const markRead = useMarkRead();
  const q = useQuery({
    queryKey: ['notifications', 'page', page],
    queryFn: () => api<NotificationPage>('/notifications', { query: { page, pageSize: 25 } }),
  });
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          <Button
            variant="secondary"
            onClick={() => markRead.mutate('all')}
            loading={markRead.isPending}
          >
            Mark all as read
          </Button>
        }
      />
      <Card>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <>
                <ul className="list">
                  {d.items.map((n) => (
                    <li key={n.id} className="row-between">
                      <span>
                        {n.link ? (
                          <Link to={n.link} onClick={() => !n.readAt && markRead.mutate(n.id)}>
                            {n.readAt ? n.title : <strong>{n.title}</strong>}
                          </Link>
                        ) : (
                          n.title
                        )}
                        {n.body && <div className="muted">{n.body}</div>}
                        <div className="muted" style={{ fontSize: '0.8rem' }}>
                          {formatDateTime(n.createdAt)}
                        </div>
                      </span>
                      {!n.readAt && (
                        <Button variant="ghost" size="sm" onClick={() => markRead.mutate(n.id)}>
                          Mark read
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
              </>
            ) : (
              <EmptyState title="No notifications yet" />
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
