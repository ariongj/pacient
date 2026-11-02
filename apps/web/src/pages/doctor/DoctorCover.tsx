import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { coverState, type Colleague, type CoverArrangement } from '../../api/cover';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  PageHeader,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';

const STATE_TONE = {
  CURRENT: 'success',
  UPCOMING: 'info',
  ENDED: 'neutral',
  CANCELLED: 'neutral',
} as const;

/** "2026-11-02T09:00" for a datetime-local input, in local time. */
function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CoverStateBadge({ a }: { a: CoverArrangement }) {
  const s = coverState(a);
  return (
    <Badge tone={STATE_TONE[s]}>
      {s === 'CURRENT' ? 'Active now' : s.charAt(0) + s.slice(1).toLowerCase()}
    </Badge>
  );
}

/**
 * Arrange cover. Doctors arrange it for themselves; a director chooses the absent doctor too
 * (`forDoctor`), from the same list of facility doctors.
 */
export function ArrangeCoverDialog({
  open,
  onClose,
  forDoctor = false,
}: {
  open: boolean;
  onClose: () => void;
  forDoctor?: boolean;
}) {
  const qc = useQueryClient();
  const colleagues = useQuery({
    queryKey: ['cover', 'colleagues'],
    queryFn: () => api<{ items: Colleague[] }>('/cover/colleagues').then((r) => r.items),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/cover', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cover'] });
      onClose();
    },
  });
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const inAWeek = new Date(now.getTime() + 7 * 86_400_000);
  const options = (colleagues.data ?? []).map((c) => ({
    value: c.id,
    label: c.specialty ? `${c.fullName} – ${c.specialty}` : c.fullName,
  }));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({
      ...(forDoctor ? { doctorId: v.doctorId } : {}),
      coverDoctorId: v.coverDoctorId,
      startsAt: new Date(v.startsAt!).toISOString(),
      endsAt: new Date(v.endsAt!).toISOString(),
      note: v.note || undefined,
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Arrange result cover" wide>
      <form onSubmit={onSubmit}>
        <p className="muted">
          While cover is active, the covering doctor receives the new, critical and corrected result
          alerts, sees the unreviewed results and can open the records of the patients concerned.
          Every access is recorded in the patient’s access log.
        </p>
        <div className="form-grid">
          {forDoctor && (
            <SelectField
              label="Doctor who will be away"
              name="doctorId"
              required
              placeholder={colleagues.isLoading ? 'Loading…' : 'Choose a doctor'}
              options={options}
            />
          )}
          <SelectField
            label="Covering doctor"
            name="coverDoctorId"
            required
            placeholder={colleagues.isLoading ? 'Loading…' : 'Choose a colleague'}
            options={options}
          />
          <TextField
            label="From"
            name="startsAt"
            type="datetime-local"
            required
            defaultValue={localInput(now)}
          />
          <TextField
            label="Until"
            name="endsAt"
            type="datetime-local"
            required
            defaultValue={localInput(inAWeek)}
            hint="At most 60 days"
          />
        </div>
        <TextField
          label="Note for the covering doctor"
          name="note"
          maxLength={300}
          placeholder="e.g. Annual leave – urgent messages too, please"
        />
        <ErrorAlert error={create.error ?? colleagues.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Arrange cover
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Table of arrangements; `show` picks which colleague column is shown. */
export function CoverTable({
  items,
  show,
  caption,
}: {
  items: CoverArrangement[];
  show: 'cover' | 'absent' | 'both';
  caption: string;
}) {
  const user = useUser();
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/cover/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cover'] }),
  });
  return (
    <>
      <ErrorAlert error={cancel.error} />
      <Table caption={caption}>
        <thead>
          <tr>
            {show !== 'cover' && <th>Away</th>}
            {show !== 'absent' && <th>Covered by</th>}
            <th>Period</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => {
            const state = coverState(a);
            const canCancel =
              (state === 'CURRENT' || state === 'UPCOMING') &&
              (user.role === 'DIRECTOR' || a.doctorId === user.id || a.createdById === user.id);
            return (
              <tr key={a.id}>
                {show !== 'cover' && (
                  <td>
                    <strong>{a.doctorName}</strong>
                  </td>
                )}
                {show !== 'absent' && (
                  <td>
                    <strong>{a.coverDoctorName}</strong>
                  </td>
                )}
                <td>
                  {formatDateTime(a.startsAt)} – {formatDateTime(a.endsAt)}
                  {a.note && <div className="muted">“{a.note}”</div>}
                </td>
                <td>
                  <CoverStateBadge a={a} />
                </td>
                <td>
                  {canCancel && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={cancel.isPending && cancel.variables === a.id}
                      onClick={() => {
                        if (window.confirm('Cancel this cover arrangement?')) cancel.mutate(a.id);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}

export function DoctorCover() {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['cover', 'mine'],
    queryFn: () => api<{ mine: CoverArrangement[]; coveringFor: CoverArrangement[] }>('/cover'),
  });
  return (
    <>
      <PageHeader
        title="Cover & absence"
        subtitle="Results never wait for someone who is away: arrange a colleague to cover them."
        actions={<Button onClick={() => setOpen(true)}>Arrange cover</Button>}
      />
      <QueryView query={query}>
        {(d) => (
          <div className="stack">
            <Card title="My absences">
              {d.mine.length === 0 ? (
                <EmptyState title="No cover arranged">
                  Going on leave or to a conference? Arrange cover so your results and critical
                  alerts reach a colleague.
                </EmptyState>
              ) : (
                <CoverTable items={d.mine} show="cover" caption="My absences" />
              )}
            </Card>
            <Card title="I’m covering for">
              {d.coveringFor.length === 0 ? (
                <EmptyState title="You are not covering for anyone" />
              ) : (
                <>
                  <p className="muted">
                    Their unreviewed results appear on your worklist under “Covering for”.
                  </p>
                  <CoverTable items={d.coveringFor} show="absent" caption="Covering for" />
                </>
              )}
            </Card>
          </div>
        )}
      </QueryView>
      <ArrangeCoverDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
