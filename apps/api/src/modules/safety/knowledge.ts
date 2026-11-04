/**
 * Medication safety knowledge used by the engine: ingredient synonyms (brand and local names),
 * therapeutic classes for duplicate-therapy checks, allergy groups with cross-reactivity, and the
 * renal / age / pregnancy rules.
 *
 * CURATED DEMO SET – not a validated clinical database. A production deployment must integrate a
 * maintained drug knowledge base; the Ministry can extend the interaction pairs in the app.
 */
export type Severity = 'CONTRAINDICATED' | 'MAJOR' | 'MODERATE' | 'MINOR';

/** Severity order: lower index = more severe. */
export const SEVERITY_ORDER: Severity[] = ['CONTRAINDICATED', 'MAJOR', 'MODERATE', 'MINOR'];
export const BLOCKING: Severity[] = ['CONTRAINDICATED', 'MAJOR'];

/** Brand, local and alternative names → INN ingredients (lower case). */
export const SYNONYMS: Record<string, string[]> = {
  aspirin: ['acetylsalicylic acid'],
  asa: ['acetylsalicylic acid'],
  aspirina: ['acetylsalicylic acid'],
  cardiopirin: ['acetylsalicylic acid'],
  andol: ['acetylsalicylic acid'],
  acetaminophen: ['paracetamol'],
  panadol: ['paracetamol'],
  efferalgan: ['paracetamol'],
  daleron: ['paracetamol'],
  brufen: ['ibuprofen'],
  nurofen: ['ibuprofen'],
  voltaren: ['diclofenac'],
  olfen: ['diclofenac'],
  naprosyn: ['naproxen'],
  analgin: ['metamizole'],
  metamizol: ['metamizole'],
  novalgin: ['metamizole'],
  augmentin: ['amoxicillin', 'clavulanic acid'],
  'co-amoxiclav': ['amoxicillin', 'clavulanic acid'],
  amoksicilin: ['amoxicillin'],
  amoksicilina: ['amoxicillin'],
  bactrim: ['sulfamethoxazole', 'trimethoprim'],
  'co-trimoxazole': ['sulfamethoxazole', 'trimethoprim'],
  cotrimoxazole: ['sulfamethoxazole', 'trimethoprim'],
  klacid: ['clarithromycin'],
  sumamed: ['azithromycin'],
  cipro: ['ciprofloxacin'],
  ciprinol: ['ciprofloxacin'],
  marevan: ['warfarin'],
  sintrom: ['acenocoumarol'],
  xarelto: ['rivaroxaban'],
  eliquis: ['apixaban'],
  pradaxa: ['dabigatran'],
  clexane: ['enoxaparin'],
  plavix: ['clopidogrel'],
  concor: ['bisoprolol'],
  glucophage: ['metformin'],
  siofor: ['metformin'],
  diaprel: ['gliclazide'],
  lipitor: ['atorvastatin'],
  sortis: ['atorvastatin'],
  zocor: ['simvastatin'],
  crestor: ['rosuvastatin'],
  lasix: ['furosemide'],
  aldactone: ['spironolactone'],
  tritace: ['ramipril'],
  enap: ['enalapril'],
  prestarium: ['perindopril'],
  cozaar: ['losartan'],
  lorista: ['losartan'],
  diovan: ['valsartan'],
  norvasc: ['amlodipine'],
  tenox: ['amlodipine'],
  cordarone: ['amiodarone'],
  lanoxin: ['digoxin'],
  isoptin: ['verapamil'],
  ventolin: ['salbutamol'],
  albuterol: ['salbutamol'],
  tramal: ['tramadol'],
  zoloft: ['sertraline'],
  prozac: ['fluoxetine'],
  cipralex: ['escitalopram'],
  seropram: ['citalopram'],
  viagra: ['sildenafil'],
  nitroglycerin: ['glyceryl trinitrate'],
  nitroglicerina: ['glyceryl trinitrate'],
  'isosorbide mononitrate': ['isosorbide mononitrate'],
  diflucan: ['fluconazole'],
  orvagil: ['metronidazole'],
  flagyl: ['metronidazole'],
  depakine: ['valproic acid'],
  valproate: ['valproic acid'],
  'sodium valproate': ['valproic acid'],
  tegretol: ['carbamazepine'],
  roaccutane: ['isotretinoin'],
  euthyrox: ['levothyroxine'],
  letrox: ['levothyroxine'],
  controloc: ['pantoprazole'],
  nexium: ['esomeprazole'],
  ulcosan: ['omeprazole'],
  reglan: ['metoclopramide'],
  'kalium chloratum': ['potassium chloride'],
  kcl: ['potassium chloride'],
  'potassium chloride': ['potassium chloride'],
  lithium: ['lithium'],
  'lithium carbonate': ['lithium'],
  methotrexat: ['methotrexate'],
  haloperidol: ['haloperidol'],
  diazepam: ['diazepam'],
  bensedin: ['diazepam'],
  xanax: ['alprazolam'],
  lexaurin: ['bromazepam'],
  'insulin glargine': ['insulin glargine'],
  heparin: ['heparin'],
  omnipaque: ['iohexol'],
  'contrast medium': ['iodinated contrast'],
  'iodinated contrast': ['iodinated contrast'],
};

