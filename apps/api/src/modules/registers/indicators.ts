import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  REGISTERS,
  TARGETS,
  type CareProcessDef,
  type RegisterCode,
  type TargetCode,
} from './definitions.js';

/**
 * Aggregate quality indicators per register, computed in SQL with the same rules as evaluate.ts:
 * - enrolled: active register members (not merged, not deceased);
 * - per care process: members for whom it was done in the last 12 months;
 * - per target: members whose latest value in the last 12 months meets the target.
 * Only counts leave this module. Counts below SMALL_CELL_THRESHOLD are suppressed together with
 * the percentages that would reveal them.
 */

const done = (def: CareProcessDef, register: RegisterCode): SQL => {
  const s = def.source;
  switch (s.kind) {
    case 'LAB':
      return sql`EXISTS (SELECT 1 FROM lab_results l
        WHERE l.patient_id = e.patient_id AND l.superseded_by_id IS NULL
          AND l.status <> 'PRELIMINARY' AND l.collected_at >= now() - interval '365 days'
          AND ${labMatch(s)})`;
    case 'BP':
      return sql`EXISTS (SELECT 1 FROM vital_signs v WHERE v.patient_id = e.patient_id
        AND v.systolic IS NOT NULL AND v.diastolic IS NOT NULL
        AND v.recorded_at >= now() - interval '365 days')`;
    case 'WEIGHT':
      return sql`EXISTS (SELECT 1 FROM vital_signs v WHERE v.patient_id = e.patient_id
        AND v.weight_kg IS NOT NULL AND v.recorded_at >= now() - interval '365 days')`;
    case 'RECORD': {
      const notDone = def.notDoneResults?.length
        ? sql`AND r.result NOT IN (${sql.join(
            def.notDoneResults.map((x) => sql`${x}`),
            sql`, `,
          )})`
        : sql``;
      return sql`EXISTS (SELECT 1 FROM care_process_records r WHERE r.patient_id = e.patient_id
        AND r.register = ${register} AND r.process = ${def.code}
        AND r.performed_at >= now() - interval '365 days' ${notDone})`;
    }
    case 'IMMUNIZATION':
      return sql`EXISTS (SELECT 1 FROM immunizations i WHERE i.patient_id = e.patient_id
        AND i.vaccine ~* ${s.namePattern} AND i.administered_at >= now() - interval '365 days')`;
  }
};

function labMatch(s: Extract<CareProcessDef['source'], { kind: 'LAB' }>): SQL {
  const codes = sql`ARRAY[${sql.join(
    s.loinc.map((c) => sql`${c}`),
    sql`, `,
  )}]::text[]`;
  const exclude = s.excludePattern ? sql`AND l.test_name !~* ${s.excludePattern}` : sql``;
  return sql`(l.test_code = ANY(${codes}) OR (l.test_name ~* ${s.namePattern} ${exclude}))`;
}

/** First number of a result value, as in numericValue() ("7,9" → 7.9). */
const num = sql`substring(replace(l.value, ',', '.') from '[0-9]+(\\.[0-9]+)?')::numeric`;

function targetMet(def: CareProcessDef, target: TargetCode): SQL {
  if (target === 'BP') {
    return sql`EXISTS (SELECT 1 FROM (
        SELECT v.systolic, v.diastolic, v.recorded_at FROM vital_signs v
        WHERE v.patient_id = e.patient_id AND v.systolic IS NOT NULL AND v.diastolic IS NOT NULL
          AND v.recorded_at >= now() - interval '365 days'
        ORDER BY v.recorded_at DESC LIMIT 1) last
      WHERE last.systolic < CASE WHEN date_part('year', age(last.recorded_at, p.date_of_birth)) >= 80
                                 THEN 150 ELSE 140 END
        AND last.diastolic < 90)`;
  }
  const s = def.source as Extract<CareProcessDef['source'], { kind: 'LAB' }>;
  const rule =
    target === 'HBA1C'
      ? sql`CASE WHEN last.unit ILIKE '%mmol%' OR last.n > 20 THEN last.n <= 58 ELSE last.n <= 7.5 END`
      : sql`CASE WHEN last.unit ILIKE '%mg%' OR last.n > 40 THEN last.n < 193 ELSE last.n < 5.0 END`;
  return sql`EXISTS (SELECT 1 FROM (
      SELECT l.unit, ${num} AS n FROM lab_results l
      WHERE l.patient_id = e.patient_id AND l.superseded_by_id IS NULL
        AND l.status <> 'PRELIMINARY' AND l.collected_at >= now() - interval '365 days'
        AND ${labMatch(s)}
      ORDER BY l.collected_at DESC LIMIT 1) last
    WHERE last.n IS NOT NULL AND ${rule})`;
}

export interface IndicatorCell {
  count: number | null;
  percent: number | null;
  suppressed: boolean;
}
export interface RegisterIndicators {
  register: RegisterCode;
  label: string;
  enrolled: number | null;
  suppressed: boolean;
  /** Enrolled per 1 000 registered (living, unmerged) patients of the same population. */
  prevalencePer1000: number | null;
  processes: ({ code: string; label: string } & IndicatorCell)[];
  targets: ({ code: TargetCode; label: string; description: string } & IndicatorCell)[];
}

const cell = (count: number, enrolled: number): IndicatorCell => {
  if (enrolled < SMALL_CELL_THRESHOLD || (count > 0 && count < SMALL_CELL_THRESHOLD)) {
    return { count: null, percent: null, suppressed: true };
  }
  return {
    count,
    percent: enrolled ? Math.round((count / enrolled) * 1000) / 10 : null,
    suppressed: false,
  };
};

