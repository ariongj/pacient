/**
 * Patient-reported outcome measures (PROMs): questionnaire definitions and scoring.
 *
 * Only instruments that are free to use without a licence fee or permission are included:
 *  - PHQ-9 and GAD-7: developed by Drs Robert L. Spitzer, Janet B. W. Williams, Kurt Kroenke and
 *    colleagues with an educational grant from Pfizer Inc. "No permission required to reproduce,
 *    translate, display or distribute" (phqscreeners.com).
 *  - WHO-5 Well-Being Index: Psychiatric Centre North Zealand (who-5.org); free of charge and may be
 *    used without permission (non-commercial terms – confirm the current terms before national
 *    roll-out).
 *  - AUDIT-C: the first three questions of the WHO AUDIT (Babor et al., WHO 2001; AUDIT-C as
 *    described by Bush et al., 1998). The AUDIT is published by WHO for free use.
 * Licensed instruments (e.g. EQ-5D, SF-36) are deliberately not included.
 *
 * TRANSLATIONS: the Albanian (sq) and Serbian (sr) texts below are WORKING translations made for
 * this demonstration. They are NOT validated and must be replaced by validated translations
 * (official PHQ/GAD/WHO-5/AUDIT translations where they exist, otherwise a forward–backward
 * translation and cognitive testing) before any clinical use. The UI says so too.
 */

export type Lang = 'en' | 'sq' | 'sr';
export type Text = Record<Lang, string>;

export const INSTRUMENT_CODES = ['PHQ9', 'GAD7', 'WHO5', 'AUDITC'] as const;
export type InstrumentCode = (typeof INSTRUMENT_CODES)[number];

export const FREQUENCIES = ['ONCE', 'WEEKLY', 'MONTHLY', 'QUARTERLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface Option {
  value: number;
  text: Text;
}
export interface Item {
  code: string;
  text: Text;
  options: Option[];
}
export interface Band {
  code: string;
  /** Inclusive score range. */
  min: number;
  max: number;
}
export interface Instrument {
  code: InstrumentCode;
  name: string;
  /** What it measures (English; translated in the web app). */
  measures: string;
  stem: Text;
  items: Item[];
  minScore: number;
  maxScore: number;
  /** HIGHER_WORSE (symptoms) or HIGHER_BETTER (well-being). */
  direction: 'HIGHER_WORSE' | 'HIGHER_BETTER';
  bands: Band[];
  /** Minimum change in score that is considered clinically meaningful (null: none established). */
  mcid: number | null;
  /**
   * Sensitive mental-health or substance-use questionnaires: guardians never see or complete them
   * (adolescent confidentiality); only the young person and the care team do.
   */
  sensitive: boolean;
  terms: string;
  source: string;
  /** WORKING: sq/sr texts are unvalidated working translations. */
  translationStatus: 'WORKING';
}

const FREQ4: Option[] = [
  { value: 0, text: { en: 'Not at all', sq: 'Aspak', sr: 'Nimalo' } },
  { value: 1, text: { en: 'Several days', sq: 'Disa ditë', sr: 'Nekoliko dana' } },
  {
    value: 2,
    text: {
      en: 'More than half the days',
      sq: 'Më shumë se gjysmën e ditëve',
      sr: 'Više od polovine dana',
    },
  },
  { value: 3, text: { en: 'Nearly every day', sq: 'Pothuajse çdo ditë', sr: 'Skoro svaki dan' } },
];