/** Multi-word or single-word INNs recognised directly in free text (in addition to synonyms). */
export const KNOWN_INGREDIENTS = new Set<string>([
  'acetylsalicylic acid',
  'paracetamol',
  'ibuprofen',
  'diclofenac',
  'naproxen',
  'ketorolac',
  'indomethacin',
  'celecoxib',
  'meloxicam',
  'ketoprofen',
  'etoricoxib',
  'metamizole',
  'tramadol',
  'codeine',
  'morphine',
  'oxycodone',
  'fentanyl',
  'amoxicillin',
  'ampicillin',
  'flucloxacillin',
  'piperacillin',
  'benzylpenicillin',
  'phenoxymethylpenicillin',
  'clavulanic acid',
  'cefalexin',
  'cefuroxime',
  'ceftriaxone',
  'cefazolin',
  'cefixime',
  'azithromycin',
  'clarithromycin',
  'erythromycin',
  'ciprofloxacin',
  'levofloxacin',
  'moxifloxacin',
  'nitrofurantoin',
  'sulfamethoxazole',
  'trimethoprim',
  'metronidazole',
  'fluconazole',
  'linezolid',
  'doxycycline',
  'gentamicin',
  'metformin',
  'gliclazide',
  'glimepiride',
  'glibenclamide',
  'insulin glargine',
  'insulin aspart',
  'amlodipine',
  'ramipril',
  'enalapril',
  'lisinopril',
  'perindopril',
  'captopril',
  'losartan',
  'valsartan',
  'candesartan',
  'irbesartan',
  'telmisartan',
  'bisoprolol',
  'metoprolol',
  'atenolol',
  'carvedilol',
  'propranolol',
  'nebivolol',
  'furosemide',
  'torasemide',
  'hydrochlorothiazide',
  'indapamide',
  'spironolactone',
  'eplerenone',
  'potassium chloride',
  'atorvastatin',
  'simvastatin',
  'rosuvastatin',
  'pravastatin',
  'clopidogrel',
  'ticagrelor',
  'warfarin',
  'acenocoumarol',
  'rivaroxaban',
  'apixaban',
  'dabigatran',
  'enoxaparin',
  'heparin',
  'digoxin',
  'amiodarone',
  'verapamil',
  'diltiazem',
  'glyceryl trinitrate',
  'isosorbide mononitrate',
  'sildenafil',
  'omeprazole',
  'pantoprazole',
  'esomeprazole',
  'lansoprazole',
  'metoclopramide',
  'ondansetron',
  'domperidone',
  'salbutamol',
  'budesonide',
  'formoterol',
  'prednisolone',
  'methylprednisolone',
  'dexamethasone',
  'levothyroxine',
  'sertraline',
  'fluoxetine',
  'paroxetine',
  'citalopram',
  'escitalopram',
  'amitriptyline',
  'haloperidol',
  'quetiapine',
  'lithium',
  'diazepam',
  'lorazepam',
  'alprazolam',
  'bromazepam',
  'clonazepam',
  'midazolam',
  'zolpidem',
  'valproic acid',
  'carbamazepine',
  'phenytoin',
  'levetiracetam',
  'isotretinoin',
  'methotrexate',
  'allopurinol',
  'azathioprine',
  'colchicine',
  'diphenhydramine',
  'chlorphenamine',
  'promethazine',
  'hydroxyzine',
  'iohexol',
  'iodinated contrast',
  'ferrous sulfate',
  'sodium chloride',
]);