export type IndicatorGroup = 'NONE' | 'FACILITY' | 'MUNICIPALITY';

export interface IndicatorRow {
  key: string | null;
  name: string | null;
  registers: RegisterIndicators[];
}

/**
 * Indicators for all registers, optionally limited to one facility, grouped by facility or
 * municipality (of the managing facility). Returns one row per group (one row when NONE).
 */
export async function computeIndicators(opts: {
  facilityId?: string | null;
  register?: RegisterCode;
  groupBy: IndicatorGroup;
}): Promise<IndicatorRow[]> {
  const registers = opts.register ? [opts.register] : (Object.keys(REGISTERS) as RegisterCode[]);
  const groupKey =
    opts.groupBy === 'FACILITY'
      ? sql`f.id::text`
      : opts.groupBy === 'MUNICIPALITY'
        ? sql`f.municipality`
        : sql`'ALL'`;
  const groupName =
    opts.groupBy === 'FACILITY'
      ? sql`f.name`
      : opts.groupBy === 'MUNICIPALITY'
        ? sql`f.municipality`
        : sql`'ALL'`;
  const facilityFilter = opts.facilityId ? sql`AND e.facility_id = ${opts.facilityId}` : sql``;

  // Denominator for prevalence: living, unmerged patients registered at the same facilities.
  const population = await db.execute<{ key: string; n: number }>(sql`
    SELECT ${groupKey} AS key, count(*)::int AS n
    FROM patients p JOIN facilities f ON f.id = p.primary_facility_id
    WHERE p.merged_into_id IS NULL AND p.deceased_at IS NULL
      ${opts.facilityId ? sql`AND p.primary_facility_id = ${opts.facilityId}` : sql``}
    GROUP BY 1`);
  const pop = new Map(population.rows.map((r) => [String(r.key), Number(r.n)]));

  const rows = new Map<string, IndicatorRow>();
  for (const register of registers) {
    const def = REGISTERS[register];
    const procCols = def.processes.map(
      (p, i) =>
        sql`count(*) FILTER (WHERE ${done(p, register)})::int AS ${sql.identifier(`p${i}`)}`,
    );
    const targetDefs = def.processes.filter((p) => p.target);
    const targetCols = targetDefs.map(
      (p, i) =>
        sql`count(*) FILTER (WHERE ${targetMet(p, p.target!)})::int AS ${sql.identifier(`t${i}`)}`,
    );
    const result = await db.execute<Record<string, string | number | null>>(sql`
      SELECT ${groupKey} AS key, ${groupName} AS name, count(*)::int AS enrolled,
             ${sql.join([...procCols, ...targetCols], sql`, `)}
      FROM register_enrolments e
      JOIN patients p ON p.id = e.patient_id
      JOIN facilities f ON f.id = e.facility_id
      WHERE e.register = ${register} AND e.status = 'ACTIVE'
        AND p.merged_into_id IS NULL AND p.deceased_at IS NULL ${facilityFilter}
      GROUP BY 1, 2
      ORDER BY 2`);
    for (const r of result.rows) {
      const key = String(r.key);
      const enrolled = Number(r.enrolled);
      const small = enrolled < SMALL_CELL_THRESHOLD;
      const popN = pop.get(key) ?? 0;
      const ind: RegisterIndicators = {
        register,
        label: def.label,
        enrolled: small ? null : enrolled,
        suppressed: small,
        prevalencePer1000: small || !popN ? null : Math.round((enrolled / popN) * 10_000) / 10,
        processes: def.processes.map((p, i) => ({
          code: p.code,
          label: p.label,
          ...cell(Number(r[`p${i}`] ?? 0), enrolled),
        })),
        targets: targetDefs.map((p, i) => ({
          code: p.target!,
          label: TARGETS[p.target!].label,
          description: TARGETS[p.target!].description,
          ...cell(Number(r[`t${i}`] ?? 0), enrolled),
        })),
      };
      let row = rows.get(key);
      if (!row) {
        row = {
          key: opts.groupBy === 'NONE' ? null : key,
          name: opts.groupBy === 'NONE' ? null : (r.name as string | null),
          registers: [],
        };
        rows.set(key, row);
      }
      row.registers.push(ind);
    }
  }
  // Registers with no members still appear (as suppressed zeros) in an ungrouped view.
  if (opts.groupBy === 'NONE') {
    const row = rows.get('ALL') ?? { key: null, name: null, registers: [] };
    for (const register of registers) {
      if (!row.registers.some((x) => x.register === register)) {
        const def = REGISTERS[register];
        row.registers.push({
          register,
          label: def.label,
          enrolled: 0,
          suppressed: false,
          prevalencePer1000: 0,
          processes: def.processes.map((p) => ({
            code: p.code,
            label: p.label,
            count: 0,
            percent: null,
            suppressed: false,
          })),
          targets: def.processes
            .filter((p) => p.target)
            .map((p) => ({
              code: p.target!,
              label: TARGETS[p.target!].label,
              description: TARGETS[p.target!].description,
              count: 0,
              percent: null,
              suppressed: false,
            })),
        });
      }
    }
    row.registers.sort((a, b) => registers.indexOf(a.register) - registers.indexOf(b.register));
    rows.set('ALL', row);
  }
  return [...rows.values()];
}
