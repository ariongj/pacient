import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type ConsentType = 'CROSS_FACILITY_SHARING' | 'RESEARCH' | 'TREATMENT';
export type ConsentDecision = 'GRANTED' | 'WITHDRAWN' | 'REFUSED';
export type ConsentMethod = 'PORTAL' | 'IN_PERSON' | 'WRITTEN';

export interface ConsentText {
  type: ConsentType;
  version: string;
  title: string;
  summary: string;
  details: string[];
  defaultDecision: 'GRANTED' | 'NOT_GRANTED';
  patientManaged: boolean;
}

export interface CurrentConsent {
  id?: string;
  type: ConsentType;
  decision: ConsentDecision | 'NOT_GRANTED';
  isDefault: boolean;
  method: ConsentMethod | null;
  recordedAt: string | null;
  recordedBy: string | null;
  recordedByRole: string | null;
  wordingVersion: string;
  procedure?: string | null;
  expiresAt?: string | null;
}

export interface ConsentHistoryRow {
  id: string;
  type: ConsentType;
  decision: ConsentDecision;
  method: ConsentMethod;
  procedure: string | null;
  wordingVersion: string;
  note?: string | null;
  documentId?: string | null;
  onBehalfGuardianshipId: string | null;
  expiresAt: string | null;
  createdAt: string;
  recordedById: string;
  recordedBy: string;
  recordedByRole: string;
}

export interface ConsentOverview {
  current: CurrentConsent[];
  treatment: CurrentConsent[];
  history: ConsentHistoryRow[];
  texts: ConsentText[];
}

export const consentKey = (patientId: string) => ['patient', patientId, 'consents'];

export function useConsents(patientId: string | null | undefined) {
  return useQuery({
    queryKey: consentKey(patientId ?? 'none'),
    queryFn: () => api<ConsentOverview>(`/patients/${patientId}/consents`),
    enabled: Boolean(patientId),
  });
}

export function useRecordConsent(patientId: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ConsentHistoryRow>(`/patients/${patientId}/consents`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId] });
      onDone?.();
    },
  });
}

export const CONSENT_LABELS: Record<ConsentType, string> = {
  CROSS_FACILITY_SHARING: 'Sharing with other facilities',
  RESEARCH: 'Research use',
  TREATMENT: 'Treatment consent',
};

export const DECISION_LABELS: Record<CurrentConsent['decision'], string> = {
  GRANTED: 'Agreed',
  WITHDRAWN: 'Withdrawn',
  REFUSED: 'Refused',
  NOT_GRANTED: 'Not given',
};

export const METHOD_LABELS: Record<ConsentMethod, string> = {
  PORTAL: 'Online (portal)',
  IN_PERSON: 'In person',
  WRITTEN: 'Signed form',
};

export const decisionTone = (d: CurrentConsent['decision']) =>
  d === 'GRANTED' ? 'success' : d === 'NOT_GRANTED' ? 'neutral' : 'warning';