const PHQ9: Instrument = {
  code: 'PHQ9',
  name: 'PHQ-9',
  measures: 'Depression symptoms',
  stem: {
    en: 'Over the last 2 weeks, how often have you been bothered by any of the following problems?',
    sq: 'Gjatë 2 javëve të fundit, sa shpesh ju kanë shqetësuar problemet e mëposhtme?',
    sr: 'Tokom poslednje 2 nedelje, koliko često su vas mučili sledeći problemi?',
  },
  items: [
    {
      en: 'Little interest or pleasure in doing things',
      sq: 'Pak interes ose kënaqësi për të bërë gjëra',
      sr: 'Malo interesovanja ili zadovoljstva u obavljanju stvari',
    },
    {
      en: 'Feeling down, depressed, or hopeless',
      sq: 'Ndiheni të mërzitur, të dëshpëruar ose pa shpresë',
      sr: 'Osećate se potišteno, depresivno ili beznadežno',
    },
    {
      en: 'Trouble falling or staying asleep, or sleeping too much',
      sq: 'Vështirësi për të fjetur ose për të qëndruar në gjumë, ose flini shumë',
      sr: 'Teškoće da zaspite ili da ostanete u snu, ili previše spavate',
    },
    {
      en: 'Feeling tired or having little energy',
      sq: 'Ndiheni të lodhur ose keni pak energji',
      sr: 'Osećate se umorno ili imate malo energije',
    },
    {
      en: 'Poor appetite or overeating',
      sq: 'Oreks i dobët ose ngrënie e tepërt',
      sr: 'Slab apetit ili prejedanje',
    },
    {
      en: 'Feeling bad about yourself – or that you are a failure or have let yourself or your family down',
      sq: 'Ndiheni keq për veten – ose se keni dështuar, ose e keni zhgënjyer veten apo familjen',
      sr: 'Loše mišljenje o sebi – ili osećaj da ste neuspešni ili da ste izneverili sebe ili porodicu',
    },
    {
      en: 'Trouble concentrating on things, such as reading the newspaper or watching television',
      sq: 'Vështirësi në përqendrim, p.sh. kur lexoni gazetën ose shikoni televizor',
      sr: 'Teškoće sa koncentracijom, na primer pri čitanju novina ili gledanju televizije',
    },
    {
      en: 'Moving or speaking so slowly that other people could have noticed – or the opposite: being so fidgety or restless that you have been moving around a lot more than usual',
      sq: 'Lëvizni ose flisni aq ngadalë sa të tjerët mund ta kenë vënë re – ose e kundërta: jeni aq të shqetësuar sa lëvizni shumë më tepër se zakonisht',
      sr: 'Krećete se ili govorite toliko sporo da su drugi to mogli primetiti – ili suprotno: toliko ste nemirni da se krećete mnogo više nego obično',
    },
    {
      en: 'Thoughts that you would be better off dead, or of hurting yourself in some way',
      sq: 'Mendime se do të ishte më mirë të ishit të vdekur, ose për ta lënduar veten në ndonjë mënyrë',
      sr: 'Misli da bi vam bilo bolje da ste mrtvi ili da se na neki način povredite',
    },
  ].map((text, i) => ({ code: `q${i + 1}`, text, options: FREQ4 })),
  minScore: 0,
  maxScore: 27,
  direction: 'HIGHER_WORSE',
  bands: [
    { code: 'MINIMAL', min: 0, max: 4 },
    { code: 'MILD', min: 5, max: 9 },
    { code: 'MODERATE', min: 10, max: 14 },
    { code: 'MODERATELY_SEVERE', min: 15, max: 19 },
    { code: 'SEVERE', min: 20, max: 27 },
  ],
  mcid: 5,
  sensitive: true,
  terms:
    'Developed by Drs Robert L. Spitzer, Janet B. W. Williams, Kurt Kroenke and colleagues with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  source: 'Kroenke K, Spitzer RL, Williams JB. J Gen Intern Med 2001;16:606–613.',
  translationStatus: 'WORKING',
};

