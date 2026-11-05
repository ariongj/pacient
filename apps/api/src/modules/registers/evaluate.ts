import {
  DUE_SOON_DAYS,
  NEW_ENROLMENT_GRACE_DAYS,
  REGISTERS,
  TARGETS,
  type CareProcessDef,
  type ProcessSource,
  type RegisterCode,
  type TargetCode,
} from './definitions.js';

/**
 * Pure evaluation of a patient's care processes from their record (no database access), shared by
 * the chart, the recall lists and the recall worker. The aggregate indicators (indicators.ts)
 * compute the same rules in SQL; a test checks that both agree.
 */

export interface LabPoint {
  testName: string;
  testCode: string | null;
  value: string;
  unit: string | null;
  collectedAt: Date;
}
export interface VitalPoint {
  systolic: number | null;
  diastolic: number | null;
  weightKg: string | number | null;
  heightCm: string | number | null;
  recordedAt: Date;
}
export interface RecordPoint {
  register: string;
  process: string;
  result: string;
  notes: string | null;
  performedAt: Date;
}
export interface ImmunizationPoint {
  vaccine: string;
  administeredAt: Date;
}
export interface PatientData {
  dateOfBirth: string;
  sex: string;
  labs: LabPoint[];
  vitals: VitalPoint[];
  records: RecordPoint[];
  immunizations: ImmunizationPoint[];
}

export type ProcessState = 'UP_TO_DATE' | 'DUE_SOON' | 'DUE' | 'OVERDUE';

export interface ProcessStatus {
  code: string;
  label: string;
  intervalDays: number;
  recordable: boolean;
  results: readonly string[] | null;
  last: {
    at: string;
    /** Short display value, e.g. "7.9 %", "142/88 mmHg", "NORMAL". */
    display: string;
    /** Extra context, e.g. "eGFR ≈ 62 mL/min/1.73 m²". */
    detail: string | null;
  } | null;
  dueDate: string;
  state: ProcessState;
  target: {
    code: TargetCode;
    description: string;
    /** null when there is no recent value to judge. */
    met: boolean | null;
  } | null;
  /** Up to 12 recent values for a trend line (HbA1c, systolic blood pressure). */
  trend: { at: string; value: number }[];
}

const DAY = 86_400_000;
const regex = (p: string) => new RegExp(p, 'i');
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function labMatches(source: ProcessSource, lab: Pick<LabPoint, 'testName' | 'testCode'>) {
  if (source.kind !== 'LAB') return false;
  if (lab.testCode && source.loinc.includes(lab.testCode)) return true;
  if (!regex(source.namePattern).test(lab.testName)) return false;
  return !(source.excludePattern && regex(source.excludePattern).test(lab.testName));
}

/** First number in a result value ("7,9" → 7.9, "<5.2" → 5.2); null when there is none. */
export function numericValue(value: string): number | null {
  const m = /\d+(?:\.\d+)?/.exec(value.replace(',', '.'));
  return m ? Number(m[0]) : null;
}

