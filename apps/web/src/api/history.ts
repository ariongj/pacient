import { useQuery } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for record history (who changed what in the chart, and when). */

export type HistoryTable =
  | 'allergies'
  | 'diagnoses'
  | 'prescriptions'
  | 'vital_signs'
  | 'lab_results'
  | 'immunizations'
  | 'encounters';

export type FieldKind =
  'text' | 'number' | 'bool' | 'date' | 'datetime' | 'enum' | 'user' | 'facility' | 'masked';

type Value = string | number | boolean | null;

export interface HistoryActor {
  userId: string | null;
  name: string | null;
  role: string | null;
  action: string;
  at: string;
}

export interface FieldChange {
  field: string;
  label: string;
  kind: FieldKind;
  before: Value;
  after: Value;
}

export interface RecordVersion {
  version: number;
  operation: 'BASELINE' | 'INSERT' | 'UPDATE' | 'DELETE';
  recordedAt: string;
  by: HistoryActor | null;
  mergedMove: boolean;
  title: string;
  changes: FieldChange[];
  state: { field: string; label: string; kind: FieldKind; value: Value }[];
}

export interface RecordHistoryResponse {
  table: HistoryTable;
  tableLabel: string;
  resourceId: string;
  title: string;
  deleted: boolean;
  versions: RecordVersion[];
}

export interface ChangeItem {
  id: string;
  table: HistoryTable;
  tableLabel: string;
  resourceId: string;
  title: string;
  version: number;
  operation: RecordVersion['operation'];
  recordedAt: string;
  by: HistoryActor | null;
  mergedMove: boolean;
  changedFields: { field: string; label: string }[];
}

/* ------------------------------------------------------------------------------ labels -- */

/** Record types (the server sends English labels; these are the translated ones). */
export const tableLabel = (table: HistoryTable) =>
  ({
    allergies: t('Allergy'),
    diagnoses: t('Diagnosis'),
    prescriptions: t('Prescription'),
    vital_signs: t('Vital signs'),
    lab_results: t('Laboratory result'),
    immunizations: t('Vaccination'),
    encounters: t('Visit|record'),
  })[table];

/** Column labels, keyed by column; falls back to the server's English label. */
export function fieldLabel(field: string, fallback: string) {
  const labels: Record<string, string> = {
    substance: t('Substance'),
    reaction: t('Reaction'),
    severity: t('Severity'),
    verification_status: t('Verification'),
    source: t('Source'),
    recorded_at: t('Recorded'),
    recorded_by_id: t('Recorded by'),
    icd10_code: t('ICD-10 code'),
    description: t('Description'),
    status: t('Status'),
    diagnosed_at: t('Diagnosed'),
    resolved_at: t('Resolved'),
    notes: t('Notes'),
    doctor_id: t('Doctor'),
    medication: t('Medication'),
    dosage: t('Dosage'),
    dose_amount: t('Dose'),
    dose_unit: t('Dose unit'),
    frequency: t('Frequency'),
    frequency_code: t('Frequency code'),
    route: t('Route'),
    as_needed: t('As needed'),
    max_doses_per_24h: t('Maximum doses in 24 hours'),
    duration_days: t('Duration (days)'),
    instructions: t('Instructions'),
    start_date: t('Start date'),
    end_date: t('End date'),
    pharmacy_status: t('Pharmacy status'),
    verified_by_id: t('Verified by'),
    verified_at: t('Verified'),
    pharmacist_note: t('Pharmacist note'),
    dispensed_by_id: t('Dispensed by'),
    dispensed_at: t('Dispensed'),
    dispensed_quantity: t('Quantity dispensed'),
    e_prescription_code: t('E-prescription code'),
    repeats_allowed: t('Repeats allowed'),
    community_valid_until: t('Valid at community pharmacies until'),
    systolic: t('Systolic (mmHg)'),
    diastolic: t('Diastolic (mmHg)'),
    heart_rate: t('Heart rate (/min)'),
    respiratory_rate: t('Respiratory rate (/min)'),
    oxygen_saturation: t('Oxygen saturation (%)'),
    on_supplemental_oxygen: t('On supplemental oxygen'),
    temperature_c: t('Temperature (°C)'),
    consciousness: t('Consciousness (ACVPU)'),
    pain_score: t('Pain score'),
    capillary_refill_seconds: t('Capillary refill (s)'),
    respiratory_effort: t('Respiratory effort'),
    weight_kg: t('Weight (kg)'),
    height_cm: t('Height (cm)'),
    test_name: t('Test'),
    test_code: t('Test code'),
    value: t('Value'),
    unit: t('Unit'),
    reference_range: t('Reference range'),
    flag: t('Flag'),
    collected_at: t('Collected'),
    ordered_by_id: t('Ordered by'),
    superseded_at: t('Replaced by a correction'),
    acknowledged_at: t('Acknowledged'),
    acknowledged_by_id: t('Acknowledged by'),
    released_at: t('Released to the patient'),
    released_by_id: t('Released by'),
    vaccine: t('Vaccine'),
    dose_number: t('Dose number'),
    lot_number: t('Lot number'),
    site: t('Site'),
    administered_at: t('Administered'),
    administered_by_id: t('Administered by'),
    facility_id: t('Facility'),
    type: t('Visit type'),
    reason: t('Reason'),
    started_at: t('Started'),
    ended_at: t('Ended'),
    note_status: t('Note status'),
    confidential_from_guardians: t('Hidden from guardians'),
    signed_at: t('Signed'),
    signed_by_id: t('Signed by'),
  };
  return labels[field] ?? fallback;
}

/* ------------------------------------------------------------------------------- hooks -- */

export function useRecordHistory(
  patientId: string,
  table: HistoryTable,
  resourceId: string | null,
) {
  return useQuery({
    queryKey: ['patient', patientId, 'history', table, resourceId],
    queryFn: () =>
      api<RecordHistoryResponse>(`/history/patients/${patientId}/records/${table}/${resourceId}`),
    enabled: Boolean(resourceId),
  });
}

export function useRecentChanges(patientId: string, page: number, table?: HistoryTable) {
  return useQuery({
    queryKey: ['patient', patientId, 'history', 'changes', page, table ?? ''],
    queryFn: () =>
      api<{ items: ChangeItem[]; page: number; totalPages: number; total: number }>(
        `/history/patients/${patientId}/changes`,
        { query: { page, pageSize: 20, table } },
      ),
  });
}
