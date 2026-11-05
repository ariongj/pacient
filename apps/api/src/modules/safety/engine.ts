/**
 * Medication safety engine: checks a candidate medication for a patient against their other
 * medicines (active prescriptions and anything dispensed in the last 30 days), allergies, kidney
 * function, age and pregnancy. Data loading is batched (one round of queries for many patients);
 * evaluation is a pure function, so the pharmacy queue can check hundreds of prescriptions cheaply.
 *
 * Alerts carry an English message template plus values; `toPublicAlert` translates them for the
 * person looking at them. CURATED DEMO KNOWLEDGE – not a validated clinical database.
 */
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  allergies,
  diagnoses,
  drugInteractions,
  labResults,
  medicationCatalog,
  patients,
  prescriptions,
  vitalSigns,
} from '../../db/schema.js';
import { formatDateFor, tr, type Locale, type TrVars } from '../../i18n/index.js';
import {
  AGE_RULES,
  ALLERGY_GROUPS,
  BLOCKING,
  CLASS_PAIRS,
  CLASSES,
  CROSS_REACTIVE,
  KNOWN_INGREDIENTS,
  MAJOR_DUPLICATE_CLASSES,
  PREGNANCY_RULES,
  RENAL_RULES,
  SEVERITY_ORDER,
  SYNONYMS,
  type Severity,
} from './knowledge.js';
import { doseRuleIndex, evaluateDose, type DoseSummary, type StructuredDose } from './dosing.js';

export type AlertKind =
  'INTERACTION' | 'ALLERGY' | 'DUPLICATE' | 'DOSE' | 'RENAL' | 'PREGNANCY' | 'AGE';

export interface EngineAlert {
  /** Stable code used to override an alert, e.g. "INTERACTION:ibuprofen+warfarin". */
  code: string;
  kind: AlertKind;
  severity: Severity;
  blocking: boolean;
  /** English message template (translation key) and its values. */
  template: string;
  vars: TrVars;
  /** Values that are themselves translatable texts. */
  translateVars?: string[];
  management: string;
  details?: Record<string, unknown>;
}

export interface PublicAlert {
  code: string;
  kind: AlertKind;
  severity: Severity;
  blocking: boolean;
  message: string;
  management: string;
  details?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ ingredients ------------- */

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/\-\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = new Map<string, RegExp>();
function containsPhrase(text: string, phrase: string) {
  let re = phraseRe.get(phrase);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}($|[^a-z0-9])`);
    phraseRe.set(phrase, re);
  }
  return re.test(text);
}

/** Free-text medication name → INN ingredients (synonyms, known INNs, else the first word). */
export function ingredientsFromText(text: string, extraKnown: Iterable<string> = []): string[] {
  const t = norm(text);
  const found = new Set<string>();
  for (const [syn, inns] of Object.entries(SYNONYMS)) {
    if (containsPhrase(t, syn)) inns.forEach((i) => found.add(i));
  }
  for (const inn of KNOWN_INGREDIENTS) if (containsPhrase(t, inn)) found.add(inn);
  for (const inn of extraKnown) if (inn && containsPhrase(t, inn)) found.add(inn);
  // "clavulanic acid" alone, or an unknown first word, should still count as an ingredient.
  if (!found.size) {
    const first = t.split(/[\s/]/)[0] ?? '';
    if (first.length >= 4 && !/^\d/.test(first)) found.add(first);
  }
  return [...found];
}

/* ------------------------------------------------------------------ interaction cache ------- */

interface InteractionRow {
  id: string;
  ingredientA: string;
  ingredientB: string;
  severity: Severity;
  effect: string;
  management: string;
}
let cache: { at: number; pairs: Map<string, InteractionRow>; names: Set<string> } | null = null;

export function invalidateInteractionCache() {
  cache = null;
}

export async function interactionIndex(executor: Executor = db) {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const rows = await executor
    .select({
      id: drugInteractions.id,
      ingredientA: drugInteractions.ingredientA,
      ingredientB: drugInteractions.ingredientB,
      severity: drugInteractions.severity,
      effect: drugInteractions.effect,
      management: drugInteractions.management,
    })
    .from(drugInteractions)
    .where(eq(drugInteractions.isActive, true));
  const pairs = new Map<string, InteractionRow>();
  const names = new Set<string>();
  for (const r of rows) {
    pairs.set(pairKey(r.ingredientA, r.ingredientB), r);
    names.add(r.ingredientA);
    names.add(r.ingredientB);
  }
  cache = { at: Date.now(), pairs, names };
  return cache;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}+${b}` : `${b}+${a}`);
