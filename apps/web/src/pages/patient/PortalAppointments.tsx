import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { Appointment } from '../../api/types';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { useCareTeam } from './shared';

function RequestForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const careTeam = useCareTeam();
  const mutation = useMutation({
    mutationFn: (body: object) => api('/appointments', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      onDone();
    },
  });
  // Earliest bookable slot: tomorrow, in the local time zone, for the datetime-local input.
  const min = new Date(Date.now() + 86_400_000 - new Date().getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    mutation.mutate({
      doctorId: f.get('doctorId'),
      scheduledAt: new Date(String(f.get('scheduledAt'))).toISOString(),
      reason: f.get('reason'),
    });
  }

  return (
    <QueryView query={careTeam}>
      {(team) =>
        team.items.length === 0 ? (
          <Alert tone="warning">
            You do not have a doctor in your care team yet. Contact your family medicine centre.
          </Alert>
        ) : (
          <form onSubmit={onSubmit}>
            <SelectField
              label="Doctor"
              name="doctorId"
              required
              options={team.items.map((m) => ({
                value: m.doctorId,
                label: `${m.fullName}${m.specialty ? ` — ${m.specialty}` : ''}`,
              }))}
            />
            <TextField
              label="Preferred date and time"
              name="scheduledAt"
              type="datetime-local"
              min={min}
              required
            />
            <TextAreaField
              label="Reason for the visit"
              name="reason"
              required
              minLength={2}
              maxLength={500}
              hint="Do not use this for urgent problems — call 112 in an emergency."
            />
            <ErrorAlert error={mutation.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={onDone}>
                Cancel
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                Send request
              </Button>
            </div>
          </form>
        )
      }
    </QueryView>
  );
}

export function PortalAppointments() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['appointments', 'all'],
    queryFn: () => api<{ items: Appointment[] }>('/appointments'),
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api(`/appointments/${id}/status`, { method: 'PATCH', body: { status: 'CANCELLED' } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });

  const now = Date.now();
  return (
    <>
      <PageHeader
        title="Appointments"
        subtitle="Requests are confirmed by your doctor."
        actions={<Button onClick={() => setOpen(true)}>Request appointment</Button>}
      />
      <ErrorAlert error={cancel.error} />
      <QueryView query={q}>
        {(d) => {
          const upcoming = d.items.filter((a) => new Date(a.scheduledAt).getTime() >= now);
          const past = d.items.filter((a) => new Date(a.scheduledAt).getTime() < now).reverse();
          const rows = (items: Appointment[], allowCancel: boolean) => (
            <Table caption="Appointments">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Doctor</th>
                  <th>Where</th>
                  <th>Reason</th>
                  <th>Status</th>
                  {allowCancel && (
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>{formatDateTime(a.scheduledAt)}</td>
                    <td>{a.doctorName}</td>
                    <td>{a.facilityName}</td>
                    <td>{a.reason}</td>
                    <td>
                      <StatusBadge value={a.status} />
                    </td>
                    {allowCancel && (
                      <td>
                        {(a.status === 'REQUESTED' || a.status === 'CONFIRMED') && (
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={cancel.isPending && cancel.variables === a.id}
                            onClick={() => {
                              if (window.confirm('Cancel this appointment?')) cancel.mutate(a.id);
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          );
          return (
            <div className="stack">
              <Card title="Upcoming">
                {upcoming.length ? (
                  rows(upcoming, true)
                ) : (
                  <EmptyState title="No upcoming appointments" />
                )}
              </Card>
              <Card title="Past">
                {past.length ? rows(past, false) : <EmptyState title="No past appointments" />}
              </Card>
            </div>
          );
        }}
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title="Request an appointment">
        <RequestForm onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
