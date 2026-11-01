import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';

/** Loads one list section of a patient's chart, e.g. `diagnoses` or `lab-results`. */
export function useSection<T>(patientId: string, section: string) {
  return useQuery({
    queryKey: ['patient', patientId, section],
    queryFn: () => api<{ items: T[] }>(`/patients/${patientId}/${section}`).then((r) => r.items),
  });
}
