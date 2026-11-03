import { useQuery } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** Temporary identities: newborns before civil registration, and unidentified patients. */
export type TemporaryKind = 'NEWBORN' | 'UNIDENTIFIED';
export type Sex = 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
export type DeliveryType =
  | 'SPONTANEOUS_VAGINAL'
  | 'ASSISTED_VAGINAL'
  | 'CAESAREAN_ELECTIVE'
  | 'CAESAREAN_EMERGENCY';

export interface TemporaryRecord {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: Sex;
  temporaryIdentity: TemporaryKind;
  identityNote: string | null;
  createdAt: string;
  bornAt: string | null;
  motherId: string | null;
  motherName: string | null;
}

export interface BirthListItem {
  id: string;
  bornAt: string;
  birthOrder: number;
  civilRegisteredAt: string | null;
  newbornId: string;
  newbornFirstName: string;
  newbornLastName: string;
  newbornNationalId: string;
  newbornSex: Sex;
  temporaryIdentity: TemporaryKind | null;
  motherId: string;
  motherName: string;
  motherNationalId: string;
  // Clinical fields – present for doctors and nurses only.
  deliveryType?: DeliveryType;
  gestationalWeeks?: number;
  gestationalDays?: number;
  birthWeightGrams?: number;
  lengthCm?: string | null;
  headCircumferenceCm?: string | null;
  apgar1?: number;
  apgar5?: number;
  apgar10?: number | null;
  notes?: string | null;
  attendantName?: string;
}

interface BirthDetails {
  id: string;
  bornAt: string;
  birthOrder: number;
  civilRegisteredAt: string | null;
  facilityName: string;
  deliveryType: DeliveryType;
  gestationalWeeks: number;
  gestationalDays: number;
  birthWeightGrams: number;
  lengthCm: string | null;
  headCircumferenceCm: string | null;
  apgar1: number;
  apgar5: number;
  apgar10: number | null;
  notes: string | null;
  attendantName: string;
}

export interface PatientBirth {
  asNewborn: (BirthDetails & { motherId: string; motherName: string }) | null;
  asMother: (BirthDetails & {
    newbornId: string;
    newbornName: string;
    newbornSex: Sex;
    newbornNationalId: string;
    temporaryIdentity: TemporaryKind | null;
  })[];
}

export const isTemporaryNumber = (n: string) => /^TMP\d{10}$/.test(n);

/** "Unknown patient #4821" for unidentified records, otherwise "First Last". */
export function displayName(p: {
  firstName: string;
  lastName: string;
  temporaryIdentity?: TemporaryKind | null;
}): string {
  if (p.temporaryIdentity === 'UNIDENTIFIED') {
    return t('Unknown patient {code}', { code: p.lastName });
  }
  return `${p.firstName} ${p.lastName}`;
}

export const DELIVERY_TYPES: DeliveryType[] = [
  'SPONTANEOUS_VAGINAL',
  'ASSISTED_VAGINAL',
  'CAESAREAN_ELECTIVE',
  'CAESAREAN_EMERGENCY',
];

export function deliveryLabel(d: DeliveryType): string {
  switch (d) {
    case 'SPONTANEOUS_VAGINAL':
      return t('Spontaneous vaginal birth');
    case 'ASSISTED_VAGINAL':
      return t('Assisted vaginal birth (vacuum/forceps)');
    case 'CAESAREAN_ELECTIVE':
      return t('Planned caesarean section');
    case 'CAESAREAN_EMERGENCY':
      return t('Emergency caesarean section');
  }
}

export const gestationLabel = (weeks: number, days: number) =>
  t('{weeks}+{days} weeks', { weeks, days });

export function useTemporaryRecords() {
  return useQuery({
    queryKey: ['identity', 'temporary'],
    queryFn: () => api<{ items: TemporaryRecord[] }>('/identity/temporary').then((r) => r.items),
  });
}

export function useBirths(range: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['identity', 'births', range],
    queryFn: () =>
      api<{ items: BirthListItem[]; clinical: boolean }>('/identity/births', { query: range }),
  });
}

export function usePatientBirth(patientId: string) {
  return useQuery({
    queryKey: ['patient', patientId, 'birth'],
    queryFn: () => api<PatientBirth>(`/identity/patients/${patientId}/birth`),
  });
}
