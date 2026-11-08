/** API client and types for blood donors. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '../format';
import { t } from '../i18n';
import { api, type RequestOptions } from './client';
import type { Abo, RhD } from './bloodbank';

export const DONORS_KEY = ['blood-donors'] as const;

export type DonorStatus = 'ACTIVE' | 'DEFERRED' | 'PERMANENTLY_DEFERRED';
export type VisitOutcome = 'COMPLETED' | 'DEFERRED' | 'ABORTED';
export type Marker = 'hiv' | 'hbv' | 'hcv' | 'syphilis';
export type MarkerResult = 'NEGATIVE' | 'REACTIVE';

export interface Question {
  code: string;
  text: string;
  triggerOn: boolean;
  womenOnly: boolean;
  permanent: boolean;
}

export interface Definitions {
  questions: Question[];
  limits: {
    minAge: number;
    maxAge: number;
    maxFirstDonationAge: number;
    hbWomen: number;
    hbMen: number;
    systolic: [number, number];
    diastolic: [number, number];
    pulse: [number, number];
    minWeightKg: number;
    intervalDaysMen: number;
    intervalDaysWomen: number;
    maxPerYearMen: number;
    maxPerYearWomen: number;
    volume: [number, number];
  };
  markers: { code: Marker; label: string }[];
  appealIntervalDays: number;
}

export interface Problem {
  code: string;
  message: string;
  vars: Record<string, string | number> | null;
  defer: number | 'PERMANENT' | null;
}

export interface DonorRow {
  id: string;
  patientId: string;
  abo: Abo | null;
  rhD: RhD | null;
  status: DonorStatus;
  deferredUntil: string | null;
  lastDonationAt: string | null;
  donationCount: number;
  contactConsent: boolean;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth: string;
  sex: string;
  deferralReason?: string | null;
}

export interface Lookup {
  person: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
    nationalId: string;
  };
  donorId: string | null;
  registrationProblem: Problem | null;
}

export interface DonationRow {
  id: string;
  attendedAt: string;
  outcome: VisitOutcome;
  volumeMl: number | null;
  haemoglobin: string | null;
  deferralReason: string | null;
  adverseReaction: string | null;
  bloodUnitId: string | null;
  unitNumber: string | null;
  unitStatus: string | null;
  facilityName: string;
  testing: 'AWAITING' | 'NOT_PASSED' | 'EXPIRED' | 'RELEASED' | null;
}

export interface DonorDetail {
  donor: DonorRow & {
    deferralReason: string | null;
    firstDonationAt: string | null;
  };
  person: {
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
    sex: string;
    phone: string | null;
  };
  nextEligibleDate: string;
  donations: DonationRow[];
}

export interface Eligibility {
  eligible: boolean;
  problems: Problem[];
  deferral: { status: 'DEFERRED' | 'PERMANENTLY_DEFERRED'; until: string | null } | null;
  nextEligibleDate: string;
}

export interface WorklistItem {
  id: string;
  donorId: string;
  attendedAt: string;
  outcome: VisitOutcome;
  volumeMl: number | null;
  bloodUnitId: string | null;
  adverseReaction: string | null;
  firstName: string;
  lastName: string;
  nationalId: string;
  abo: Abo | null;
  rhD: RhD | null;
}

export interface Measurements {
  haemoglobin?: number | null;
  systolic?: number | null;
  diastolic?: number | null;
  pulse?: number | null;
  weightKg?: number | null;
}

export interface MyDonorCard {
  registered: boolean;
  group?: { abo: Abo; rhD: RhD } | null;
  donationCount?: number;
  firstDonationAt?: string | null;
  lastDonationAt?: string | null;
  state?: 'ACTIVE' | 'TEMPORARILY_DEFERRED' | 'CONTACT_BLOOD_BANK';
  deferredUntil?: string | null;
  nextEligibleDate?: string | null;
  contactConsent?: boolean;
  donations?: {
    attendedAt: string;
    outcome: 'COMPLETED' | 'NOT_COLLECTED';
    facilityName: string;
  }[];
}

export interface DonorStats {
  scope: 'FACILITY' | 'NATIONAL';
  smallCellThreshold: number;
  months: { month: string; completed: number; deferred: number; aborted: number }[];
  deferralReasons: { code: string; count: number | null }[];
  donors: number;
  repeatDonors: number;
  repeatPercent: number | null;
  unitsReleased: { group: string; count: number }[];
}

export interface AppealResult {
  sent: number;
  recentlyAsked: number;
  notEligible: number;
  noPortal: number;
}

/* ------------------------------------------------------------------ hooks ---------------- */

export const useDonorsMe = () =>
  useQuery({
    queryKey: [...DONORS_KEY, 'me'],
    queryFn: () => api<{ isStaff: boolean; canSeeStats: boolean }>('/blood-donors/me'),
  });

export const useDonorDefinitions = (enabled = true) =>
  useQuery({
    queryKey: [...DONORS_KEY, 'definitions'],
    queryFn: () => api<Definitions>('/blood-donors/definitions'),
    staleTime: Infinity,
    enabled,
  });

export const useDonor = (id: string | null) =>
  useQuery({
    queryKey: [...DONORS_KEY, 'donor', id],
    queryFn: () => api<DonorDetail>(`/blood-donors/donors/${id}`),
    enabled: Boolean(id),
  });

