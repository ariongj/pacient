/**
 * Cancer registry reference data and coding rules (ICD-10, ICD-O-3, TNM).
 *
 * The lists below are a small, code-defined subset of common sites and morphologies offered as
 * shortcuts in the registration form; any code in the right format is accepted. Labels are English
 * source texts translated in the web dictionaries.
 */

/** ICD-O-3 topography groups offered in the form (first three characters of the site code). */
export const SITE_GROUPS: { code: string; label: string }[] = [
  { code: 'C02', label: 'Tongue' },
  { code: 'C11', label: 'Nasopharynx' },
  { code: 'C15', label: 'Oesophagus' },
  { code: 'C16', label: 'Stomach' },
  { code: 'C18', label: 'Colon' },
  { code: 'C19', label: 'Rectosigmoid junction' },
  { code: 'C20', label: 'Rectum' },
  { code: 'C22', label: 'Liver and intrahepatic bile ducts' },
  { code: 'C25', label: 'Pancreas' },
  { code: 'C32', label: 'Larynx' },
  { code: 'C34', label: 'Bronchus and lung' },
  { code: 'C40', label: 'Bone of limbs' },
  { code: 'C42', label: 'Haematopoietic and reticuloendothelial systems' },
  { code: 'C44', label: 'Skin' },
  { code: 'C50', label: 'Breast' },
  { code: 'C53', label: 'Cervix uteri' },
  { code: 'C54', label: 'Corpus uteri' },
  { code: 'C56', label: 'Ovary' },
  { code: 'C61', label: 'Prostate gland' },
  { code: 'C62', label: 'Testis' },
  { code: 'C64', label: 'Kidney' },
  { code: 'C67', label: 'Bladder' },
  { code: 'C69', label: 'Eye and adnexa' },
  { code: 'C71', label: 'Brain' },
  { code: 'C73', label: 'Thyroid gland' },
  { code: 'C77', label: 'Lymph nodes' },
  { code: 'C80', label: 'Unknown primary site' },
];

/** Common ICD-O-3 morphologies (code/behaviour). */
export const MORPHOLOGIES: { code: string; label: string }[] = [
  { code: '8000/3', label: 'Malignant neoplasm, not otherwise specified' },
  { code: '8010/3', label: 'Carcinoma, not otherwise specified' },
  { code: '8041/3', label: 'Small cell carcinoma' },
  { code: '8046/3', label: 'Non-small cell carcinoma' },
  { code: '8070/3', label: 'Squamous cell carcinoma' },
  { code: '8077/2', label: 'Squamous intraepithelial neoplasia, grade III' },
  { code: '8090/3', label: 'Basal cell carcinoma' },
  { code: '8120/3', label: 'Transitional cell carcinoma' },
  { code: '8140/3', label: 'Adenocarcinoma, not otherwise specified' },
  { code: '8260/3', label: 'Papillary adenocarcinoma' },
  { code: '8312/3', label: 'Renal cell carcinoma' },
  { code: '8500/2', label: 'Intraductal carcinoma (DCIS)' },
  { code: '8500/3', label: 'Infiltrating duct carcinoma' },
  { code: '8520/3', label: 'Lobular carcinoma' },
  { code: '8720/3', label: 'Malignant melanoma' },
  { code: '9440/3', label: 'Glioblastoma' },
  { code: '9650/3', label: 'Hodgkin lymphoma' },
  { code: '9680/3', label: 'Diffuse large B-cell lymphoma' },
  { code: '9732/3', label: 'Plasma cell myeloma' },
  { code: '9861/3', label: 'Acute myeloid leukaemia' },
];

/** Paired organs: laterality must be stated (LEFT, RIGHT, BILATERAL or UNKNOWN). */
export const PAIRED_SITE_GROUPS = new Set([
  'C34',
  'C40',
  'C50',
  'C56',
  'C62',
  'C64',
  'C65',
  'C66',
  'C69',
  'C74',
]);

export const LATERALITIES = ['LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE', 'UNKNOWN'] as const;
export const BASES_OF_DIAGNOSIS = [
  'HISTOLOGY',
  'CYTOLOGY',
  'CLINICAL_INVESTIGATION',
  'CLINICAL_ONLY',
  'DEATH_CERTIFICATE_ONLY',
] as const;
export const STAGES = ['0', 'I', 'II', 'III', 'IV', 'UNKNOWN'] as const;
export const TUMOUR_GROUPS = [
  'BREAST',
  'LUNG',
  'COLORECTAL',
  'UROLOGY',
  'GYNAECOLOGY',
  'HAEMATOLOGY',
  'HEAD_NECK',
  'SKIN',
  'UPPER_GI',
  'OTHER',
] as const;
export const RECOMMENDATIONS = [
  'SURGERY',
  'CHEMOTHERAPY',
  'RADIOTHERAPY',
  'COMBINED',
  'SURVEILLANCE',
  'PALLIATIVE',
  'MORE_TESTS',
  'OTHER',
] as const;