export const orderPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/* ------------------------------------------------------------------ patient context --------- */

export interface ContextMedication {
  id: string;
  medication: string;
  ingredients: string[];
  atc: string | null;
}

export interface PatientSafetyContext {
  patientId: string;
  ageYears: number | null;
  sex: string;
  allergies: { substance: string; severity: string; verificationStatus: string }[];
  medications: ContextMedication[];
  kidney: { egfr: number; source: 'EGFR' | 'CREATININE'; at: Date } | null;
  pregnant: boolean;
  /** Age in days (neonatal dosing) and the latest recorded weight (per-kg dosing). */
  ageDays?: number | null;
  weightKg?: number | null;
  weightAt?: Date | null;
}

export function ageInYears(dob: string, now = new Date()): number {
  const d = new Date(`${dob}T00:00:00Z`);
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

/** CKD-EPI 2021 (race-free) eGFR from serum creatinine in µmol/L. */
export function ckdEpi2021(creatinineUmolL: number, age: number, sex: string): number | null {
  if (age < 18 || !(creatinineUmolL > 0) || (sex !== 'FEMALE' && sex !== 'MALE')) return null;
  const scr = creatinineUmolL / 88.4;
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

const EGFR_CODES = ['33914-3', '62238-1', '98979-8', '48642-3', '48643-1', '69405-9'];
const CREATININE_CODES = ['2160-0', '14682-9'];

/** Loads everything the engine needs for several patients in one round of queries. */
export async function loadContexts(
  patientIds: string[],
  opts: { excludePrescriptionIds?: string[]; executor?: Executor; now?: Date } = {},
): Promise<Map<string, PatientSafetyContext>> {
  const executor = opts.executor ?? db;
  const now = opts.now ?? new Date();
  const ids = [...new Set(patientIds)];
  const out = new Map<string, PatientSafetyContext>();
  if (!ids.length) return out;
  const index = await interactionIndex(executor);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const since365 = new Date(now.getTime() - 365 * 86_400_000);

  const [people, allergyRows, medRows, labRows, pregnancyRows, weightRows] = await Promise.all([
    executor
      .select({ id: patients.id, dob: patients.dateOfBirth, sex: patients.sex })
      .from(patients)
      .where(inArray(patients.id, ids)),
    executor
      .select({
        patientId: allergies.patientId,
        substance: allergies.substance,
        severity: allergies.severity,
        verificationStatus: allergies.verificationStatus,
      })
      .from(allergies)
      .where(and(inArray(allergies.patientId, ids), ne(allergies.verificationStatus, 'REFUTED'))),
    executor
      .select({
        id: prescriptions.id,
        patientId: prescriptions.patientId,
        medication: prescriptions.medication,
        ingredients: medicationCatalog.ingredients,
        atc: medicationCatalog.atcCode,
      })
      .from(prescriptions)
      .leftJoin(medicationCatalog, eq(medicationCatalog.id, prescriptions.catalogItemId))
      .where(
        and(
          inArray(prescriptions.patientId, ids),
          or(
            eq(prescriptions.status, 'ACTIVE'),
            and(ne(prescriptions.status, 'CANCELLED'), gt(prescriptions.dispensedAt, since30)),
          ),
        ),
      ),
    executor
      .select({
        patientId: labResults.patientId,
        testName: labResults.testName,
        testCode: labResults.testCode,
        value: labResults.value,
        unit: labResults.unit,
        collectedAt: labResults.collectedAt,
      })
      .from(labResults)
      .where(
        and(
          inArray(labResults.patientId, ids),
          isNull(labResults.supersededById),
          gt(labResults.collectedAt, since365),
          or(
            inArray(labResults.testCode, [...EGFR_CODES, ...CREATININE_CODES]),
            sql`lower(${labResults.testName}) ~ '(egfr|creatinin|kreatinin)'`,
          ),
        ),
      )
      .orderBy(desc(labResults.collectedAt)),
    executor
      .select({ patientId: diagnoses.patientId })
      .from(diagnoses)
      .where(
        and(
          inArray(diagnoses.patientId, ids),
          ne(diagnoses.status, 'RESOLVED'),
          sql`(${diagnoses.icd10Code} ~ '^O[0-9]' OR ${diagnoses.icd10Code} ~ '^Z3[345]')`,
        ),
      ),
    executor
      .selectDistinctOn([vitalSigns.patientId], {
        patientId: vitalSigns.patientId,
        weightKg: vitalSigns.weightKg,
        recordedAt: vitalSigns.recordedAt,
      })
      .from(vitalSigns)
      .where(and(inArray(vitalSigns.patientId, ids), sql`${vitalSigns.weightKg} IS NOT NULL`))
      .orderBy(vitalSigns.patientId, desc(vitalSigns.recordedAt)),
  ]);
  const weights = new Map(weightRows.map((w) => [w.patientId, w]));

  const pregnant = new Set(pregnancyRows.map((r) => r.patientId));
  for (const p of people) {
    const age = p.dob ? ageInYears(p.dob, now) : null;
    let kidney: PatientSafetyContext['kidney'] = null;
    for (const l of labRows) {
      if (l.patientId !== p.id) continue;
      const value = Number.parseFloat(String(l.value).replace(',', '.'));
      if (!Number.isFinite(value)) continue;
      const isEgfr =
        (l.testCode && EGFR_CODES.includes(l.testCode)) || /egfr/i.test(l.testName ?? '');
      if (isEgfr) {
        kidney = { egfr: Math.round(value), source: 'EGFR', at: l.collectedAt };
        break;
      }
      // Creatinine: µmol/L unless the unit says mg/dL (or the value is clearly in mg/dL).
      const umol = /mg/i.test(l.unit ?? '') || value < 20 ? value * 88.4 : value;
      const egfr = age !== null ? ckdEpi2021(umol, age, p.sex) : null;
      if (egfr !== null) {
        kidney = { egfr, source: 'CREATININE', at: l.collectedAt };
        break;
      }
    }
    out.set(p.id, {
      patientId: p.id,
      ageYears: age,
      sex: p.sex,
      allergies: allergyRows.filter((a) => a.patientId === p.id),
      medications: medRows
        .filter((m) => m.patientId === p.id && !opts.excludePrescriptionIds?.includes(m.id))
        .map((m) => ({
          id: m.id,
          medication: m.medication,
          ingredients: m.ingredients?.length
            ? m.ingredients
            : ingredientsFromText(m.medication, index.names),
          atc: m.atc ?? null,
        })),
      kidney,
      pregnant: pregnant.has(p.id) && p.sex === 'FEMALE' && age !== null && age >= 12 && age <= 55,
      ageDays: p.dob
        ? Math.floor((now.getTime() - new Date(`${p.dob}T00:00:00Z`).getTime()) / 86_400_000)
        : null,
      weightKg: weights.get(p.id)?.weightKg ? Number(weights.get(p.id)!.weightKg) : null,
      weightAt: weights.get(p.id)?.recordedAt ?? null,
    });
  }
  return out;
}

export interface Candidate {
  medication: string;
  ingredients: string[];
  atc: string | null;
  /** Catalogue strength and form ("500 mg", "tablet") for converting countable doses to mg. */
  strength?: string | null;
  form?: string | null;
}

/** Resolves a candidate (catalogue item or free text) to ingredients and ATC code. */
export async function resolveCandidate(
  medication: string,
  catalogItemId?: string | null,
  executor: Executor = db,
): Promise<Candidate> {
  if (catalogItemId) {
    const [item] = await executor
      .select({
        name: medicationCatalog.name,
        ingredients: medicationCatalog.ingredients,
        atc: medicationCatalog.atcCode,
        strength: medicationCatalog.strength,
        form: medicationCatalog.form,
      })
      .from(medicationCatalog)
      .where(eq(medicationCatalog.id, catalogItemId));
    if (item) {
      const index = await interactionIndex(executor);
      return {
        medication,
        ingredients: item.ingredients?.length
          ? item.ingredients
          : ingredientsFromText(item.name, index.names),
        atc: item.atc ?? null,
        strength: item.strength ?? null,
        form: item.form ?? null,
      };
    }
  }
  const index = await interactionIndex(executor);
  return { medication, ingredients: ingredientsFromText(medication, index.names), atc: null };
}

/* ------------------------------------------------------------------ evaluation -------------- */

const classesOf = (ingredients: string[], atc: string | null) =>
  Object.entries(CLASSES)
    .filter(
      ([, c]) =>
        ingredients.some((i) => c.members.includes(i)) ||
        Boolean(atc && c.atc?.some((a) => atc.startsWith(a))),
    )
    .map(([k]) => k);

const ALLERGY_SEVERITY_WORD: Record<string, string> = {
  MILD: 'mild',
  MODERATE: 'moderate',
  SEVERE: 'severe',
  LIFE_THREATENING: 'life-threatening',
};
const ALLERGY_STATUS_WORD: Record<string, string> = {
  CONFIRMED: 'confirmed',
  UNCONFIRMED: 'unconfirmed',
};

function alert(
  kind: AlertKind,
  key: string,
  severity: Severity,
  template: string,
  vars: TrVars,
  management: string,
  translateVars?: string[],
  details?: Record<string, unknown>,
): EngineAlert {
  return {
    code: `${kind}:${key}`,
    kind,
    severity,
    blocking: BLOCKING.includes(severity),
    template,
    vars,
    translateVars,
    management,
    details,
  };
}

/**
 * Pure evaluation: alerts for giving `candidate` to the patient described by `ctx`.
 * `interactions` is the active interaction index.
 */
export function evaluate(
  ctx: PatientSafetyContext,
  candidate: { medication: string; ingredients: string[]; atc: string | null },
  interactions: Map<string, InteractionRow>,
): EngineAlert[] {
  const alerts: EngineAlert[] = [];
  const ings = candidate.ingredients;
  const candClasses = classesOf(ings, candidate.atc);

  // 1. Interactions and duplicates against other medicines.
  for (const other of ctx.medications) {
    for (const a of ings) {
      for (const b of other.ingredients) {
        if (a === b) {
          alerts.push(
            alert(
              'DUPLICATE',
              `ingredient:${a}`,
              'MODERATE',
              'Duplicate therapy: the patient already takes {other} ({ingredient}).',
              { other: other.medication, ingredient: a },
              'Check whether both are intended; stop one or adjust the total dose.',
              undefined,
              { prescriptionId: other.id },
            ),
          );
          continue;
        }
        const hit = interactions.get(pairKey(a, b));
        if (hit) {
          alerts.push(
            alert(
              'INTERACTION',
              pairKey(a, b),
              hit.severity,
              'Interaction with {other}: {effect}',
              { other: other.medication, effect: hit.effect },
              hit.management,
              ['effect'],
              { prescriptionId: other.id, interactionId: hit.id, ingredients: orderPair(a, b) },
            ),
          );
        }
      }
    }
    const otherClasses = classesOf(other.ingredients, other.atc);
    for (const c of candClasses) {
      if (otherClasses.includes(c) && !other.ingredients.some((i) => ings.includes(i))) {
        alerts.push(
          alert(
            'DUPLICATE',
            `class:${c}`,
            MAJOR_DUPLICATE_CLASSES.has(c) ? 'MAJOR' : 'MODERATE',
            'Duplicate therapy: {other} is also one of the {group}.',
            { other: other.medication, group: CLASSES[c]!.label },
            'Combining two medicines of the same group rarely helps and adds side effects; review whether both are needed.',
            ['group'],
            { prescriptionId: other.id, class: c },
          ),
        );
      }
    }
    for (const rule of CLASS_PAIRS) {
      const hitPair =
        (candClasses.includes(rule.a) && otherClasses.includes(rule.b)) ||
        (candClasses.includes(rule.b) && otherClasses.includes(rule.a));
      if (hitPair) {
        alerts.push(
          alert(
            'INTERACTION',
            `class:${[rule.a, rule.b].sort().join('+')}`,
            rule.severity,
            'Interaction with {other}: {effect}',
            { other: other.medication, effect: rule.effect },
            rule.management,
            ['effect'],
            { prescriptionId: other.id },
          ),
        );
      }
    }
    // Same ATC level 4 without a known class (catalogue items only).
    if (
      candidate.atc &&
      other.atc &&
      candidate.atc.slice(0, 5) === other.atc.slice(0, 5) &&
      !candClasses.some((c) => otherClasses.includes(c)) &&
      !other.ingredients.some((i) => ings.includes(i))
    ) {
      alerts.push(
        alert(
          'DUPLICATE',
          `atc:${candidate.atc.slice(0, 5)}`,
          'MINOR',
          'Duplicate therapy: {other} is in the same therapeutic group (ATC {atc}).',
          { other: other.medication, atc: candidate.atc.slice(0, 5) },
          'Check whether both are intended.',
          undefined,
          { prescriptionId: other.id },
        ),
      );
    }
  }

  // 2. Allergies, including groups and partial cross-reactivity.
  for (const a of ctx.allergies) {
    const text = norm(a.substance);
    const subst = ingredientsFromText(a.substance);
    const groups = Object.entries(ALLERGY_GROUPS)
      .filter(
        ([, g]) =>
          g.words.some((w) => containsPhrase(text, w)) || subst.some((s) => g.members.includes(s)),
      )
      .map(([k]) => k);
    const direct =
      ings.some((i) => subst.includes(i) || containsPhrase(text, i)) ||
      groups.some((g) => ALLERGY_GROUPS[g]!.members.some((m) => ings.includes(m)));
    const vars = {
      substance: a.substance,
      severity: ALLERGY_SEVERITY_WORD[a.severity] ?? a.severity.toLowerCase(),
      status: ALLERGY_STATUS_WORD[a.verificationStatus] ?? a.verificationStatus.toLowerCase(),
    };
    if (direct) {
      const strong =
        (a.severity === 'SEVERE' || a.severity === 'LIFE_THREATENING') &&
        a.verificationStatus === 'CONFIRMED';
      alerts.push(
        alert(
          'ALLERGY',
          norm(a.substance),
          strong ? 'CONTRAINDICATED' : 'MAJOR',
          'Recorded allergy to {substance} ({severity}, {status}).',
          vars,
          'Do not give unless the allergy has been ruled out; choose an alternative.',
          ['severity', 'status'],
        ),
      );
      continue;
    }
    for (const rule of CROSS_REACTIVE) {
      if (!groups.includes(rule.allergy)) continue;
      if (ALLERGY_GROUPS[rule.drugs]!.members.some((m) => ings.includes(m))) {
        alerts.push(
          alert(
            'ALLERGY',
            `cross:${rule.allergy}:${rule.drugs}`,
            rule.severity,
            'Allergy to {substance}: {note}',
            { substance: a.substance, note: rule.note },
            'Use only if the benefit outweighs the risk, and monitor for an allergic reaction.',
            ['note'],
          ),
        );
      }
    }
  }

  // 3. Kidney function.
  if (ctx.kidney) {
    for (const r of RENAL_RULES) {
      if (!r.ingredients.some((i) => ings.includes(i))) continue;
      const rule = r.rules.find((x) => ctx.kidney!.egfr < x.below);
      if (rule) {
        alerts.push(
          alert(
            'RENAL',
            r.ingredients.find((i) => ings.includes(i))!,
            rule.severity,
            'Kidney function: eGFR {egfr} ml/min/1.73 m² ({date}). {advice}',
            { egfr: ctx.kidney.egfr, date: ctx.kidney.at, advice: rule.advice },
            'Adjust or choose an alternative according to kidney function.',
            ['advice'],
            { egfr: ctx.kidney.egfr, source: ctx.kidney.source },
          ),
        );
      }
    }
  }

  // 4. Age.
  if (ctx.ageYears !== null) {
    for (const r of AGE_RULES) {
      if (!r.ingredients.some((i) => ings.includes(i))) continue;
      const applies =
        (r.maxAgeExclusive !== undefined && ctx.ageYears < r.maxAgeExclusive) ||
        (r.minAge !== undefined && ctx.ageYears >= r.minAge);
      if (applies) {
        alerts.push(
          alert(
            'AGE',
            r.ingredients.find((i) => ings.includes(i))!,
            r.severity,
            'Age {age}: {advice}',
            { age: ctx.ageYears, advice: r.advice },
            'Choose an age-appropriate alternative.',
            ['advice'],
          ),
        );
      }
    }
  }

  // 5. Pregnancy.
  if (ctx.pregnant) {
    for (const r of PREGNANCY_RULES) {
      if (!r.ingredients.some((i) => ings.includes(i))) continue;
      alerts.push(
        alert(
          'PREGNANCY',
          r.ingredients.find((i) => ings.includes(i))!,
          r.severity,
          'Pregnancy: {advice}',
          { advice: r.advice },
          'Choose a pregnancy-compatible alternative; discuss with obstetrics if unsure.',
          ['advice'],
        ),
      );
    }
  }

  // One alert per code, most severe first.
  const byCode = new Map<string, EngineAlert>();
  for (const a of alerts) {
    const prev = byCode.get(a.code);
    if (!prev || SEVERITY_ORDER.indexOf(a.severity) < SEVERITY_ORDER.indexOf(prev.severity)) {
      byCode.set(a.code, a);
    }
  }
  return [...byCode.values()].sort(
    (x, y) => SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity),
  );
}

const bySeverity = (x: EngineAlert, y: EngineAlert) =>
  SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity);

