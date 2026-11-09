import { and, eq, isNotNull } from 'drizzle-orm';
import { LAB_CATALOG } from '../modules/lab/catalog.js';
import {
  activateMapVersion,
  activateSystemVersion,
  createMapVersion,
  createSystemVersion,
  type ConceptRow,
  type MapRow,
} from '../modules/terminology/terminology.service.js';
import { db } from './client.js';
import { codeSystems, conceptMaps, facilities, medicationCatalog, users } from './schema.js';

/**
 * Demo terminology (development only): an ICD-10 subset with Albanian and Serbian displays (one
 * active version and a draft with changes, so the comparison can be tried), a LOINC subset for the
 * laboratory catalogue, ATC codes of the medicines catalogue, a local laboratory code system of the
 * demo facility and its mapping to LOINC (with unmatched codes). Public reference codes only.
 */

type C = [code: string, en: string, sq: string, sr: string];

/** ICD-10 chapters used by the subset (codes are the chapter numbers). */
const CHAPTERS: C[] = [
  [
    'I',
    'Certain infectious and parasitic diseases',
    'Disa sëmundje infektive dhe parazitare',
    'Određene infektivne i parazitarne bolesti',
  ],
  ['II', 'Neoplasms', 'Neoplazmat', 'Neoplazme'],
  [
    'III',
    'Diseases of the blood and blood-forming organs and certain disorders involving the immune mechanism',
    'Sëmundjet e gjakut dhe të organeve hematopoietike dhe disa çrregullime të imunitetit',
    'Bolesti krvi i krvotvornih organa i određeni poremećaji imunog mehanizma',
  ],
  [
    'IV',
    'Endocrine, nutritional and metabolic diseases',
    'Sëmundjet endokrine, të ushqyerjes dhe metabolike',
    'Endokrine, nutritivne i metaboličke bolesti',
  ],
  [
    'V',
    'Mental and behavioural disorders',
    'Çrregullimet mendore dhe të sjelljes',
    'Duševni poremećaji i poremećaji ponašanja',
  ],
  [
    'VI',
    'Diseases of the nervous system',
    'Sëmundjet e sistemit nervor',
    'Bolesti nervnog sistema',
  ],
  [
    'IX',
    'Diseases of the circulatory system',
    'Sëmundjet e sistemit të qarkullimit të gjakut',
    'Bolesti sistema krvotoka',
  ],
  [
    'X',
    'Diseases of the respiratory system',
    'Sëmundjet e sistemit të frymëmarrjes',
    'Bolesti sistema za disanje',
  ],
  [
    'XI',
    'Diseases of the digestive system',
    'Sëmundjet e sistemit të tretjes',
    'Bolesti sistema za varenje',
  ],
  [
    'XIII',
    'Diseases of the musculoskeletal system and connective tissue',
    'Sëmundjet e sistemit muskuloskeletor dhe të indit lidhor',
    'Bolesti mišićno-koštanog sistema i vezivnog tkiva',
  ],
  [
    'XIV',
    'Diseases of the genitourinary system',
    'Sëmundjet e sistemit urogjenital',
    'Bolesti mokraćno-polnog sistema',
  ],
  [
    'XV',
    'Pregnancy, childbirth and the puerperium',
    'Shtatzënia, lindja dhe lehonia',
    'Trudnoća, porođaj i babinje',
  ],
  [
    'XVIII',
    'Symptoms, signs and abnormal clinical and laboratory findings, not elsewhere classified',
    'Simptomat, shenjat dhe gjetjet jonormale klinike e laboratorike, të paklasifikuara gjetiu',
    'Simptomi, znaci i patološki klinički i laboratorijski nalazi, neklasifikovani na drugom mestu',
  ],
  [
    'XIX',
    'Injury, poisoning and certain other consequences of external causes',
    'Lëndimet, helmimet dhe disa pasoja të tjera të shkaqeve të jashtme',
    'Povrede, trovanja i određene druge posledice spoljašnjih uzroka',
  ],
  [
    'XXI',
    'Factors influencing health status and contact with health services',
    'Faktorët që ndikojnë në gjendjen shëndetësore dhe kontakti me shërbimet shëndetësore',
    'Faktori koji utiču na zdravstveno stanje i kontakt sa zdravstvenom službom',
  ],
  ['XXII', 'Codes for special purposes', 'Kode për qëllime të veçanta', 'Šifre za posebne namene'],
];

