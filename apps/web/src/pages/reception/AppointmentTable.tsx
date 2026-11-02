import type { Appointment } from '../../api/types';
import { StatusBadge, Table } from '../../components/ui';
import { formatTime } from '../../format';
import { AppointmentActions, type useAppointmentStatus } from './appointmentActions';

export function AppointmentTable({
  caption,
  items,
  mutation,
}: {
  caption: string;
  items: Appointment[];
  mutation: ReturnType<typeof useAppointmentStatus>;
}) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th>Time</th>
          <th>Patient</th>
          <th>Doctor</th>
          <th>Reason</th>
          <th>Status</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id}>
            <td className="mono">
              {formatTime(a.scheduledAt)}
              <div className="muted">{a.durationMinutes} min</div>
            </td>
            <td>
              <strong>{a.patientName}</strong>
            </td>
            <td>
              {a.doctorName}
              {a.doctorSpecialty && <div className="muted">{a.doctorSpecialty}</div>}
            </td>
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
  );
}
