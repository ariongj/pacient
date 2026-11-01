import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { Announcement } from '../../api/types';
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

const AUDIENCE_LABEL: Record<Announcement['audience'], string> = {
  EVERYONE: 'Everyone',
  STAFF: 'Staff only',
  PATIENTS: 'Patients only',
};

const isActive = (a: Announcement) => !a.expiresAt || new Date(a.expiresAt).getTime() > Date.now();

function NewAnnouncementForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: object) => api('/announcements', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['announcements'] });
      onDone();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const expires = String(f.get('expiresAt') ?? '');
    mutation.mutate({
      title: String(f.get('title') ?? '').trim(),
      body: String(f.get('body') ?? '').trim(),
      audience: f.get('audience'),
      ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
    });
  }
  return (
    <form onSubmit={onSubmit}>
      <TextField label="Title" name="title" required minLength={3} maxLength={200} />
      <TextAreaField label="Message" name="body" required minLength={3} maxLength={5000} rows={6} />
      <div className="form-grid">
        <SelectField
          label="Audience"
          name="audience"
          required
          defaultValue="EVERYONE"
          options={(Object.keys(AUDIENCE_LABEL) as Announcement['audience'][]).map((a) => ({
            value: a,
            label: AUDIENCE_LABEL[a],
          }))}
        />
        <TextField
          label="Expires (optional)"
          name="expiresAt"
          type="datetime-local"
          hint="Leave empty to keep it until withdrawn."
        />
      </div>
      <p className="muted">
        Do not include personal or clinical information about any patient in announcements.
      </p>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          Publish
        </Button>
      </div>
    </form>
  );
}

export function AnnouncementsManagePage() {
  const user = useUser();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['announcements', 'manage'],
    queryFn: () => api<{ items: Announcement[] }>('/announcements/manage'),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/announcements/${id}/withdraw`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['announcements'] }),
  });

  const ministry = user.role === 'MINISTRY';
  return (
    <>
      <PageHeader
        title="Announcements"
        subtitle={
          ministry
            ? 'National announcements from the Ministry of Health'
            : `Announcements for ${user.facility?.name ?? 'your facility'}`
        }
        actions={<Button onClick={() => setOpen(true)}>New announcement</Button>}
      />
      <Alert tone="info">
        {ministry
          ? 'Announcements published here are shown nationally to every facility, to staff, patients or both.'
          : 'Announcements published here are shown only to staff and/or registered patients of your facility.'}
      </Alert>
      <ErrorAlert error={withdraw.error} />
      <Card>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <ul className="list">
                {d.items.map((a) => {
                  const active = isActive(a);
                  return (
                    <li key={a.id} className="announcement">
                      <div className="row-between">
                        <strong>{a.title}</strong>
                        <span className="row">
                          <Badge tone="info">{AUDIENCE_LABEL[a.audience]}</Badge>
                          {active ? (
                            <Badge tone="success">Active</Badge>
                          ) : (
                            <Badge tone="neutral">Expired or withdrawn</Badge>
                          )}
                        </span>
                      </div>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p>
                      <div className="row-between">
                        <span className="muted" style={{ fontSize: '0.85rem' }}>
                          {a.authorName} · published {formatDateTime(a.publishedAt)}
                          {a.expiresAt
                            ? ` · ${active ? 'expires' : 'ended'} ${formatDateTime(a.expiresAt)}`
                            : ''}
                        </span>
                        {active && (
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={withdraw.isPending && withdraw.variables === a.id}
                            onClick={() => {
                              if (
                                window.confirm(`Withdraw “${a.title}”? It will no longer be shown.`)
                              ) {
                                withdraw.mutate(a.id);
                              }
                            }}
                          >
                            Withdraw
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="No announcements yet" />
            )
          }
        </QueryView>
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title="New announcement" wide>
        <NewAnnouncementForm onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
