import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Appointment } from '../../api/types';
import { AnnouncementsCard } from '../../components/Announcements';
import {
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  Stat,
  StatusBadge,
  Table,
} from '../../components/ui';
import { formatDateTime, formatFullDate } from '../../format';
import { AppointmentActions, useAppointmentStatus } from './appointmentActions';
import { AppointmentTable } from './AppointmentTable';
import { BookAppointmentDialog } from './BookAppointmentDialog';
import { t } from '../../i18n';

const byTime = (a: Appointment, b: Appointment) => a.scheduledAt.localeCompare(b.scheduledAt);

export function ReceptionToday() {
  const [booking, setBooking] = useState(false);
  const mutation = useAppointmentStatus();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000 - 1);

  const today = useQuery({
    queryKey: ['appointments', 'reception', 'today', start.toISOString()],
    queryFn: () =>
      api<{ items: Appointment[] }>('/appointments', {
        query: { from: start.toISOString(), to: end.toISOString() },
      }),
    refetchInterval: 60_000,
  });
  const pending = useQuery({
    queryKey: ['appointments', 'reception', 'requested'],
    queryFn: () =>
      api<{ items: Appointment[] }>('/appointments', {
        query: { status: 'REQUESTED', from: start.toISOString() },
      }),
  });

  const items = [...(today.data?.items ?? [])].sort(byTime);
  const count = (s: Appointment['status']) => items.filter((a) => a.status === s).length;
  const active = items.filter((a) => a.status !== 'CANCELLED');

  return (
    <>
      <PageHeader
        title={t('Front desk – today')}
        subtitle={formatFullDate(new Date())}
        actions={<Button onClick={() => setBooking(true)}>{t('Book appointment')}</Button>}
      />
      <div className="stack">
        <div className="kpi-grid">
          <Stat label={t('Booked today')} value={active.length} />
          <Stat
            label={t('Checked in / waiting')}
            value={count('CHECKED_IN')}
            tone={count('CHECKED_IN') > 0 ? 'info' : undefined}
          />
          <Stat label={t('Completed')} value={count('COMPLETED')} tone="success" />
          <Stat
            label={t('No-shows')}
            value={count('NO_SHOW')}
            tone={count('NO_SHOW') > 0 ? 'danger' : undefined}
          />
          <Stat
            label={t('Requests to confirm')}
            value={pending.data?.items.length ?? 0}
            tone={(pending.data?.items.length ?? 0) > 0 ? 'warning' : undefined}
          />
        </div>

        <ErrorAlert error={mutation.error} />

        <Card
          title={t("Today's queue")}
          actions={<span className="muted">{t('Refreshes every minute')}</span>}
        >
          <QueryView query={today}>
            {() =>
              active.length ? (
                <AppointmentTable
                  caption={t("Today's appointments")}
                  items={active}
                  mutation={mutation}
                />
              ) : (
                <EmptyState title={t('No appointments today')} />
              )
            }
          </QueryView>
        </Card>

        <Card title={t('Appointment requests awaiting confirmation')}>
          <QueryView query={pending}>
            {(d) =>
              d.items.length ? (
                <Table caption={t('Pending appointment requests')}>
                  <thead>
                    <tr>
                      <th>{t('When')}</th>
                      <th>{t('Patient')}</th>
                      <th>{t('Doctor')}</th>
                      <th>{t('Reason')}</th>
                      <th>{t('Status')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...d.items].sort(byTime).map((a) => (
                      <tr key={a.id}>
                        <td>{formatDateTime(a.scheduledAt)}</td>
                        <td>
                          <strong>{a.patientName}</strong>
                        </td>
                        <td>{a.doctorName}</td>
                        <td>{a.reason}</td>
                        <td>
                          <StatusBadge value={a.status} />
                        </td>
                        <td>
                          <AppointmentActions appointment={a} mutation={mutation} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title={t('No requests waiting')} />
              )
            }
          </QueryView>
        </Card>
        <AnnouncementsCard />
      </div>
      <BookAppointmentDialog open={booking} onClose={() => setBooking(false)} />
    </>
  );
}
