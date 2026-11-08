/**
 * Infection prevention reference content defined in code. ILLUSTRATIVE: the surveillance criteria
 * summarise ECDC/CDC-NHSN definitions and the restricted list follows the WHO AWaRe "Reserve" and
 * common hospital restriction lists; the hospital's infection control committee confirms both.
 */

export const PRECAUTIONS = ['CONTACT', 'DROPLET', 'AIRBORNE', 'PROTECTIVE'] as const;
export type Precaution = (typeof PRECAUTIONS)[number];

/** What staff must do for each precaution (shown with the badge). */
export const PRECAUTION_GUIDANCE: Record<Precaution, string> = {
  CONTACT:
    'Gloves and apron or gown for contact with the patient or surroundings; dedicated equipment.',
  DROPLET: 'Surgical mask within 1–2 metres; single room or cohort with the same organism.',
  AIRBORNE:
    'FFP2/FFP3 respirator; single room with the door closed (negative pressure if available).',
  PROTECTIVE:
    'Protects a vulnerable patient (e.g. neutropenia): hand hygiene, mask if unwell, no plants or fresh flowers.',
};

export const HAI_TYPES = [
  'CLABSI',
  'CAUTI',
  'VAP',
  'SSI',
  'CDI',
  'MRSA_BACTERAEMIA',
  'OTHER',
] as const;
export type HaiType = (typeof HAI_TYPES)[number];

/** Short surveillance criteria (onset ≥ 48 h after admission unless stated otherwise). */
export const HAI_CRITERIA: Record<
  HaiType,
  { label: string; criteria: string; device: string | null }
> = {
  CLABSI: {
    label: 'Central line-associated bloodstream infection',
    criteria:
      'Positive blood culture with a recognised pathogen (or two cultures with a common commensal and symptoms), central line in place for more than 2 days, no other source.',
    device: 'Central venous catheter',
  },
  CAUTI: {
    label: 'Catheter-associated urinary tract infection',
    criteria:
      'Fever or urinary symptoms with a urine culture of ≥ 10⁵ CFU/ml, urinary catheter in place for more than 2 days.',
    device: 'Urinary catheter',
  },
  VAP: {
    label: 'Ventilator-associated pneumonia',
    criteria:
      'New and persistent infiltrate on imaging with fever or leucocytosis and purulent secretions, mechanical ventilation for more than 2 days.',
    device: 'Mechanical ventilation',
  },
  SSI: {
    label: 'Surgical site infection',
    criteria:
      'Infection of the incision or organ/space within 30 days of the operation (90 days with an implant): pus, positive culture or a diagnosis by the surgeon.',
    device: null,
  },
  CDI: {
    label: 'Clostridioides difficile infection',
    criteria:
      'Diarrhoea (≥ 3 unformed stools in 24 h) with a positive toxin test, onset more than 3 days after admission.',
    device: null,
  },
  MRSA_BACTERAEMIA: {
    label: 'MRSA bloodstream infection',
    criteria:
      'Blood culture positive for meticillin-resistant Staphylococcus aureus, taken more than 48 h after admission.',
    device: null,
  },
  OTHER: {
    label: 'Other healthcare-associated infection',
    criteria:
      'Infection not present or incubating on admission, with onset 48 h or more after admission.',
    device: null,
  },
};

export const HAI_STATUSES = ['SUSPECTED', 'CONFIRMED', 'RULED_OUT'] as const;

/** Reserve antibiotics that need approval by the stewardship team (pharmacist or infection control). */
export interface RestrictedAgent {
  code: string;
  name: string;
  /** ATC codes (prefix match). */
  atc: string[];
  /** Spellings in medication names and ingredients (lower case, Albanian and Serbian included). */
  names: string[];
  /** Oral use is not restricted (e.g. oral vancomycin for C. difficile). */
  intravenousOnly?: boolean;
}

export const RESTRICTED_AGENTS: RestrictedAgent[] = [
  { code: 'MEROPENEM', name: 'Meropenem', atc: ['J01DH02'], names: ['meropenem'] },
  { code: 'IMIPENEM', name: 'Imipenem/cilastatin', atc: ['J01DH51'], names: ['imipenem'] },
  { code: 'ERTAPENEM', name: 'Ertapenem', atc: ['J01DH03'], names: ['ertapenem'] },
  {
    code: 'VANCOMYCIN',
    name: 'Vancomycin (intravenous)',
    atc: ['J01XA01'],
    names: ['vancomycin', 'vankomicin', 'vankomicinë'],
    intravenousOnly: true,
  },
  {
    code: 'TEICOPLANIN',
    name: 'Teicoplanin',
    atc: ['J01XA02'],
    names: ['teicoplanin', 'teikoplanin'],
  },
  { code: 'LINEZOLID', name: 'Linezolid', atc: ['J01XX08'], names: ['linezolid'] },
  { code: 'DAPTOMYCIN', name: 'Daptomycin', atc: ['J01XX09'], names: ['daptomycin', 'daptomicin'] },
  {
    code: 'COLISTIN',
    name: 'Colistin',
    atc: ['J01XB01'],
    names: ['colistin', 'kolistin', 'kolistinë', 'polymyxin e'],
  },
  {
    code: 'TIGECYCLINE',
    name: 'Tigecycline',
    atc: ['J01AA12'],
    names: ['tigecycline', 'tigeciklin'],
  },
  {
    code: 'CEFTAZIDIME_AVIBACTAM',
    name: 'Ceftazidime/avibactam',
    atc: ['J01DD52'],
    names: ['avibactam'],
  },
];

/** "Start smart, then focus": every restricted antibiotic is reviewed after 72 hours. */
export const REVIEW_AFTER_HOURS = 72;
export const REVIEW_OUTCOMES = ['CONTINUE', 'NARROW', 'SWITCH_ORAL', 'STOP'] as const;

/** Routes that count as oral (not restricted for intravenous-only agents). */
const ORAL = /^(oral|po|per os|gojore|oralno)$/i;

export function matchRestrictedAgent(input: {
  medication: string;
  route?: string | null;
  atcCode?: string | null;
  ingredients?: string[] | null;
}): RestrictedAgent | null {
  const text = [input.medication, ...(input.ingredients ?? [])].join(' ').toLowerCase();
  for (const agent of RESTRICTED_AGENTS) {
    const byAtc = Boolean(input.atcCode && agent.atc.some((a) => input.atcCode!.startsWith(a)));
    const byName = agent.names.some((n) => text.includes(n));
    if (!byAtc && !byName) continue;
    if (agent.intravenousOnly && input.route && ORAL.test(input.route.trim())) continue;
    return agent;
  }
  return null;
}

/**
 * Positive culture heuristic for "possible HAI" suggestions: a culture result (by test name)
 * whose value is not negative, collected more than 48 hours after admission, with no HAI already
 * recorded for the patient within 7 days. Deliberately simple; infection control decides.
 */
export const CULTURE_TEST = '(cultur|kultur|hemokult|urokult)';
export const NEGATIVE_VALUE =
  '(negativ|no growth|steril|pa rritje|nuk ka rritje|bez rasta|nije izolovan)';
