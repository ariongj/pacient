import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { t } from '../i18n';

/** API client and types for organ donation and advance directives. */

export const DONATION_DECISIONS = ['DONOR', 'DONOR_SOME', 'NOT_DONOR'] as const;
export type DonationDecision = (typeof DONATION_DECISIONS)[number];
export const ORGANS = [
  'KIDNEYS',
  'LIVER',
  'HEART',
  'LUNGS',
  'PANCREAS',
  'CORNEAS',
  'TISSUE',
] as const;
export type Organ = (typeof ORGANS)[number];
export const DIRECTIVE_KINDS = [
  'DNACPR',
  'TREATMENT_ESCALATION',
  'ADVANCE_REFUSAL',
  'HEALTHCARE_PROXY',
] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];
export const PATIENT_REVOCABLE_KINDS: readonly DirectiveKind[] = [
  'HEALTHCARE_PROXY',
  'ADVANCE_REFUSAL',
];
export type CheckPurpose = 'END_OF_LIFE_CARE' | 'TRANSPLANT_COORDINATION';

export interface DonationEntry {
  id: string;
  decision: DonationDecision;
  organs: Organ[] | null;
  familyInformed: boolean | null;
  faithOrBeliefNote: string | null;
  recordedVia: 'PORTAL' | 'IN_PERSON';
  createdAt: string;
  recordedByName: string;
  recordedByRole: string;
}

export interface Directive {
  id: string;
  kind: DirectiveKind;
  status: 'ACTIVE' | 'REVOKED';
  summary: string;
  discussedWith: string | null;
  proxyName: string | null;
  proxyPhone: string | null;
  documentId: string | null;
  reviewDate: string | null;
  reviewDue: boolean;
  selfRegistered: boolean;
  createdAt: string;
  createdByName: string;
  createdByRole: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface DirectiveFlag {
  id: string;
  kind: DirectiveKind;
  summary: string;
  reviewDate: string | null;
  reviewDue: boolean;
}

export interface MyWishes {
  acting: boolean;
  donation: {
    eligible: boolean;
    reason: 'MINOR' | 'DECEASED' | 'GUARDIAN' | null;
    current: DonationEntry | null;
    history: DonationEntry[];
  };
  directives: Directive[];
}

export interface DonationInput {
  decision: DonationDecision;
  organs?: Organ[];
  familyInformed?: boolean;
  faithOrBeliefNote?: string;
}

export interface DonationCheck {
  registered: boolean;
  current: Omit<DonationEntry, 'id' | 'recordedByName' | 'recordedByRole'> | null;
  changes: number;
  checkedAt: string;
}

export interface CountRow {
  key: string;
  registered: number | null;
  donors: number | null;
  donorPct: number | null;
  suppressed: boolean;
}

export interface RegistryStats {
  smallCellThreshold: number;
  adultPopulation: number;
  registered: number | null;
  donors: number | null;
  byDecision: { decision: DonationDecision; count: number | null }[];
  donorPctOfRegistered: number | null;
  registeredPctOfAdults: number | null;
  byMunicipality: CountRow[];
  byAgeBand: CountRow[];
  bySex: CountRow[];
  byMonth: {
    month: string;
    DONOR: number | null;
    DONOR_SOME: number | null;
    NOT_DONOR: number | null;
  }[];
}

/* ------------------------------------------------------------------ labels */

export const decisionLabel = (d: DonationDecision) =>
  ({
    DONOR: t('Yes – I want to donate my organs and tissue'),
    DONOR_SOME: t('Yes – only some organs or tissue'),
    NOT_DONOR: t('No – I do not want to donate'),
  })[d];

export const decisionShort = (d: DonationDecision) =>
  ({
    DONOR: t('Donor (all organs)'),
    DONOR_SOME: t('Donor (some organs)'),
    NOT_DONOR: t('Not a donor'),
  })[d];

export const organLabel = (o: Organ) =>
  ({
    KIDNEYS: t('Kidneys'),
    LIVER: t('Liver'),
    HEART: t('Heart'),
    LUNGS: t('Lungs'),
    PANCREAS: t('Pancreas'),
    CORNEAS: t('Corneas'),
    TISSUE: t('Tissue (skin, bone, heart valves)'),
  })[o];

export const kindLabel = (k: DirectiveKind) =>
  ({
    DNACPR: t('Do not attempt cardiopulmonary resuscitation (DNACPR)'),
    TREATMENT_ESCALATION: t('Treatment escalation plan (ceiling of care)'),
    ADVANCE_REFUSAL: t('Advance refusal of treatment'),
    HEALTHCARE_PROXY: t('Healthcare proxy'),
  })[k];

/** Short label for badges and banners. */
export const kindShort = (k: DirectiveKind) =>
  ({
    DNACPR: t('DNACPR'),
    TREATMENT_ESCALATION: t('Ceiling of care'),
    ADVANCE_REFUSAL: t('Refusal of treatment'),
    HEALTHCARE_PROXY: t('Healthcare proxy'),
  })[k];

/** Plain-language explanation for the patient. */
export const kindExplanation = (k: DirectiveKind) =>
  ({
    DNACPR: t(
      'Your doctors have decided, after talking with you or those close to you, that if your heart or breathing stopped, trying to restart it (CPR) would not help you. All other care and treatment continue. You can ask your doctor about this decision at any time.',
    ),
    TREATMENT_ESCALATION: t(
      'Your care team has agreed with you or those close to you which treatments are right for you if you become more unwell, for example whether intensive care would help. You can ask your doctor about it at any time.',
    ),
    ADVANCE_REFUSAL: t(
      'You have refused a specific treatment in advance. Your care team will respect it. You can withdraw it whenever you wish.',
    ),
    HEALTHCARE_PROXY: t(
      'The person you want your care team to consult if you cannot decide for yourself.',
    ),
  })[k];

export const purposeLabel = (p: CheckPurpose) =>
  ({
    END_OF_LIFE_CARE: t('End-of-life care planning'),
    TRANSPLANT_COORDINATION: t('Transplant coordination'),
  })[p];

/** Directive text as shown; the portal's default proxy note is translated. */
export const summaryText = (summary: string) =>
  summary === 'Named by the patient in the portal'
    ? t('Named by the patient in the portal')
    : summary;

/* ------------------------------------------------------------------ portal */

/** `actingFor`: the child a guardian is acting for (part of the cache key), or null. */
export function useMyWishes(actingFor: string | null, enabled = true) {
  return useQuery({
    queryKey: ['directives', 'mine', actingFor ?? 'self'],
    queryFn: () => api<MyWishes>('/directives/mine'),
    enabled,
  });
}

function useInvalidateMine() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['directives'] });
}

