import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api, type RequestOptions } from './client';

export type BloodProduct = 'RED_CELLS' | 'PLASMA' | 'PLATELETS' | 'CRYOPRECIPITATE' | 'WHOLE_BLOOD';
export type Abo = 'O' | 'A' | 'B' | 'AB';
export type RhD = 'POS' | 'NEG';
export type Urgency = 'ROUTINE' | 'URGENT' | 'EMERGENCY';
export type RequestStatus =
  'REQUESTED' | 'SAMPLE_RECEIVED' | 'CROSSMATCHED' | 'ISSUED' | 'COMPLETED' | 'CANCELLED';
export type TransfusionStatus =
  'ISSUED' | 'AWAITING_CHECK' | 'IN_PROGRESS' | 'COMPLETED' | 'STOPPED' | 'RETURNED';
export type ReactionType =
  'FEBRILE' | 'ALLERGIC' | 'HAEMOLYTIC' | 'TACO' | 'TRALI' | 'ANAPHYLAXIS' | 'OTHER';
export type ReactionSeverity = 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING';

export interface Vitals {
  systolic?: number;
  diastolic?: number;
  heartRate?: number;
  respiratoryRate?: number;
  temperature?: number;
  spo2?: number;
}

export interface Observation extends Vitals {
  phase: 'PRE' | 'T15' | 'HOURLY' | 'OTHER' | 'END' | 'REACTION';
  at: string;
  by: string;
  note?: string;
  volumeGivenMl?: number;
  actionsTaken?: string;
}

export interface ReservedUnit {
  id: string;
  unitNumber: string;
  abo: Abo;
  rhD: RhD;
  expiresAt: string;
  product?: BloodProduct;
}

export interface Transfusion {
  id: string;
  requestId: string;
  patientId: string;
  status: TransfusionStatus;
  issuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  observations: Observation[];
  reaction: boolean;
  reactionType: ReactionType | null;
  reactionSeverity: ReactionSeverity | null;
  reactionDetails: string | null;
  unitId: string;
  unitNumber: string;
  product: BloodProduct;
  abo: Abo;
  rhD: RhD;
  volumeMl: number;
  expiresAt: string;
  issuedBy: string;
  checkedById: string | null;
  checkedBy: string | null;
  secondCheckerId: string | null;
  secondChecker: string | null;
}

export interface PatientRequest {
  id: string;
  product: BloodProduct;
  units: number;
  urgency: Urgency;
  indication: string;
  haemoglobinGl: number | null;
  status: RequestStatus;
  createdAt: string;
  crossmatchedAt: string | null;
  requestedBy: string;
  requestedById: string;
  reservedUnits: ReservedUnit[];
}

export interface PatientBloodBank {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    sex: string;
    dateOfBirth: string;
    nationalId: string;
  };
  bloodGroup: {
    group: {
      abo: Abo;
      rhD: RhD;
      antibodyScreen: string;
      antibodies: string | null;
      testedAt: string;
    } | null;
    confirmed: boolean;
    concordantTests: number;
    discordant: boolean;
    history: {
      id: string;
      abo: Abo;
      rhD: RhD;
      antibodyScreen: string;
      antibodies: string | null;
      testedAt: string;
    }[];
  };
  requests: PatientRequest[];
  transfusions: Transfusion[];
  isStaff: boolean;
}

export interface QueueItem {
  id: string;
  patientId: string;
  patientName: string;
  nationalId: string;
  dateOfBirth: string;
  sex: string;
  product: BloodProduct;
  units: number;
  urgency: Urgency;
  indication: string;
  haemoglobinGl: number | null;
  status: RequestStatus;
  sampleReceivedAt: string | null;
  crossmatchedAt: string | null;
  createdAt: string;
  requestedBy: string;
  bloodGroup: { abo: Abo; rhD: RhD } | null;
  groupConfirmed: boolean;
  groupDiscordant: boolean;
  antibodyScreen: string | null;
  reservedUnits: ReservedUnit[];
  issuedCount: number;
}