/** Therapeutic classes (≈ ATC level 4) for duplicate-therapy checks. */
export const CLASSES: Record<string, { label: string; members: string[]; atc?: string[] }> = {
  NSAID: {
    label: 'NSAIDs',
    members: [
      'ibuprofen',
      'diclofenac',
      'naproxen',
      'ketorolac',
      'indomethacin',
      'celecoxib',
      'meloxicam',
      'ketoprofen',
      'etoricoxib',
    ],
    atc: ['M01AB', 'M01AC', 'M01AE', 'M01AH'],
  },
  ACE_INHIBITOR: {
    label: 'ACE inhibitors',
    members: ['ramipril', 'enalapril', 'lisinopril', 'perindopril', 'captopril'],
    atc: ['C09AA'],
  },
  ARB: {
    label: 'angiotensin receptor blockers',
    members: ['losartan', 'valsartan', 'candesartan', 'irbesartan', 'telmisartan'],
    atc: ['C09CA'],
  },
  STATIN: {
    label: 'statins',
    members: ['atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin'],
    atc: ['C10AA'],
  },
  PPI: {
    label: 'proton pump inhibitors',
    members: ['omeprazole', 'pantoprazole', 'esomeprazole', 'lansoprazole'],
    atc: ['A02BC'],
  },
  BETA_BLOCKER: {
    label: 'beta blockers',
    members: ['bisoprolol', 'metoprolol', 'atenolol', 'carvedilol', 'propranolol', 'nebivolol'],
    atc: ['C07AB', 'C07AA', 'C07AG'],
  },
  BENZODIAZEPINE: {
    label: 'benzodiazepines',
    members: ['diazepam', 'lorazepam', 'alprazolam', 'bromazepam', 'clonazepam', 'midazolam'],
    atc: ['N05BA', 'N05CD'],
  },
  SSRI: {
    label: 'SSRIs',
    members: ['sertraline', 'fluoxetine', 'paroxetine', 'citalopram', 'escitalopram'],
    atc: ['N06AB'],
  },
  ANTICOAGULANT: {
    label: 'anticoagulants',
    members: [
      'warfarin',
      'acenocoumarol',
      'rivaroxaban',
      'apixaban',
      'dabigatran',
      'enoxaparin',
      'heparin',
    ],
    atc: ['B01AA', 'B01AB', 'B01AE', 'B01AF'],
  },
  SULFONYLUREA: {
    label: 'sulfonylureas',
    members: ['gliclazide', 'glimepiride', 'glibenclamide'],
    atc: ['A10BB'],
  },
  OPIOID: {
    label: 'opioids',
    members: ['tramadol', 'codeine', 'morphine', 'oxycodone', 'fentanyl'],
    atc: ['N02AA', 'N02AX', 'N02AB'],
  },
  LOOP_DIURETIC: { label: 'loop diuretics', members: ['furosemide', 'torasemide'], atc: ['C03CA'] },
};

/** Duplicates within these classes are major (e.g. two anticoagulants), otherwise moderate. */
export const MAJOR_DUPLICATE_CLASSES = new Set(['ANTICOAGULANT', 'OPIOID']);

/** Class pairs that interact as classes (in addition to ingredient pairs in the database). */
export const CLASS_PAIRS: {
  a: string;
  b: string;
  severity: Severity;
  effect: string;
  management: string;
}[] = [
  {
    a: 'ACE_INHIBITOR',
    b: 'ARB',
    severity: 'MAJOR',
    effect:
      'Dual blockade of the renin–angiotensin system: hyperkalaemia, low blood pressure and kidney injury.',
    management: 'Avoid the combination; use one agent.',
  },
];