/**
 * Full check for one patient: load, resolve and evaluate – plus the dose-range check when a
 * structured dose is given. `checkMedication` returns only the alerts.
 */
export async function checkMedicationDetailed(
  patientId: string,
  medication: string,
  catalogItemId?: string | null,
  opts: {
    excludePrescriptionIds?: string[];
    executor?: Executor;
    dose?: StructuredDose | null;
  } = {},
): Promise<{
  alerts: EngineAlert[];
  candidate: Candidate;
  context: PatientSafetyContext | null;
  dose: DoseSummary | null;
}> {
  const executor = opts.executor ?? db;
  const [contexts, candidate, index, rules] = await Promise.all([
    loadContexts([patientId], { excludePrescriptionIds: opts.excludePrescriptionIds, executor }),
    resolveCandidate(medication, catalogItemId, executor),
    interactionIndex(executor),
    opts.dose ? doseRuleIndex(executor) : Promise.resolve(null),
  ]);
  const ctx = contexts.get(patientId) ?? null;
  if (!ctx) return { alerts: [], candidate, context: null, dose: null };
  const alerts = evaluate(ctx, candidate, index.pairs);
  let dose: DoseSummary | null = null;
  if (opts.dose && rules) {
    const result = evaluateDose(ctx, candidate, opts.dose, rules);
    dose = result.summary;
    alerts.push(...result.alerts);
    alerts.sort(bySeverity);
  }
  return { alerts, candidate, context: ctx, dose };
}

