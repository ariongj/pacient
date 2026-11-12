import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import {
  canJoinNow,
  setAppointmentMode,
  useWaitingPatients,
  type AppointmentMode,
  type AppointmentWithMode as Appointment,
} from '../../api/telemedicine';
import { JoinVideoLink } from '../video/VideoBits';
import type { AppointmentStatus } from '../../api/types';
import {
  Badge,
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
import { t } from '../../i18n';

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
  // The patient has arrived (checked in at the front desk): the visit can be closed from here.
  CHECKED_IN: [
    { to: 'COMPLETED', label: 'Complete', variant: 'primary' },
    { to: 'NO_SHOW', label: 'No-show', variant: 'secondary' },
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

  const waiting = useWaitingPatients();
  const refetchWaiting = waiting.refetch;
  // A patient entering a waiting room wakes this page through the live 'video.signal' event.
  useEffect(() => {
    const onSignal = () => void refetchWaiting();
    window.addEventListener('pacient:video-signal', onSignal);
    return () => window.removeEventListener('pacient:video-signal', onSignal);
  }, [refetchWaiting]);
  const waitingIds = new Set((waiting.data ?? []).map((w) => w.appointmentId));
  const switchMode = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: AppointmentMode }) =>
      setAppointmentMode(id, mode),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['appointments'] }),
  });

  const change = useMutation({
    mutationFn: ({ id, to: next }: { id: string; to: AppointmentStatus }) =>
      api(`/appointments/${id}/status`, { method: 'PATCH', body: { status: next } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['appointments'] }),
  });

  return (
    <>
      <PageHeader
        title={t('Schedule')}
        subtitle={t('Your appointments. Requests from patients need confirmation.')}
        actions={
          <Link to="/doctor/availability" className="btn btn-secondary btn-md">
            {t('My consulting hours')}
          </Link>
        }
      />
      {(waiting.data ?? []).length > 0 && (
        <Card title={t('Patients in the video waiting room')}>
          <ul className="list">
            {waiting.data!.map((w) => (
              <li key={w.sessionId} className="row-between">
                <span>
                  <strong>{formatTime(w.scheduledAt)}</strong> · {w.patientName}
                </span>
                <JoinVideoLink appointmentId={w.appointmentId} waiting />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <div className="search-bar">
          <TextField
            label={t('From')}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label={t('To')}
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
          <SelectField
            label={t('Status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder={t('All statuses')}
            options={enumOptions(['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])}
          />
        </div>
        <ErrorAlert error={change.error ?? switchMode.error} />
        <QueryView query={list}>
          {(items) => {
            if (items.length === 0)
              return <EmptyState title={t('No appointments in this period')} />;
            const online = items.filter((a) => a.bookedVia === 'PORTAL').length;
            const noShows = items.filter((a) => a.status === 'NO_SHOW').length;
            const ended = items.filter((a) =>
              ['COMPLETED', 'NO_SHOW', 'CHECKED_IN'].includes(a.status),
            ).length;
            const days = new Map<string, Appointment[]>();
            for (const a of items) {
              const key = new Date(a.scheduledAt).toDateString();
              days.set(key, [...(days.get(key) ?? []), a]);
            }
            return (
              <div className="stack">
                <p className="muted" style={{ margin: 0 }}>
                  {t('{count} appointments · {online} booked online · {noShows} no-shows', {
                    count: items.length,
                    online,
                    noShows,
                  })}
                  {ended > 0 &&
                    ` · ${t('no-show rate {pct}%', { pct: Math.round((noShows / ended) * 100) })}`}
                </p>
                {[...days.entries()].map(([key, appts]) => (
                  <section key={key}>
                    <h2 style={{ marginBottom: '0.5rem' }}>{formatDate(appts[0]!.scheduledAt)}</h2>
                    <ul className="list">
                      {appts.map((a) => (
                        <li key={a.id} className="row-between">
                          <span>
                            <strong>{formatTime(a.scheduledAt)}</strong>{' '}
                            <span className="muted">
                              ({t('{m} min', { m: a.durationMinutes })})
                            </span>{' '}
                            · <Link to={`/doctor/patients/${a.patientId}`}>{a.patientName}</Link> ·{' '}
                            {a.reason}
                          </span>
                          <span className="row">
                            {a.bookedVia === 'PORTAL' && (
                              <Badge tone="info">{t('Booked online')}</Badge>
                            )}
                            {a.mode === 'VIDEO' && <Badge tone="info">{t('Video visit')}</Badge>}
                            <StatusBadge value={a.status} />
                            {canJoinNow(a) && (
                              <JoinVideoLink appointmentId={a.id} waiting={waitingIds.has(a.id)} />
                            )}
                            {(a.status === 'REQUESTED' || a.status === 'CONFIRMED') && (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={switchMode.isPending && switchMode.variables?.id === a.id}
                                onClick={() =>
                                  switchMode.mutate({
                                    id: a.id,
                                    mode: a.mode === 'VIDEO' ? 'IN_PERSON' : 'VIDEO',
                                  })
                                }
                              >
                                {a.mode === 'VIDEO' ? t('Make in person') : t('Make video visit')}
                              </Button>
                            )}
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
                                aria-label={t('{action} appointment with {name} at {time}', {
                                  action: t(act.label),
                                  name: a.patientName,
                                  time: formatTime(a.scheduledAt),
                                })}
                              >
                                {t(act.label)}
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