export function ageAt(dateOfBirth: string, at: Date): number {
  const d = new Date(`${dateOfBirth}T00:00:00Z`);
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

/** HbA1c in % (DCCT) or mmol/mol (IFCC; assumed when the unit says so or the value is > 20). */
export function hba1cMet(value: string, unit: string | null): boolean | null {
  const n = numericValue(value);
  if (n === null) return null;
  const ifcc = /mmol/i.test(unit ?? '') || n > 20;
  return ifcc ? n <= 58 : n <= 7.5;
}

/** Below 140/90, or below 150/90 from age 80 (age at the time of the measurement). */
export function bpMet(systolic: number, diastolic: number, age: number): boolean {
  return systolic < (age >= 80 ? 150 : 140) && diastolic < 90;
}

/** Total cholesterol < 5.0 mmol/L (or < 193 mg/dL when the value is clearly in mg/dL). */
export function cholesterolMet(value: string, unit: string | null): boolean | null {
  const n = numericValue(value);
  if (n === null) return null;
  const mgdl = /mg/i.test(unit ?? '') || n > 40;
  return mgdl ? n < 193 : n < 5.0;
}

/** CKD-EPI 2021 eGFR (mL/min/1.73 m²) from serum creatinine in µmol/L; adults only. */
export function egfrFromCreatinine(umolPerL: number, age: number, sex: string): number | null {
  if (age < 18 || umolPerL <= 0) return null;
  const scr = umolPerL / 88.4;
  const female = sex === 'FEMALE';
  const k = female ? 0.7 : 0.9;
  const a = female ? -0.241 : -0.302;
  const egfr =
    142 *
    Math.min(scr / k, 1) ** a *
    Math.max(scr / k, 1) ** -1.2 *
    0.9938 ** age *
    (female ? 1.012 : 1);
  return Math.round(egfr);
}

interface Occurrence {
  at: Date;
  display: string;
  detail: string | null;
  met: boolean | null;
  numeric: number | null;
}

/** Every occurrence of a process in the record, newest first. */
function occurrences(register: RegisterCode, def: CareProcessDef, data: PatientData): Occurrence[] {
  const s = def.source;
  switch (s.kind) {
    case 'LAB':
      return data.labs
        .filter((l) => labMatches(s, l))
        .sort((a, b) => b.collectedAt.getTime() - a.collectedAt.getTime())
        .map((l) => {
          const n = numericValue(l.value);
          let detail: string | null = null;
          let met: boolean | null = null;
          if (def.target === 'HBA1C') met = hba1cMet(l.value, l.unit);
          if (def.target === 'CHOLESTEROL') met = cholesterolMet(l.value, l.unit);
          if (def.code === 'CREATININE' && n !== null && !/egfr|filtrim/i.test(l.testName)) {
            const umol = /mg/i.test(l.unit ?? '') ? n * 88.4 : n;
            const e = egfrFromCreatinine(umol, ageAt(data.dateOfBirth, l.collectedAt), data.sex);
            if (e !== null) detail = `eGFR ≈ ${e} mL/min/1.73 m²`;
          }
          return {
            at: l.collectedAt,
            display: `${l.value}${l.unit ? ` ${l.unit}` : ''}`,
            detail,
            met,
            numeric: n,
          };
        });
    case 'BP':
      return data.vitals
        .filter((v) => v.systolic !== null && v.diastolic !== null)
        .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
        .map((v) => ({
          at: v.recordedAt,
          display: `${v.systolic}/${v.diastolic} mmHg`,
          detail: null,
          met: bpMet(v.systolic!, v.diastolic!, ageAt(data.dateOfBirth, v.recordedAt)),
          numeric: v.systolic,
        }));
    case 'WEIGHT':
      return data.vitals
        .filter((v) => v.weightKg !== null)
        .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
        .map((v) => {
          const kg = Number(v.weightKg);
          // BMI from the most recent height recorded up to then.
          const h = data.vitals
            .filter((x) => x.heightCm !== null && x.recordedAt <= v.recordedAt)
            .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0];
          const m = h ? Number(h.heightCm) / 100 : null;
          const bmi = m ? Math.round((kg / (m * m)) * 10) / 10 : null;
          return {
            at: v.recordedAt,
            display: `${kg} kg`,
            detail: bmi ? `BMI ${bmi}` : null,
            met: null,
            numeric: kg,
          };
        });
    case 'RECORD':
      return data.records
        .filter((r) => r.process === def.code && r.register === register)
        .filter((r) => !(def.notDoneResults ?? []).includes(r.result))
        .sort((a, b) => b.performedAt.getTime() - a.performedAt.getTime())
        .map((r) => ({
          at: r.performedAt,
          display: r.result,
          detail: r.notes,
          met: null,
          numeric: null,
        }));
    case 'IMMUNIZATION':
      return data.immunizations
        .filter((i) => regex(s.namePattern).test(i.vaccine))
        .sort((a, b) => b.administeredAt.getTime() - a.administeredAt.getTime())
        .map((i) => ({
          at: i.administeredAt,
          display: i.vaccine,
          detail: null,
          met: null,
          numeric: null,
        }));
  }
}

/** Status of every care process of one register for one patient. */
export function evaluateRegister(
  register: RegisterCode,
  enrolledAt: Date,
  data: PatientData,
  now = new Date(),
): ProcessStatus[] {
  return REGISTERS[register].processes.map((def) => {
    const all = occurrences(register, def, data);
    const last = all[0];
    const due = last
      ? new Date(last.at.getTime() + def.intervalDays * DAY)
      : new Date(enrolledAt.getTime() + NEW_ENROLMENT_GRACE_DAYS * DAY);
    // Never done: due straight away, overdue once the grace period after enrolment has passed.
    let state: ProcessState;
    if (now >= due) state = 'OVERDUE';
    else if (!last) state = 'DUE';
    else state = due.getTime() - now.getTime() <= DUE_SOON_DAYS * DAY ? 'DUE_SOON' : 'UP_TO_DATE';
    // Targets are judged on the latest value of the last 12 months.
    const recent = last && now.getTime() - last.at.getTime() <= 365 * DAY ? last : undefined;
    return {
      code: def.code,
      label: def.label,
      intervalDays: def.intervalDays,
      recordable: def.source.kind === 'RECORD',
      results: def.results ?? null,
      last: last ? { at: last.at.toISOString(), display: last.display, detail: last.detail } : null,
      dueDate: isoDate(due),
      state,
      target: def.target
        ? {
            code: def.target,
            description: TARGETS[def.target].description,
            met: recent ? recent.met : null,
          }
        : null,
      trend:
        def.code === 'HBA1C' || def.code === 'BLOOD_PRESSURE'
          ? all
              .filter((o) => o.numeric !== null)
              .slice(0, 12)
              .reverse()
              .map((o) => ({ at: o.at.toISOString(), value: o.numeric! }))
          : [],
    };
  });
}

export const isOverdue = (p: ProcessStatus) => p.state === 'OVERDUE';