export const useWorklist = (list: 'today' | 'testing-queue' | 'deferrals', enabled = true) =>
  useQuery({
    queryKey: [...DONORS_KEY, list],
    queryFn: () =>
      api<{ items: (WorklistItem & DonorRow)[] }>(`/blood-donors/${list}`).then((r) => r.items),
    refetchInterval: 60_000,
    enabled,
  });

export const useDonorStats = (enabled = true) =>
  useQuery({
    queryKey: [...DONORS_KEY, 'stats'],
    queryFn: () => api<DonorStats>('/blood-donors/stats'),
    enabled,
  });

export const useMyDonorCard = () =>
  useQuery({
    queryKey: [...DONORS_KEY, 'mine'],
    queryFn: () => api<MyDonorCard>('/blood-donors/mine'),
  });

/** A POST/PATCH under /blood-donors that refreshes every donor query. */
export function useDonorsAction<TBody, TResult = Record<string, unknown>>(
  path: (body: TBody) => string,
  method: RequestOptions['method'] = 'POST',
  strip: (body: TBody) => unknown = (b) => b,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) =>
      api<TResult>(`/blood-donors${path(body)}`, { method, body: strip(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DONORS_KEY });
    },
  });
}

/* ------------------------------------------------------------------ labels --------------- */

export const donorGroup = (abo: Abo | null | undefined, rhD: RhD | null | undefined) =>
  abo && rhD ? `${abo}${rhD === 'POS' ? '+' : '−'}` : t('Not confirmed yet');

export const donorStatusLabel = (s: DonorStatus) =>
  ({
    ACTIVE: t('Active donor'),
    DEFERRED: t('Temporarily deferred'),
    PERMANENTLY_DEFERRED: t('Permanently deferred'),
  })[s];

export const outcomeLabel = (o: VisitOutcome) =>
  ({
    COMPLETED: t('Donation completed'),
    DEFERRED: t('Deferred|donation visit'),
    ABORTED: t('Collection stopped'),
  })[o];

export const testingLabel = (s: DonationRow['testing']) =>
  s === null
    ? '—'
    : {
        AWAITING: t('Awaiting tests'),
        NOT_PASSED: t('Not released'),
        EXPIRED: t('Expired before testing'),
        RELEASED: t('Released to stock'),
      }[s];

/** Problem codes from the eligibility engine, for the live form and the statistics. */
const PROBLEM_LABELS: Record<string, string> = {
  PERMANENTLY_DEFERRED: 'The donor is permanently deferred',
  DEFERRED: 'The donor is deferred until {date}',
  TOO_YOUNG: 'Donors must be at least 18 years old',
  TOO_OLD: 'Donors must be 65 or younger',
  FIRST_DONATION_AGE: 'A first donation is possible up to the age of 60',
  INTERVAL: 'Too soon after the last donation (next possible on {next})',
  HB_LOW: 'Haemoglobin below {min} g/L',
  BP_SYSTOLIC: 'Systolic blood pressure outside 100–180',
  BP_DIASTOLIC: 'Diastolic blood pressure outside 60–100',
  PULSE: 'Pulse outside 50–100',
  WEIGHT: 'Weight below 50 kg',
};

/** Short names of the reasons for the statistics. */
const REASON_LABELS: Record<string, string> = {
  PERMANENTLY_DEFERRED: 'Already permanently deferred',
  DEFERRED: 'Already deferred',
  INTERVAL: 'Too soon after the last donation',
  HB_LOW: 'Low haemoglobin',
  BP_SYSTOLIC: 'Blood pressure',
  BP_DIASTOLIC: 'Blood pressure',
  PULSE: 'Pulse',
  WEIGHT: 'Weight',
  TOO_YOUNG: 'Age',
  TOO_OLD: 'Age',
  FIRST_DONATION_AGE: 'Age',
  Q_FEELING_WELL: 'Not feeling well',
  Q_RECENT_ILLNESS: 'Recent illness',
  Q_ANTIBIOTICS: 'Antibiotics',
  Q_TATTOO_PIERCING: 'Tattoo or piercing',
  Q_MALARIA_TRAVEL: 'Travel to a malaria area',
  Q_SURGERY: 'Surgery or endoscopy',
  Q_PREGNANCY: 'Pregnancy or recent birth',
  Q_RISK_BEHAVIOUR: 'Sexual risk',
  Q_INJECTED_DRUGS: 'Injected drugs',
  Q_KNOWN_INFECTION: 'Known infection',
};

export function problemLabel(p: Problem, questions: Question[] = []): string {
  const q = p.code.startsWith('Q_') ? questions.find((x) => `Q_${x.code}` === p.code) : null;
  if (q) return t(q.text);
  const vars = { ...(p.vars ?? {}) };
  if (typeof vars.date === 'string') vars.date = formatDate(vars.date);
  if (typeof vars.next === 'string') vars.next = formatDate(vars.next);
  return t(PROBLEM_LABELS[p.code] ?? p.message, vars);
}

export const reasonLabel = (code: string) => (REASON_LABELS[code] ? t(REASON_LABELS[code]) : code);
