/**
 * Chronic disease registers, defined in code (reviewed changes only). Each register lists the
 * ICD-10 codes that enrol a patient automatically and the care processes of the annual review,
 * with how often each is due and – where there is one – the treatment target used for quality
 * indicators.
 *
 * IMPORTANT: intervals and targets follow common international guidance (WHO HEARTS, NICE,
 * ADA/EASD, GINA, GOLD, KDIGO) and are placeholders until the Ministry's national clinical
 * guidelines are confirmed. They are decision support for recall and audit, not treatment advice.
 */

export const REGISTER_CODES = [
  'DIABETES',
  'HYPERTENSION',
  'ASTHMA',
  'COPD',
  'CKD',
  'HEART_FAILURE',
] as const;
export type RegisterCode = (typeof REGISTER_CODES)[number];

/** Where a care process is found in the record. */
export type ProcessSource =
  /** A laboratory result, by LOINC code or test name (case-insensitive POSIX regex). */
  | { kind: 'LAB'; loinc: string[]; namePattern: string; excludePattern?: string }
  /** Blood pressure from vital signs (systolic and diastolic). */
  | { kind: 'BP' }
  /** Weight from vital signs (BMI when a height is known). */
  | { kind: 'WEIGHT' }
  /** An explicitly recorded review item (care_process_records). */
  | { kind: 'RECORD' }
  /** A vaccination, by vaccine name pattern. */
  | { kind: 'IMMUNIZATION'; namePattern: string };

export type TargetCode = 'HBA1C' | 'BP' | 'CHOLESTEROL';

export interface CareProcessDef {
  code: string;
  label: string;
  /** Due again this many days after the last time it was done. */
  intervalDays: number;
  source: ProcessSource;
  /** Allowed results for RECORD processes. */
  results?: readonly string[];
  /** Results that count as "not done" for completion (e.g. DECLINED). */
  notDoneResults?: readonly string[];
  target?: TargetCode;
}

export interface RegisterDef {
  code: RegisterCode;
  label: string;
  /** ICD-10 code prefixes (without dot), e.g. "E11" matches E11, E11.9, E119. */
  icd10Prefixes: string[];
  processes: CareProcessDef[];
}

/** LOINC and name patterns for the laboratory tests the registers use. */
export const LAB = {
  HBA1C: {
    kind: 'LAB',
    loinc: ['4548-4', '17856-6', '59261-8', '41995-2'],
    namePattern: 'hba1c|a1c|glik(uar|ozil|ovan)|glycated|hemoglobin[a ]*a1c',
  },
  CREATININE: {
    kind: 'LAB',
    loinc: ['2160-0', '14682-9', '38483-4', '33914-3', '62238-1', '98979-8'],
    namePattern: 'creatinin|kreatinin|egfr|filtrim',
    excludePattern: 'urin|albumin|acr',
  },
  URINE_ACR: {
    kind: 'LAB',
    loinc: ['9318-7', '14959-1', '32294-1', '14958-3'],
    namePattern: 'albumin.*(creatinin|kreatinin)|(^|[^a-z])acr([^a-z]|$)|mikroalbumin|microalbumin',
  },
  CHOLESTEROL: {
    kind: 'LAB',
    loinc: ['2093-3', '14647-2'],
    namePattern: 'cholesterol|kolesterol|holesterol',
    excludePattern: 'hdl|ldl',
  },
  POTASSIUM: {
    kind: 'LAB',
    loinc: ['2823-3', '6298-4'],
    namePattern: 'potassium|kalium|kalij|kaliu',
  },
} as const satisfies Record<string, ProcessSource>;

const INFLUENZA: ProcessSource = { kind: 'IMMUNIZATION', namePattern: 'influen|grip' };
const YEAR = 365;
const HALF_YEAR = 182;
const EXAM_RESULTS = ['NORMAL', 'ABNORMAL', 'DECLINED'] as const;
const DONE_RESULTS = ['DONE', 'DECLINED'] as const;
const SMOKING_RESULTS = ['NON_SMOKER', 'EX_SMOKER', 'SMOKER', 'DECLINED'] as const;

const smoking: CareProcessDef = {
  code: 'SMOKING_STATUS',
  label: 'Smoking status',
  intervalDays: YEAR,
  source: { kind: 'RECORD' },
  results: SMOKING_RESULTS,
  notDoneResults: ['DECLINED'],
};
const bp = (intervalDays: number): CareProcessDef => ({
  code: 'BLOOD_PRESSURE',
  label: 'Blood pressure',
  intervalDays,
  source: { kind: 'BP' },
  target: 'BP',
});
const creatinine = (intervalDays: number): CareProcessDef => ({
  code: 'CREATININE',
  label: 'Kidney function (creatinine / eGFR)',
  intervalDays,
  source: LAB.CREATININE,
});
const acr: CareProcessDef = {
  code: 'URINE_ACR',
  label: 'Urine albumin–creatinine ratio',
  intervalDays: YEAR,
  source: LAB.URINE_ACR,
};
const cholesterol: CareProcessDef = {
  code: 'CHOLESTEROL',
  label: 'Cholesterol',
  intervalDays: YEAR,
  source: LAB.CHOLESTEROL,
  target: 'CHOLESTEROL',
};
const weight = (intervalDays: number): CareProcessDef => ({
  code: 'WEIGHT',
  label: 'Weight / BMI',
  intervalDays,
  source: { kind: 'WEIGHT' },
});
const flu: CareProcessDef = {
  code: 'INFLUENZA_VACCINATION',
  label: 'Influenza vaccination',
  intervalDays: YEAR,
  source: INFLUENZA,
};
const inhaler: CareProcessDef = {
  code: 'INHALER_TECHNIQUE',
  label: 'Inhaler technique checked',
  intervalDays: YEAR,
  source: { kind: 'RECORD' },
  results: ['NORMAL', 'ABNORMAL', 'DECLINED'],
  notDoneResults: ['DECLINED'],
};

