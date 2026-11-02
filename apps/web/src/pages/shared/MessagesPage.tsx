import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type {
  CareTeamMember,
  MessageThreadDetail,
  MessageThreadSummary,
  Page,
  PatientListItem,
} from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';

/**
 * Secure, non-urgent messaging between a patient and the doctors in their care team.
 * Used by both the patient portal and the doctor workspace.
 */
function NewThreadForm({
  prefillPatientId,
  onCreated,
  onCancel,
}: {
  prefillPatientId: string | null;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const user = useUser();
  const isPatient = user.role === 'PATIENT';
  const queryClient = useQueryClient();

  const careTeam = useQuery({
    queryKey: ['careTeam', user.patientId],
    queryFn: () => api<{ items: CareTeamMember[] }>(`/patients/${user.patientId}/care-team`),
    enabled: isPatient && Boolean(user.patientId),
  });
  const myPatients = useQuery({
    queryKey: ['patients', 'mine', 'all'],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', { query: { scope: 'mine', pageSize: 100 } }),
    enabled: !isPatient,
  });

  const create = useMutation({
    mutationFn: (body: object) =>
      api<{ id: string }>('/messages/threads', { method: 'POST', body }),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      onCreated(thread.id);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const recipient = String(f.get('recipient') ?? '');
    create.mutate({
      ...(isPatient ? { doctorId: recipient } : { patientId: recipient }),
      subject: f.get('subject'),
      body: f.get('body'),
    });
  }

  const options = isPatient
    ? (careTeam.data?.items ?? []).map((m) => ({
        value: m.doctorId,
        label: `${m.fullName}${m.specialty ? ` — ${m.specialty}` : ''}`,
      }))
    : (myPatients.data?.items ?? []).map((p) => ({
        value: p.id,
        label: `${p.lastName}, ${p.firstName} (${p.nationalId})`,
      }));
  const loading = isPatient ? careTeam.isPending : myPatients.isPending;
  const loadError = isPatient ? careTeam.error : myPatients.error;

  if (loadError) return <ErrorAlert error={loadError} />;
  if (!loading && options.length === 0) {
    return (
      <Alert tone="warning">
        {isPatient
          ? t('You do not have a doctor in your care team yet, so you cannot start a conversation.')
          : t(
              'You have no patients in your care. Messages can only be sent within a care relationship.',
            )}
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <SelectField
        label={isPatient ? t('Doctor') : t('Patient')}
        name="recipient"
        required
        disabled={loading}
        defaultValue={!isPatient && prefillPatientId ? prefillPatientId : undefined}
        key={options.length}
        placeholder={loading ? t('Loading…') : t('Choose…')}
        options={options}
      />
      <TextField label={t('Subject')} name="subject" required minLength={2} maxLength={200} />
      <TextAreaField
        label={t('Message')}
        name="body"
        required
        maxLength={5000}
        hint={isPatient ? t('Not for emergencies — call 112 if you need urgent help.') : undefined}
      />
      <ErrorAlert error={create.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {t('Send')}
        </Button>
      </div>
    </form>
  );
}

function Conversation({ threadId }: { threadId: string }) {
  const user = useUser();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ['messages', 'thread', threadId],
    queryFn: () => api<MessageThreadDetail>(`/messages/threads/${threadId}`),
  });

  // Opening a conversation marks messages as read on the server: refresh counts.
  useEffect(() => {
    if (q.data) {
      queryClient.invalidateQueries({ queryKey: ['messages', 'threads'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
  }, [q.data, queryClient]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [q.data?.messages.length]);

  const send = useMutation({
    mutationFn: (text: string) =>
      api(`/messages/threads/${threadId}/messages`, { method: 'POST', body: { body: text } }),
    onSuccess: () => {
      setBody('');
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });
  const close = useMutation({
    mutationFn: () => api(`/messages/threads/${threadId}/close`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages'] }),
  });

  return (
    <QueryView query={q}>
      {(th) => (
        <Card
          title={th.subject}
          actions={
            <span className="row">
              {th.status === 'CLOSED' && <Badge tone="neutral">{t('Closed')}</Badge>}
              {user.role === 'DOCTOR' && th.status === 'OPEN' && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={close.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        t('Close this conversation? Neither side can reply afterwards.'),
                      )
                    ) {
                      close.mutate();
                    }
                  }}
                >
                  {t('Close conversation')}
                </Button>
              )}
            </span>
          }
        >
          <p className="muted">
            {t('With {name}', {
              name: user.role === 'PATIENT' ? th.doctorName : th.patientName,
            })}
          </p>
          <ErrorAlert error={close.error} />
          <div className="chat" role="log" aria-label={t('Messages')} aria-live="polite">
            {th.messages.map((m) => {
              const mine = m.senderId === user.id;
              return (
                <div key={m.id} className={`bubble ${mine ? 'bubble-mine' : ''}`}>
                  <span className="sr-only">
                    {mine ? t('You wrote:') : t('{name} wrote:', { name: m.senderName })}
                  </span>
                  {m.body}
                  <div className="bubble-meta">
                    {mine ? t('You') : m.senderName} · {formatDateTime(m.createdAt)}
                    {mine && m.readAt ? ` · ${t('Read')}` : ''}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          {th.canReply ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (body.trim()) send.mutate(body.trim());
              }}
              style={{ marginTop: '1rem' }}
            >
              <TextAreaField
                label={t('Reply')}
                name="reply"
                rows={3}
                required
                maxLength={5000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <ErrorAlert error={send.error} />
              <div className="form-actions">
                <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
                  {t('Send')}
                </Button>
              </div>
            </form>
          ) : (
            <Alert tone="neutral">
              {th.status === 'CLOSED'
                ? t('This conversation has been closed. Start a new message if you need to.')
                : t('Replies are not possible because the care relationship has ended.')}
            </Alert>
          )}
        </Card>
      )}
    </QueryView>
  );
}

export function MessagesPage() {
  const user = useUser();
  const isPatient = user.role === 'PATIENT';
  const [params, setParams] = useSearchParams();
  const selected = params.get('thread');
  const prefillPatientId = params.get('patientId');
  const [composing, setComposing] = useState(Boolean(prefillPatientId));

  const threads = useQuery({
    queryKey: ['messages', 'threads'],
    queryFn: () => api<{ items: MessageThreadSummary[] }>('/messages/threads'),
  });

  function select(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set('thread', id);
    else next.delete('thread');
    next.delete('patientId');
    setParams(next, { replace: false });
  }

  return (
    <>
      <PageHeader
        title={t('Messages')}
        subtitle={
          isPatient
            ? t('Secure messages with the doctors in your care team.')
            : t('Secure messages with patients in your care.')
        }
        actions={<Button onClick={() => setComposing(true)}>{t('New message')}</Button>}
      />
      {isPatient && (
        <Alert tone="info">
          {t(
            'Messages are for non-urgent questions and are answered during working hours. In an emergency, call 112.',
          )}
        </Alert>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <Card title={t('Conversations')}>
            <QueryView query={threads}>
              {(d) =>
                d.items.length ? (
                  <nav aria-label={t('Conversations')} className="thread-list">
                    {d.items.map((th) => (
                      <button
                        key={th.id}
                        type="button"
                        aria-current={th.id === selected ? 'true' : undefined}
                        onClick={() => select(th.id)}
                      >
                        <div className="row-between">
                          <strong>{th.subject}</strong>
                          <span className="row">
                            {th.unreadCount > 0 && (
                              <Badge tone="info">
                                {t('{count} new', { count: th.unreadCount })}
                              </Badge>
                            )}
                            {th.status === 'CLOSED' && <Badge tone="neutral">{t('Closed')}</Badge>}
                          </span>
                        </div>
                        <div className="muted" style={{ fontSize: '0.85rem' }}>
                          {isPatient ? th.doctorName : th.patientName} ·{' '}
                          {formatDateTime(th.lastMessageAt)}
                        </div>
                      </button>
                    ))}
                  </nav>
                ) : (
                  <EmptyState title={t('No conversations yet')} />
                )
              }
            </QueryView>
          </Card>
        </div>
        <div style={{ flex: '2 1 420px', minWidth: 0 }}>
          {selected ? (
            <Conversation key={selected} threadId={selected} />
          ) : (
            <Card>
              <EmptyState title={t('Select a conversation')}>
                {t('Choose a conversation on the left, or start a new message.')}
              </EmptyState>
            </Card>
          )}
        </div>
      </div>
      <Dialog open={composing} onClose={() => setComposing(false)} title={t('New message')} wide>
        <NewThreadForm
          prefillPatientId={prefillPatientId}
          onCancel={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            select(id);
          }}
        />
      </Dialog>
    </>
  );
}