const GAD7: Instrument = {
  code: 'GAD7',
  name: 'GAD-7',
  measures: 'Anxiety symptoms',
  stem: {
    en: 'Over the last 2 weeks, how often have you been bothered by the following problems?',
    sq: 'Gjatë 2 javëve të fundit, sa shpesh ju kanë shqetësuar problemet e mëposhtme?',
    sr: 'Tokom poslednje 2 nedelje, koliko često su vas mučili sledeći problemi?',
  },
  items: [
    {
      en: 'Feeling nervous, anxious, or on edge',
      sq: 'Ndiheni nervozë, në ankth ose të tensionuar',
      sr: 'Osećate se nervozno, anksiozno ili napeto',
    },
    {
      en: 'Not being able to stop or control worrying',
      sq: 'Nuk arrini ta ndalni ose ta kontrolloni shqetësimin',
      sr: 'Ne možete da prestanete da brinete niti da kontrolišete brigu',
    },
    {
      en: 'Worrying too much about different things',
      sq: 'Shqetësoheni tepër për gjëra të ndryshme',
      sr: 'Previše brinete o različitim stvarima',
    },
    { en: 'Trouble relaxing', sq: 'Vështirësi për t’u çlodhur', sr: 'Teško se opuštate' },
    {
      en: 'Being so restless that it is hard to sit still',
      sq: 'Jeni aq të shqetësuar sa e keni të vështirë të rrini ulur',
      sr: 'Toliko ste nemirni da vam je teško da mirno sedite',
    },
    {
      en: 'Becoming easily annoyed or irritable',
      sq: 'Mërziteni ose acaroheni lehtë',
      sr: 'Lako se iznervirate ili razdražite',
    },
    {
      en: 'Feeling afraid, as if something awful might happen',
      sq: 'Ndiheni të frikësuar, sikur mund të ndodhë diçka e tmerrshme',
      sr: 'Osećate strah, kao da bi moglo da se desi nešto strašno',
    },
  ].map((text, i) => ({ code: `q${i + 1}`, text, options: FREQ4 })),
  minScore: 0,
  maxScore: 21,
  direction: 'HIGHER_WORSE',
  bands: [
    { code: 'MINIMAL', min: 0, max: 4 },
    { code: 'MILD', min: 5, max: 9 },
    { code: 'MODERATE', min: 10, max: 14 },
    { code: 'SEVERE', min: 15, max: 21 },
  ],
  // Toussaint A et al., J Affect Disord 2020 (MCID about 4 points).
  mcid: 4,
  sensitive: true,
  terms:
    'Developed by Drs Robert L. Spitzer, Janet B. W. Williams, Kurt Kroenke and colleagues with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  source: 'Spitzer RL, Kroenke K, Williams JB, Löwe B. Arch Intern Med 2006;166:1092–1097.',
  translationStatus: 'WORKING',
};

const WHO5: Instrument = {
  code: 'WHO5',
  name: 'WHO-5',
  measures: 'Well-being',
  stem: {
    en: 'For each of the five statements, choose the answer closest to how you have been feeling over the last two weeks.',
    sq: 'Për secilin nga pesë pohimet, zgjidhni përgjigjen që i afrohet më shumë asaj si jeni ndier gjatë dy javëve të fundit.',
    sr: 'Za svaku od pet izjava izaberite odgovor koji je najbliži tome kako ste se osećali tokom poslednje dve nedelje.',
  },
  items: [
    {
      en: 'I have felt cheerful and in good spirits',
      sq: 'Jam ndier i/e gëzuar dhe në humor të mirë',
      sr: 'Osećao/la sam se veselo i dobro raspoloženo',
    },
    {
      en: 'I have felt calm and relaxed',
      sq: 'Jam ndier i/e qetë dhe i/e çlodhur',
      sr: 'Osećao/la sam se mirno i opušteno',
    },
    {
      en: 'I have felt active and vigorous',
      sq: 'Jam ndier aktiv/e dhe plot energji',
      sr: 'Osećao/la sam se aktivno i puno energije',
    },
    {
      en: 'I woke up feeling fresh and rested',
      sq: 'Jam zgjuar i/e freskët dhe i/e pushuar',
      sr: 'Budio/la sam se svež/a i odmoran/na',
    },
    {
      en: 'My daily life has been filled with things that interest me',
      sq: 'Jeta ime e përditshme ka qenë plot me gjëra që më interesojnë',
      sr: 'Moj svakodnevni život bio je ispunjen stvarima koje me zanimaju',
    },
  ].map((text, i) => ({
    code: `q${i + 1}`,
    text,
    options: [
      { value: 5, text: { en: 'All of the time', sq: 'Gjithë kohën', sr: 'Sve vreme' } },
      {
        value: 4,
        text: { en: 'Most of the time', sq: 'Pjesën më të madhe të kohës', sr: 'Većinu vremena' },
      },
      {
        value: 3,
        text: {
          en: 'More than half of the time',
          sq: 'Më shumë se gjysmën e kohës',
          sr: 'Više od polovine vremena',
        },
      },
      {
        value: 2,
        text: {
          en: 'Less than half of the time',
          sq: 'Më pak se gjysmën e kohës',
          sr: 'Manje od polovine vremena',
        },
      },
      { value: 1, text: { en: 'Some of the time', sq: 'Herë pas here', sr: 'Ponekad' } },
      { value: 0, text: { en: 'At no time', sq: 'Asnjëherë', sr: 'Nikada' } },
    ],
  })),
  // Raw score 0–25 multiplied by 4: a percentage score 0–100 (100 = best well-being).
  minScore: 0,
  maxScore: 100,
  direction: 'HIGHER_BETTER',
  bands: [
    { code: 'VERY_LOW', min: 0, max: 28 },
    { code: 'LOW', min: 29, max: 50 },
    { code: 'GOOD', min: 51, max: 100 },
  ],
  // Topp CW et al., Psychother Psychosom 2015 (10 percentage points).
  mcid: 10,
  sensitive: false,
  terms:
    'Psychiatric Centre North Zealand. Free of charge and may be used without permission for non-commercial purposes; confirm the current terms before national roll-out.',
  source: 'Topp CW, Østergaard SD, Søndergaard S, Bech P. Psychother Psychosom 2015;84:167–176.',
  translationStatus: 'WORKING',
};

