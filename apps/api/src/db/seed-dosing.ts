/**
 * Dose rules for dose-range checks (hazard H16). DEMO DOSE LIMITS – verify against a licensed
 * reference before any clinical use. Values are maximums per administration and per 24 hours;
 * `perKg` rules are multiplied by the latest recorded weight and capped by `absoluteMaxDaily`.
 */
import { db } from './client.js';
import { doseRules } from './schema.js';
import { invalidateDoseRuleCache, type AgeGroup } from '../modules/safety/dosing.js';

type Rule = [
  ingredient: string,
  route: string,
  ageGroup: AgeGroup,
  unit: 'mg' | 'mcg' | 'g' | 'IU' | 'units',
  perKg: boolean,
  maxSingle: number | null,
  maxDaily: number | null,
  absoluteMaxDaily: number | null,
  note: string | null,
];

/** Notes are English source texts, translated in the server dictionaries (sq-dosing, sr-dosing). */
export const NOTES = {
  ibuprofenOtc: 'Without a prescription (OTC) the maximum is 1200 mg per day.',
  nsaidElderly: 'Older adults: use the lowest effective dose for the shortest time.',
  amoxicillinSevere: 'Severe infections: up to 6 g per day may be used – document the indication.',
  metformin: 'Increase gradually; check kidney function (eGFR) before raising the dose.',
  enoxaparin:
    'Prophylaxis is usually 40 mg once a day; treatment 1 mg/kg every 12 hours – adjust for kidney function.',
  morphine:
    'Opioid-naive patients: start low (oral 5–10 mg every 4 hours); higher doses only with documented tolerance.',
  gentamicin: 'Once-daily dosing by weight; adjust by blood levels and kidney function.',
  azithromycin: 'Some regimens use 1 g as a single dose.',
  tramadol: 'Over 75 years: no more than 300 mg per day; lowers the seizure threshold.',
  furosemide: 'Higher doses are used in kidney failure under specialist care.',
  aspirin: 'Antiplatelet dose is 75–100 mg once a day.',
  clopidogrel: 'Loading dose 300–600 mg once; maintenance 75 mg once a day.',
  warfarin: 'Dose by INR; usual maintenance 2–10 mg once a day.',
  metoclopramide: 'Use for no more than 5 days (neurological side effects).',
  salbutamol: 'In an acute attack higher doses are given under supervision.',
  steroids: 'Higher doses are used in some conditions under specialist care.',
  diazepamElderly: 'Older adults: half the adult dose (risk of falls and confusion).',
  insulin: 'Dose by blood glucose; check the units carefully (U-100 pens).',
  lidocaine: 'Maximum 4.5 mg/kg without adrenaline (300 mg in total).',
  ondansetron: 'Single IV doses over 16 mg prolong the QT interval.',
  methotrexate:
    'Methotrexate for arthritis or psoriasis is taken ONCE A WEEK – a daily dose can be fatal.',
  ciprofloxacinChild: 'Use in children only when there is no suitable alternative.',
  neonatal: 'Neonates: extend the dosing interval; check with neonatology.',
} as const;

