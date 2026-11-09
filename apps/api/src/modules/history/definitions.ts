/**
 * Versioned clinical tables and the columns shown in their history. Only listed columns are ever
 * returned: ids, links to other rows, timestamps of the row itself and anything added to a table
 * later stay hidden until they are listed here on purpose.
 */

export type FieldKind =
  'text' | 'number' | 'bool' | 'date' | 'datetime' | 'enum' | 'user' | 'facility' | 'masked';

export interface FieldDef {
  /** English label (the web app translates it). */
  label: string;
  kind: FieldKind;
}

export interface TableDef {
  label: string;
  /** FHIR resource type the rows map to. */
  fhirType:
    | 'AllergyIntolerance'
    | 'Condition'
    | 'MedicationRequest'
    | 'Observation'
    | 'Immunization'
    | 'Encounter';
  /** A short title of one version (e.g. the substance of an allergy). */
  title: (data: Record<string, unknown>) => string;
  fields: Record<string, FieldDef>;
}

const f = (label: string, kind: FieldKind = 'text'): FieldDef => ({ label, kind });
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export const VERSIONED_TABLES = {
  allergies: {
    label: 'Allergy',
    fhirType: 'AllergyIntolerance',
    title: (d) => s(d.substance),
    fields: {
      substance: f('Substance'),
      reaction: f('Reaction'),
      severity: f('Severity', 'enum'),
      verification_status: f('Verification', 'enum'),
      source: f('Source', 'enum'),
      recorded_at: f('Recorded', 'datetime'),
      recorded_by_id: f('Recorded by', 'user'),
    },
  },
  diagnoses: {
    label: 'Diagnosis',
    fhirType: 'Condition',
    title: (d) => `${s(d.icd10_code)} ${s(d.description)}`.trim(),
    fields: {
      icd10_code: f('ICD-10 code'),
      description: f('Description'),
      status: f('Status', 'enum'),
      diagnosed_at: f('Diagnosed', 'datetime'),
      resolved_at: f('Resolved', 'datetime'),
      notes: f('Notes'),
      doctor_id: f('Doctor', 'user'),
    },
  },
  prescriptions: {
    label: 'Prescription',
    fhirType: 'MedicationRequest',
    title: (d) => s(d.medication),
    fields: {
      medication: f('Medication'),
      dosage: f('Dosage'),
      dose_amount: f('Dose', 'number'),
      dose_unit: f('Dose unit'),
      frequency: f('Frequency'),
      frequency_code: f('Frequency code'),
      route: f('Route'),
      as_needed: f('As needed', 'bool'),
      max_doses_per_24h: f('Maximum doses in 24 hours', 'number'),
      duration_days: f('Duration (days)', 'number'),
      instructions: f('Instructions'),
      start_date: f('Start date', 'date'),
      end_date: f('End date', 'date'),
      status: f('Status', 'enum'),
      pharmacy_status: f('Pharmacy status', 'enum'),
      verified_by_id: f('Verified by', 'user'),
      verified_at: f('Verified', 'datetime'),
      pharmacist_note: f('Pharmacist note'),
      dispensed_by_id: f('Dispensed by', 'user'),
      dispensed_at: f('Dispensed', 'datetime'),
      dispensed_quantity: f('Quantity dispensed'),
      // The code works like a key at any pharmacy: the history only says that it was issued.
      e_prescription_code: f('E-prescription code', 'masked'),
      repeats_allowed: f('Repeats allowed', 'number'),
      community_valid_until: f('Valid at community pharmacies until', 'date'),
      doctor_id: f('Prescriber', 'user'),
    },
  },
  vital_signs: {
    label: 'Vital signs',
    fhirType: 'Observation',
    title: () => 'Vital signs',
    fields: {
      systolic: f('Systolic (mmHg)', 'number'),
      diastolic: f('Diastolic (mmHg)', 'number'),
      heart_rate: f('Heart rate (/min)', 'number'),
      respiratory_rate: f('Respiratory rate (/min)', 'number'),
      oxygen_saturation: f('Oxygen saturation (%)', 'number'),
      on_supplemental_oxygen: f('On supplemental oxygen', 'bool'),
      temperature_c: f('Temperature (°C)', 'number'),
      consciousness: f('Consciousness (ACVPU)', 'enum'),
      pain_score: f('Pain score', 'number'),
      capillary_refill_seconds: f('Capillary refill (s)', 'number'),
      respiratory_effort: f('Respiratory effort', 'enum'),
      weight_kg: f('Weight (kg)', 'number'),
      height_cm: f('Height (cm)', 'number'),
      recorded_at: f('Recorded', 'datetime'),
      recorded_by_id: f('Recorded by', 'user'),
    },
  },
  lab_results: {
    label: 'Laboratory result',
    fhirType: 'Observation',
    title: (d) => s(d.test_name),
    fields: {
      test_name: f('Test'),
      test_code: f('Test code'),
      value: f('Value'),
      unit: f('Unit'),
      reference_range: f('Reference range'),
      flag: f('Flag', 'enum'),
      status: f('Status', 'enum'),
      source: f('Source', 'enum'),
      collected_at: f('Collected', 'datetime'),
      ordered_by_id: f('Ordered by', 'user'),
      superseded_at: f('Replaced by a correction', 'datetime'),
      acknowledged_at: f('Acknowledged', 'datetime'),
      acknowledged_by_id: f('Acknowledged by', 'user'),
      released_at: f('Released to the patient', 'datetime'),
      released_by_id: f('Released by', 'user'),
    },
  },
  immunizations: {
    label: 'Vaccination',
    fhirType: 'Immunization',
    title: (d) => s(d.vaccine),
    fields: {
      vaccine: f('Vaccine'),
      dose_number: f('Dose number', 'number'),
      lot_number: f('Lot number'),
      site: f('Site'),
      administered_at: f('Administered', 'datetime'),
      administered_by_id: f('Administered by', 'user'),
      facility_id: f('Facility', 'facility'),
      notes: f('Notes'),
    },
  },
  encounters: {
    label: 'Visit',
    fhirType: 'Encounter',
    title: (d) => s(d.reason),
    fields: {
      type: f('Visit type', 'enum'),
      reason: f('Reason'),
      notes: f('Notes'),
      started_at: f('Started', 'datetime'),
      ended_at: f('Ended', 'datetime'),
      note_status: f('Note status', 'enum'),
      confidential_from_guardians: f('Hidden from guardians', 'bool'),
      signed_at: f('Signed', 'datetime'),
      signed_by_id: f('Signed by', 'user'),
      doctor_id: f('Doctor', 'user'),
      facility_id: f('Facility', 'facility'),
    },
  },
} satisfies Record<string, TableDef>;

export type VersionedTable = keyof typeof VERSIONED_TABLES;
export const VERSIONED_TABLE_NAMES = Object.keys(VERSIONED_TABLES) as VersionedTable[];

export const isVersionedTable = (t: string): t is VersionedTable => t in VERSIONED_TABLES;