const AUDITC: Instrument = {
  code: 'AUDITC',
  name: 'AUDIT-C',
  measures: 'Alcohol use',
  stem: {
    en: 'The following questions are about drinks containing alcohol during the past year. One standard drink is, for example, a small beer (330 ml), a glass of wine (100 ml) or a small glass of spirits (30 ml).',
    sq: 'Pyetjet e mëposhtme kanë të bëjnë me pijet që përmbajnë alkool gjatë vitit të kaluar. Një pije standarde është, për shembull, një birrë e vogël (330 ml), një gotë verë (100 ml) ose një gotë e vogël raki (30 ml).',
    sr: 'Sledeća pitanja odnose se na pića koja sadrže alkohol tokom protekle godine. Jedno standardno piće je, na primer, malo pivo (330 ml), čaša vina (100 ml) ili čašica žestokog pića (30 ml).',
  },
  items: [
    {
      code: 'q1',
      text: {
        en: 'How often do you have a drink containing alcohol?',
        sq: 'Sa shpesh pini një pije që përmban alkool?',
        sr: 'Koliko često pijete piće koje sadrži alkohol?',
      },
      options: [
        { value: 0, text: { en: 'Never', sq: 'Asnjëherë', sr: 'Nikada' } },
        {
          value: 1,
          text: {
            en: 'Monthly or less',
            sq: 'Një herë në muaj ose më rrallë',
            sr: 'Jednom mesečno ili ređe',
          },
        },
        {
          value: 2,
          text: { en: '2–4 times a month', sq: '2–4 herë në muaj', sr: '2–4 puta mesečno' },
        },
        {
          value: 3,
          text: { en: '2–3 times a week', sq: '2–3 herë në javë', sr: '2–3 puta nedeljno' },
        },
        {
          value: 4,
          text: {
            en: '4 or more times a week',
            sq: '4 ose më shumë herë në javë',
            sr: '4 ili više puta nedeljno',
          },
        },
      ],
    },
    {
      code: 'q2',
      text: {
        en: 'How many standard drinks containing alcohol do you have on a typical day when you are drinking?',
        sq: 'Sa pije standarde me alkool pini në një ditë të zakonshme kur pini?',
        sr: 'Koliko standardnih pića sa alkoholom popijete tipičnog dana kada pijete?',
      },
      options: [
        { value: 0, text: { en: '1 or 2', sq: '1 ose 2', sr: '1 ili 2' } },
        { value: 1, text: { en: '3 or 4', sq: '3 ose 4', sr: '3 ili 4' } },
        { value: 2, text: { en: '5 or 6', sq: '5 ose 6', sr: '5 ili 6' } },
        { value: 3, text: { en: '7 to 9', sq: '7 deri 9', sr: '7 do 9' } },
        { value: 4, text: { en: '10 or more', sq: '10 ose më shumë', sr: '10 ili više' } },
      ],
    },
    {
      code: 'q3',
      text: {
        en: 'How often do you have six or more drinks on one occasion?',
        sq: 'Sa shpesh pini gjashtë ose më shumë pije në një rast?',
        sr: 'Koliko često popijete šest ili više pića u jednoj prilici?',
      },
      options: [
        { value: 0, text: { en: 'Never', sq: 'Asnjëherë', sr: 'Nikada' } },
        {
          value: 1,
          text: {
            en: 'Less than monthly',
            sq: 'Më rrallë se një herë në muaj',
            sr: 'Ređe od jednom mesečno',
          },
        },
        { value: 2, text: { en: 'Monthly', sq: 'Çdo muaj', sr: 'Mesečno' } },
        { value: 3, text: { en: 'Weekly', sq: 'Çdo javë', sr: 'Nedeljno' } },
        {
          value: 4,
          text: {
            en: 'Daily or almost daily',
            sq: 'Çdo ditë ose pothuajse çdo ditë',
            sr: 'Svakodnevno ili skoro svakodnevno',
          },
        },
      ],
    },
  ],
  minScore: 0,
  maxScore: 12,
  direction: 'HIGHER_WORSE',
  // Positive screen from 4 (men) or 3 (women and anyone else); 8 and above: high risk. The cut-offs
  // depend on the national standard drink and are illustrative until confirmed.
  bands: [
    { code: 'LOWER_RISK', min: 0, max: 2 },
    { code: 'INCREASED_RISK', min: 3, max: 7 },
    { code: 'HIGH_RISK', min: 8, max: 12 },
  ],
  mcid: null,
  sensitive: true,
  terms:
    'The first three questions of the WHO Alcohol Use Disorders Identification Test (AUDIT), published by WHO for use without permission.',
  source:
    'Bush K et al. Arch Intern Med 1998;158:1789–1795; Babor TF et al. AUDIT, 2nd ed. WHO 2001.',
  translationStatus: 'WORKING',
};

