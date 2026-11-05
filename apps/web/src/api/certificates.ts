import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { t } from '../i18n';

/** API client and types for medical certificates. */

export const CERTIFICATE_KINDS = [
  'SICK_LEAVE',
  'FITNESS_FOR_WORK',
  'SCHOOL_ABSENCE',
  'SPORTS_FITNESS',
  'DRIVING_FITNESS',
  'GENERAL',
] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];
export const FITNESS_KINDS: readonly CertificateKind[] = [
  'FITNESS_FOR_WORK',
  'SPORTS_FITNESS',
  'DRIVING_FITNESS',
];
export type FitnessOutcome = 'FIT' | 'FIT_WITH_RESTRICTIONS' | 'UNFIT';
export const MAX_DAYS_PER_CERTIFICATE = 30;
export const MEDICAL_COMMISSION_DAYS = 90;

export interface CertificateListItem {
  id: string;
  kind: CertificateKind;
  serialNumber: string;
  startDate: string;
  endDate: string | null;
  outcome: FitnessOutcome | null;
  status: 'ISSUED' | 'REVOKED';
  issuedAt: string;
  revokedAt: string | null;
  icd10Code: string | null;
  diagnosisOnCertificate: boolean;
  purpose: string | null;
  remarks: string | null;
  restrictions: string | null;
  encounterId: string | null;
  extendsCertificateId: string | null;
  extendedById: string | null;
  revokeReason: string | null;
  issuedById: string;
  issuedByName: string;
  facilityId: string;
  facilityName: string;
  days: number | null;
  chainDays: number | null;
}

export interface CertificateDetail
  extends Omit<
    CertificateListItem,
    'issuedByName' | 'facilityName' | 'extendedById' | 'chainDays'
  > {
  verificationUrl: string;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    nationalId: string;
    sex: string;
    address: string | null;
    municipality: string | null;
  };
  doctor: { fullName: string; specialty: string | null; licenseNumber: string | null };
  facility: {
    name: string;
    code: string;
    municipality: string;
    address: string | null;
    phone: string | null;
  };
}

export interface CertificateWarning {
  code: 'MEDICAL_COMMISSION';
  message: string;
  days: number;
}

export interface IssuedCertificate extends CertificateListItem {
  verificationUrl: string;
  warnings: CertificateWarning[];
}

export interface IssueCertificateInput {
  kind: CertificateKind;
  startDate: string;
  endDate?: string | null;
  icd10Code?: string | null;
  diagnosisOnCertificate?: boolean;
  outcome?: FitnessOutcome | null;
  restrictions?: string | null;
  purpose?: string | null;
  remarks?: string | null;
  encounterId?: string | null;
  extendsCertificateId?: string | null;
}

export type VerificationState = 'VALID' | 'EXPIRED' | 'REVOKED';
export interface CertificateVerification {
  genuine: true;
  state: VerificationState;
  kind: CertificateKind;
  serialNumber: string;
  startDate: string;
  endDate: string | null;
  outcome: FitnessOutcome | null;
  restrictions: string | null;
  issuedAt: string;
  revokedAt: string | null;
  issuer: { facility: string; municipality: string; doctor: string };
  patient: { initials: string; birthYear: number };
}

export interface CertificateStats {
  from: string;
  to: string;
  rows: { month: string; kind: CertificateKind; issued: number; revoked: number; days: number }[];
  totals: {
    issued: number;
    revoked: number;
    sickLeaveCertificates: number;
    sickLeaveDays: number;
    averageSickLeaveDays: number | null;
  };
}

/* ------------------------------------------------------------------ labels ---------------- */

const KIND_LABELS: Record<CertificateKind, string> = {
  SICK_LEAVE: 'Sick leave',
  FITNESS_FOR_WORK: 'Fitness for work',
  SCHOOL_ABSENCE: 'School absence',
  SPORTS_FITNESS: 'Fitness for sports',
  DRIVING_FITNESS: 'Fitness to drive',
  GENERAL: 'General medical certificate',
};
export const kindSource = (k: CertificateKind) => KIND_LABELS[k];
export const kindLabel = (k: CertificateKind) => t(KIND_LABELS[k]);

const OUTCOME_LABELS: Record<FitnessOutcome, string> = {
  FIT: 'Fit',
  FIT_WITH_RESTRICTIONS: 'Fit with restrictions',
  UNFIT: 'Not fit',
};
export const outcomeLabel = (o: FitnessOutcome) => t(OUTCOME_LABELS[o]);

export const stateLabel = (s: VerificationState) =>
  s === 'VALID'
    ? t('Valid')
    : s === 'EXPIRED'
      ? t('Genuine – the period has ended')
      : t('Revoked – not valid');

/* ------------------------------------------------------------------ hooks ----------------- */

export function useCertificates(patientId: string | null) {
  return useQuery({
    queryKey: ['patient', patientId, 'certificates'],
    queryFn: () =>
      api<{ items: CertificateListItem[] }>(`/certificates/patients/${patientId}`).then(
        (r) => r.items,
      ),
    enabled: Boolean(patientId),
  });
}

export function useCertificate(id: string | null) {
  return useQuery({
    queryKey: ['certificate', id],
    queryFn: () => api<CertificateDetail>(`/certificates/${id}`),
    enabled: Boolean(id),
  });
}

export function useIssueCertificate(patientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueCertificateInput) =>
      api<IssuedCertificate>(`/certificates/patients/${patientId}`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId, 'certificates'] }),
  });
}

export function useRevokeCertificate(patientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<CertificateListItem>(`/certificates/${id}/revoke`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId, 'certificates'] });
      void qc.invalidateQueries({ queryKey: ['certificate'] });
      void qc.invalidateQueries({ queryKey: ['certificate-lookup'] });
    },
  });
}

export function useCertificateStats(from: string, to: string) {
  return useQuery({
    queryKey: ['certificate-stats', from, to],
    queryFn: () => api<CertificateStats>('/certificates/stats', { query: { from, to } }),
  });
}

export interface CertificateLookup {
  id: string;
  kind: CertificateKind;
  serialNumber: string;
  startDate: string;
  endDate: string | null;
  status: 'ISSUED' | 'REVOKED';
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  issuedByName: string;
  patientId: string;
  patientName: string;
}

export function useCertificateLookup(serial: string) {
  return useQuery({
    queryKey: ['certificate-lookup', serial],
    queryFn: () =>
      api<CertificateLookup>(`/certificates/by-serial/${encodeURIComponent(serial)}`),
    enabled: serial.length > 4,
    retry: false,
  });
}

export function useVerifyCertificate(code: string) {
  return useQuery({
    queryKey: ['certificate-verify', code],
    queryFn: () =>
      api<CertificateVerification>(`/verify/certificates/${encodeURIComponent(code)}`),
    enabled: Boolean(code),
    retry: false,
  });
}

/* ------------------------------------------------------------------ dates ----------------- */

const dayMs = 86_400_000;
export const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
export const daysCovered = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / dayMs) + 1;
/** Today's date in Kosovo (YYYY-MM-DD). */
export const todayKosovo = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
