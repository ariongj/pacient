import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Appointment } from '../../api/types';

/** Local-time day boundaries for a yyyy-mm-dd date (defaults to today). */
export function dayRange(day?: string) {
  const start = day ? new Date(`${day}T00:00:00`) : new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

export const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Facility appointments for one day (nurses see the whole facility schedule). */
export function useDaySchedule(day?: string) {
  const { from, to } = dayRange(day);
  return useQuery({
    queryKey: ['appointments', 'day', from],
    queryFn: () => api<{ items: Appointment[] }>('/appointments', { query: { from, to } }),
  });
}

export function useCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/appointments/${id}/status`, { method: 'PATCH', body: { status: 'CHECKED_IN' } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['appointments'] }),
  });
}