/** Allergy groups: words used when recording an allergy → member ingredients. */
export const ALLERGY_GROUPS: Record<string, { words: string[]; members: string[] }> = {
  penicillin: {
    words: ['penicillin', 'penicilin', 'penicilina', 'penicilinë', 'penicillins'],
    members: [
      'amoxicillin',
      'ampicillin',
      'flucloxacillin',
      'piperacillin',
      'benzylpenicillin',
      'phenoxymethylpenicillin',
    ],
  },
  cephalosporin: {
    words: ['cephalosporin', 'cefalosporin'],
    members: ['cefalexin', 'cefuroxime', 'ceftriaxone', 'cefazolin', 'cefixime'],
  },
  sulfonamide: {
    words: ['sulfonamide', 'sulfonamid', 'sulfa', 'sulphonamide'],
    members: ['sulfamethoxazole'],
  },
  nsaid: {
    words: ['nsaid', 'nsaids', 'aine', 'antiinflammatory', 'anti-inflammatory'],
    members: [...CLASSES.NSAID!.members, 'acetylsalicylic acid'],
  },
  aspirin: { words: ['aspirin', 'aspirina', 'asa'], members: ['acetylsalicylic acid'] },
  opioid: {
    words: ['opioid', 'opiate', 'opioide'],
    members: CLASSES.OPIOID!.members,
  },
  statin: { words: ['statin', 'statine'], members: CLASSES.STATIN!.members },
  contrast: {
    words: ['contrast', 'iodine', 'jod', 'jodi', 'kontrast'],
    members: ['iohexol', 'iodinated contrast'],
  },
};

/** Partial cross-reactivity: allergy group → other group (moderate caution). */
export const CROSS_REACTIVE: {
  allergy: string;
  drugs: string;
  severity: Severity;
  note: string;
}[] = [
  {
    allergy: 'penicillin',
    drugs: 'cephalosporin',
    severity: 'MODERATE',
    note: 'Cephalosporins carry a small risk of cross-reactivity with penicillin allergy.',
  },
  {
    allergy: 'aspirin',
    drugs: 'nsaid',
    severity: 'MAJOR',
    note: 'Patients with aspirin hypersensitivity often react to other NSAIDs.',
  },
];

/** Renal rules by eGFR (ml/min/1.73 m²): first matching threshold applies. */
export const RENAL_RULES: {
  ingredients: string[];
  rules: { below: number; severity: Severity; advice: string }[];
}[] = [
  {
    ingredients: ['metformin'],
    rules: [
      {
        below: 30,
        severity: 'CONTRAINDICATED',
        advice: 'Metformin is contraindicated below eGFR 30 (risk of lactic acidosis).',
      },
      {
        below: 45,
        severity: 'MODERATE',
        advice: 'Do not start metformin; if already taking it, reduce the dose (max 1 g/day).',
      },
    ],
  },
  {
    ingredients: CLASSES.NSAID!.members,
    rules: [
      { below: 30, severity: 'MAJOR', advice: 'Avoid NSAIDs in severe kidney impairment.' },
      {
        below: 60,
        severity: 'MODERATE',
        advice: 'Use NSAIDs with caution: shortest course, monitor kidney function.',
      },
    ],
  },
  {
    ingredients: ['nitrofurantoin'],
    rules: [
      {
        below: 45,
        severity: 'MAJOR',
        advice: 'Avoid nitrofurantoin below eGFR 45: ineffective and more toxic.',
      },
    ],
  },
  {
    ingredients: ['enoxaparin'],
    rules: [
      {
        below: 30,
        severity: 'MODERATE',
        advice:
          'Reduce the enoxaparin dose below eGFR 30 (e.g. 1 mg/kg once daily); consider anti-Xa monitoring.',
      },
    ],
  },
  {
    ingredients: ['spironolactone', 'eplerenone'],
    rules: [
      {
        below: 30,
        severity: 'MAJOR',
        advice: 'Avoid potassium-sparing diuretics below eGFR 30 (hyperkalaemia).',
      },
    ],
  },
  {
    ingredients: ['gliclazide', 'glimepiride', 'glibenclamide'],
    rules: [
      {
        below: 30,
        severity: 'MODERATE',
        advice: 'Risk of prolonged hypoglycaemia; use the lowest dose or an alternative.',
      },
    ],
  },
];

