import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Appointment, AppointmentStatus, DirectoryEntry } from '../../api/types';
import {
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  TextField,
} from '../../components/ui';
import { humanize } from '../../format';
import { useAppointmentStatus } from './appointmentActions';
import { AppointmentTable } from './AppointmentTable';
import { BookAppointmentDialog } from './BookAppointmentDialog';

const STATUSES: AppointmentStatus[] = [
  'REQUESTED',
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
];

const isoDay = (d: Date) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

export function ReceptionAppointments() {
  const [from, setFrom] = useState(isoDay(new Date()));
  const [to, setTo] = useState(isoDay(new Date(Date.now() + 6 * 86_400_000)));
  const [status, setStatus] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [booking, setBooking] = useState(false);
  const mutation = useAppointmentStatus();

  const fromIso = new Date(`${from}T00:00:00`).toISOString();
  const toIso = new Date(`${to}T23:59:59.999`).toISOString();
  const doctors = useQuery({
    queryKey: ['directory', 'DOCTOR'],
    queryFn: () => api<{ items: DirectoryEntry[] }>('/directory', { query: { role: 'DOCTOR' } }),
  });
  const q = useQuery({
    queryKey: ['appointments', 'reception', 'range', fromIso, toIso, status],
    queryFn: () =>
      api<{ items: Appointment[] }>('/appointments', {
        query: { from: fromIso, to: toIso, status: status || undefined },
      }),
    enabled: from <= to,
  });

  const filtered = (q.data?.items ?? [])
    .filter((a) => !doctorId || a.doctorId === doctorId)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const days = new Map<string, Appointment[]>();
  for (const a of filtered) {
    const key = isoDay(new Date(a.scheduledAt));
    days.set(key, [...(days.get(key) ?? []), a]);
  }
  const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <PageHeader
        title="Appointments"
        subtitle="Facility schedule across all doctors"
        actions={<Button onClick={() => setBooking(true)}>Book appointment</Button>}
      />
      <Card>
        <div className="form-grid">
          <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="All statuses"
            options={STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
          />
          <SelectField
            label="Doctor"
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            placeholder="All doctors"
            options={(doctors.data?.items ?? []).map((d) => ({ value: d.id, label: d.fullName }))}
          />
        </div>
        {from > to && <p className="error-text">The start date must be before the end date.</p>}
      </Card>
      <ErrorAlert error={mutation.error} />
      <div className="stack" style={{ marginTop: '1rem' }}>
        <QueryView query={q}>
          {() =>
            days.size ? (
              [...days.entries()].map(([day, items]) => (
                <Card key={day} title={`${dayFmt.format(new Date(`${day}T12:00:00`))} · ${items.length}`}>
                  <AppointmentTable caption={`Appointments on ${day}`} items={items} mutation={mutation} />
                </Card>
              ))
            ) : (
              <Card>
                <EmptyState title="No appointments in this period" />
              </Card>
            )
          }
        </QueryView>
      </div>
      <BookAppointmentDialog open={booking} onClose={() => setBooking(false)} />
    </>
  );
}
