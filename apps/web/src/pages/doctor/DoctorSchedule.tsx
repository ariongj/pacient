import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Appointment, AppointmentStatus } from '../../api/types';
import {
  Button,
  Card,
  EmptyState,
  enumOptions,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  StatusBadge,
  TextField,
} from '../../components/ui';
import { formatDate, formatTime } from '../../format';

/** Mirrors the server's allowed transitions for doctors. */
const ACTIONS: Partial<
  Record<
    AppointmentStatus,
    { to: AppointmentStatus; label: string; variant: 'primary' | 'secondary' | 'ghost' }[]
  >
> = {
  REQUESTED: [
    { to: 'CONFIRMED', label: 'Confirm', variant: 'primary' },
    { to: 'CANCELLED', label: 'Decline', variant: 'ghost' },
  ],
  CONFIRMED: [
    { to: 'COMPLETED', label: 'Complete', variant: 'primary' },
    { to: 'NO_SHOW', label: 'No-show', variant: 'secondary' },
    { to: 'CANCELLED', label: 'Cancel', variant: 'ghost' },
  ],
};

const toDateInput = (d: Date) => d.toISOString().slice(0, 10);

export function DoctorSchedule() {
  const qc = useQueryClient();
  const [from, setFrom] = useState(() => toDateInput(new Date()));
  const [to, setTo] = useState(() => toDateInput(new Date(Date.now() + 14 * 86_400_000)));
  const [status, setStatus] = useState('');

  const range = useMemo(
    () => ({
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: new Date(`${to}T23:59:59`).toISOString(),
    }),
    [from, to],
  );

  const list = useQuery({
    queryKey: ['appointments', 'schedule', range.from, range.to, status],
    queryFn: () =>
      api<{ items: Appointment[] }>('/appointments', { query: { ...range, status } }).then(
        (r) => r.items,
      ),
    placeholderData: keepPreviousData,
  });

  const change = useMutation({
    mutationFn: ({ id, to: next }: { id: string; to: AppointmentStatus }) =>
      api(`/appointments/${id}/status`, { method: 'PATCH', body: { status: next } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['appointments'] }),
  });

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle="Your appointments. Requests from patients need confirmation."
      />
      <Card>
        <div className="search-bar">
          <TextField
            label="From"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="All statuses"
            options={enumOptions(['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])}
          />
        </div>
        <ErrorAlert error={change.error} />
        <QueryView query={list}>
          {(items) => {
            if (items.length === 0) return <EmptyState title="No appointments in this period" />;
            const days = new Map<string, Appointment[]>();
            for (const a of items) {
              const key = new Date(a.scheduledAt).toDateString();
              days.set(key, [...(days.get(key) ?? []), a]);
            }
            return (
              <div className="stack">
                {[...days.entries()].map(([key, appts]) => (
                  <section key={key}>
                    <h2 style={{ marginBottom: '0.5rem' }}>{formatDate(appts[0]!.scheduledAt)}</h2>
                    <ul className="list">
                      {appts.map((a) => (
                        <li key={a.id} className="row-between">
                          <span>
                            <strong>{formatTime(a.scheduledAt)}</strong>{' '}
                            <span className="muted">({a.durationMinutes} min)</span> ·{' '}
                            <Link to={`/doctor/patients/${a.patientId}`}>{a.patientName}</Link> ·{' '}
                            {a.reason}
                          </span>
                          <span className="row">
                            <StatusBadge value={a.status} />
                            {(ACTIONS[a.status] ?? []).map((act) => (
                              <Button
                                key={act.to}
                                size="sm"
                                variant={act.variant}
                                disabled={change.isPending}
                                loading={
                                  change.isPending &&
                                  change.variables?.id === a.id &&
                                  change.variables.to === act.to
                                }
                                onClick={() => change.mutate({ id: a.id, to: act.to })}
                                aria-label={`${act.label} appointment with ${a.patientName} at ${formatTime(a.scheduledAt)}`}
                              >
                                {act.label}
                              </Button>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            );
          }}
        </QueryView>
      </Card>
    </>
  );
}