export const REGISTERS: Record<RegisterCode, RegisterDef> = {
  DIABETES: {
    code: 'DIABETES',
    label: 'Diabetes',
    icd10Prefixes: ['E10', 'E11', 'E12', 'E13', 'E14'],
    processes: [
      {
        code: 'HBA1C',
        label: 'HbA1c',
        intervalDays: HALF_YEAR,
        source: LAB.HBA1C,
        target: 'HBA1C',
      },
      bp(HALF_YEAR),
      creatinine(YEAR),
      acr,
      cholesterol,
      weight(YEAR),
      {
        code: 'FOOT_EXAM',
        label: 'Foot examination',
        intervalDays: YEAR,
        source: { kind: 'RECORD' },
        results: EXAM_RESULTS,
        notDoneResults: ['DECLINED'],
      },
      {
        code: 'RETINAL_SCREENING',
        label: 'Eye (retinal) screening',
        intervalDays: YEAR,
        source: { kind: 'RECORD' },
        results: EXAM_RESULTS,
        notDoneResults: ['DECLINED'],
      },
      smoking,
      flu,
    ],
  },
  HYPERTENSION: {
    code: 'HYPERTENSION',
    label: 'Hypertension',
    icd10Prefixes: ['I10', 'I11', 'I12', 'I13', 'I15'],
    processes: [bp(HALF_YEAR), creatinine(YEAR), cholesterol, weight(YEAR), smoking],
  },
  ASTHMA: {
    code: 'ASTHMA',
    label: 'Asthma',
    icd10Prefixes: ['J45', 'J46'],
    processes: [
      inhaler,
      {
        code: 'ACTION_PLAN',
        label: 'Written asthma action plan',
        intervalDays: YEAR,
        source: { kind: 'RECORD' },
        results: DONE_RESULTS,
        notDoneResults: ['DECLINED'],
      },
      smoking,
      flu,
    ],
  },
  COPD: {
    code: 'COPD',
    label: 'COPD',
    icd10Prefixes: ['J44'],
    processes: [
      {
        code: 'SPIROMETRY',
        label: 'Spirometry',
        intervalDays: 2 * YEAR,
        source: { kind: 'RECORD' },
        results: ['NORMAL', 'OBSTRUCTION', 'DECLINED'],
        notDoneResults: ['DECLINED'],
      },
      inhaler,
      smoking,
      flu,
    ],
  },
  CKD: {
    code: 'CKD',
    label: 'Chronic kidney disease',
    icd10Prefixes: ['N18'],
    processes: [bp(HALF_YEAR), creatinine(HALF_YEAR), acr],
  },
  HEART_FAILURE: {
    code: 'HEART_FAILURE',
    label: 'Heart failure',
    icd10Prefixes: ['I50'],
    processes: [
      bp(HALF_YEAR),
      creatinine(HALF_YEAR),
      {
        code: 'POTASSIUM',
        label: 'Potassium',
        intervalDays: HALF_YEAR,
        source: LAB.POTASSIUM,
      },
      weight(HALF_YEAR),
      flu,
    ],
  },
};

/** Treatment targets (placeholders until confirmed by national guidelines). */
export const TARGETS: Record<TargetCode, { label: string; description: string }> = {
  HBA1C: { label: 'HbA1c at target', description: 'HbA1c ≤ 7.5 % (58 mmol/mol)' },
  BP: {
    label: 'Blood pressure at target',
    description: 'Below 140/90 mmHg (below 150/90 mmHg from age 80)',
  },
  CHOLESTEROL: { label: 'Cholesterol at target', description: 'Total cholesterol < 5.0 mmol/L' },
};

/** Days without a first result before a never-done process counts as overdue. */
export const NEW_ENROLMENT_GRACE_DAYS = 90;
/** A process becomes "due soon" this many days before its due date. */
export const DUE_SOON_DAYS = 30;
/** Recall notifications for the same process are sent at most this often. */
export const RECALL_INTERVAL_DAYS = 90;

/** Normalised ICD-10 code: upper case, no dot or spaces ("e11.9" → "E119"). */
export const normIcd10 = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Registers whose codes match an ICD-10 diagnosis code. */
export function registersForIcd10(code: string): RegisterCode[] {
  const c = normIcd10(code);
  return REGISTER_CODES.filter((r) => REGISTERS[r].icd10Prefixes.some((p) => c.startsWith(p)));
}

/** All care processes with a RECORD source (recorded by hand), with their allowed results. */
export function recordProcess(register: RegisterCode, process: string): CareProcessDef | undefined {
  return REGISTERS[register].processes.find(
    (p) => p.code === process && p.source.kind === 'RECORD',
  );
}
