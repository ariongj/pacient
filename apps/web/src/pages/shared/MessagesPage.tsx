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
          ? 'You do not have a doctor in your care team yet, so you cannot start a conversation.'
          : 'You have no patients in your care. Messages can only be sent within a care relationship.'}
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <SelectField
        label={isPatient ? 'Doctor' : 'Patient'}
        name="recipient"
        required
        disabled={loading}
        defaultValue={!isPatient && prefillPatientId ? prefillPatientId : undefined}
        key={options.length}
        placeholder={loading ? 'Loading…' : 'Choose…'}
        options={options}
      />
      <TextField label="Subject" name="subject" required minLength={2} maxLength={200} />
      <TextAreaField
        label="Message"
        name="body"
        required
        maxLength={5000}
        hint={isPatient ? 'Not for emergencies — call 112 if you need urgent help.' : undefined}
      />
      <ErrorAlert error={create.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={create.isPending}>
          Send
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
      {(t) => (
        <Card
          title={t.subject}
          actions={
            <span className="row">
              {t.status === 'CLOSED' && <Badge tone="neutral">Closed</Badge>}
              {user.role === 'DOCTOR' && t.status === 'OPEN' && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={close.isPending}
                  onClick={() => {
                    if (
                      window.confirm('Close this conversation? Neither side can reply afterwards.')
                    ) {
                      close.mutate();
                    }
                  }}
                >
                  Close conversation
                </Button>
              )}
            </span>
          }
        >
          <p className="muted">
            {user.role === 'PATIENT' ? `With ${t.doctorName}` : `With ${t.patientName}`}
          </p>
          <ErrorAlert error={close.error} />
          <div className="chat" role="log" aria-label="Messages" aria-live="polite">
            {t.messages.map((m) => {
              const mine = m.senderId === user.id;
              return (
                <div key={m.id} className={`bubble ${mine ? 'bubble-mine' : ''}`}>
                  <span className="sr-only">{mine ? 'You wrote:' : `${m.senderName} wrote:`}</span>
                  {m.body}
                  <div className="bubble-meta">
                    {mine ? 'You' : m.senderName} · {formatDateTime(m.createdAt)}
                    {mine && m.readAt ? ' · Read' : ''}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          {t.canReply ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (body.trim()) send.mutate(body.trim());
              }}
              style={{ marginTop: '1rem' }}
            >
              <TextAreaField
                label="Reply"
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
                  Send
                </Button>
              </div>
            </form>
          ) : (
            <Alert tone="neutral">
              {t.status === 'CLOSED'
                ? 'This conversation has been closed. Start a new message if you need to.'
                : 'Replies are not possible because the care relationship has ended.'}
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
        title="Messages"
        subtitle={
          isPatient
            ? 'Secure messages with the doctors in your care team.'
            : 'Secure messages with patients in your care.'
        }
        actions={<Button onClick={() => setComposing(true)}>New message</Button>}
      />
      {isPatient && (
        <Alert tone="info">
          Messages are for non-urgent questions and are answered during working hours. In an
          emergency, call <strong>112</strong>.
        </Alert>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <Card title="Conversations">
            <QueryView query={threads}>
              {(d) =>
                d.items.length ? (
                  <nav aria-label="Conversations" className="thread-list">
                    {d.items.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        aria-current={t.id === selected ? 'true' : undefined}
                        onClick={() => select(t.id)}
                      >
                        <div className="row-between">
                          <strong>{t.subject}</strong>
                          <span className="row">
                            {t.unreadCount > 0 && <Badge tone="info">{t.unreadCount} new</Badge>}
                            {t.status === 'CLOSED' && <Badge tone="neutral">Closed</Badge>}
                          </span>
                        </div>
                        <div className="muted" style={{ fontSize: '0.85rem' }}>
                          {isPatient ? t.doctorName : t.patientName} ·{' '}
                          {formatDateTime(t.lastMessageAt)}
                        </div>
                      </button>
                    ))}
                  </nav>
                ) : (
                  <EmptyState title="No conversations yet" />
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
              <EmptyState title="Select a conversation">
                Choose a conversation on the left, or start a new message.
              </EmptyState>
            </Card>
          )}
        </div>
      </div>
      <Dialog open={composing} onClose={() => setComposing(false)} title="New message" wide>
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
