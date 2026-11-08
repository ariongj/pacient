/** Labels for codes in public datasets, in English, Albanian and Serbian (Latin). */
export type Lang = 'en' | 'sq' | 'sr';
export type L = Record<Lang, string>;

export const label = (l: L | undefined, lang: Lang, fallback: string) => l?.[lang] ?? fallback;

export const FACILITY_TYPES: Record<string, L> = {
  UNIVERSITY_CLINICAL_CENTER: {
    en: 'University clinical centre',
    sq: 'Qendër klinike universitare',
    sr: 'Univerzitetski klinički centar',
  },
  REGIONAL_HOSPITAL: { en: 'Regional hospital', sq: 'Spital rajonal', sr: 'Regionalna bolnica' },
  FAMILY_MEDICINE_CENTER: {
    en: 'Family medicine centre',
    sq: 'Qendër e mjekësisë familjare',
    sr: 'Centar porodične medicine',
  },
  SPECIALIZED_CLINIC: {
    en: 'Specialised clinic',
    sq: 'Klinikë e specializuar',
    sr: 'Specijalizovana klinika',
  },
};

export const SPECIALTIES: Record<string, L> = {
  CARDIOLOGY: { en: 'Cardiology', sq: 'Kardiologji', sr: 'Kardiologija' },
  DERMATOLOGY: { en: 'Dermatology', sq: 'Dermatologji', sr: 'Dermatologija' },
  ENDOCRINOLOGY: { en: 'Endocrinology', sq: 'Endokrinologji', sr: 'Endokrinologija' },
  ENT: { en: 'Ear, nose and throat', sq: 'Otorinolaringologji', sr: 'Otorinolaringologija' },
  GASTROENTEROLOGY: { en: 'Gastroenterology', sq: 'Gastroenterologji', sr: 'Gastroenterologija' },
  GENERAL_SURGERY: { en: 'General surgery', sq: 'Kirurgji e përgjithshme', sr: 'Opšta hirurgija' },
  GYNAECOLOGY: { en: 'Gynaecology', sq: 'Gjinekologji', sr: 'Ginekologija' },
  NEUROLOGY: { en: 'Neurology', sq: 'Neurologji', sr: 'Neurologija' },
  NEUROSURGERY: { en: 'Neurosurgery', sq: 'Neurokirurgji', sr: 'Neurohirurgija' },
  OPHTHALMOLOGY: { en: 'Ophthalmology', sq: 'Oftalmologji', sr: 'Oftalmologija' },
  ORTHOPAEDICS: { en: 'Orthopaedics', sq: 'Ortopedi', sr: 'Ortopedija' },
  PAEDIATRIC_SURGERY: {
    en: 'Paediatric surgery',
    sq: 'Kirurgji pediatrike',
    sr: 'Dečja hirurgija',
  },
  PSYCHIATRY: { en: 'Psychiatry', sq: 'Psikiatri', sr: 'Psihijatrija' },
  RHEUMATOLOGY: { en: 'Rheumatology', sq: 'Reumatologji', sr: 'Reumatologija' },
  UROLOGY: { en: 'Urology', sq: 'Urologji', sr: 'Urologija' },
  VASCULAR_SURGERY: {
    en: 'Vascular surgery',
    sq: 'Kirurgji vaskulare',
    sr: 'Vaskularna hirurgija',
  },
};

export const WAIT_KINDS: Record<string, L> = {
  PROCEDURE: { en: 'Procedure', sq: 'Procedurë', sr: 'Procedura' },
  OUTPATIENT: {
    en: 'First specialist appointment',
    sq: 'Vizita e parë te specialisti',
    sr: 'Prvi pregled kod specijaliste',
  },
};

export const COHORTS: Record<string, L> = {
  '12-23m': { en: '12–23 months', sq: '12–23 muaj', sr: '12–23 meseca' },
  '24-35m': { en: '24–35 months', sq: '24–35 muaj', sr: '24–35 meseci' },
  '6-7y': { en: '6–7 years', sq: '6–7 vjeç', sr: '6–7 godina' },
};

export const PROGRAMMES: Record<string, L> = {
  CERVICAL: {
    en: 'Cervical screening',
    sq: 'Depistimi i kancerit të qafës së mitrës',
    sr: 'Skrining raka grlića materice',
  },
  BREAST: {
    en: 'Breast screening',
    sq: 'Depistimi i kancerit të gjirit',
    sr: 'Skrining raka dojke',
  },
  COLORECTAL: {
    en: 'Bowel screening',
    sq: 'Depistimi i kancerit kolorektal',
    sr: 'Skrining kolorektalnog raka',
  },
};