/** [code, parent, en, sq, sr]: categories and subcategories (WHO ICD-10, 2019 edition). */
const ICD10: [string, string, string, string, string][] = [
  [
    'A09',
    'I',
    'Other gastroenteritis and colitis of infectious and unspecified origin',
    'Gastroenterit dhe kolit tjetër me origjinë infektive dhe të paspecifikuar',
    'Drugi gastroenteritis i kolitis infektivnog i neoznačenog porekla',
  ],
  [
    'B20',
    'I',
    'Human immunodeficiency virus [HIV] disease resulting in infectious and parasitic diseases',
    'Sëmundje nga HIV që shkakton sëmundje infektive dhe parazitare',
    'HIV bolest sa posledičnim infektivnim i parazitarnim bolestima',
  ],
  [
    'C18',
    'II',
    'Malignant neoplasm of colon',
    'Neoplazmë malinje e zorrës së trashë',
    'Maligna neoplazma debelog creva',
  ],
  [
    'C34',
    'II',
    'Malignant neoplasm of bronchus and lung',
    'Neoplazmë malinje e bronkeve dhe e mushkërive',
    'Maligna neoplazma bronha i pluća',
  ],
  [
    'C50',
    'II',
    'Malignant neoplasm of breast',
    'Neoplazmë malinje e gjirit',
    'Maligna neoplazma dojke',
  ],
  [
    'C61',
    'II',
    'Malignant neoplasm of prostate',
    'Neoplazmë malinje e prostatës',
    'Maligna neoplazma prostate',
  ],
  [
    'D50',
    'III',
    'Iron deficiency anaemia',
    'Anemi nga mungesa e hekurit',
    'Anemija zbog nedostatka gvožđa',
  ],
  [
    'D50.9',
    'D50',
    'Iron deficiency anaemia, unspecified',
    'Anemi nga mungesa e hekurit, e paspecifikuar',
    'Anemija zbog nedostatka gvožđa, neoznačena',
  ],
  ['E10', 'IV', 'Type 1 diabetes mellitus', 'Diabet mellitus i tipit 1', 'Dijabetes melitus tip 1'],
  ['E11', 'IV', 'Type 2 diabetes mellitus', 'Diabet mellitus i tipit 2', 'Dijabetes melitus tip 2'],
  [
    'E11.9',
    'E11',
    'Type 2 diabetes mellitus without complications',
    'Diabet mellitus i tipit 2 pa komplikime',
    'Dijabetes melitus tip 2 bez komplikacija',
  ],
  ['E66', 'IV', 'Obesity', 'Obeziteti', 'Gojaznost'],
  [
    'E78',
    'IV',
    'Disorders of lipoprotein metabolism and other lipidaemias',
    'Çrregullime të metabolizmit të lipoproteinave dhe lipidemi të tjera',
    'Poremećaji metabolizma lipoproteina i druge lipidemije',
  ],
  [
    'E78.5',
    'E78',
    'Hyperlipidaemia, unspecified',
    'Hiperlipidemi, e paspecifikuar',
    'Hiperlipidemija, neoznačena',
  ],
  ['F32', 'V', 'Depressive episode', 'Episod depresiv', 'Depresivna epizoda'],
  [
    'F32.9',
    'F32',
    'Depressive episode, unspecified',
    'Episod depresiv, i paspecifikuar',
    'Depresivna epizoda, neoznačena',
  ],
  [
    'F41',
    'V',
    'Other anxiety disorders',
    'Çrregullime të tjera të ankthit',
    'Drugi anksiozni poremećaji',
  ],
  [
    'F41.1',
    'F41',
    'Generalized anxiety disorder',
    'Çrregullim i ankthit të përgjithësuar',
    'Generalizovani anksiozni poremećaj',
  ],
  ['G40', 'VI', 'Epilepsy', 'Epilepsia', 'Epilepsija'],
  [
    'I10',
    'IX',
    'Essential (primary) hypertension',
    'Hipertension esencial (primar)',
    'Esencijalna (primarna) hipertenzija',
  ],
  [
    'I21',
    'IX',
    'Acute myocardial infarction',
    'Infarkt akut i miokardit',
    'Akutni infarkt miokarda',
  ],
  [
    'I21.9',
    'I21',
    'Acute myocardial infarction, unspecified',
    'Infarkt akut i miokardit, i paspecifikuar',
    'Akutni infarkt miokarda, neoznačen',
  ],
  [
    'I48',
    'IX',
    'Atrial fibrillation and flutter',
    'Fibrilacion dhe flater atrial',
    'Treperenje i lepršanje pretkomora',
  ],
  ['I50', 'IX', 'Heart failure', 'Insuficienca e zemrës', 'Srčana insuficijencija'],
  [
    'I50.9',
    'I50',
    'Heart failure, unspecified',
    'Insuficiencë e zemrës, e paspecifikuar',
    'Srčana insuficijencija, neoznačena',
  ],
  ['I63', 'IX', 'Cerebral infarction', 'Infarkt cerebral', 'Infarkt mozga'],
  [
    'I63.9',
    'I63',
    'Cerebral infarction, unspecified',
    'Infarkt cerebral, i paspecifikuar',
    'Infarkt mozga, neoznačen',
  ],
  [
    'J06',
    'X',
    'Acute upper respiratory infections of multiple and unspecified sites',
    'Infeksione akute të rrugëve të sipërme të frymëmarrjes në vende të shumta dhe të paspecifikuara',
    'Akutne infekcije gornjih disajnih puteva na više mesta i neoznačene lokalizacije',
  ],
  [
    'J06.9',
    'J06',
    'Acute upper respiratory infection, unspecified',
    'Infeksion akut i rrugëve të sipërme të frymëmarrjes, i paspecifikuar',
    'Akutna infekcija gornjih disajnih puteva, neoznačena',
  ],
  [
    'J18',
    'X',
    'Pneumonia, organism unspecified',
    'Pneumoni, shkaktari i paspecifikuar',
    'Upala pluća, neoznačen uzročnik',
  ],
  [
    'J18.9',
    'J18',
    'Pneumonia, unspecified',
    'Pneumoni, e paspecifikuar',
    'Upala pluća, neoznačena',
  ],
  [
    'J44',
    'X',
    'Other chronic obstructive pulmonary disease',
    'Sëmundje tjetër kronike obstruktive e mushkërive',
    'Druga hronična opstruktivna bolest pluća',
  ],
  ['J45', 'X', 'Asthma', 'Astma', 'Astma'],
  ['J45.9', 'J45', 'Asthma, unspecified', 'Astmë, e paspecifikuar', 'Astma, neoznačena'],
  [
    'K21',
    'XI',
    'Gastro-oesophageal reflux disease',
    'Sëmundja e refluksit gastroezofageal',
    'Gastroezofagealna refluksna bolest',
  ],
  [
    'K21.9',
    'K21',
    'Gastro-oesophageal reflux disease without oesophagitis',
    'Sëmundje e refluksit gastroezofageal pa ezofagit',
    'Gastroezofagealna refluksna bolest bez ezofagitisa',
  ],
  ['K35', 'XI', 'Acute appendicitis', 'Apendicit akut', 'Akutna upala slepog creva'],
  ['M54', 'XIII', 'Dorsalgia', 'Dorsalgji', 'Bol u leđima'],
  [
    'M54.5',
    'M54',
    'Low back pain',
    'Dhimbje e pjesës së poshtme të shpinës',
    'Bol u donjem delu leđa',
  ],
  [
    'N18',
    'XIV',
    'Chronic kidney disease',
    'Sëmundje kronike e veshkave',
    'Hronična bolest bubrega',
  ],
  [
    'N39',
    'XIV',
    'Other disorders of urinary system',
    'Çrregullime të tjera të sistemit urinar',
    'Drugi poremećaji mokraćnog sistema',
  ],
  [
    'N39.0',
    'N39',
    'Urinary tract infection, site not specified',
    'Infeksion i rrugëve urinare, vendndodhja e paspecifikuar',
    'Infekcija mokraćnih puteva, neoznačene lokalizacije',
  ],
  [
    'O80',
    'XV',
    'Single spontaneous delivery',
    'Lindje e vetme spontane',
    'Spontani porođaj jednog deteta',
  ],
  [
    'R50',
    'XVIII',
    'Fever of other and unknown origin',
    'Temperaturë me origjinë tjetër dhe të panjohur',
    'Groznica drugog i nepoznatog porekla',
  ],
  ['R50.9', 'R50', 'Fever, unspecified', 'Temperaturë, e paspecifikuar', 'Groznica, neoznačena'],
  ['S72', 'XIX', 'Fracture of femur', 'Thyerje e femurit', 'Prelom butne kosti'],
  [
    'S72.0',
    'S72',
    'Fracture of neck of femur',
    'Thyerje e qafës së femurit',
    'Prelom vrata butne kosti',
  ],
  [
    'Z00',
    'XXI',
    'General examination and investigation of persons without complaint and reported diagnosis',
    'Ekzaminim i përgjithshëm i personave pa ankesa dhe pa diagnozë',
    'Opšti pregled i ispitivanje osoba bez tegoba i prijavljene dijagnoze',
  ],
  [
    'Z00.0',
    'Z00',
    'General medical examination',
    'Ekzaminim i përgjithshëm mjekësor',
    'Opšti lekarski pregled',
  ],
  ['U07', 'XXII', 'Emergency use of U07', 'Përdorim emergjent i U07', 'Hitna upotreba U07'],
  [
    'U07.1',
    'U07',
    'COVID-19, virus identified',
    'COVID-19, virusi i identifikuar',
    'COVID-19, virus identifikovan',
  ],
];