/** Age rules. */
export const AGE_RULES: {
  ingredients: string[];
  maxAgeExclusive?: number;
  minAge?: number;
  severity: Severity;
  advice: string;
}[] = [
  {
    ingredients: ['acetylsalicylic acid'],
    maxAgeExclusive: 16,
    severity: 'MAJOR',
    advice: 'Aspirin should not be given to children under 16 (risk of Reye’s syndrome).',
  },
  {
    ingredients: ['codeine', 'tramadol'],
    maxAgeExclusive: 12,
    severity: 'CONTRAINDICATED',
    advice:
      'Codeine and tramadol are contraindicated under 12 years (life-threatening breathing problems).',
  },
  {
    ingredients: CLASSES.BENZODIAZEPINE!.members.concat(['zolpidem']),
    minAge: 65,
    severity: 'MODERATE',
    advice:
      'In older adults benzodiazepines and Z-drugs increase falls, confusion and fractures; avoid or use the lowest dose briefly.',
  },
  {
    ingredients: [
      'diphenhydramine',
      'chlorphenamine',
      'promethazine',
      'hydroxyzine',
      'amitriptyline',
    ],
    minAge: 65,
    severity: 'MODERATE',
    advice:
      'Strongly anticholinergic medicines cause confusion and falls in older adults; prefer alternatives.',
  },
];

/** Pregnancy rules (patient with an active pregnancy diagnosis). */
export const PREGNANCY_RULES: { ingredients: string[]; severity: Severity; advice: string }[] = [
  {
    ingredients: ['warfarin', 'acenocoumarol'],
    severity: 'CONTRAINDICATED',
    advice: 'Vitamin K antagonists are teratogenic; use low-molecular-weight heparin in pregnancy.',
  },
  {
    ingredients: [...CLASSES.ACE_INHIBITOR!.members, ...CLASSES.ARB!.members],
    severity: 'CONTRAINDICATED',
    advice:
      'ACE inhibitors and ARBs are fetotoxic; switch to a pregnancy-compatible antihypertensive (e.g. labetalol, nifedipine, methyldopa).',
  },
  {
    ingredients: CLASSES.STATIN!.members,
    severity: 'CONTRAINDICATED',
    advice: 'Statins should be stopped during pregnancy.',
  },
  {
    ingredients: ['isotretinoin', 'methotrexate'],
    severity: 'CONTRAINDICATED',
    advice: 'Highly teratogenic – must not be used in pregnancy.',
  },
  {
    ingredients: ['valproic acid'],
    severity: 'CONTRAINDICATED',
    advice:
      'Valproate causes major malformations and developmental disorders; specialist review required.',
  },
  {
    ingredients: CLASSES.NSAID!.members,
    severity: 'MODERATE',
    advice: 'Avoid NSAIDs from 20 weeks of pregnancy (fetal kidney and ductus problems).',
  },
];

/**
 * Curated interaction pairs used to seed the database (ingredient names as above; order is
 * normalised on insert). Effect/management texts are reused so they can be translated once.
 */
const BLEEDING = 'Increased risk of bleeding.';
const BLEEDING_MGMT =
  'Avoid if possible; if needed, use the lowest dose for the shortest time, consider gastroprotection and monitor for bleeding (INR for warfarin).';
const INR_UP = 'Raises the anticoagulant effect of warfarin (higher INR, bleeding).';
const INR_MGMT = 'Avoid or reduce the warfarin dose and check the INR within 3–5 days.';
const HYPERK = 'Risk of high potassium (hyperkalaemia), especially with kidney impairment.';
const HYPERK_MGMT = 'Avoid or monitor potassium and kidney function closely.';
const MYOPATHY = 'Higher statin levels: risk of muscle damage (myopathy, rhabdomyolysis).';
const MYOPATHY_MGMT =
  'Pause the statin during the course or use a non-interacting antibiotic (e.g. azithromycin).';
