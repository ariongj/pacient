import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import { getLocale, t } from '../i18n';

/** Structured dosing: units, routes and frequency codes the API accepts. */
export const DOSE_UNITS = [
  'mg',
  'g',
  'mcg',
  'ml',
  'IU',
  'units',
  'tablet',
  'capsule',
  'puff',
  'drop',
  'mg/kg',
] as const;
export type DoseUnit = (typeof DOSE_UNITS)[number];

export const ROUTES = [
  'oral',
  'IV',
  'IM',
  'SC',
  'inhaled',
  'topical',
  'rectal',
  'sublingual',
  'nasal',
  'ophthalmic',
  'otic',
] as const;
export type RouteCode = (typeof ROUTES)[number];

export const FREQUENCY_CODES = [
  'QD',
  'BID',
  'TID',
  'QID',
  'Q4H',
  'Q6H',
  'Q8H',
  'Q12H',
  'QHS',
  'PRN',
  'STAT',
  'WEEKLY',
] as const;
export type FrequencyCode = (typeof FREQUENCY_CODES)[number];

export const AGE_GROUPS = ['ADULT', 'CHILD', 'NEONATE', 'ELDERLY'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export const RULE_UNITS = ['mg', 'g', 'mcg', 'IU', 'units'] as const;

export interface StructuredDose {
  doseAmount: number;
  doseUnit: DoseUnit;
  frequencyCode: FrequencyCode;
  maxDosesPer24h?: number;
  durationDays?: number;
  asNeeded?: boolean;
  route?: string;
}

/** Structured fields stored on a prescription (null for free-text prescriptions). */
export interface StructuredPrescriptionFields {
  doseAmount?: string | null;
  doseUnit?: DoseUnit | null;
  frequencyCode?: FrequencyCode | null;
  durationDays?: number | null;
  asNeeded?: boolean;
}

export interface DoseRule {
  id: string;
  ingredient: string;
  route: string;
  ageGroup: AgeGroup;
  unit: string;
  perKg: boolean;
  maxSingleDose: string | null;
  maxDailyDose: string | null;
  absoluteMaxDaily: string | null;
  note: string | null;
  noteTranslated: string | null;
  isActive: boolean;
  updatedAt: string;
}

export interface DoseSummary {
  ageGroup: AgeGroup;
  weightKg: number | null;
  weightRecordedAt: string | null;
  timesPerDay: number | null;
  notComputed: 'NEEDS_WEIGHT' | 'NEEDS_STRENGTH' | 'UNIT_MISMATCH' | null;
  ingredients: {
    ingredient: string;
    singleDose: string | null;
    dailyDose: string | null;
    ruleId: string | null;
    ruleAgeGroup: AgeGroup | null;
    maxSingle: string | null;
    maxDaily: string | null;
    note: string | null;
    checked: boolean;
  }[];
}

/** The patient facts dose checks use (age group and the latest weight). */
export interface DosingPatient {
  ageGroup: AgeGroup;
  weightKg: number | null;
  weightRecordedAt: string | null;
}

export function ageGroupLabel(g: AgeGroup | string): string {
  switch (g) {
    case 'ADULT':
      return t('Adult');
    case 'CHILD':
      return t('Child (under 18)');
    case 'NEONATE':
      return t('Neonate (under 28 days)');
    case 'ELDERLY':
      return t('Older adult (65+)');
    default:
      return g;
  }
}

export function routeLabel(r: string): string {
  switch (r.toUpperCase()) {
    case 'ORAL':
      return t('Oral');
    case 'IV':
      return t('Intravenous (IV)');
    case 'IM':
      return t('Intramuscular (IM)');
    case 'SC':
      return t('Subcutaneous (SC)');
    case 'INHALED':
      return t('Inhaled');
    case 'TOPICAL':
      return t('Topical');
    case 'RECTAL':
      return t('Rectal');
    case 'SUBLINGUAL':
      return t('Sublingual');
    case 'NASAL':
      return t('Nasal');
    case 'OPHTHALMIC':
      return t('Eye (ophthalmic)');
    case 'OTIC':
      return t('Ear (otic)');
    default:
      return r;
  }
}

export function unitLabel(u: DoseUnit | string): string {
  switch (u) {
    case 'tablet':
      return t('tablet(s)');
    case 'capsule':
      return t('capsule(s)');
    case 'puff':
      return t('puff(s)');
    case 'drop':
      return t('drop(s)');
    case 'units':
      return t('units');
    case 'IU':
      return t('IU');
    default:
      return u;
  }
}

const FREQUENCY_TEXT: Record<FrequencyCode, string> = {
  QD: 'once a day',
  BID: 'twice a day',
  TID: 'three times a day',
  QID: 'four times a day',
  Q4H: 'every 4 hours',
  Q6H: 'every 6 hours',
  Q8H: 'every 8 hours',
  Q12H: 'every 12 hours',
  QHS: 'at bedtime',
  PRN: 'as needed, up to {n} times in 24 hours',
  STAT: 'once, immediately',
  WEEKLY: 'once a week',
};

/** Label for the frequency picker, e.g. "TID – three times a day". */
export function frequencyLabel(code: FrequencyCode): string {
  if (code === 'PRN') return `PRN – ${t('as needed')}`;
  return `${code} – ${t(FREQUENCY_TEXT[code])}`;
}

const COUNT_UNITS: Partial<Record<DoseUnit, [string, string]>> = {
  tablet: ['{n} tablet', '{n} tablets'],
  capsule: ['{n} capsule', '{n} capsules'],
  puff: ['{n} puff', '{n} puffs'],
  drop: ['{n} drop', '{n} drops'],
  units: ['{n} unit', '{n} units'],
};

const localNumber = (n: number) => {
  const s = String(Math.round(n * 1000) / 1000);
  return getLocale() === 'en' ? s : s.replace('.', ',');
};

/**
 * Live preview of the text the server generates from a structured dose (same English source
 * texts, translated with the same dictionaries): "500 mg · three times a day, for 5 days".
 */
export function doseText(
  dose: StructuredDose,
  weightKg?: number | null,
): { dosage: string; frequency: string } {
  const n = localNumber(dose.doseAmount);
  const count = COUNT_UNITS[dose.doseUnit];
  let dosage = count
    ? t(dose.doseAmount === 1 ? count[0] : count[1], { n })
    : `${n} ${dose.doseUnit === 'IU' ? t('IU') : dose.doseUnit}`;
  if (dose.doseUnit === 'mg/kg' && weightKg) {
    const mg = dose.doseAmount * weightKg;
    dosage += ` (${localNumber(mg >= 10 ? Math.round(mg) : Math.round(mg * 100) / 100)} mg)`;
  }
  let frequency = t(FREQUENCY_TEXT[dose.frequencyCode], { n: dose.maxDosesPer24h ?? '…' });
  if (dose.asNeeded && dose.frequencyCode !== 'PRN') {
    frequency = t('{frequency}, as needed', { frequency });
    if (dose.maxDosesPer24h) {
      frequency = t('{frequency}, at most {n} doses in 24 hours', {
        frequency,
        n: dose.maxDosesPer24h,
      });
    }
  }
  if (dose.durationDays) {
    frequency = t(
      dose.durationDays === 1 ? '{frequency}, for 1 day' : '{frequency}, for {n} days',
      { frequency, n: dose.durationDays },
    );
  }
  return { dosage, frequency };
}

/** "4 g/day" style limit text for a rule, with the per-kg basis. */
export function ruleLimit(value: string | null, rule: Pick<DoseRule, 'unit' | 'perKg'>): string {
  if (value === null) return '–';
  const n = localNumber(Number(value));
  return rule.perKg ? `${n} ${rule.unit}/kg` : `${n} ${rule.unit}`;
}

export interface DoseRulesPage {
  items: DoseRule[];
  page: number;
  totalPages: number;
  total: number;
  canEdit: boolean;
  disclaimer: string;
}

export function useDoseRules(params: {
  q: string;
  ageGroup: string;
  route: string;
  page: number;
  includeInactive: boolean;
}) {
  return useQuery({
    queryKey: ['safety', 'dose-rules', params],
    queryFn: () =>
      api<DoseRulesPage>('/safety/dose-rules', {
        query: {
          q: params.q.trim() || undefined,
          ageGroup: params.ageGroup || undefined,
          route: params.route || undefined,
          page: params.page,
          pageSize: 25,
          includeInactive: params.includeInactive ? 'true' : undefined,
        },
      }),
  });
}