export const INSTRUMENTS: Record<InstrumentCode, Instrument> = { PHQ9, GAD7, WHO5, AUDITC };

export class AnswerError extends Error {
  constructor(
    message: string,
    public readonly items: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Checks that every item has one of its allowed values. AUDIT-C: when the person never drinks
 * (q1 = 0), questions 2 and 3 may be left out and count as 0.
 */
export function validateAnswers(
  code: InstrumentCode,
  answers: Record<string, unknown>,
): Record<string, number> {
  const inst = INSTRUMENTS[code];
  const known = new Set(inst.items.map((i) => i.code));
  const unknown = Object.keys(answers).filter((k) => !known.has(k));
  if (unknown.length) throw new AnswerError('Unknown questions in the answers', unknown);
  const out: Record<string, number> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  const neverDrinks = code === 'AUDITC' && answers.q1 === 0;
  for (const item of inst.items) {
    const v = answers[item.code];
    if (v === undefined || v === null) {
      if (neverDrinks && item.code !== 'q1') {
        out[item.code] = 0;
        continue;
      }
      missing.push(item.code);
      continue;
    }
    if (typeof v !== 'number' || !item.options.some((o) => o.value === v)) {
      invalid.push(item.code);
      continue;
    }
    out[item.code] = neverDrinks && item.code !== 'q1' ? 0 : v;
  }
  if (missing.length) throw new AnswerError('Please answer every question', missing);
  if (invalid.length) throw new AnswerError('Some answers are not valid', invalid);
  return out;
}

export interface Scored {
  score: number;
  severity: string;
  /** Needs a clinician today (PHQ-9 item 9 above zero, or a severe PHQ-9 score). */
  safetyFlag: boolean;
  /**
   * What the portal shows at once. CRISIS: thoughts of self-harm – call 112 / the helpline now;
   * HIGH: a severe or high-risk result – contact the doctor within the next few days.
   */
  advice: 'CRISIS' | 'HIGH' | null;
}

export function bandOf(code: InstrumentCode, score: number, sex?: string | null): string {
  const inst = INSTRUMENTS[code];
  if (code === 'AUDITC') {
    if (score >= 8) return 'HIGH_RISK';
    // Men screen positive from 4, women (and anyone whose sex is not recorded as male) from 3.
    return score >= (sex === 'MALE' ? 4 : 3) ? 'INCREASED_RISK' : 'LOWER_RISK';
  }
  return inst.bands.find((b) => score >= b.min && score <= b.max)!.code;
}

export function scoreAnswers(
  code: InstrumentCode,
  answers: Record<string, number>,
  sex?: string | null,
): Scored {
  const raw = Object.values(answers).reduce((a, b) => a + b, 0);
  const score = code === 'WHO5' ? raw * 4 : raw;
  const severity = bandOf(code, score, sex);
  const selfHarm = code === 'PHQ9' && (answers.q9 ?? 0) > 0;
  const safetyFlag = selfHarm || (code === 'PHQ9' && severity === 'SEVERE');
  const high =
    severity === 'SEVERE' ||
    severity === 'MODERATELY_SEVERE' ||
    severity === 'VERY_LOW' ||
    severity === 'HIGH_RISK';
  return { score, severity, safetyFlag, advice: selfHarm ? 'CRISIS' : high ? 'HIGH' : null };
}

/** The change since the previous score, and whether it is clinically meaningful. */
export function changeOf(code: InstrumentCode, previous: number | null, current: number) {
  if (previous === null) return null;
  const inst = INSTRUMENTS[code];
  const difference = current - previous;
  const better = inst.direction === 'HIGHER_BETTER' ? difference > 0 : difference < 0;
  const meaningful = inst.mcid !== null && Math.abs(difference) >= inst.mcid;
  return {
    previous,
    difference,
    meaningful,
    direction: difference === 0 ? 'SAME' : better ? 'BETTER' : 'WORSE',
  } as const;
}

/* --------------------------------------------------------------------------- schedule -- */

const DAY = 86_400_000;

/** The next due time after `from` for a repeating frequency (null for ONCE). */
export function nextDueAfter(frequency: Frequency, from: Date): Date | null {
  const d = new Date(from);
  switch (frequency) {
    case 'ONCE':
      return null;
    case 'WEEKLY':
      return new Date(d.getTime() + 7 * DAY);
    case 'MONTHLY':
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    case 'QUARTERLY':
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d;
  }
}

/** Days after the due time before a questionnaire counts as overdue. */
export const GRACE_DAYS: Record<Frequency, number> = {
  ONCE: 14,
  WEEKLY: 3,
  MONTHLY: 7,
  QUARTERLY: 14,
};

export type DueState = 'UPCOMING' | 'DUE' | 'OVERDUE' | 'NONE';

export function dueState(
  a: { status: string; frequency: string; nextDueAt: Date | null },
  now = new Date(),
): DueState {
  if (a.status !== 'ACTIVE' || !a.nextDueAt) return 'NONE';
  if (a.nextDueAt.getTime() > now.getTime()) return 'UPCOMING';
  const grace = GRACE_DAYS[a.frequency as Frequency] ?? 7;
  return now.getTime() - a.nextDueAt.getTime() > grace * DAY ? 'OVERDUE' : 'DUE';
}

/** Public definition (what the web app shows). */
export function publicInstrument(i: Instrument) {
  return {
    code: i.code,
    name: i.name,
    measures: i.measures,
    stem: i.stem,
    items: i.items,
    minScore: i.minScore,
    maxScore: i.maxScore,
    direction: i.direction,
    bands: i.bands,
    mcid: i.mcid,
    sensitive: i.sensitive,
    terms: i.terms,
    source: i.source,
    translationStatus: i.translationStatus,
  };
}
