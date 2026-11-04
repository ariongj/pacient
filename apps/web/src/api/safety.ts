import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import { t } from '../i18n';

export type AlertSeverity = 'CONTRAINDICATED' | 'MAJOR' | 'MODERATE' | 'MINOR';
export type AlertKind =
  'INTERACTION' | 'ALLERGY' | 'DUPLICATE' | 'DOSE' | 'RENAL' | 'PREGNANCY' | 'AGE';

/** A safety alert as the API returns it, already translated for the reader. */
export interface SafetyAlert {
  code: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** Contraindicated and major alerts need a recorded reason to proceed. */
  blocking: boolean;
  message: string;
  management: string;
  details?: Record<string, unknown>;
}

/** An alert stored with a prescription, with the prescriber's override reason. */
export interface StoredAlert extends SafetyAlert {
  id: string;
  overrideReason: string | null;
  overriddenBy: string | null;
  createdAt: string;
}

export interface Interaction {
  id: string;
  ingredientA: string;
  ingredientB: string;
  severity: AlertSeverity;
  effect: string;
  management: string;
  effectTranslated: string;
  managementTranslated: string;
  source: string | null;
  isActive: boolean;
  updatedAt: string;
}

export const SEVERITIES: AlertSeverity[] = ['CONTRAINDICATED', 'MAJOR', 'MODERATE', 'MINOR'];

export function severityLabel(s: AlertSeverity): string {
  switch (s) {
    case 'CONTRAINDICATED':
      return t('Contraindicated');
    case 'MAJOR':
      return t('Major');
    case 'MODERATE':
      return t('Moderate');
    case 'MINOR':
      return t('Minor');
  }
}

export const severityTone = (s: AlertSeverity) =>
  s === 'CONTRAINDICATED' || s === 'MAJOR' ? 'danger' : s === 'MODERATE' ? 'warning' : 'info';

export function kindLabel(k: AlertKind): string {
  switch (k) {
    case 'INTERACTION':
      return t('Interaction');
    case 'ALLERGY':
      return t('Allergy');
    case 'DUPLICATE':
      return t('Duplicate therapy');
    case 'DOSE':
      return t('Dose');
    case 'RENAL':
      return t('Kidney function');
    case 'PREGNANCY':
      return t('Pregnancy');
    case 'AGE':
      return t('Age');
  }
}

/** Live check of one medication for a patient (debounce the inputs before calling). */
export function useSafetyCheck(
  patientId: string,
  medication: string,
  catalogItemId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['patient', patientId, 'safety-check', medication, catalogItemId],
    queryFn: () =>
      api<{ ingredients: string[]; alerts: SafetyAlert[] }>('/safety/check', {
        method: 'POST',
        body: { patientId, medication, catalogItemId: catalogItemId ?? undefined },
      }),
    enabled: enabled && medication.trim().length >= 3,
    staleTime: 30_000,
  });
}

/** Stored alerts of all the patient's prescriptions, by prescription id. */
export function useStoredAlerts(patientId: string, enabled = true) {
  return useQuery({
    queryKey: ['patient', patientId, 'safety-alerts'],
    queryFn: () =>
      api<{ byPrescription: Record<string, StoredAlert[]> }>(
        `/safety/patients/${patientId}/alerts`,
      ).then((r) => r.byPrescription),
    enabled,
  });
}