const LICENCE_ICD =
  'ICD-10 © World Health Organization. Subset of the 2019 edition for demonstration; national use needs the WHO licence and the official Albanian and Serbian translations. Albanian and Serbian displays here are working translations to be confirmed.';
const LICENCE_LOINC =
  'This material contains content from LOINC® (https://loinc.org). LOINC is copyright © Regenstrief Institute, Inc. and the LOINC Committee and is available at no cost under the license at https://loinc.org/license. Subset for the demonstration laboratory catalogue.';
const LICENCE_ATC =
  'ATC classification © WHO Collaborating Centre for Drug Statistics Methodology, Oslo. Only the codes of the demonstration medicines catalogue; the national list must come from the official ATC/DDD index.';

/** LOINC long common names for the laboratory catalogue (codes as in modules/lab/catalog.ts). */
const LOINC: Record<string, { display: string; note?: string }> = {
  '718-7': { display: 'Hemoglobin [Mass/volume] in Blood' },
  '6690-2': { display: 'Leukocytes [#/volume] in Blood by Automated count' },
  '777-3': { display: 'Platelets [#/volume] in Blood by Automated count' },
  '2345-7': {
    display: 'Glucose [Mass/volume] in Serum or Plasma',
    note: 'The catalogue reports mmol/L; the moles/volume code is 14749-6 – confirm with the laboratory.',
  },
  '4548-4': { display: 'Hemoglobin A1c/Hemoglobin.total in Blood' },
  '2160-0': {
    display: 'Creatinine [Mass/volume] in Serum or Plasma',
    note: 'The catalogue reports umol/L; the moles/volume code is 14682-9 – confirm with the laboratory.',
  },
  '2823-3': { display: 'Potassium [Moles/volume] in Serum or Plasma' },
  '2951-2': { display: 'Sodium [Moles/volume] in Serum or Plasma' },
  '2093-3': {
    display: 'Cholesterol [Mass/volume] in Serum or Plasma',
    note: 'The catalogue reports mmol/L; the moles/volume code is 14647-2 – confirm with the laboratory.',
  },
  '1988-5': { display: 'C reactive protein [Mass/volume] in Serum or Plasma' },
  '3016-3': { display: 'Thyrotropin [Units/volume] in Serum or Plasma' },
  '2276-4': { display: 'Ferritin [Mass/volume] in Serum or Plasma' },
};

