/**
 * Default list of notifiable infectious diseases, modelled on Kosovo's law on the prevention and
 * control of infectious diseases and the ECDC list. ILLUSTRATIVE: it must be verified against the
 * current official list of the National Institute of Public Health of Kosovo (IKShPK) – the
 * Ministry can edit it in the app (code, ICD-10 prefixes, urgency).
 *
 * IMMEDIATE = report within 24 hours; WEEKLY = weekly reporting.
 */
export interface DefaultDisease {
  code: string;
  name: string;
  icd10Prefixes: string[];
  urgency: 'IMMEDIATE' | 'WEEKLY';
}

const range = (letter: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${letter}${String(from + i).padStart(2, '0')}`);

export const DEFAULT_DISEASES: DefaultDisease[] = [
  // Immediately notifiable
  { code: 'CHOLERA', name: 'Cholera', icd10Prefixes: ['A00'], urgency: 'IMMEDIATE' },
  { code: 'PLAGUE', name: 'Plague', icd10Prefixes: ['A20'], urgency: 'IMMEDIATE' },
  { code: 'ANTHRAX', name: 'Anthrax', icd10Prefixes: ['A22'], urgency: 'IMMEDIATE' },
  { code: 'BOTULISM', name: 'Botulism', icd10Prefixes: ['A05.1'], urgency: 'IMMEDIATE' },
  { code: 'DIPHTHERIA', name: 'Diphtheria', icd10Prefixes: ['A36'], urgency: 'IMMEDIATE' },
  { code: 'POLIO', name: 'Poliomyelitis', icd10Prefixes: ['A80'], urgency: 'IMMEDIATE' },
  { code: 'MEASLES', name: 'Measles', icd10Prefixes: ['B05'], urgency: 'IMMEDIATE' },
  { code: 'RABIES', name: 'Rabies', icd10Prefixes: ['A82'], urgency: 'IMMEDIATE' },
  {
    code: 'MENINGOCOCCAL',
    name: 'Meningococcal disease',
    icd10Prefixes: ['A39'],
    urgency: 'IMMEDIATE',
  },
  {
    code: 'CCHF',
    name: 'Crimean-Congo haemorrhagic fever',
    icd10Prefixes: ['A98.0'],
    urgency: 'IMMEDIATE',
  },
  {
    code: 'VHF',
    name: 'Other viral haemorrhagic fevers',
    icd10Prefixes: ['A96', 'A98.1', 'A98.2', 'A98.3', 'A98.4', 'A98.5', 'A98.8', 'A99'],
    urgency: 'IMMEDIATE',
  },
  { code: 'COVID19', name: 'COVID-19', icd10Prefixes: ['U07.1', 'U07.2'], urgency: 'IMMEDIATE' },
  { code: 'AVIAN_FLU', name: 'Avian influenza', icd10Prefixes: ['J09'], urgency: 'IMMEDIATE' },
  // Weekly
  { code: 'TB', name: 'Tuberculosis', icd10Prefixes: range('A', 15, 19), urgency: 'WEEKLY' },
  { code: 'HEPATITIS_A', name: 'Hepatitis A', icd10Prefixes: ['B15'], urgency: 'WEEKLY' },
  {
    code: 'HEPATITIS_B',
    name: 'Hepatitis B',
    icd10Prefixes: ['B16', 'B18.0', 'B18.1'],
    urgency: 'WEEKLY',
  },
  {
    code: 'HEPATITIS_C',
    name: 'Hepatitis C',
    icd10Prefixes: ['B17.1', 'B18.2'],
    urgency: 'WEEKLY',
  },
  { code: 'BRUCELLOSIS', name: 'Brucellosis', icd10Prefixes: ['A23'], urgency: 'WEEKLY' },
  { code: 'TULARAEMIA', name: 'Tularaemia', icd10Prefixes: ['A21'], urgency: 'WEEKLY' },
  { code: 'LEPTOSPIROSIS', name: 'Leptospirosis', icd10Prefixes: ['A27'], urgency: 'WEEKLY' },
  { code: 'SALMONELLOSIS', name: 'Salmonellosis', icd10Prefixes: ['A02'], urgency: 'WEEKLY' },
  { code: 'SHIGELLOSIS', name: 'Shigellosis', icd10Prefixes: ['A03'], urgency: 'WEEKLY' },
  { code: 'LEGIONELLOSIS', name: 'Legionellosis', icd10Prefixes: ['A48.1'], urgency: 'WEEKLY' },
  { code: 'PERTUSSIS', name: 'Pertussis', icd10Prefixes: ['A37'], urgency: 'WEEKLY' },
  { code: 'MUMPS', name: 'Mumps', icd10Prefixes: ['B26'], urgency: 'WEEKLY' },
  { code: 'RUBELLA', name: 'Rubella', icd10Prefixes: ['B06'], urgency: 'WEEKLY' },
  { code: 'VARICELLA', name: 'Varicella', icd10Prefixes: ['B01'], urgency: 'WEEKLY' },
  { code: 'SCARLET_FEVER', name: 'Scarlet fever', icd10Prefixes: ['A38'], urgency: 'WEEKLY' },
  { code: 'HIV', name: 'HIV infection', icd10Prefixes: range('B', 20, 24), urgency: 'WEEKLY' },
  { code: 'SYPHILIS', name: 'Syphilis', icd10Prefixes: range('A', 50, 53), urgency: 'WEEKLY' },
  { code: 'GONORRHOEA', name: 'Gonorrhoea', icd10Prefixes: ['A54'], urgency: 'WEEKLY' },
  { code: 'Q_FEVER', name: 'Q fever', icd10Prefixes: ['A78'], urgency: 'WEEKLY' },
  { code: 'INFLUENZA', name: 'Influenza', icd10Prefixes: ['J10', 'J11'], urgency: 'WEEKLY' },
  { code: 'TETANUS', name: 'Tetanus', icd10Prefixes: range('A', 33, 35), urgency: 'WEEKLY' },
  { code: 'LEISHMANIASIS', name: 'Leishmaniasis', icd10Prefixes: ['B55'], urgency: 'WEEKLY' },
  { code: 'ECHINOCOCCOSIS', name: 'Echinococcosis', icd10Prefixes: ['B67'], urgency: 'WEEKLY' },
  { code: 'TRICHINELLOSIS', name: 'Trichinellosis', icd10Prefixes: ['B75'], urgency: 'WEEKLY' },
];

/** ICD-10 codes are compared without dots and in upper case ("A05.1" ≡ "A051"). */
export const normaliseIcd = (code: string) => code.replace(/\./g, '').trim().toUpperCase();

/**
 * The disease a diagnosis code reports, if any. The longest matching prefix wins, so a specific
 * entry (e.g. "B18.1" hepatitis B) beats a broader one.
 */
export function matchDisease<T extends { icd10Prefixes: string[]; isActive?: boolean }>(
  icd10Code: string,
  diseases: T[],
): T | null {
  const code = normaliseIcd(icd10Code);
  let best: { disease: T; length: number } | null = null;
  for (const d of diseases) {
    if (d.isActive === false) continue;
    for (const raw of d.icd10Prefixes) {
      const prefix = normaliseIcd(raw);
      if (prefix && code.startsWith(prefix) && (!best || prefix.length > best.length)) {
        best = { disease: d, length: prefix.length };
      }
    }
  }
  return best?.disease ?? null;
}