export interface StockUnit {
  id: string;
  unitNumber: string;
  product: BloodProduct;
  abo: Abo;
  rhD: RhD;
  volumeMl: number;
  collectedAt: string;
  expiresAt: string;
  status: 'AVAILABLE' | 'RESERVED';
  expired: boolean;
  expiringSoon: boolean;
}

export interface Stock {
  matrix: Partial<Record<BloodProduct, Record<string, { available: number; reserved: number }>>>;
  expiringCount: number;
  expiredCount: number;
  isStaff: boolean;
  units: StockUnit[];
}

export interface CompatibleUnits {
  recipient: { abo: Abo; rhD: RhD } | null;
  groupConfirmed: boolean;
  items: (StockUnit & { compatibility: { ok: boolean; warnings: string[] } })[];
}

export interface ReactionsReport {
  transfusions: number;
  counts: {
    type: ReactionType;
    severity: ReactionSeverity;
    count: number | null;
    suppressed: boolean;
  }[];
  items: {
    id: string;
    patientId: string;
    patientName: string;
    unitNumber: string;
    product: BloodProduct;
    type: ReactionType;
    severity: ReactionSeverity;
    details: string;
    issuedAt: string;
    endedAt: string | null;
    status: TransfusionStatus;
  }[];
}

export const PRODUCTS: BloodProduct[] = [
  'RED_CELLS',
  'PLASMA',
  'PLATELETS',
  'CRYOPRECIPITATE',
  'WHOLE_BLOOD',
];
export const GROUPS: { abo: Abo; rhD: RhD }[] = [
  { abo: 'O', rhD: 'NEG' },
  { abo: 'O', rhD: 'POS' },
  { abo: 'A', rhD: 'NEG' },
  { abo: 'A', rhD: 'POS' },
  { abo: 'B', rhD: 'NEG' },
  { abo: 'B', rhD: 'POS' },
  { abo: 'AB', rhD: 'NEG' },
  { abo: 'AB', rhD: 'POS' },
];
export const REACTION_TYPES: ReactionType[] = [
  'FEBRILE',
  'ALLERGIC',
  'HAEMOLYTIC',
  'TACO',
  'TRALI',
  'ANAPHYLAXIS',
  'OTHER',
];
export const SEVERITIES: ReactionSeverity[] = ['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'];

/** "A Rh+" style label. */
export const groupLabel = (g: { abo: string; rhD: string } | null | undefined) =>
  g ? `${g.abo} ${g.rhD === 'POS' ? 'RhD+' : 'RhD−'}` : t('Unknown');
export const groupKey = (g: { abo: string; rhD: string }) =>
  `${g.abo}${g.rhD === 'POS' ? '+' : '-'}`;

export function productLabel(p: BloodProduct): string {
  switch (p) {
    case 'RED_CELLS':
      return t('Red cells');
    case 'PLASMA':
      return t('Fresh frozen plasma');
    case 'PLATELETS':
      return t('Platelets');
    case 'CRYOPRECIPITATE':
      return t('Cryoprecipitate');
    case 'WHOLE_BLOOD':
      return t('Whole blood');
  }
}

export function urgencyLabel(u: Urgency): string {
  return u === 'EMERGENCY' ? t('Emergency') : u === 'URGENT' ? t('Urgent') : t('Routine');
}
export const urgencyTone = (u: Urgency) =>
  u === 'EMERGENCY'
    ? ('danger' as const)
    : u === 'URGENT'
      ? ('warning' as const)
      : ('neutral' as const);

export function requestStatusLabel(s: RequestStatus): string {
  switch (s) {
    case 'REQUESTED':
      return t('Waiting for sample');
    case 'SAMPLE_RECEIVED':
      return t('Sample received');
    case 'CROSSMATCHED':
      return t('Crossmatched');
    case 'ISSUED':
      return t('Issued');
    case 'COMPLETED':
      return t('Completed');
    case 'CANCELLED':
      return t('Cancelled');
  }
}

