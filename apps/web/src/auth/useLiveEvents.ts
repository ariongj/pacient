import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to server-sent events for the signed-in user and refreshes the affected queries.
 * Each connection uses a fresh single-use ticket; on failure we back off and reconnect.
 */
export function useLiveEvents(enabled: boolean): LiveStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = async () => {
      if (stopped) return;
      setStatus('connecting');
      try {
        const { ticket } = await api<{ ticket: string }>('/events/ticket', { method: 'POST' });
        if (stopped) return;
        source = new EventSource(`/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
        source.onopen = () => {
          attempt = 0;
          setStatus('live');
        };
        source.addEventListener('notification', () => {
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
          // Many notifications reflect changes elsewhere (results, referrals, tasks, pharmacy).
          queryClient.invalidateQueries({ queryKey: ['worklist'] });
          queryClient.invalidateQueries({ queryKey: ['messages'] });
        });
        source.addEventListener('channel.message', (e) => {
          const ref = (JSON.parse((e as MessageEvent).data) as { ref?: string }).ref;
          queryClient.invalidateQueries({ queryKey: ['channels'] });
          if (ref) queryClient.invalidateQueries({ queryKey: ['channel', ref] });
        });
        source.onerror = () => {
          // Tickets are single-use, so EventSource's own retry cannot succeed: reconnect manually.
          source?.close();
          setStatus('offline');
          const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
          retry = setTimeout(connect, delay);
        };
      } catch {
        setStatus('offline');
        retry = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempt++));
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [enabled, queryClient]);

  return enabled ? status : 'offline';
}
