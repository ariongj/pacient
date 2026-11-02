import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api } from '../../../api/client';
import type { Channel, ChannelMessage } from '../../../api/types';
import { useUser } from '../../../auth/AuthContext';
import { Badge, Button, ErrorAlert, Loading } from '../../../components/ui';
import { formatDate, formatTime, humanize } from '../../../format';

interface History {
  channel: Channel;
  items: ChannelMessage[];
  hasMore: boolean;
}

const dayKey = (iso: string) => new Date(iso).toDateString();

export function ChannelConversation({
  channel,
  canManage,
  onArchived,
}: {
  channel: Channel;
  canManage: boolean;
  onArchived: () => void;
}) {
  const user = useUser();
  const queryClient = useQueryClient();
  const [earlier, setEarlier] = useState<ChannelMessage[]>([]);
  const [hasMoreEarlier, setHasMoreEarlier] = useState<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const history = useQuery({
    queryKey: ['channel', channel.id],
    queryFn: () => api<History>(`/channels/${channel.id}/messages`, { query: { limit: 50 } }),
  });

  // Reset paging when switching channel.
  useEffect(() => {
    setEarlier([]);
    setHasMoreEarlier(null);
    stickToBottom.current = true;
  }, [channel.id]);

  // Mark as read whenever new messages have been loaded while the channel is open.
  const latestId = history.data?.items.at(-1)?.id;
  useEffect(() => {
    if (!latestId) return;
    api(`/channels/${channel.id}/read`, { method: 'POST' })
      .then(() => queryClient.invalidateQueries({ queryKey: ['channels'] }))
      .catch(() => undefined);
  }, [channel.id, latestId, queryClient]);

  const messages = [...earlier, ...(history.data?.items ?? [])];

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, latestId]);

  const send = useMutation({
    mutationFn: () =>
      api(`/channels/${channel.id}/messages`, { method: 'POST', body: { body, isUrgent: urgent } }),
    onSuccess: () => {
      setBody('');
      setUrgent(false);
      stickToBottom.current = true;
      queryClient.invalidateQueries({ queryKey: ['channel', channel.id] });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });

  const archive = useMutation({
    mutationFn: () => api(`/channels/${channel.id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      onArchived();
    },
  });

  async function loadEarlier() {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingEarlier(true);
    stickToBottom.current = false;
    try {
      const res = await api<History>(`/channels/${channel.id}/messages`, {
        query: { before: oldest.createdAt, limit: 50 },
      });
      setEarlier((prev) => [...res.items, ...prev]);
      setHasMoreEarlier(res.hasMore);
    } finally {
      setLoadingEarlier(false);
    }
  }

  function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (body.trim() && !send.isPending) send.mutate();
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  const canLoadMore = hasMoreEarlier ?? history.data?.hasMore ?? false;

  return (
    <section className="card" aria-labelledby="channel-title">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 id="channel-title">#{channel.name}</h2>
          {channel.description && (
            <p className="muted" style={{ margin: '0.15rem 0 0.4rem' }}>
              {channel.description}
            </p>
          )}
          <div className="row" style={{ gap: '0.3rem' }}>
            <Badge tone="info">
              {channel.scope === 'NATIONAL' ? 'National' : (channel.facilityName ?? 'Facility')}
            </Badge>
            {channel.allowedRoles.map((r) => (
              <Badge key={r}>{humanize(r)}</Badge>
            ))}
          </div>
        </div>
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            loading={archive.isPending}
            onClick={() => {
              if (window.confirm(`Archive #${channel.name}? Members will no longer see it.`)) {
                archive.mutate();
              }
            }}
          >
            Archive channel
          </Button>
        )}
      </div>
      <ErrorAlert error={archive.error} />

      <div
        ref={scroller}
        className="chat"
        style={{ marginTop: '0.75rem', minHeight: 260 }}
        role="log"
        aria-live="polite"
        aria-label={`Messages in #${channel.name}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {canLoadMore && (
          <div style={{ textAlign: 'center' }}>
            <Button variant="ghost" size="sm" onClick={loadEarlier} loading={loadingEarlier}>
              Load earlier messages
            </Button>
          </div>
        )}
        {history.isPending ? (
          <Loading />
        ) : history.error ? (
          <ErrorAlert error={history.error} />
        ) : messages.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center' }}>
            No messages yet. Start the conversation.
          </p>
        ) : (
          messages.map((m, i) => {
            const mine = m.authorId === user.id;
            const newDay = i === 0 || dayKey(messages[i - 1]!.createdAt) !== dayKey(m.createdAt);
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {newDay && (
                  <div
                    className="muted"
                    style={{ textAlign: 'center', fontSize: '0.75rem', fontWeight: 600, margin: '0.4rem 0' }}
                  >
                    {formatDate(m.createdAt)}
                  </div>
                )}
                <div
                  className={`bubble ${mine ? 'bubble-mine' : ''}`}
                  style={m.isUrgent ? { borderLeft: '4px solid var(--danger)' } : undefined}
                >
                  {!mine && (
                    <div style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>
                      <strong>{m.authorName}</strong>{' '}
                      <span className="muted">
                        {humanize(m.authorRole)}
                        {channel.scope === 'NATIONAL' && m.authorFacility ? ` · ${m.authorFacility}` : ''}
                      </span>
                    </div>
                  )}
                  {m.isUrgent && (
                    <div style={{ marginBottom: '0.25rem' }}>
                      <Badge tone="danger">Urgent</Badge>
                    </div>
                  )}
                  {m.body}
                  <div className="bubble-meta">{mine ? `You · ${formatTime(m.createdAt)}` : formatTime(m.createdAt)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {channel.isArchived ? (
        <p className="muted">This channel is archived.</p>
      ) : (
        <form onSubmit={onSubmit} style={{ marginTop: '0.75rem' }}>
          <div className="field">
            <label htmlFor="channel-composer">Message #{channel.name}</label>
            <textarea
              id="channel-composer"
              rows={3}
              maxLength={4000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onKeyDown}
              aria-describedby="composer-hint"
            />
            <small id="composer-hint" className="muted">
              Enter to send · Shift+Enter for a new line
            </small>
          </div>
          <div className="row-between">
            <label className="checkbox">
              <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
              Mark as urgent – notifies everyone in the channel
            </label>
            <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
              Send
            </Button>
          </div>
          <ErrorAlert error={send.error} />
        </form>
      )}
    </section>
  );
}