const SEROTONIN = 'Risk of serotonin syndrome (agitation, tremor, fever) and seizures.';
const SEROTONIN_MGMT = 'Avoid the combination or monitor closely; use the lowest doses.';
const QT = 'Additive QT prolongation: risk of dangerous arrhythmias (torsades de pointes).';
const QT_MGMT = 'Avoid the combination; if unavoidable, check ECG and electrolytes.';
const HYPOTENSION = 'Severe drop in blood pressure.';
const LITHIUM = 'Lithium levels rise: risk of lithium toxicity.';
const LITHIUM_MGMT = 'Avoid or reduce the lithium dose and monitor lithium levels.';
const DIGOXIN = 'Digoxin levels rise: risk of digoxin toxicity and bradycardia.';
const DIGOXIN_MGMT = 'Reduce the digoxin dose (often by half) and monitor levels and heart rate.';
const NEPHRO = 'Combined risk of kidney injury ("triple whammy" with diuretics).';
const NEPHRO_MGMT = 'Avoid NSAIDs where possible; monitor kidney function and fluids.';
const METHOTREXATE = 'Increased methotrexate toxicity (bone-marrow suppression).';
const HYPOGLY = 'Increased risk of low blood sugar (hypoglycaemia).';
const HYPOGLY_MGMT = 'Monitor blood glucose; warn the patient about hypoglycaemia symptoms.';
const SEDATION = 'Additive sedation and breathing depression.';
const SEDATION_MGMT = 'Avoid the combination or use the lowest doses with monitoring.';
const CLOPI = 'Reduced activation of clopidogrel (less antiplatelet effect).';
const CLOPI_MGMT = 'Prefer pantoprazole if a proton pump inhibitor is needed.';
const BRADY = 'Additive slowing of the heart (bradycardia, heart block) and low blood pressure.';
const BRADY_MGMT = 'Avoid the combination; if used, monitor heart rate and ECG.';
const CONTRAST =
  'Iodinated contrast can cause kidney injury, which may lead to metformin accumulation (lactic acidosis).';
const CONTRAST_MGMT =
  'Withhold metformin from the time of contrast for 48 hours in patients with eGFR below 30 or acute kidney injury; restart when kidney function is stable.';
const ALLOPURINOL = 'Higher levels of the other drug: risk of serious toxicity.';
const PHENYTOIN = 'Altered levels of either drug: loss of effect or toxicity.';
const PHENYTOIN_MGMT = 'Monitor drug levels and clinical response; adjust doses.';
const FLUOROQUINOLONE =
  'Corticosteroids increase the risk of tendon rupture with fluoroquinolones.';
const FLUOROQUINOLONE_MGMT =
  'Avoid if possible, especially in older adults; warn about tendon pain.';