/** First level of ATC (anatomical main groups). */
const ATC_GROUPS: C[] = [
  [
    'A',
    'Alimentary tract and metabolism',
    'Trakti tretës dhe metabolizmi',
    'Digestivni trakt i metabolizam',
  ],
  [
    'B',
    'Blood and blood forming organs',
    'Gjaku dhe organet hematopoietike',
    'Krv i krvotvorni organi',
  ],
  ['C', 'Cardiovascular system', 'Sistemi kardiovaskular', 'Kardiovaskularni sistem'],
  ['D', 'Dermatologicals', 'Preparate dermatologjike', 'Dermatološki lekovi'],
  [
    'G',
    'Genito urinary system and sex hormones',
    'Sistemi urogjenital dhe hormonet seksuale',
    'Urogenitalni sistem i polni hormoni',
  ],
  [
    'H',
    'Systemic hormonal preparations, excluding sex hormones and insulins',
    'Preparate hormonale sistemike, pa hormonet seksuale dhe insulinat',
    'Sistemski hormonski preparati, osim polnih hormona i insulina',
  ],
  [
    'J',
    'Antiinfectives for systemic use',
    'Antiinfektivë për përdorim sistemik',
    'Antiinfektivni lekovi za sistemsku primenu',
  ],
  [
    'L',
    'Antineoplastic and immunomodulating agents',
    'Agjentë antineoplastikë dhe imunomodulues',
    'Antineoplastični i imunomodulatorni lekovi',
  ],
  ['M', 'Musculo-skeletal system', 'Sistemi muskuloskeletor', 'Mišićno-koštani sistem'],
  ['N', 'Nervous system', 'Sistemi nervor', 'Nervni sistem'],
  [
    'P',
    'Antiparasitic products, insecticides and repellents',
    'Produkte antiparazitare, insekticide dhe repelentë',
    'Antiparazitarni proizvodi, insekticidi i repelenti',
  ],
  ['R', 'Respiratory system', 'Sistemi i frymëmarrjes', 'Respiratorni sistem'],
  ['S', 'Sensory organs', 'Organet shqisore', 'Čulni organi'],
  ['V', 'Various', 'Të ndryshme', 'Razno'],
];

