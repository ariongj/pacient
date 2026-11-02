import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Channel } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, QueryView } from '../../components/ui';
import { ChannelConversation } from './channels/ChannelConversation';
import { NewChannelDialog } from './channels/NewChannelDialog';

/** Team channels: coordination between colleagues in a facility and across the network. */
export function ChannelsPage() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const channels = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ items: Channel[] }>('/channels'),
  });

  const items = channels.data?.items ?? [];
  const selectedId = params.get('c') ?? items[0]?.id ?? null;
  const selected = items.find((c) => c.id === selectedId) ?? null;
  const select = (id: string) => setParams({ c: id }, { replace: true });

  const canCreate = user.role === 'DIRECTOR' || user.role === 'MINISTRY';
  const canManage = (c: Channel) =>
    (user.role === 'MINISTRY' && c.scope === 'NATIONAL') ||
    (user.role === 'DIRECTOR' && c.scope === 'FACILITY');

  const groups: { title: string; items: Channel[] }[] = [
    { title: user.facility?.name ?? 'Facility', items: items.filter((c) => c.scope === 'FACILITY') },
    { title: 'National', items: items.filter((c) => c.scope === 'NATIONAL') },
  ].filter((g) => g.items.length);

  return (
    <>
      <PageHeader
        title="Team channels"
        subtitle="Real-time coordination with your colleagues"
        actions={canCreate ? <Button onClick={() => setCreating(true)}>New channel</Button> : undefined}
      />
      <Alert tone="info">
        Channels are for coordination. Do not post patient identifiers — use the patient record,
        care tasks or referrals.
      </Alert>
      <QueryView query={channels}>
        {() =>
          items.length === 0 ? (
            <EmptyState title="No channels available for your role" />
          ) : (
            <div className="split">
              <Card>
                <nav aria-label="Channels" className="thread-list">
                  {groups.map((g) => (
                    <div key={g.title} style={{ marginBottom: '0.75rem' }}>
                      <div
                        className="muted"
                        style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 0.5rem 0.25rem' }}
                      >
                        {g.title}
                      </div>
                      {g.items.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          aria-current={c.id === selectedId ? 'true' : undefined}
                          title={c.description ?? undefined}
                          onClick={() => select(c.id)}
                        >
                          <span className="row-between">
                            <span style={{ fontWeight: c.unreadCount ? 700 : 500 }}># {c.name}</span>
                            {c.unreadCount > 0 && (
                              <Badge tone="danger">
                                {c.unreadCount}
                                <span className="sr-only"> unread</span>
                              </Badge>
                            )}
                          </span>
                          {c.description && (
                            <span className="muted" style={{ display: 'block', fontSize: '0.78rem' }}>
                              {c.description}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                </nav>
              </Card>
              {selected ? (
                <ChannelConversation
                  key={selected.id}
                  channel={selected}
                  canManage={canManage(selected)}
                  onArchived={() => setParams({}, { replace: true })}
                />
              ) : (
                <EmptyState title="Channel not found">It may have been archived.</EmptyState>
              )}
            </div>
          )
        }
      </QueryView>
      <NewChannelDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCreating(false);
          select(c.id);
        }}
      />
    </>
  );
}