/** Convenience: load, resolve and evaluate for one patient. */
export async function checkMedication(
  patientId: string,
  medication: string,
  catalogItemId?: string | null,
  opts: {
    excludePrescriptionIds?: string[];
    executor?: Executor;
    dose?: StructuredDose | null;
  } = {},
): Promise<EngineAlert[]> {
  return (await checkMedicationDetailed(patientId, medication, catalogItemId, opts)).alerts;
}

/* ------------------------------------------------------------------ translation ------------- */

/** Quantities such as "2.5 mg" use a decimal comma in Albanian and Serbian. */
const QUANTITY_RE = /^\d+\.\d+(?: [A-Za-zµ/%]+)?$/;

function translatedVars(locale: Locale, a: { vars: TrVars; translateVars?: string[] }): TrVars {
  const vars: TrVars = { ...a.vars };
  for (const k of a.translateVars ?? []) {
    const v = vars[k];
    if (typeof v === 'string') vars[k] = tr(locale, v);
  }
  if (locale !== 'en') {
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'string' && QUANTITY_RE.test(v)) vars[k] = v.replace('.', ',');
      else if (typeof v === 'number' && !Number.isInteger(v)) vars[k] = String(v).replace('.', ',');
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) vars[k] = new Date(v);
    if (k === 'date' && vars[k] instanceof Date) vars[k] = formatDateFor(locale, vars[k] as Date);
  }
  return vars;
}

