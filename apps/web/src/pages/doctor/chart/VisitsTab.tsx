import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Encounter, Page } from '../../../api/types';
import { useUser } from '../../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  enumOptions,
  ErrorAlert,
  formValues,
  Pagination,
  QueryView,
  SelectField,
  StatusBadge,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime, humanize } from '../../../format';
import { useChartMutation } from './shared';

const TYPES = ['OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'TELEHEALTH', 'HOME_VISIT'] as const;

function conflictMessage(err: unknown) {
  return err instanceof ApiError && err.status === 409 ? (
    <Alert tone="warning" title="This note changed since you opened it">
      {err.message} Reload the visit list to see the latest version before editing again.
    </Alert>
  ) : (
    <ErrorAlert error={err} />
  );
}

function NewEncounterForm({ patientId, onDone }: { patientId: string; onDone: () => void }) {
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/encounters', method: 'POST', body }),
    onDone,
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate(
      compact({
        type: v.type,
        reason: v.reason,
        notes: v.notes,
        startedAt: v.startedAt ? new Date(v.startedAt).toISOString() : undefined,
      }),
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <SelectField label="Visit type" name="type" required options={enumOptions(TYPES)} />
        <TextField label="Started" name="startedAt" type="datetime-local" hint="Defaults to now" />
      </div>
      <TextField label="Reason for visit" name="reason" required minLength={2} maxLength={500} />
      <TextAreaField
        label="Clinical note"
        name="notes"
        rows={8}
        maxLength={20000}
        hint="Saved as a draft until you sign it."
      />
      <ErrorAlert error={create.error} />
      <div className="form-actions">
        <Button type="submit" loading={create.isPending}>
          Save draft
        </Button>
      </div>
    </form>
  );
}

function EncounterItem({ patientId, e }: { patientId: string; e: Encounter }) {
  const user = useUser();
  const isAuthor = e.doctorId === user.id;
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(e.notes ?? '');
  const [addendumOpen, setAddendumOpen] = useState(false);

  const save = useChartMutation(
    patientId,
    () => ({ path: `/encounters/${e.id}`, method: 'PATCH', body: { version: e.version, notes } }),
    () => setEditing(false),
  );
  const sign = useChartMutation(patientId, () => ({
    path: `/encounters/${e.id}/sign`,
    method: 'POST',
    body: { version: e.version },
  }));
  const addendum = useChartMutation(
    patientId,
    (body: { reason: string; content: string }) => ({
      path: `/encounters/${e.id}/addenda`,
      method: 'POST',
      body,
    }),
    () => setAddendumOpen(false),
  );

  return (
    <li>
      <div className="row-between">
        <span className="timeline-date">
          {formatDateTime(e.startedAt)} · {humanize(e.type)}
        </span>
        <StatusBadge value={e.noteStatus} />
      </div>
      <h3>{e.reason}</h3>
      <div className="muted">
        {e.doctorName}
        {e.doctorSpecialty ? ` (${e.doctorSpecialty})` : ''} · {e.facilityName}
        {e.signedAt ? ` · signed ${formatDateTime(e.signedAt)}` : ''}
      </div>

      {editing ? (
        <div className="stack" style={{ marginTop: '0.5rem' }}>
          <TextAreaField
            label="Clinical note"
            rows={8}
            value={notes}
            onChange={(ev) => setNotes(ev.target.value)}
          />
          {conflictMessage(save.error)}
          <div className="row">
            <Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Save draft
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : e.notes ? (
        <div className="note">{e.notes}</div>
      ) : (
        <p className="muted">No note text.</p>
      )}

      {(e.diagnoses.length > 0 || e.prescriptions.length > 0) && (
        <div className="row" style={{ margin: '0.25rem 0' }}>
          {e.diagnoses.map((d) => (
            <span key={d.id}>
              <code>{d.icd10Code}</code> {d.description}
            </span>
          ))}
          {e.prescriptions.map((p) => (
            <span key={p.id} className="muted">
              ℞ {p.medication} {p.dosage}
            </span>
          ))}
        </div>
      )}

      {e.addenda.map((a) => (
        <div key={a.id} className="addendum">
          <strong>Addendum — {a.reason}</strong>
          <div className="muted">
            {a.authorName} · {formatDateTime(a.createdAt)}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{a.content}</div>
        </div>
      ))}

      {conflictMessage(sign.error)}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        {e.noteStatus === 'DRAFT' && isAuthor && !editing && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit draft
            </Button>
            <Button size="sm" loading={sign.isPending} onClick={() => sign.mutate(undefined)}>
              Sign note
            </Button>
          </>
        )}
        {e.noteStatus === 'DRAFT' && !isAuthor && (
          <span className="muted">Draft — only the author can edit or sign.</span>
        )}
        {e.noteStatus === 'SIGNED' && (
          <Button size="sm" variant="secondary" onClick={() => setAddendumOpen(true)}>
            Add addendum
          </Button>
        )}
      </div>

      <Dialog open={addendumOpen} onClose={() => setAddendumOpen(false)} title="Add addendum">
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const v = formValues(ev.currentTarget);
            addendum.mutate({ reason: v.reason ?? '', content: v.content ?? '' });
          }}
        >
          <p className="muted">
            Signed notes are never changed. An addendum is attached with your name and the time.
          </p>
          <TextField
            label="Reason for addendum"
            name="reason"
            required
            minLength={3}
            maxLength={300}
          />
          <TextAreaField
            label="Addendum"
            name="content"
            required
            minLength={2}
            maxLength={10000}
            rows={6}
          />
          <ErrorAlert error={addendum.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setAddendumOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={addendum.isPending}>
              Add addendum
            </Button>
          </div>
        </form>
      </Dialog>
    </li>
  );
}

export function VisitsTab({ patientId }: { patientId: string }) {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['patient', patientId, 'encounters', page],
    queryFn: () =>
      api<Page<Encounter>>(`/patients/${patientId}/encounters`, { query: { page, pageSize: 10 } }),
    placeholderData: keepPreviousData,
  });

  return (
    <Card
      title="Visits"
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={() => void list.refetch()}>
            Reload
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            New visit
          </Button>
        </>
      }
    >
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title="No visits recorded" />
          ) : (
            <>
              <ol className="timeline">
                {data.items.map((e) => (
                  // Re-mount on version change so local edit state never holds a stale version.
                  <EncounterItem key={`${e.id}-${e.version}`} patientId={patientId} e={e} />
                ))}
              </ol>
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New visit" wide>
        <NewEncounterForm patientId={patientId} onDone={() => setCreating(false)} />
      </Dialog>
    </Card>
  );
}
