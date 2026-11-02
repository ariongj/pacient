import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { API_BASE, api } from '../../api/client';
import type {
  IntegrationClient,
  IntegrationMessage,
  IntegrationMessageDetail,
  IntegrationMessageStatus,
} from '../../api/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  Table,
  TextAreaField,
  TextField,
  type Tone,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';

const STATUS_LABEL: Record<IntegrationMessageStatus, string> = {
  NEEDS_REVIEW: 'Needs review',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  RESOLVED: 'Resolved',
  IGNORED: 'Ignored',
};
const STATUS_TONE: Record<IntegrationMessageStatus, Tone> = {
  NEEDS_REVIEW: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  RESOLVED: 'info',
  IGNORED: 'neutral',
};
const STATUSES = Object.keys(STATUS_LABEL) as IntegrationMessageStatus[];

interface MessagesPage {
  items: IntegrationMessage[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: Partial<Record<IntegrationMessageStatus, number>>;
}

function MessageStatus({ status }: { status: IntegrationMessageStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** HL7 date (YYYYMMDD…) → readable date, falling back to the raw value. */
function hl7Date(v: string) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  return m ? formatDate(`${m[1]}-${m[2]}-${m[3]}`) : v || '—';
}

/* ------------------------------------------------------------------ connections ------------- */

function NewConnectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<{ name: string; apiKey: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ id: string; name: string; apiKeyPrefix: string; apiKey: string }>(
        '/integrations/clients',
        { method: 'POST', body: { name } },
      ),
    onSuccess: (row) => {
      setCreated({ name: row.name, apiKey: row.apiKey });
      queryClient.invalidateQueries({ queryKey: ['integrations', 'clients'] });
    },
  });

  function close() {
    setCreated(null);
    setCopied(false);
    create.reset();
    onClose();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
    create.mutate(name);
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const base = API_BASE.startsWith('http')
    ? `${API_BASE}/integrations/lab`
    : `${window.location.origin}${API_BASE}/integrations/lab`;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? 'Connection created' : 'Connect a laboratory system'}
      wide
    >
      {!created ? (
        <form onSubmit={onSubmit}>
          <p className="muted">
            Register the laboratory information system (LIS) that processes this facility’s orders.
            It receives its own API key and only sees orders placed at your facility.
          </p>
          <TextField
            label="System name"
            name="name"
            required
            minLength={3}
            maxLength={120}
            placeholder="e.g. Central Laboratory LIS"
          />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create connection
            </Button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <Alert tone="warning" title="Copy this key now – it will not be shown again">
            Only a fingerprint of the key is stored. If it is lost, revoke this connection and
            create a new one. Share it with the laboratory vendor over a secure channel only.
          </Alert>
          <div>
            <label htmlFor="new-api-key">
              <strong>API key for {created.name}</strong>
            </label>
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                id="new-api-key"
                readOnly
                value={created.apiKey}
                onFocus={(e) => e.currentTarget.select()}
                style={{ flex: '1 1 260px', minWidth: 0, fontFamily: 'monospace' }}
              />
              <Button size="sm" onClick={copy}>
                {copied ? 'Copied ✓' : 'Copy key'}
              </Button>
            </div>
          </div>
          <div>
            <h3>Setup for the laboratory vendor</h3>
            <ul className="muted" style={{ overflowWrap: 'anywhere' }}>
              <li>
                Base URL: <code>{base}</code>
              </li>
              <li>
                Every request: <code>Authorization: Bearer &lt;API key&gt;</code>
              </li>
              <li>
                <code>GET /orders</code> – new orders as JSON, or <code>?format=hl7</code> for
                ORM^O01 messages
              </li>
              <li>
                <code>POST /orders/&#123;placerOrderNumber&#125;/receive</code> – confirm the order
                was taken (optional <code>fillerOrderNumber</code>)
              </li>
              <li>
                <code>POST /results</code> – ORU^R01 with{' '}
                <code>Content-Type: application/hl7-v2</code>; an HL7 ACK is returned
              </li>
              <li>
                <code>GET /ping</code> – connectivity check
              </li>
            </ul>
          </div>
          <div className="form-actions">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ConnectionsCard() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const clients = useQuery({
    queryKey: ['integrations', 'clients'],
    queryFn: () => api<{ items: IntegrationClient[] }>('/integrations/clients'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/integrations/clients/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations'] }),
  });

  function onRevoke(c: IntegrationClient) {
    if (
      window.confirm(
        `Revoke "${c.name}"? Its API key stops working immediately and it can no longer receive orders or send results.`,
      )
    ) {
      revoke.mutate(c.id);
    }
  }

  return (
    <Card
      title="Connected systems"
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          Connect laboratory
        </Button>
      }
    >
      <ErrorAlert error={revoke.error} />
      <QueryView query={clients}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState title="No laboratory systems connected">
              Connect your laboratory information system so orders and results flow automatically.
            </EmptyState>
          ) : (
            <Table caption="Connected laboratory systems">
              <thead>
                <tr>
                  <th>System</th>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Last contact</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted">Added {formatDate(c.createdAt)}</div>
                    </td>
                    <td>
                      <code>{c.apiKeyPrefix}…</code>
                    </td>
                    <td>
                      {c.isActive ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="neutral">Revoked</Badge>
                      )}
                    </td>
                    <td>{c.lastSeenAt ? formatDateTime(c.lastSeenAt) : 'Never'}</td>
                    <td>
                      {c.isActive && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={revoke.isPending && revoke.variables === c.id}
                          onClick={() => onRevoke(c)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <NewConnectionDialog open={creating} onClose={() => setCreating(false)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ review ------------------ */

function ReviewDialog({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [patientId, setPatientId] = useState('');
  const [note, setNote] = useState('');
  const detail = useQuery({
    queryKey: ['integrations', 'message', messageId],
    queryFn: () => api<IntegrationMessageDetail>(`/integrations/messages/${messageId}`),
  });
  const review = useMutation({
    mutationFn: (body: { action: 'FILE' | 'IGNORE'; patientId?: string; note: string }) =>
      api(`/integrations/messages/${messageId}/review`, { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      onClose();
    },
  });
  const noteOk = note.trim().length >= 5;

  return (
    <QueryView query={detail}>
      {(m) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (patientId && noteOk)
              review.mutate({ action: 'FILE', patientId, note: note.trim() });
          }}
        >
          <p className="muted">
            Received {formatDateTime(m.receivedAt)} · control ID <code>{m.controlId}</code>
            {m.error && <> · {m.error}</>}
          </p>
          <Grid min={260}>
            <section aria-labelledby="msg-identifiers">
              <h3 id="msg-identifiers">What the laboratory sent</h3>
              <dl className="dl">
                <div>
                  <dt>Name</dt>
                  <dd>{m.identifiers.name || '—'}</dd>
                </div>
                <div>
                  <dt>National ID</dt>
                  <dd>{m.identifiers.nationalId || '—'}</dd>
                </div>
                <div>
                  <dt>Date of birth</dt>
                  <dd>{hl7Date(m.identifiers.dateOfBirth)}</dd>
                </div>
                <div>
                  <dt>Order number</dt>
                  <dd>
                    <code>{m.identifiers.placerOrderNumber || '—'}</code>
                  </dd>
                </div>
              </dl>
            </section>
            <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend>
                <h3 style={{ margin: 0 }}>Patients at this facility with that national ID</h3>
              </legend>
              {m.candidates.length === 0 ? (
                <p className="muted">
                  No matching patient. If the message does not belong here, ignore it and contact
                  the laboratory.
                </p>
              ) : (
                <div className="stack" style={{ gap: '0.5rem' }}>
                  {m.candidates.map((c) => (
                    <label
                      key={c.id}
                      className="card"
                      style={{
                        display: 'flex',
                        gap: '0.6rem',
                        alignItems: 'flex-start',
                        padding: '0.6rem 0.75rem',
                        cursor: 'pointer',
                        margin: 0,
                      }}
                    >
                      <input
                        type="radio"
                        name="candidate"
                        value={c.id}
                        checked={patientId === c.id}
                        onChange={() => setPatientId(c.id)}
                        style={{ width: 'auto', minHeight: 'auto', marginTop: '0.25rem' }}
                      />
                      <span>
                        <strong>
                          {c.firstName} {c.lastName}
                        </strong>
                        <span className="muted" style={{ display: 'block' }}>
                          National ID {c.nationalId} · born {formatDate(c.dateOfBirth)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          </Grid>
          <TextAreaField
            label="Review note"
            name="note"
            required
            minLength={5}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            hint="Record how you confirmed the identity (e.g. called the laboratory about a date-of-birth typo)."
          />
          <ErrorAlert error={review.error} />
          <div className="form-actions" style={{ flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={!noteOk}
              loading={review.isPending && review.variables?.action === 'IGNORE'}
              onClick={() => review.mutate({ action: 'IGNORE', note: note.trim() })}
            >
              Ignore message
            </Button>
            <Button
              type="submit"
              disabled={!patientId || !noteOk}
              loading={review.isPending && review.variables?.action === 'FILE'}
            >
              File to selected patient
            </Button>
          </div>
        </form>
      )}
    </QueryView>
  );
}

/* ------------------------------------------------------------------ message log ------------- */

function MessagesCard() {
  const [status, setStatus] = useState<IntegrationMessageStatus | ''>('');
  const [clientId, setClientId] = useState('');
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const clients = useQuery({
    queryKey: ['integrations', 'clients'],
    queryFn: () => api<{ items: IntegrationClient[] }>('/integrations/clients'),
  });
  const messages = useQuery({
    queryKey: ['integrations', 'messages', status, clientId, page],
    queryFn: () =>
      api<MessagesPage>('/integrations/messages', {
        query: {
          status: status || undefined,
          clientId: clientId || undefined,
          page,
          pageSize: 20,
        },
      }),
  });
  const counts = messages.data?.counts ?? {};
  const needsReview = counts.NEEDS_REVIEW ?? 0;

  function filter(s: IntegrationMessageStatus | '') {
    setStatus(s);
    setPage(1);
  }

  return (
    <>
      {needsReview > 0 && (
        <Alert tone="warning" title={`${needsReview} message(s) held for review`}>
          These results have not been filed to any record yet. Review them promptly – a clinician
          may be waiting for them.
        </Alert>
      )}
      <div role="group" aria-label="Filter messages by status">
        <Grid min={150}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => filter(status === s ? '' : s)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'block',
                borderRadius: 12,
                outline: status === s ? '2px solid var(--primary)' : undefined,
                outlineOffset: 2,
              }}
            >
              <Stat
                label={STATUS_LABEL[s]}
                value={formatNumber(counts[s] ?? 0)}
                tone={s === 'NEEDS_REVIEW' && (counts[s] ?? 0) > 0 ? 'warning' : undefined}
                hint={status === s ? 'Filtered – click to clear' : 'Click to filter'}
              />
            </button>
          ))}
        </Grid>
      </div>
      <Card title="Message log">
        <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <SelectField
            label="Status"
            name="status"
            value={status}
            onChange={(e) => filter(e.target.value as IntegrationMessageStatus | '')}
            options={[
              { value: '', label: 'All statuses' },
              ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
            ]}
          />
          <SelectField
            label="System"
            name="clientId"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setPage(1);
            }}
            options={[
              { value: '', label: 'All systems' },
              ...(clients.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </div>
        <QueryView query={messages}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title="No messages">
                Messages appear here as soon as a connected laboratory sends results.
              </EmptyState>
            ) : (
              <>
                <Table caption="Laboratory messages">
                  <thead>
                    <tr>
                      <th>Received</th>
                      <th>System</th>
                      <th>Type</th>
                      <th>Control ID</th>
                      <th>Status</th>
                      <th>Results</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((m) => (
                      <tr key={m.id}>
                        <td>{formatDateTime(m.receivedAt)}</td>
                        <td>{m.clientName}</td>
                        <td>
                          <code>{m.messageType}</code>
                          <div className="muted">
                            {m.direction === 'INBOUND' ? 'Inbound' : 'Outbound'}
                          </div>
                        </td>
                        <td>
                          <code style={{ overflowWrap: 'anywhere' }}>{m.controlId}</code>
                        </td>
                        <td>
                          <MessageStatus status={m.status} />
                        </td>
                        <td>{m.resultCount}</td>
                        <td style={{ maxWidth: 300 }}>
                          {m.status === 'NEEDS_REVIEW' ? (
                            <div className="stack" style={{ gap: '0.35rem' }}>
                              {m.error && <span className="muted">{m.error}</span>}
                              <Button size="sm" onClick={() => setReviewing(m.id)}>
                                Review
                              </Button>
                            </div>
                          ) : (
                            <>
                              {m.error && <div className="muted">{m.error}</div>}
                              {m.reviewNote && (
                                <div>
                                  Review: {m.reviewNote}
                                  {m.reviewedAt && (
                                    <span className="muted"> ({formatDateTime(m.reviewedAt)})</span>
                                  )}
                                </div>
                              )}
                              {!m.error && !m.reviewNote && <span className="muted">—</span>}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
              </>
            )
          }
        </QueryView>
      </Card>
      <Dialog
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        title="Review held laboratory message"
        wide
      >
        {reviewing && <ReviewDialog messageId={reviewing} onClose={() => setReviewing(null)} />}
      </Dialog>
    </>
  );
}

export function IntegrationsPage() {
  return (
    <>
      <PageHeader
        title="Laboratory connections"
        subtitle="Laboratory systems that receive this facility’s orders and send results back (HL7 v2)"
      />
      <p className="muted">
        Results are filed automatically only when the order number, national ID and date of birth
        all match; anything else is held here for your review so it never lands in the wrong record.
      </p>
      <div className="stack">
        <ConnectionsCard />
        <MessagesCard />
      </div>
    </>
  );
}