/** Local laboratory codes of the demo facility → LOINC (null = no LOINC code in the subset). */
const LOCAL_LAB: [code: string, sq: string, loinc: string | null, comment: string | null][] = [
  ['HGB', 'Hemoglobina', '718-7', null],
  ['WBC', 'Leukocitet', '6690-2', null],
  ['PLT', 'Trombocitet', '777-3', null],
  [
    'GLU',
    'Glukoza esëll',
    '2345-7',
    'Local test is fasting only; LOINC code is not fasting-specific',
  ],
  ['HBA1C', 'HbA1c', '4548-4', null],
  ['CREA', 'Kreatinina', '2160-0', null],
  ['K', 'Kaliumi', '2823-3', null],
  ['NA', 'Natriumi', '2951-2', null],
  ['CHOL', 'Kolesteroli total', '2093-3', null],
  ['CRP', 'Proteina C-reaktive', '1988-5', null],
  ['TSH', 'TSH', '3016-3', null],
  ['FERR', 'Feritina', '2276-4', null],
  ['ESR', 'Sedimentimi i eritrociteve', null, 'No LOINC code in the demonstration subset'],
  ['URINE-DIP', 'Urina me shirit', null, 'Panel; map each analyte separately'],
  ['SMEAR', 'Njollosja e gjakut periferik', null, 'Descriptive result'],
];