export function useRecordMyDonation() {
  const done = useInvalidateMine();
  return useMutation({
    mutationFn: (body: DonationInput) =>
      api<DonationEntry>('/directives/mine/organ-donation', { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useNameProxy() {
  const done = useInvalidateMine();
  return useMutation({
    mutationFn: (body: {
      proxyName: string;
      proxyPhone?: string;
      relationship?: string;
      note?: string;
    }) => api<Directive>('/directives/mine/healthcare-proxy', { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useWithdrawMine() {
  const done = useInvalidateMine();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<Directive>(`/directives/mine/directives/${id}/revoke`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: done,
  });
}

/* ------------------------------------------------------------------ clinicians */

export function usePatientDirectives(patientId: string) {
  return useQuery({
    queryKey: ['directives', 'patient', patientId],
    queryFn: () =>
      api<{ items: Directive[]; donationRegistrable: boolean; canRecord: DirectiveKind[] }>(
        `/directives/patients/${patientId}`,
      ),
  });
}

export function useDirectiveFlags(patientId: string, enabled = true) {
  return useQuery({
    queryKey: ['directives', 'flags', patientId],
    queryFn: () => api<{ items: DirectiveFlag[] }>(`/directives/patients/${patientId}/flags`),
    enabled,
    retry: false,
  });
}

export function useEdDirectiveFlags(enabled = true) {
  return useQuery({
    queryKey: ['directives', 'ed-flags'],
    queryFn: () =>
      api<{ items: { patientId: string; items: DirectiveFlag[] }[] }>('/directives/ed-flags'),
    enabled,
    retry: false,
    staleTime: 60_000,
    select: (d) => new Map(d.items.map((i) => [i.patientId, i.items])),
  });
}

export interface DirectiveBody {
  kind: DirectiveKind;
  summary: string;
  discussedWith?: string;
  proxyName?: string;
  proxyPhone?: string;
  reviewDate?: string;
}

export function useRecordDirective(patientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DirectiveBody) =>
      api<Directive>(`/directives/patients/${patientId}`, { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['directives'] }),
  });
}

export function useRevokeDirective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<Directive>(`/directives/${id}/revoke`, { method: 'POST', body: { reason } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['directives'] }),
  });
}

export function useCheckDonation(patientId: string) {
  return useMutation({
    mutationFn: (body: { purpose: CheckPurpose; note?: string }) =>
      api<DonationCheck>(`/directives/patients/${patientId}/organ-donation/check`, {
        method: 'POST',
        body,
      }),
  });
}

export function useRecordDonationInPerson(patientId: string) {
  return useMutation({
    mutationFn: (body: DonationInput) =>
      api<{ id: string; createdAt: string }>(`/directives/patients/${patientId}/organ-donation`, {
        method: 'POST',
        body: { ...body, personPresent: true },
      }),
  });
}

export function useRegistryStats() {
  return useQuery({
    queryKey: ['directives', 'registry'],
    queryFn: () => api<RegistryStats>('/directives/registry/stats'),
  });
}
