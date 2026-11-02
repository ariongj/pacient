import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Appointment } from '../../api/types';
import {
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  StatusBadge,
  Table,
  TextField,
} from '../../components/ui';
import { formatTime } from '../../format';
import { todayInput, useCheckIn, useDaySchedule } from './appointments';
import { t, tn } from '../../i18n';

/** The facility's clinic schedule for one day, grouped by doctor, with check-in. */
export function NurseSchedule() {
  const [day, setDay] = useState(todayInput());
  const schedule = useDaySchedule(day);
  const checkIn = useCheckIn();

  return (
    <>
      <PageHeader
        title={t('Clinic schedule')}
        subtitle={t('All clinics at your facility. Check patients in when they arrive.')}
      />
      <Card>
        <div className="search-bar">
          <TextField
            label={t('Day')}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value || todayInput())}
          />
        </div>
        <ErrorAlert error={checkIn.error} />
        <QueryView query={schedule}>
          {(d) => {
            const byDoctor = new Map<string, Appointment[]>();
            for (const a of d.items) {
              if (a.status === 'CANCELLED') continue;
              byDoctor.set(a.doctorName, [...(byDoctor.get(a.doctorName) ?? []), a]);
            }
            if (byDoctor.size === 0) return <EmptyState title={t('No appointments on this day')} />;
            return (
              <div className="stack">
                {[...byDoctor.entries()]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([doctor, items]) => (
                    <section key={doctor}>
                      <h2 style={{ margin: '0.5rem 0' }}>
                        {doctor}{' '}
                        <span className="muted" style={{ fontWeight: 400, fontSize: '0.9rem' }}>
                          {items[0]?.doctorSpecialty ?? ''} ·{' '}
                          {tn(items.length, '{count} appointment', '{count} appointments')}
                        </span>
                      </h2>
                      <Table caption={t('Appointments with {doctor}', { doctor })}>
                        <thead>
                          <tr>
                            <th>{t('Time')}</th>
                            <th>{t('Patient')}</th>
                            <th>{t('Reason')}</th>
                            <th>{t('Status')}</th>
                            <th>
                              <span className="sr-only">{t('Actions')}</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((a) => (
                            <tr key={a.id}>
                              <td className="mono">
                                {formatTime(a.scheduledAt)}
                                <div className="muted">
                                  {t('{minutes} min', { minutes: a.durationMinutes })}
                                </div>
                              </td>
                              <td>
                                <Link to={`/nurse/patients/${a.patientId}`}>{a.patientName}</Link>
                              </td>
                              <td>{a.reason}</td>
                              <td>
                                <StatusBadge value={a.status} />
                              </td>
                              <td>
                                {a.status === 'CONFIRMED' && (
                                  <Button
                                    size="sm"
                                    loading={checkIn.isPending && checkIn.variables === a.id}
                                    onClick={() => checkIn.mutate(a.id)}
                                  >
                                    {t('Check in')}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
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