export function toPublicAlert(a: EngineAlert, locale: Locale): PublicAlert {
  return {
    code: a.code,
    kind: a.kind,
    severity: a.severity,
    blocking: a.blocking,
    message: tr(locale, a.template, translatedVars(locale, a)),
    management: tr(locale, a.management),
    details: a.details,
  };
}

/** English rendering for storage (prescription_alerts.message). */
export const renderEnglish = (a: EngineAlert) => tr('en', a.template, translatedVars('en', a));

/** Stored alert row → public alert in the reader's language (uses the saved template). */
export function storedToPublic(
  row: {
    id: string;
    kind: string;
    severity: Severity;
    message: string;
    details: Record<string, unknown> | null;
    overrideReason: string | null;
    overriddenById: string | null;
    overriddenByName?: string | null;
    createdAt: Date;
  },
  locale: Locale,
) {
  const d = row.details ?? {};
  const template = typeof d.template === 'string' ? d.template : null;
  const management = typeof d.management === 'string' ? d.management : '';
  const message = template
    ? tr(
        locale,
        template,
        translatedVars(locale, {
          vars: (d.vars as TrVars) ?? {},
          translateVars: (d.translateVars as string[]) ?? [],
        }),
      )
    : row.message;
  return {
    id: row.id,
    code: typeof d.code === 'string' ? d.code : `${row.kind}`,
    kind: row.kind as AlertKind,
    severity: row.severity,
    blocking: BLOCKING.includes(row.severity),
    message,
    management: management ? tr(locale, management) : '',
    overrideReason: row.overrideReason,
    overriddenBy: row.overriddenByName ?? null,
    createdAt: row.createdAt,
  };
}
