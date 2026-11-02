/**
 * Medication safety *decision support* for pharmacist verification.
 *
 * These checks flag possible problems for a professional to review; they never block or approve a
 * prescription on their own and are not a substitute for a validated drug-interaction database,
 * which a production deployment must integrate (see docs/BLUEPRINT-ALIGNMENT.md).
 */
export type AlertSeverity = 'HIGH' | 'MODERATE';

export interface SafetyAlert {
  kind: 'ALLERGY' | 'CROSS_REACTIVITY' | 'DUPLICATE_THERAPY';
  severity: AlertSeverity;
  message: string;
}

/** Drug classes keyed by the words patients and clinicians use when recording an allergy. */
const CLASSES: Record<string, string[]> = {
  penicillin: [
    'penicillin',
    'amoxicillin',
    'ampicillin',
    'flucloxacillin',
    'piperacillin',
    'co-amoxiclav',
  ],
  sulfonamide: [
    'sulfamethoxazole',
    'co-trimoxazole',
    'trimethoprim-sulfamethoxazole',
    'sulfasalazine',
    'sulfadiazine',
  ],
  nsaid: [
    'ibuprofen',
    'diclofenac',
    'naproxen',
    'aspirin',
    'ketorolac',
    'indomethacin',
    'celecoxib',
  ],
  aspirin: ['aspirin', 'acetylsalicylic acid'],
  codeine: ['codeine', 'co-codamol'],
  statin: ['atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin'],
};
/** Classes with documented partial cross-reactivity. */
const CROSS: Record<string, { drugs: string[]; note: string }> = {
  penicillin: {
    drugs: ['cefalexin', 'cephalexin', 'cefuroxime', 'ceftriaxone', 'cefazolin', 'cefixime'],
    note: 'cephalosporins have a small risk of cross-reactivity with penicillin allergy',
  },
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function classOf(allergen: string): string[] {
  const a = norm(allergen);
  return Object.entries(CLASSES)
    .filter(([cls, drugs]) => a.includes(cls) || drugs.some((d) => a.includes(d)))
    .map(([cls]) => cls);
}

/** First word of a medication name, used to compare products ("Amlodipine 5 mg" → "amlodipine"). */
export const ingredient = (medication: string) => norm(medication).split(' ')[0] ?? '';

export function checkPrescription(
  medication: string,
  allergies: { substance: string; severity: string; verificationStatus: string }[],
  otherActiveMedications: string[],
): SafetyAlert[] {
  const alerts: SafetyAlert[] = [];
  const med = norm(medication);
  const relevant = allergies.filter(
    (a) => a.verificationStatus === 'CONFIRMED' || a.verificationStatus === 'UNCONFIRMED',
  );

  for (const allergy of relevant) {
    const allergen = norm(allergy.substance);
    const classes = classOf(allergy.substance);
    const direct = med.includes(allergen) || allergen.includes(ingredient(medication));
    const inClass = classes.some((c) => CLASSES[c]!.some((d) => med.includes(d)));
    if (direct || inClass) {
      alerts.push({
        kind: 'ALLERGY',
        severity: 'HIGH',
        message: `Recorded allergy to ${allergy.substance} (${allergy.severity.toLowerCase().replace('_', '-')}, ${allergy.verificationStatus.toLowerCase()})`,
      });
      continue;
    }
    for (const c of classes) {
      const cross = CROSS[c];
      if (cross?.drugs.some((d) => med.includes(d))) {
        alerts.push({
          kind: 'CROSS_REACTIVITY',
          severity: 'MODERATE',
          message: `Allergy to ${allergy.substance}: ${cross.note}`,
        });
      }
    }
  }

  const base = ingredient(medication);
  if (base && otherActiveMedications.some((m) => ingredient(m) === base)) {
    alerts.push({
      kind: 'DUPLICATE_THERAPY',
      severity: 'MODERATE',
      message: `The patient already has an active prescription for ${base}`,
    });
  }
  return alerts;
}
