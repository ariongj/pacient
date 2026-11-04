import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLocale, t } from '../i18n';
import { api } from './client';

/** Euro amount from cents: "12,50 €" (Albanian, Serbian) or "€12.50" (English). */
export function formatMoney(cents: number | null | undefined): string {
  const value = Number(cents ?? 0) / 100;
  const negative = value < 0;
  const [int, dec] = Math.abs(value).toFixed(2).split('.');
  if (getLocale() === 'en') {
    return `${negative ? '-' : ''}€${(int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
  }
  const group = getLocale() === 'sr' ? '.' : ' ';
  return `${negative ? '-' : ''}${(int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, group)},${dec} €`;
}

export const INSURERS = ['FSSH', 'PRIVATE', 'NONE'] as const;
export type Insurer = (typeof INSURERS)[number];
export const EXEMPTIONS = [
  'CHILD',
  'PENSIONER',
  'CHRONIC',
  'SOCIAL_ASSISTANCE',
  'DISABILITY',
  'VETERAN',
] as const;
export type Exemption = (typeof EXEMPTIONS)[number];
export type ChargeStatus = 'OPEN' | 'CLAIMED' | 'PAID' | 'REJECTED' | 'VOID';
export type ClaimStatus =
  'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'PARTIALLY_PAID' | 'PAID' | 'REJECTED';
export const SERVICE_CATEGORIES = [
  'CONSULTATION',
  'EMERGENCY',
  'LABORATORY',
  'IMAGING',
  'BED_DAY',
  'SURGERY',
  'PHARMACY',
  'OTHER',
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export function insurerLabel(i: string): string {
  switch (i) {
    case 'FSSH':
      return t('Health Insurance Fund (FSSH)');
    case 'PRIVATE':
      return t('Private insurance');
    default:
      return t('Not insured');
  }
}

export function exemptionLabel(e: string | null | undefined): string {
  switch (e) {
    case 'CHILD':
      return t('Child (under 18)');
    case 'PENSIONER':
      return t('Pensioner (65 and over)');
    case 'CHRONIC':
      return t('Chronic illness');
    case 'SOCIAL_ASSISTANCE':
      return t('Social assistance');
    case 'DISABILITY':
      return t('Disability');
    case 'VETERAN':
      return t('War veteran');
    default:
      return t('No exemption');
  }
}

export function categoryLabel(c: string): string {
  const labels: Record<string, string> = {
    CONSULTATION: t('Consultations'),
    EMERGENCY: t('Emergency'),
    LABORATORY: t('Laboratory'),
    IMAGING: t('Imaging'),
    BED_DAY: t('Hospital days'),
    SURGERY: t('Operations'),
    PHARMACY: t('Pharmacy'),
    OTHER: t('Other'),
  };
  return labels[c] ?? c;
}

export function chargeStatusLabel(s: string): string {
  const labels: Record<string, string> = {
    OPEN: t('Not yet claimed'),
    CLAIMED: t('Claimed from the Fund'),
    PAID: t('Settled'),
    REJECTED: t('Rejected by the Fund'),
    VOID: t('Voided'),
  };
  return labels[s] ?? s;
}

export function claimStatusLabel(s: string): string {
  const labels: Record<string, string> = {
    DRAFT: t('Draft'),
    SUBMITTED: t('Submitted'),
    ACCEPTED: t('Accepted'),
    PARTIALLY_PAID: t('Partially paid'),
    PAID: t('Paid'),
    REJECTED: t('Rejected'),
  };
  return labels[s] ?? s;
}

export interface Coverage {
  id: string;
  patientId: string;
  insurer: Insurer;
  policyNumber: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  exemption: Exemption | null;
  validFrom: string;
  validUntil: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface InsuranceView {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
  };
  current: Coverage | null;
  automaticExemption: Exemption | null;
  history: Coverage[];
  canEdit: boolean;
}

export interface Charge {
  id: string;
  patientId: string;
  facilityId: string;
  facilityName: string;
  serviceCode: string;
  serviceName: string;
  category: ServiceCategory;
  sourceType: string;
  quantity: number;
  totalCents: number;
  copayCents: number;
  insurerCents: number;
  status: ChargeStatus;
  claimId: string | null;
  serviceDate: string;
  voidReason: string | null;
  copayPaid: boolean;
  receiptNumber: string | null;
  paymentId: string | null;
  patientName?: string;
  nationalId?: string;
}

export interface PaymentSummary {
  id: string;
  receiptNumber: string;
  amountCents: number;
  method: 'CASH' | 'CARD' | 'TRANSFER';
  receivedAt: string;
  facilityName: string;
  chargeIds: string[];
}

export interface PatientAccount {
  items: Charge[];
  payments: PaymentSummary[];
  totals: { openCopayCents: number; paidCopayCents: number; insurerCents: number };
}

export interface Receipt {
  id: string;
  receiptNumber: string;
  amountCents: number;
  method: string;
  receivedAt: string;
  facilityName: string;
  facilityCode: string;
  patientName: string;
  nationalId: string;
  lines: {
    id: string;
    serviceCode: string;
    serviceName: string;
    serviceDate: string;
    quantity: number;
    copayCents: number;
  }[];
}

export interface Claim {
  id: string;
  reference: string;
  insurer: string;
  periodFrom: string;
  periodTo: string;
  status: ClaimStatus;
  totalCents: number;
  paidCents: number;
  submittedAt: string | null;
  respondedAt: string | null;
  responseNote: string | null;
  createdAt: string;
  lineCount: number;
}

export interface ClaimDetail extends Claim {
  lines: {
    id: string;
    patientName: string;
    nationalId: string;
    policyNumber: string | null;
    serviceCode: string;
    serviceName: string;
    serviceDate: string;
    quantity: number;
    insurerCents: number;
    status: ChargeStatus;
  }[];
}

export interface Service {
  id: string;
  code: string;
  name: string;
  category: ServiceCategory;
  priceCents: number;
  copayCents: number;
  isActive: boolean;
}

export interface BillingSummary {
  openCopayCents: number;
  unclaimedCents: number;
  claimedCents: number;
  paidByInsurerCents: number;
  chargesThisMonth: number;
  copaymentsThisMonthCents: number;
}

export const BILLING_KEY = ['billing'] as const;

export const useInsurance = (patientId: string | null) =>
  useQuery({
    queryKey: [...BILLING_KEY, 'insurance', patientId],
    queryFn: () => api<InsuranceView>(`/billing/patients/${patientId}/insurance`),
    enabled: Boolean(patientId),
  });

export const usePatientAccount = (patientId: string | null) =>
  useQuery({
    queryKey: [...BILLING_KEY, 'account', patientId],
    queryFn: () => api<PatientAccount>(`/billing/patients/${patientId}/charges`),
    enabled: Boolean(patientId),
  });

export const useServices = () =>
  useQuery({
    queryKey: [...BILLING_KEY, 'services'],
    queryFn: () => api<{ items: Service[] }>('/billing/services').then((r) => r.items),
    staleTime: 10 * 60_000,
  });

/** Mutation that refreshes every billing query afterwards. */
export function useBillingMutation<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BILLING_KEY });
    },
  });
}