export const SEED_INTERACTIONS: [string, string, Severity, string, string][] = [
  ['warfarin', 'ibuprofen', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['warfarin', 'diclofenac', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['warfarin', 'naproxen', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['warfarin', 'ketorolac', 'CONTRAINDICATED', BLEEDING, BLEEDING_MGMT],
  ['warfarin', 'acetylsalicylic acid', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['warfarin', 'clopidogrel', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['warfarin', 'amiodarone', 'MAJOR', INR_UP, INR_MGMT],
  ['warfarin', 'fluconazole', 'MAJOR', INR_UP, INR_MGMT],
  ['warfarin', 'metronidazole', 'MAJOR', INR_UP, INR_MGMT],
  ['warfarin', 'sulfamethoxazole', 'MAJOR', INR_UP, INR_MGMT],
  ['warfarin', 'ciprofloxacin', 'MODERATE', INR_UP, INR_MGMT],
  ['warfarin', 'clarithromycin', 'MODERATE', INR_UP, INR_MGMT],
  [
    'warfarin',
    'paracetamol',
    'MINOR',
    INR_UP,
    'Regular high doses may raise the INR; check the INR if used for several days.',
  ],
  ['acenocoumarol', 'ibuprofen', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['rivaroxaban', 'ibuprofen', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['apixaban', 'acetylsalicylic acid', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['enoxaparin', 'ibuprofen', 'MAJOR', BLEEDING, BLEEDING_MGMT],
  ['clopidogrel', 'ibuprofen', 'MODERATE', BLEEDING, BLEEDING_MGMT],
  ['sertraline', 'ibuprofen', 'MODERATE', BLEEDING, BLEEDING_MGMT],
  ['clopidogrel', 'omeprazole', 'MODERATE', CLOPI, CLOPI_MGMT],
  ['clopidogrel', 'esomeprazole', 'MODERATE', CLOPI, CLOPI_MGMT],
  ['ramipril', 'spironolactone', 'MAJOR', HYPERK, HYPERK_MGMT],
  ['enalapril', 'spironolactone', 'MAJOR', HYPERK, HYPERK_MGMT],
  ['ramipril', 'potassium chloride', 'MAJOR', HYPERK, HYPERK_MGMT],
  ['losartan', 'spironolactone', 'MAJOR', HYPERK, HYPERK_MGMT],
  ['losartan', 'potassium chloride', 'MAJOR', HYPERK, HYPERK_MGMT],
  ['spironolactone', 'potassium chloride', 'MAJOR', HYPERK, HYPERK_MGMT],
  ['ramipril', 'trimethoprim', 'MODERATE', HYPERK, HYPERK_MGMT],
  ['ramipril', 'ibuprofen', 'MODERATE', NEPHRO, NEPHRO_MGMT],
  ['ramipril', 'diclofenac', 'MODERATE', NEPHRO, NEPHRO_MGMT],
  ['furosemide', 'ibuprofen', 'MODERATE', NEPHRO, NEPHRO_MGMT],
  ['losartan', 'ibuprofen', 'MODERATE', NEPHRO, NEPHRO_MGMT],
  ['simvastatin', 'clarithromycin', 'CONTRAINDICATED', MYOPATHY, MYOPATHY_MGMT],
  ['atorvastatin', 'clarithromycin', 'MAJOR', MYOPATHY, MYOPATHY_MGMT],
  ['simvastatin', 'erythromycin', 'CONTRAINDICATED', MYOPATHY, MYOPATHY_MGMT],
  [
    'simvastatin',
    'amiodarone',
    'MAJOR',
    MYOPATHY,
    'Do not exceed simvastatin 20 mg daily with amiodarone.',
  ],
  [
    'simvastatin',
    'verapamil',
    'MAJOR',
    MYOPATHY,
    'Do not exceed simvastatin 20 mg daily with verapamil.',
  ],
  ['atorvastatin', 'fluconazole', 'MODERATE', MYOPATHY, MYOPATHY_MGMT],
  ['sertraline', 'tramadol', 'MAJOR', SEROTONIN, SEROTONIN_MGMT],
  ['fluoxetine', 'tramadol', 'MAJOR', SEROTONIN, SEROTONIN_MGMT],
  ['escitalopram', 'tramadol', 'MAJOR', SEROTONIN, SEROTONIN_MGMT],
  ['sertraline', 'linezolid', 'CONTRAINDICATED', SEROTONIN, SEROTONIN_MGMT],
  ['citalopram', 'linezolid', 'CONTRAINDICATED', SEROTONIN, SEROTONIN_MGMT],
  [
    'methotrexate',
    'trimethoprim',
    'CONTRAINDICATED',
    METHOTREXATE,
    'Avoid; use another antibiotic.',
  ],
  [
    'methotrexate',
    'sulfamethoxazole',
    'CONTRAINDICATED',
    METHOTREXATE,
    'Avoid; use another antibiotic.',
  ],
  [
    'methotrexate',
    'ibuprofen',
    'MAJOR',
    METHOTREXATE,
    'Avoid with high-dose methotrexate; monitor blood counts and kidney function with low doses.',
  ],
  [
    'sildenafil',
    'glyceryl trinitrate',
    'CONTRAINDICATED',
    HYPOTENSION,
    'Never combine; nitrates are contraindicated within 24 hours of sildenafil.',
  ],
  [
    'sildenafil',
    'isosorbide mononitrate',
    'CONTRAINDICATED',
    HYPOTENSION,
    'Never combine; nitrates are contraindicated with sildenafil.',
  ],
  ['lithium', 'ibuprofen', 'MAJOR', LITHIUM, LITHIUM_MGMT],
  ['lithium', 'diclofenac', 'MAJOR', LITHIUM, LITHIUM_MGMT],
  ['lithium', 'hydrochlorothiazide', 'MAJOR', LITHIUM, LITHIUM_MGMT],
  ['lithium', 'ramipril', 'MAJOR', LITHIUM, LITHIUM_MGMT],
  ['lithium', 'furosemide', 'MODERATE', LITHIUM, LITHIUM_MGMT],
  ['digoxin', 'amiodarone', 'MAJOR', DIGOXIN, DIGOXIN_MGMT],
  ['digoxin', 'verapamil', 'MAJOR', DIGOXIN, DIGOXIN_MGMT],
  ['digoxin', 'clarithromycin', 'MAJOR', DIGOXIN, DIGOXIN_MGMT],
  [
    'digoxin',
    'furosemide',
    'MODERATE',
    'Low potassium from the diuretic increases digoxin toxicity.',
    'Monitor potassium and digoxin levels.',
  ],
  ['bisoprolol', 'verapamil', 'MAJOR', BRADY, BRADY_MGMT],
  ['metoprolol', 'verapamil', 'MAJOR', BRADY, BRADY_MGMT],
  ['bisoprolol', 'diltiazem', 'MODERATE', BRADY, BRADY_MGMT],
  ['amiodarone', 'bisoprolol', 'MODERATE', BRADY, BRADY_MGMT],
  ['ciprofloxacin', 'amiodarone', 'MAJOR', QT, QT_MGMT],
  ['clarithromycin', 'amiodarone', 'MAJOR', QT, QT_MGMT],
  ['azithromycin', 'amiodarone', 'MAJOR', QT, QT_MGMT],
  ['haloperidol', 'citalopram', 'MAJOR', QT, QT_MGMT],
  ['ondansetron', 'citalopram', 'MODERATE', QT, QT_MGMT],
  ['levofloxacin', 'haloperidol', 'MAJOR', QT, QT_MGMT],
  ['metformin', 'iodinated contrast', 'MODERATE', CONTRAST, CONTRAST_MGMT],
  ['metformin', 'iohexol', 'MODERATE', CONTRAST, CONTRAST_MGMT],
  ['gliclazide', 'fluconazole', 'MODERATE', HYPOGLY, HYPOGLY_MGMT],
  ['glimepiride', 'clarithromycin', 'MODERATE', HYPOGLY, HYPOGLY_MGMT],
  ['tramadol', 'diazepam', 'MAJOR', SEDATION, SEDATION_MGMT],
  ['morphine', 'diazepam', 'MAJOR', SEDATION, SEDATION_MGMT],
  ['codeine', 'alprazolam', 'MAJOR', SEDATION, SEDATION_MGMT],
  ['oxycodone', 'lorazepam', 'MAJOR', SEDATION, SEDATION_MGMT],
  [
    'allopurinol',
    'azathioprine',
    'CONTRAINDICATED',
    ALLOPURINOL,
    'Avoid, or reduce azathioprine to a quarter of the dose with close blood-count monitoring.',
  ],
  [
    'colchicine',
    'clarithromycin',
    'CONTRAINDICATED',
    ALLOPURINOL,
    'Avoid; colchicine toxicity can be fatal.',
  ],
  ['carbamazepine', 'clarithromycin', 'MAJOR', PHENYTOIN, PHENYTOIN_MGMT],
  ['phenytoin', 'fluconazole', 'MAJOR', PHENYTOIN, PHENYTOIN_MGMT],
  ['valproic acid', 'carbamazepine', 'MODERATE', PHENYTOIN, PHENYTOIN_MGMT],
  ['ciprofloxacin', 'prednisolone', 'MODERATE', FLUOROQUINOLONE, FLUOROQUINOLONE_MGMT],
  ['levofloxacin', 'prednisolone', 'MODERATE', FLUOROQUINOLONE, FLUOROQUINOLONE_MGMT],
  [
    'levothyroxine',
    'ferrous sulfate',
    'MINOR',
    'Iron reduces the absorption of levothyroxine.',
    'Take them at least 4 hours apart.',
  ],
];

/** Source label for seeded pairs. */
export const SEED_SOURCE = 'Curated demo set – not a validated clinical database';