export const ICD10_CANCER = /^(C[0-8][0-9]|C9[0-7]|D0[0-9])(\.[0-9A-Z]{1,2})?$/;
export const TOPOGRAPHY = /^C[0-9]{2}\.[0-9]$/;
export const MORPHOLOGY = /^[0-9]{4}\/[0-3]$/;
export const TNM_T = /^(c|p|yc|yp)?(TX|T0|Tis|Ta|T[1-4][a-d]?)$/;
export const TNM_N = /^(c|p|yc|yp)?(NX|N0|N[1-3][a-c]?)$/;
export const TNM_M = /^(c|p)?(MX|M0|M1[a-d]?)$/;

export const siteGroupOf = (topography: string) => topography.slice(0, 3);
export const siteLabelOf = (group: string) =>
  SITE_GROUPS.find((s) => s.code === group)?.label ?? null;

export interface CaseCheckInput {
  icd10: string;
  topography: string;
  morphology: string;
  laterality: string;
  tnmM?: string | null;
  stage?: string | null;
}

export interface CaseWarning {
  code: string;
  message: string;
}

/**
 * Coding consistency checks. Problems (laterality missing for a paired organ) block registration;
 * warnings are shown and stored only in the audit entry.
 */
export function checkCase(c: CaseCheckInput): { problems: CaseWarning[]; warnings: CaseWarning[] } {
  const problems: CaseWarning[] = [];
  const warnings: CaseWarning[] = [];
  const group = siteGroupOf(c.topography);
  if (PAIRED_SITE_GROUPS.has(group) && c.laterality === 'NOT_APPLICABLE') {
    problems.push({
      code: 'LATERALITY_REQUIRED',
      message: 'State the side (left, right, both or unknown) for a paired organ',
    });
  }
  if (!PAIRED_SITE_GROUPS.has(group) && ['LEFT', 'RIGHT', 'BILATERAL'].includes(c.laterality)) {
    warnings.push({
      code: 'LATERALITY_NOT_PAIRED',
      message: 'A side was given for a site that is not a paired organ',
    });
  }
  const icd3 = c.icd10.slice(0, 3);
  const behaviour = c.morphology.slice(-1);
  const inSitu = icd3.startsWith('D0');
  // ICD-10 C00–C42, C44, C47–C76: the topography group should match the ICD-10 category.
  const n = Number(icd3.slice(1));
  if (icd3.startsWith('C')) {
    const expected =
      icd3 === 'C43' ? 'C44' : n <= 42 || n === 44 || (n >= 47 && n <= 76) ? icd3 : null;
    if (expected && group !== expected) {
      warnings.push({
        code: 'TOPOGRAPHY_MISMATCH',
        message: 'The site code does not match the ICD-10 code',
      });
    }
  }
  if (inSitu && behaviour !== '2') {
    warnings.push({
      code: 'BEHAVIOUR_MISMATCH',
      message: 'An in-situ ICD-10 code (D00–D09) normally has behaviour /2',
    });
  } else if (!inSitu && behaviour === '2') {
    warnings.push({
      code: 'BEHAVIOUR_MISMATCH',
      message: 'Behaviour /2 (in situ) does not match an invasive ICD-10 code',
    });
  } else if (behaviour === '0' || behaviour === '1') {
    warnings.push({
      code: 'BEHAVIOUR_NOT_MALIGNANT',
      message: 'Benign or uncertain behaviour is not normally registered',
    });
  }
  if (c.stage && c.stage !== 'UNKNOWN') {
    if (c.tnmM && /M1/.test(c.tnmM) && c.stage !== 'IV') {
      warnings.push({
        code: 'STAGE_MISMATCH',
        message: 'Distant metastasis (M1) is normally stage IV',
      });
    }
    if (behaviour === '2' && c.stage !== '0') {
      warnings.push({ code: 'STAGE_MISMATCH', message: 'An in-situ tumour is normally stage 0' });
    }
    if (behaviour === '3' && c.stage === '0') {
      warnings.push({ code: 'STAGE_MISMATCH', message: 'Stage 0 is used for in-situ tumours' });
    }
  }
  return { problems, warnings };
}

/** Five-year age bands at diagnosis (0–4 … 80–84, 85+). */
export function ageBand(age: number): string {
  if (age >= 85) return '85+';
  const lo = Math.floor(Math.max(0, age) / 5) * 5;
  return `${lo}–${lo + 4}`;
}

export const AGE_BANDS = [...Array.from({ length: 17 }, (_, i) => `${i * 5}–${i * 5 + 4}`), '85+'];

/** Topography for a death-certificate-only case derived from its ICD-10 underlying cause. */
export function topographyFromIcd10(icd10: string): string | null {
  const icd3 = icd10.slice(0, 3);
  if (icd3 === 'C43') return 'C44.9';
  const n = Number(icd3.slice(1));
  if (icd3.startsWith('C') && (n <= 42 || n === 44 || (n >= 47 && n <= 80))) {
    const digit = /^C\d\d\.(\d)/.exec(icd10)?.[1] ?? '9';
    return `${icd3}.${digit}`;
  }
  return null;
}
