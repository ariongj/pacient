import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for national e-prescriptions (dispensed by community pharmacies). */

export type EPrescriptionStatus =
  'ACTIVE' | 'PARTLY_DISPENSED' | 'DISPENSED' | 'EXPIRED' | 'CANCELLED' | 'STOPPED';

export interface Dispensing {
  id: string;
  supplyNumber: number;
  dispensedAt: string;
  pharmacyName: string;
  pharmacistName: string;
  productName: string;
  quantity: string;
  system: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface EPrescription {
  prescriptionId: string;
  code: string | null;
  medication: string;
  dosage: string;
  frequency: string;
  instructions: string | null;
  issuedAt: string;
  validUntil: string | null;
  repeatsAllowed: number;
  status: EPrescriptionStatus;
  suppliesTotal: number;
  suppliesDispensed: number;
  suppliesRemaining: number;
  dispensings: Dispensing[];
}

export interface MyEPrescription extends EPrescription {
  patientId: string;
  patientName: string;
}

export interface Suppressible {
  value: number | null;
  suppressed: boolean;
}

export interface ErxStats {
  scope: 'FACILITY' | 'NATIONAL';
  since: string;
  smallCellThreshold: number;
  issued: Suppressible;
  dispensed: Suppressible;
  cancelled: Suppressible;
  dispensedPct: number | null;
  medianHoursToFirstDispensing: number | null;
  byMonth: { month: string; issued: Suppressible; dispensed: Suppressible }[];
  topMedicines: { name: string; issued: Suppressible }[];
  byAtcGroup: { group: string | null; issued: Suppressible }[];
  pharmacies: { name: string; supplies: Suppressible }[] | null;
}

export const ACTIVE_STATUSES: EPrescriptionStatus[] = ['ACTIVE', 'PARTLY_DISPENSED'];

export function usePatientEPrescriptions(patientId: string | null) {
  return useQuery({
    queryKey: ['patient', patientId, 'e-prescriptions'],
    queryFn: () =>
      api<{ items: EPrescription[] }>(`/e-prescriptions/patients/${patientId}`).then(
        (r) => r.items,
      ),
    enabled: Boolean(patientId),
  });
}

export function useMyEPrescriptions(enabled = true) {
  return useQuery({
    queryKey: ['e-prescriptions', 'mine'],
    queryFn: () => api<{ items: MyEPrescription[] }>('/e-prescriptions/mine').then((r) => r.items),
    enabled,
  });
}

export function useErxStats(enabled = true) {
  return useQuery({
    queryKey: ['e-prescriptions', 'stats'],
    queryFn: () => api<ErxStats>('/e-prescriptions/stats'),
    enabled,
  });
}

export function useIssueEPrescription(patientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      prescriptionId,
      ...body
    }: {
      prescriptionId: string;
      repeats: number;
      validDays?: number;
    }) =>
      api<EPrescription>(`/e-prescriptions/prescriptions/${prescriptionId}/issue`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId] });
      void qc.invalidateQueries({ queryKey: ['e-prescriptions'] });
    },
  });
}

export function useCancelEPrescription(patientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prescriptionId, reason }: { prescriptionId: string; reason: string }) =>
      api<EPrescription>(`/e-prescriptions/prescriptions/${prescriptionId}/cancel`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId] });
      void qc.invalidateQueries({ queryKey: ['e-prescriptions'] });
    },
  });
}

export function erxStatusLabel(status: EPrescriptionStatus): string {
  switch (status) {
    case 'ACTIVE':
      return t('Ready to dispense|e-prescription');
    case 'PARTLY_DISPENSED':
      return t('Partly dispensed');
    case 'DISPENSED':
      return t('Fully dispensed');
    case 'EXPIRED':
      return t('Expired|e-prescription');
    case 'CANCELLED':
      return t('Cancelled|e-prescription');
    case 'STOPPED':
      return t('Stopped|e-prescription');
  }
}

export function erxStatusTone(
  status: EPrescriptionStatus,
): 'info' | 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'ACTIVE':
      return 'info';
    case 'PARTLY_DISPENSED':
      return 'warning';
    case 'DISPENSED':
      return 'success';
    default:
      return 'neutral';
  }
}

/** "1 of 3 supplies dispensed". */
export function suppliesLabel(e: Pick<EPrescription, 'suppliesDispensed' | 'suppliesTotal'>) {
  return t('{dispensed} of {total} supplies dispensed', {
    dispensed: e.suppliesDispensed,
    total: e.suppliesTotal,
  });
}

/** ATC anatomical main groups. */
export function atcGroupLabel(group: string | null): string {
  const labels: Record<string, string> = {
    A: t('Alimentary tract and metabolism'),
    B: t('Blood and blood-forming organs'),
    C: t('Cardiovascular system'),
    D: t('Dermatologicals'),
    G: t('Genito-urinary system and sex hormones'),
    H: t('Systemic hormonal preparations'),
    J: t('Anti-infectives for systemic use'),
    L: t('Antineoplastic and immunomodulating agents'),
    M: t('Musculo-skeletal system'),
    N: t('Nervous system'),
    P: t('Antiparasitic products'),
    R: t('Respiratory system'),
    S: t('Sensory organs'),
    V: t('Various'),
  };
  return group ? `${group} – ${labels[group] ?? group}` : t('Not in the national catalogue');
}
