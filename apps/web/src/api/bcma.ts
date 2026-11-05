import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { MedicationAdministration } from './types';

/**
 * Barcode-checked medication administration (BCMA) and patient wristbands. The wristband carries
 * a signed code (PAC1.…) that identifies the patient; the server checks it, the pack barcode, the
 * time since the last dose and allergies before a dose is recorded as given.
 */
export type BcmaProblemCode =
  | 'INVALID_TOKEN'
  | 'WRONG_PATIENT'
  | 'EXPIRED_TOKEN'
  | 'UNKNOWN_BARCODE'
  | 'WRONG_DRUG'
  | 'DIFFERENT_STRENGTH'
  | 'NOT_DUE'
  | 'ALREADY_GIVEN'
  | 'MAX_DOSES_REACHED'
  | 'ALLERGY';

export interface BcmaProblem {
  code: BcmaProblemCode;
  overridable: boolean;
  severity: 'STOP' | 'WARNING';
  /** Already translated by the server into the user's language. */
  message: string;
  details?: Record<string, unknown>;
}

export interface BcmaCheck {
  ok: boolean;
  problems: BcmaProblem[];
  patientConfirmed: boolean;
  medicationConfirmed: boolean;
  scannedItem: { id: string; name: string; strength: string | null; form: string } | null;
  prescription: {
    id: string;
    medication: string;
    dosage: string;
    route: string;
    frequency: string;
  };
  lastGivenAt: string | null;
  nextDueAt: string | null;
}

export interface Wristband {
  token: string;
  issuedAt: string;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
    identifier: string;
    identifierKind: 'NATIONAL_ID' | 'TEMPORARY';
    temporaryIdentity: 'NEWBORN' | 'UNIDENTIFIED' | null;
  };
  allergyStatus: 'ALLERGIES' | 'NONE_KNOWN' | 'NOT_RECORDED';
  allergies: string[];
  bloodGroup: string | null;
  stay: {
    kind: 'ADMISSION' | 'EMERGENCY';
    facility: string;
    unit: string;
    bed: string | null;
    since: string;
  };
}

export interface BcmaCompliance {
  unit: { id: string; name: string } | null;
  compliance: {
    unitId: string;
    days: number;
    given: number;
    bothScanned: number;
    patientScanned: number;
    medicationScanned: number;
    overridden: number;
    compliancePct: number | null;
  } | null;
}

/** MAR rows with the scan flags recorded at the bedside. */
export type ScannedAdministration = MedicationAdministration & {
  patientScanned?: boolean;
  medicationScanned?: boolean;
  scanOverrideReason?: string | null;
};

/** Minimum length of the reason for giving a dose without both scans or despite a warning. */
export const MIN_SCAN_OVERRIDE = 10;

/** True when a scanned value looks like one of our wristbands rather than a pack barcode. */
export const isWristbandCode = (value: string) =>
  /^PAC1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());

export function usePrintWristband(patientId: string) {
  return useMutation({
    mutationFn: () =>
      api<Wristband>(`/patients/${patientId}/wristband`, { method: 'POST', body: {} }),
  });
}

export function useBcmaVerify(patientId: string) {
  return useMutation({
    mutationFn: (body: {
      prescriptionId: string;
      patientToken?: string;
      medicationBarcode?: string;
    }) => api<BcmaCheck>(`/patients/${patientId}/bcma/verify`, { method: 'POST', body }),
  });
}

export function useBcmaCompliance(patientId: string, enabled = true, days = 7) {
  return useQuery({
    queryKey: ['patient', patientId, 'bcma-compliance', days],
    queryFn: () =>
      api<BcmaCompliance>(`/patients/${patientId}/bcma/compliance`, { query: { days } }),
    enabled,
    staleTime: 60_000,
  });
}