export function transfusionStatusLabel(s: TransfusionStatus): string {
  switch (s) {
    case 'ISSUED':
      return t('Issued – bedside check pending');
    case 'AWAITING_CHECK':
      return t('Waiting for second checker');
    case 'IN_PROGRESS':
      return t('Transfusion running');
    case 'COMPLETED':
      return t('Completed');
    case 'STOPPED':
      return t('Stopped');
    case 'RETURNED':
      return t('Returned to blood bank');
  }
}

export function reactionTypeLabel(r: ReactionType): string {
  switch (r) {
    case 'FEBRILE':
      return t('Febrile non-haemolytic');
    case 'ALLERGIC':
      return t('Allergic');
    case 'HAEMOLYTIC':
      return t('Haemolytic');
    case 'TACO':
      return t('Circulatory overload (TACO)');
    case 'TRALI':
      return t('Acute lung injury (TRALI)');
    case 'ANAPHYLAXIS':
      return t('Anaphylaxis');
    case 'OTHER':
      return t('Other');
  }
}

export function severityLabel(s: ReactionSeverity): string {
  switch (s) {
    case 'MILD':
      return t('Mild');
    case 'MODERATE':
      return t('Moderate');
    case 'SEVERE':
      return t('Severe');
    case 'LIFE_THREATENING':
      return t('Life-threatening');
  }
}

export function phaseLabel(p: Observation['phase']): string {
  switch (p) {
    case 'PRE':
      return t('Before start');
    case 'T15':
      return t('After 15 minutes');
    case 'HOURLY':
      return t('Hourly');
    case 'OTHER':
      return t('Other observation');
    case 'END':
      return t('End of transfusion');
    case 'REACTION':
      return t('Reaction');
  }
}

export function vitalsSummary(v: Vitals): string {
  const parts: string[] = [];
  if (v.systolic && v.diastolic)
    parts.push(t('BP {sys}/{dia}', { sys: v.systolic, dia: v.diastolic }));
  if (v.heartRate) parts.push(t('Pulse {n}', { n: v.heartRate }));
  if (v.temperature) parts.push(`${v.temperature} °C`);
  if (v.respiratoryRate) parts.push(t('RR {n}', { n: v.respiratoryRate }));
  if (v.spo2) parts.push(`SpO₂ ${v.spo2}%`);
  return parts.join(' · ');
}

/** Number inputs of a vitals form → Vitals object (blank fields omitted). */
export function readVitals(form: FormData, prefix = ''): Vitals {
  const out: Vitals = {};
  for (const k of [
    'systolic',
    'diastolic',
    'heartRate',
    'respiratoryRate',
    'temperature',
    'spo2',
  ] as const) {
    const raw = form.get(prefix + k);
    if (typeof raw === 'string' && raw.trim() !== '') out[k] = Number(raw.replace(',', '.'));
  }
  return out;
}

export const BB_KEY = ['bloodbank'] as const;

export function usePatientBloodBank(patientId: string) {
  return useQuery({
    queryKey: [...BB_KEY, 'patient', patientId],
    queryFn: () => api<PatientBloodBank>(`/blood-bank/patients/${patientId}`),
  });
}

export function useBloodBankMe() {
  return useQuery({
    queryKey: [...BB_KEY, 'me'],
    queryFn: () => api<{ isStaff: boolean }>('/blood-bank/me'),
    staleTime: 5 * 60_000,
  });
}

export function useColleagues() {
  return useQuery({
    queryKey: [...BB_KEY, 'colleagues'],
    queryFn: () =>
      api<{ items: { id: string; fullName: string; role: string }[] }>(
        '/blood-bank/colleagues',
      ).then((r) => r.items),
    staleTime: 5 * 60_000,
  });
}

/** POST to a blood bank endpoint and refresh every blood bank view. */
export function useBloodBankAction<TBody>(
  path: (body: TBody) => string,
  method: RequestOptions['method'] = 'POST',
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) =>
      api<Record<string, unknown> & { warnings?: string[] }>(`/blood-bank${path(body)}`, {
        method,
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BB_KEY });
    },
  });
}