export const DOSE_RULES: Rule[] = [
  // Analgesics and antipyretics.
  ['paracetamol', 'ORAL', 'ADULT', 'mg', false, 1000, 4000, null, null],
  ['paracetamol', 'ORAL', 'CHILD', 'mg', true, 15, 60, 4000, null],
  ['paracetamol', 'ORAL', 'NEONATE', 'mg', true, 15, 60, null, NOTES.neonatal],
  ['paracetamol', 'IV', 'ADULT', 'mg', false, 1000, 4000, null, null],
  ['paracetamol', 'IV', 'CHILD', 'mg', true, 15, 60, 4000, null],
  ['paracetamol', 'RECTAL', 'ADULT', 'mg', false, 1000, 4000, null, null],
  ['paracetamol', 'RECTAL', 'CHILD', 'mg', true, 20, 60, 4000, null],
  ['ibuprofen', 'ORAL', 'ADULT', 'mg', false, 800, 2400, null, NOTES.ibuprofenOtc],
  ['ibuprofen', 'ORAL', 'CHILD', 'mg', true, 10, 40, 2400, null],
  ['ibuprofen', 'ORAL', 'ELDERLY', 'mg', false, 400, 1200, null, NOTES.nsaidElderly],
  ['diclofenac', 'ORAL', 'ADULT', 'mg', false, 75, 150, null, null],
  ['metamizole', 'ORAL', 'ADULT', 'mg', false, 1000, 4000, null, null],
  ['metamizole', 'IV', 'ADULT', 'mg', false, 2500, 5000, null, null],
  ['acetylsalicylic acid', 'ORAL', 'ADULT', 'mg', false, 1000, 4000, null, NOTES.aspirin],
  ['tramadol', 'ORAL', 'ADULT', 'mg', false, 100, 400, null, null],
  ['tramadol', 'ORAL', 'ELDERLY', 'mg', false, 100, 300, null, NOTES.tramadol],
  ['morphine', 'ORAL', 'ADULT', 'mg', false, 30, 180, null, NOTES.morphine],
  ['morphine', 'IV', 'ADULT', 'mg', false, 10, 60, null, NOTES.morphine],
  ['morphine', 'SC', 'ADULT', 'mg', false, 10, 60, null, NOTES.morphine],
  ['morphine', 'ORAL', 'CHILD', 'mg', true, 0.3, 1.8, 180, NOTES.morphine],
  // Antibiotics.
  ['amoxicillin', 'ORAL', 'ADULT', 'mg', false, 1000, 3000, null, NOTES.amoxicillinSevere],
  ['amoxicillin', 'ORAL', 'CHILD', 'mg', true, 30, 90, 4000, null],
  ['clavulanic acid', 'ORAL', 'ADULT', 'mg', false, 125, 375, null, null],
  ['ceftriaxone', 'IV', 'ADULT', 'mg', false, 2000, 4000, null, null],
  ['ceftriaxone', 'IM', 'ADULT', 'mg', false, 2000, 4000, null, null],
  ['ceftriaxone', 'IV', 'CHILD', 'mg', true, 80, 100, 4000, null],
  ['azithromycin', 'ORAL', 'ADULT', 'mg', false, 500, 500, null, NOTES.azithromycin],
  ['azithromycin', 'ORAL', 'CHILD', 'mg', true, 10, 10, 500, null],
  ['ciprofloxacin', 'ORAL', 'ADULT', 'mg', false, 750, 1500, null, null],
  ['ciprofloxacin', 'IV', 'ADULT', 'mg', false, 400, 1200, null, null],
  ['ciprofloxacin', 'ORAL', 'CHILD', 'mg', true, 20, 40, 1500, NOTES.ciprofloxacinChild],
  ['nitrofurantoin', 'ORAL', 'ADULT', 'mg', false, 100, 400, null, null],
  ['gentamicin', 'IV', 'ADULT', 'mg', true, 7, 7, null, NOTES.gentamicin],
  ['gentamicin', 'IV', 'CHILD', 'mg', true, 7, 7, null, NOTES.gentamicin],
  ['gentamicin', 'IV', 'NEONATE', 'mg', true, 5, 5, null, NOTES.neonatal],
  // Cardiovascular, diabetes, anticoagulants.
  ['metformin', 'ORAL', 'ADULT', 'mg', false, 1000, 3000, null, NOTES.metformin],
  ['gliclazide', 'ORAL', 'ADULT', 'mg', false, 120, 120, null, null],
  ['insulin glargine', 'SC', 'ADULT', 'IU', false, 100, 100, null, NOTES.insulin],
  ['amlodipine', 'ORAL', 'ADULT', 'mg', false, 10, 10, null, null],
  ['ramipril', 'ORAL', 'ADULT', 'mg', false, 10, 10, null, null],
  ['bisoprolol', 'ORAL', 'ADULT', 'mg', false, 20, 20, null, null],
  ['furosemide', 'ORAL', 'ADULT', 'mg', false, 160, 600, null, NOTES.furosemide],
  ['furosemide', 'IV', 'ADULT', 'mg', false, 100, 400, null, NOTES.furosemide],
  ['furosemide', 'ORAL', 'CHILD', 'mg', true, 2, 6, 80, null],
  ['atorvastatin', 'ORAL', 'ADULT', 'mg', false, 80, 80, null, null],
  ['clopidogrel', 'ORAL', 'ADULT', 'mg', false, 600, 600, null, NOTES.clopidogrel],
  ['warfarin', 'ORAL', 'ADULT', 'mg', false, 15, 15, null, NOTES.warfarin],
  ['enoxaparin', 'SC', 'ADULT', 'mg', true, 1.5, 2, 400, NOTES.enoxaparin],
  // Gastro-intestinal.
  ['omeprazole', 'ORAL', 'ADULT', 'mg', false, 40, 80, null, null],
  ['pantoprazole', 'IV', 'ADULT', 'mg', false, 80, 160, null, null],
  ['metoclopramide', 'ORAL', 'ADULT', 'mg', false, 10, 30, null, NOTES.metoclopramide],
  ['metoclopramide', 'IV', 'ADULT', 'mg', false, 10, 30, null, NOTES.metoclopramide],
  ['metoclopramide', 'ORAL', 'CHILD', 'mg', true, 0.15, 0.5, 30, NOTES.metoclopramide],
  ['ondansetron', 'IV', 'ADULT', 'mg', false, 16, 32, null, NOTES.ondansetron],
  ['ondansetron', 'ORAL', 'ADULT', 'mg', false, 8, 24, null, null],
  // Respiratory, steroids, endocrine.
  ['salbutamol', 'INHALED', 'ADULT', 'mcg', false, 1000, 3200, null, NOTES.salbutamol],
  ['budesonide', 'INHALED', 'ADULT', 'mcg', false, 800, 1600, null, null],
  ['formoterol', 'INHALED', 'ADULT', 'mcg', false, 18, 54, null, null],
  ['prednisolone', 'ORAL', 'ADULT', 'mg', false, 80, 80, null, NOTES.steroids],
  ['prednisolone', 'ORAL', 'CHILD', 'mg', true, 2, 2, 60, null],
  ['dexamethasone', 'IV', 'ADULT', 'mg', false, 24, 40, null, NOTES.steroids],
  ['levothyroxine', 'ORAL', 'ADULT', 'mcg', false, 300, 300, null, null],
  ['methotrexate', 'ORAL', 'ADULT', 'mg', false, 25, 3.572, null, NOTES.methotrexate],
  // Other.
  ['ferrous sulfate', 'ORAL', 'ADULT', 'mg', false, 325, 975, null, null],
  ['folic acid', 'ORAL', 'ADULT', 'mg', false, 5, 15, null, null],
  ['oxytocin', 'IM', 'ADULT', 'IU', false, 10, 40, null, null],
  ['lidocaine', 'SC', 'ADULT', 'mg', true, 4.5, 4.5, 300, NOTES.lidocaine],
  ['sertraline', 'ORAL', 'ADULT', 'mg', false, 200, 200, null, null],
  ['diazepam', 'ORAL', 'ADULT', 'mg', false, 10, 30, null, null],
  ['diazepam', 'ORAL', 'ELDERLY', 'mg', false, 5, 15, null, NOTES.diazepamElderly],
];

export async function seedDoseRules() {
  await db
    .insert(doseRules)
    .values(
      DOSE_RULES.map(
        ([ingredient, route, ageGroup, unit, perKg, maxSingle, maxDaily, absolute, note]) => ({
          ingredient,
          route,
          ageGroup,
          unit,
          perKg,
          maxSingleDose: maxSingle === null ? null : String(maxSingle),
          maxDailyDose: maxDaily === null ? null : String(maxDaily),
          absoluteMaxDaily: absolute === null ? null : String(absolute),
          note,
        }),
      ),
    )
    .onConflictDoNothing();
  invalidateDoseRuleCache();
}

/** Demo data for this module (development seed only). */
export async function seedDosing(_: { facilityId: string }) {
  await seedDoseRules();
}
