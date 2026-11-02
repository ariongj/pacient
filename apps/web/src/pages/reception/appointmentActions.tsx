import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Appointment, AppointmentStatus } from '../../api/types';
import { Button, ErrorAlert } from '../../components/ui';

/** Front-desk status changes allowed by the server for reception. */
const ACTIONS: Partial<
  Record<AppointmentStatus, { to: AppointmentStatus; label: string; confirm?: string; variant?: 'primary' | 'secondary' | 'danger' }[]>
> = {
  REQUESTED: [
    { to: 'CONFIRMED', label: 'Confirm' },
    { to: 'CANCELLED', label: 'Cancel', confirm: 'Cancel this appointment request?', variant: 'secondary' },
  ],
  CONFIRMED: [
    { to: 'CHECKED_IN', label: 'Check in' },
    { to: 'NO_SHOW', label: 'No-show', confirm: 'Mark the patient as a no-show?', variant: 'secondary' },
    { to: 'CANCELLED', label: 'Cancel', confirm: 'Cancel this appointment?', variant: 'secondary' },
  ],
  CHECKED_IN: [{ to: 'CONFIRMED', label: 'Undo check-in', variant: 'secondary' }],
};

export function useAppointmentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: AppointmentStatus }) =>
      api(`/appointments/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
}

export function AppointmentActions({
  appointment,
  mutation,
}: {
  appointment: Appointment;
  mutation: ReturnType<typeof useAppointmentStatus>;
}) {
  const actions = ACTIONS[appointment.status] ?? [];
  if (!actions.length) return <span className="muted">—</span>;
  return (
    <div className="row">
      {actions.map((a) => (
        <Button
          key={a.to}
          size="sm"
          variant={a.variant ?? 'primary'}
          loading={
            mutation.isPending &&
            mutation.variables?.id === appointment.id &&
            mutation.variables?.status === a.to
          }
          onClick={() => {
            if (a.confirm && !window.confirm(a.confirm)) return;
            mutation.mutate({ id: appointment.id, status: a.to });
          }}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}

export function MutationError({ mutation }: { mutation: { error: unknown } }) {
  return <ErrorAlert error={mutation.error} />;
}