export const CHAPTERS: Record<string, L> = {
  I: {
    en: 'Infectious and parasitic diseases',
    sq: 'Sëmundje infektive dhe parazitare',
    sr: 'Zarazne i parazitarne bolesti',
  },
  II: { en: 'Neoplasms', sq: 'Tumoret', sr: 'Tumori' },
  III: {
    en: 'Blood and immune disorders',
    sq: 'Sëmundje të gjakut dhe imunitetit',
    sr: 'Bolesti krvi i imuniteta',
  },
  IV: {
    en: 'Endocrine, nutritional and metabolic',
    sq: 'Endokrine, ushqyese dhe metabolike',
    sr: 'Endokrine, nutritivne i metaboličke',
  },
  V: {
    en: 'Mental and behavioural disorders',
    sq: 'Çrregullime mendore dhe të sjelljes',
    sr: 'Mentalni poremećaji i poremećaji ponašanja',
  },
  VI: {
    en: 'Diseases of the nervous system',
    sq: 'Sëmundje të sistemit nervor',
    sr: 'Bolesti nervnog sistema',
  },
  VII: { en: 'Diseases of the eye', sq: 'Sëmundje të syrit', sr: 'Bolesti oka' },
  VIII: { en: 'Diseases of the ear', sq: 'Sëmundje të veshit', sr: 'Bolesti uha' },
  IX: {
    en: 'Diseases of the circulatory system',
    sq: 'Sëmundje të sistemit të qarkullimit',
    sr: 'Bolesti sistema krvotoka',
  },
  X: {
    en: 'Diseases of the respiratory system',
    sq: 'Sëmundje të sistemit të frymëmarrjes',
    sr: 'Bolesti sistema za disanje',
  },
  XI: {
    en: 'Diseases of the digestive system',
    sq: 'Sëmundje të sistemit tretës',
    sr: 'Bolesti sistema za varenje',
  },
  XII: { en: 'Diseases of the skin', sq: 'Sëmundje të lëkurës', sr: 'Bolesti kože' },
  XIII: {
    en: 'Musculoskeletal diseases',
    sq: 'Sëmundje muskuloskeletore',
    sr: 'Bolesti mišićno-koštanog sistema',
  },
  XIV: {
    en: 'Diseases of the genitourinary system',
    sq: 'Sëmundje të sistemit urogjenital',
    sr: 'Bolesti mokraćno-polnog sistema',
  },
  XV: {
    en: 'Pregnancy, childbirth and the puerperium',
    sq: 'Shtatzënia, lindja dhe lehonia',
    sr: 'Trudnoća, porođaj i babinje',
  },
  XVI: { en: 'Perinatal conditions', sq: 'Gjendje perinatale', sr: 'Perinatalna stanja' },
  XVII: { en: 'Congenital anomalies', sq: 'Anomali kongjenitale', sr: 'Urođene anomalije' },
  XVIII: {
    en: 'Ill-defined causes',
    sq: 'Shkaqe të papërcaktuara mirë',
    sr: 'Nedovoljno definisani uzroci',
  },
  XIX: { en: 'Injury and poisoning', sq: 'Lëndime dhe helmime', sr: 'Povrede i trovanja' },
  XX: { en: 'External causes', sq: 'Shkaqe të jashtme', sr: 'Spoljni uzroci' },
  XXII: {
    en: 'Codes for special purposes',
    sq: 'Kode për qëllime të veçanta',
    sr: 'Šifre za posebne namene',
  },
  '?': { en: 'Not classified', sq: 'E paklasifikuar', sr: 'Neklasifikovano' },
};

/** "All" rows (national totals). */
export const ALL: L = { en: 'All (Kosovo)', sq: 'Gjithsej (Kosovë)', sr: 'Ukupno (Kosovo)' };
export const ALL_CAUSES: L = { en: 'All causes', sq: 'Të gjitha shkaqet', sr: 'Svi uzroci' };
export const NOT_RECORDED: L = {
  en: 'Not recorded',
  sq: 'E paregjistruar',
  sr: 'Nije evidentirano',
};
