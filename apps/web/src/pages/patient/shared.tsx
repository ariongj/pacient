import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { CareTeamMember, ClinicalSummary } from '../../api/types';
import { useUser } from '../../auth/AuthContext';

export function usePatientId(): string {
  const user = useUser();
  if (!user.patientId) throw new Error('This account is not linked to a patient record');
  return user.patientId;
}

export function useSummary() {
  const id = usePatientId();
  return useQuery({
    queryKey: ['patient', id, 'summary'],
    queryFn: () => api<ClinicalSummary>(`/patients/${id}/summary`),
  });
}

export function useCareTeam() {
  const id = usePatientId();
  return useQuery({
    queryKey: ['careTeam', id],
    queryFn: () => api<{ items: CareTeamMember[] }>(`/patients/${id}/care-team`),
  });
}

export const ALLERGY_ASSESSMENT_TEXT: Record<string, string> = {
  NO_KNOWN_ALLERGIES: 'No known allergies (confirmed by your doctor)',
  NOT_RECORDED: 'Allergies have not been recorded yet. Tell your doctor about any allergies.',
  UNKNOWN: 'Allergy status unknown',
  ALLERGIES_RECORDED: '',
};
