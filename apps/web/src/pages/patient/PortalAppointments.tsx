import { t } from '../../i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
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
import { slotTime, useBookableDoctors, type Slot } from '../../api/scheduling';
import { Badge } from '../../components/ui';
import { formatDateTime, formatDayHeading } from '../../format';
import { SlotPicker } from '../reception/BookAppointmentDialog';
import { canJoinNow, type AppointmentMode, type AppointmentWithMode } from '../../api/telemedicine';
import { JoinVideoLink, ModeChoice } from '../video/VideoBits';
import { useCareTeam } from './shared';

/** Patients may cancel online until 2 hours before (the server enforces the same rule). */
const CANCEL_NOTICE_MS = 2 * 3_600_000;

/** Book a published free time: doctor → day and time → reason → confirmed immediately. */
function BookOnline({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const doctors = useBookableDoctors();
  const [doctorId, setDoctorId] = useState('');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<AppointmentMode>('IN_PERSON');
  const book = useMutation({
    mutationFn: () =>
      api('/scheduling/book', {
        method: 'POST',
        body: { doctorId, start: slot!.start, reason, mode },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
      void queryClient.invalidateQueries({ queryKey: ['scheduling'] });
      onDone();
    },
    onError: () => {
      // The time may have just been taken: refresh the free times.
      void queryClient.invalidateQueries({ queryKey: ['scheduling', 'slots'] });
      setSlot(null);
    },
  });

  return (
    <QueryView query={doctors}>
      {(list) => {
        const bookable = list.filter((d) => d.portalBookable);
        if (!bookable.length)
          return (
            <Alert tone="info">
              {t(
                'No doctor of your facility offers online booking yet. Send a request to your doctor or call the facility.',
              )}
            </Alert>
          );
        const doctor = bookable.find((d) => d.id === doctorId);
        return (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (slot && reason.trim().length >= 2) book.mutate();
            }}
          >
            <SelectField
              label={t('Doctor')}
              required
              value={doctorId}
              onChange={(e) => {
                setDoctorId(e.target.value);
                setSlot(null);
              }}
              placeholder={t('Choose a doctor')}
              options={bookable.map((d) => ({
                value: d.id,
                label: `${d.fullName}${d.specialty ? ` — ${d.specialty}` : ''}${
                  d.inCareTeam ? ` · ${t('your care team')}` : ''
                }`,
              }))}
            />
            {doctor && (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  {doctor.facilityName}
                </p>
                <SlotPicker doctorId={doctor.id} patientMode value={slot} onChange={setSlot} />
              </>
            )}
            {slot && (
              <>
                <Alert tone="info" title={t('Your choice')}>
                  {formatDayHeading(new Date(slot.start))} · {slotTime(slot.start)} ·{' '}
                  {doctor?.fullName}
                </Alert>
                <ModeChoice value={mode} onChange={setMode} />
                <TextAreaField
                  label={t('Reason for the visit')}
                  required
                  minLength={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  hint={t('Do not use this for urgent problems — call 112 in an emergency.')}
                />
              </>
            )}
            <ErrorAlert error={book.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={onCancel}>
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                loading={book.isPending}
                disabled={!slot || reason.trim().length < 2}
              >
                {t('Book this time')}
              </Button>
            </div>
          </form>
        );
      }}
    </QueryView>
  );
}

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
            {t(
              'You do not have a doctor in your care team yet. Contact your family medicine centre.',
            )}
          </Alert>
        ) : (
          <form onSubmit={onSubmit}>
            <SelectField
              label={t('Doctor')}
              name="doctorId"
              required
              options={team.items.map((m) => ({
                value: m.doctorId,
                label: `${m.fullName}${m.specialty ? ` — ${m.specialty}` : ''}`,
              }))}
            />
            <TextField
              label={t('Preferred date and time')}
              name="scheduledAt"
              type="datetime-local"
              min={min}
              required
            />
            <TextAreaField
              label={t('Reason for the visit')}
              name="reason"
              required
              minLength={2}
              maxLength={500}
              hint={t('Do not use this for urgent problems — call 112 in an emergency.')}
            />
            <ErrorAlert error={mutation.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={onDone}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                {t('Send request')}
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
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const q = useQuery({
    queryKey: ['appointments', 'all'],
    queryFn: () => api<{ items: AppointmentWithMode[] }>('/appointments'),
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
        title={t('Appointments')}
        subtitle={t('Book a free time online, or send a request that your doctor confirms.')}
        actions={
          <span className="row">
            <Button
              onClick={() => {
                setBooked(false);
                setBooking(true);
              }}
            >
              {t('Book appointment')}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              {t('Request appointment')}
            </Button>
          </span>
        }
      />
      {booked && (
        <Alert tone="success" title={t('Your appointment is booked')}>
          {t('You will get a reminder the day before.')}
        </Alert>
      )}
      <ErrorAlert error={cancel.error} />
      <QueryView query={q}>
        {(d) => {
          const upcoming = d.items.filter((a) => new Date(a.scheduledAt).getTime() >= now);
          const past = d.items.filter((a) => new Date(a.scheduledAt).getTime() < now).reverse();
          const rows = (items: AppointmentWithMode[], allowCancel: boolean) => (
            <Table caption={t('Appointments')}>
              <thead>
                <tr>
                  <th>{t('When')}</th>
                  <th>{t('Doctor')}</th>
                  <th>{t('Where')}</th>
                  <th>{t('Reason')}</th>
                  <th>{t('Status')}</th>
                  {allowCancel && (
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
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
                      <span className="row" style={{ gap: '0.35rem' }}>
                        <StatusBadge value={a.status} />
                        {a.bookedVia === 'PORTAL' && (
                          <Badge tone="info">{t('Booked online')}</Badge>
                        )}
                        {a.mode === 'VIDEO' && <Badge tone="info">{t('Video visit')}</Badge>}
                      </span>
                      {canJoinNow(a, now) && <JoinVideoLink appointmentId={a.id} />}
                    </td>
                    {allowCancel && (
                      <td>
                        {a.status === 'CONFIRMED' &&
                        new Date(a.scheduledAt).getTime() - now < CANCEL_NOTICE_MS ? (
                          <small className="muted">{t('Call the facility to cancel')}</small>
                        ) : (
                          (a.status === 'REQUESTED' || a.status === 'CONFIRMED') && (
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={cancel.isPending && cancel.variables === a.id}
                              onClick={() => {
                                if (window.confirm(t('Cancel this appointment?')))
                                  cancel.mutate(a.id);
                              }}
                            >
                              {t('Cancel')}
                            </Button>
                          )
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
              <Card title={t('Upcoming')}>
                {upcoming.length ? (
                  rows(upcoming, true)
                ) : (
                  <EmptyState title={t('No upcoming appointments')} />
                )}
              </Card>
              <Card title={t('Past')}>
                {past.length ? rows(past, false) : <EmptyState title={t('No past appointments')} />}
              </Card>
            </div>
          );
        }}
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Request an appointment')}>
        <RequestForm onDone={() => setOpen(false)} />
      </Dialog>
      <Dialog
        open={booking}
        onClose={() => setBooking(false)}
        title={t('Book an appointment')}
        wide
      >
        <BookOnline
          onCancel={() => setBooking(false)}
          onDone={() => {
            setBooking(false);
            setBooked(true);
          }}
        />
      </Dialog>
    </>
  );
}