const row = (
  code: string,
  en: string,
  sq: string | null,
  sr: string | null,
  parent: string | null,
  active = true,
): ConceptRow => ({
  code,
  display: en,
  displaySq: sq,
  displaySr: sr,
  parentCode: parent,
  active,
});

export async function seedTerminology({
  facilityId,
}: {
  facilityId: string;
  demoDoctorId: string;
}): Promise<void> {
  const [existing] = await db
    .select({ id: codeSystems.id })
    .from(codeSystems)
    .where(eq(codeSystems.code, 'ICD-10'));
  if (existing) return;
  const [minister] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'MINISTRY'))
    .limit(1);
  const [director] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'DIRECTOR'), eq(users.facilityId, facilityId)))
    .limit(1);
  const [facility] = await db.select().from(facilities).where(eq(facilities.id, facilityId));
  const ministryId = minister?.id ?? null;

  await db.transaction(async (tx) => {
    const system = async (values: typeof codeSystems.$inferInsert) =>
      (await tx.insert(codeSystems).values(values).returning())[0]!;
    const publish = async (
      s: typeof codeSystems.$inferSelect,
      version: string,
      rows: ConceptRow[],
      notes: string,
      by: string | null,
    ) => {
      const v = await createSystemVersion(tx, s, { version, notes, rows, userId: by });
      if (by) await activateSystemVersion(tx, v.id, by);
      return v;
    };

    // ICD-10: active 2019-KS-1 and a draft 2019-KS-2 with a few changes for the comparison.
    const icd = await system({
      code: 'ICD-10',
      name: 'International Classification of Diseases, 10th revision',
      url: 'http://hl7.org/fhir/sid/icd-10',
      publisher: 'World Health Organization; national edition: Ministry of Health',
      kind: 'EXTERNAL',
      description: LICENCE_ICD,
    });
    const icdRows = [
      ...CHAPTERS.map(([c, en, sq, sr]) => row(c, en, sq, sr, null)),
      ...ICD10.map(([c, p, en, sq, sr]) => row(c, en, sq, sr, p)),
    ];
    await publish(
      icd,
      '2019-KS-1',
      icdRows,
      'Demonstration subset of the national ICD-10 list',
      ministryId,
    );
    const draft = icdRows
      .filter((r) => r.code !== 'G40') // removed from the national subset
      .map((r) =>
        r.code === 'M54.5'
          ? { ...r, active: false } // retired in favour of a more specific code
          : r.code === 'I10'
            ? { ...r, displaySq: 'Hipertensioni arterial esencial (primar)' }
            : r,
      );
    draft.push(
      row(
        'U07.2',
        'COVID-19, virus not identified',
        'COVID-19, virusi i paidentifikuar',
        'COVID-19, virus nije identifikovan',
        'U07',
      ),
      row(
        'J44.9',
        'Chronic obstructive pulmonary disease, unspecified',
        'Sëmundje kronike obstruktive e mushkërive, e paspecifikuar',
        'Hronična opstruktivna bolest pluća, neoznačena',
        'J44',
      ),
    );
    await createSystemVersion(tx, icd, {
      version: '2019-KS-2',
      notes:
        'Demonstration draft: two codes added, one removed, one inactivated, one Albanian display corrected',
      rows: draft,
      userId: ministryId,
    });

    // LOINC subset for the laboratory catalogue.
    const loinc = await system({
      code: 'LOINC',
      name: 'Logical Observation Identifiers Names and Codes',
      url: 'http://loinc.org',
      publisher: 'Regenstrief Institute',
      kind: 'EXTERNAL',
      description: LICENCE_LOINC,
    });
    const loincRows = LAB_CATALOG.map((t) => {
      const known = LOINC[t.code];
      return {
        ...row(t.code, known?.display ?? t.name, null, null, null),
        properties: known?.note
          ? { needsConfirmation: true, note: known.note, catalogueUnit: t.unit }
          : { catalogueUnit: t.unit },
      };
    });
    await publish(
      loinc,
      '2.78-subset',
      loincRows,
      'Codes of the demonstration laboratory catalogue',
      ministryId,
    );

    // ATC codes of the medicines catalogue.
    const atc = await system({
      code: 'ATC',
      name: 'Anatomical Therapeutic Chemical classification',
      url: 'http://www.whocc.no/atc',
      publisher: 'WHO Collaborating Centre for Drug Statistics Methodology',
      kind: 'EXTERNAL',
      description: LICENCE_ATC,
    });
    const medicines = await tx
      .select({ name: medicationCatalog.name, atcCode: medicationCatalog.atcCode })
      .from(medicationCatalog)
      .where(isNotNull(medicationCatalog.atcCode));
    const byCode = new Map<string, string>();
    for (const m of medicines) if (!byCode.has(m.atcCode!)) byCode.set(m.atcCode!, m.name);
    const groups = ATC_GROUPS.filter(([g]) => [...byCode.keys()].some((c) => c.startsWith(g)));
    await publish(
      atc,
      '2026',
      [
        ...groups.map(([c, en, sq, sr]) => row(c, en, sq, sr, null)),
        ...[...byCode]
          .sort()
          .map(([c, name]) =>
            row(c, name.toLowerCase(), null, null, groups.some(([g]) => g === c[0]) ? c[0]! : null),
          ),
      ],
      'ATC codes used by the medicines catalogue',
      ministryId,
    );

    // Local laboratory code system of the demo facility, mapped to LOINC.
    if (!director || !facility) return;
    const local = await system({
      code: `LOCAL-LAB-${facility.code}`
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '-')
        .slice(0, 40),
      name: `Laboratory codes – ${facility.name}`,
      url: `https://terminology.pacient.example/CodeSystem/local-lab-${facility.code.toLowerCase()}`,
      publisher: facility.name,
      kind: 'LOCAL',
      facilityId,
      description:
        'Test codes used by the laboratory information system of the facility (synthetic).',
    });
    await publish(
      local,
      '1',
      LOCAL_LAB.map(([c, sq, loincCode]) =>
        row(c, loincCode ? (LOINC[loincCode]?.display ?? sq) : sq, sq, null, null),
      ),
      'Initial list from the laboratory information system',
      director.id,
    );
    const [map] = await tx
      .insert(conceptMaps)
      .values({
        code: `${local.code}-TO-LOINC`.slice(0, 60),
        name: `${facility.name}: laboratory codes → LOINC`,
        url: `https://terminology.pacient.example/ConceptMap/local-lab-${facility.code.toLowerCase()}-loinc`,
        sourceSystemId: local.id,
        targetSystemId: loinc.id,
      })
      .returning();
    const entries: MapRow[] = LOCAL_LAB.map(([c, sq, loincCode, comment]) => ({
      sourceCode: c,
      sourceDisplay: sq,
      targetCode: loincCode,
      equivalence: loincCode ? (c === 'GLU' ? 'WIDER' : 'EQUIVALENT') : 'UNMATCHED',
      comment,
    }));
    const mv = await createMapVersion(tx, map!, {
      version: '1',
      notes: 'Reviewed by the laboratory lead (demonstration)',
      rows: entries,
      userId: director.id,
    });
    await activateMapVersion(tx, mv.id, director.id);
  });
}
