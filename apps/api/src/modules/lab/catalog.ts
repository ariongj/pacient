/**
 * Orderable laboratory tests (LOINC codes). A deployment replaces this with the laboratory's own
 * catalogue; reference ranges are the laboratory's, shown as reported.
 */
export interface CatalogTest {
  code: string;
  name: string;
  specimen: string;
  unit: string;
  referenceRange: string;
  /** Plausible normal interval, used only by the development lab simulator. */
  normal: [number, number];
  decimals: number;
}

export const LAB_CATALOG: CatalogTest[] = [
  {
    code: '718-7',
    name: 'Haemoglobin',
    specimen: 'Blood (EDTA)',
    unit: 'g/L',
    referenceRange: '120-160',
    normal: [120, 160],
    decimals: 0,
  },
  {
    code: '6690-2',
    name: 'White blood cell count',
    specimen: 'Blood (EDTA)',
    unit: '10*9/L',
    referenceRange: '4.0-10.0',
    normal: [4, 10],
    decimals: 1,
  },
  {
    code: '777-3',
    name: 'Platelet count',
    specimen: 'Blood (EDTA)',
    unit: '10*9/L',
    referenceRange: '150-400',
    normal: [150, 400],
    decimals: 0,
  },
  {
    code: '2345-7',
    name: 'Glucose (fasting)',
    specimen: 'Serum',
    unit: 'mmol/L',
    referenceRange: '3.9-5.5',
    normal: [3.9, 5.5],
    decimals: 1,
  },
  {
    code: '4548-4',
    name: 'HbA1c',
    specimen: 'Blood (EDTA)',
    unit: '%',
    referenceRange: '4.0-5.6',
    normal: [4, 5.6],
    decimals: 1,
  },
  {
    code: '2160-0',
    name: 'Creatinine',
    specimen: 'Serum',
    unit: 'umol/L',
    referenceRange: '60-110',
    normal: [60, 110],
    decimals: 0,
  },
  {
    code: '2823-3',
    name: 'Potassium',
    specimen: 'Serum',
    unit: 'mmol/L',
    referenceRange: '3.5-5.1',
    normal: [3.5, 5.1],
    decimals: 1,
  },
  {
    code: '2951-2',
    name: 'Sodium',
    specimen: 'Serum',
    unit: 'mmol/L',
    referenceRange: '135-145',
    normal: [135, 145],
    decimals: 0,
  },
  {
    code: '2093-3',
    name: 'Total cholesterol',
    specimen: 'Serum',
    unit: 'mmol/L',
    referenceRange: '<5.2',
    normal: [3.5, 5.1],
    decimals: 1,
  },
  {
    code: '1988-5',
    name: 'C-reactive protein (CRP)',
    specimen: 'Serum',
    unit: 'mg/L',
    referenceRange: '<5',
    normal: [0.5, 4.9],
    decimals: 1,
  },
  {
    code: '3016-3',
    name: 'TSH',
    specimen: 'Serum',
    unit: 'mU/L',
    referenceRange: '0.4-4.0',
    normal: [0.4, 4],
    decimals: 2,
  },
  {
    code: '2276-4',
    name: 'Ferritin',
    specimen: 'Serum',
    unit: 'ug/L',
    referenceRange: '30-300',
    normal: [30, 300],
    decimals: 0,
  },
];

export const catalogByCode = (code: string) => LAB_CATALOG.find((t) => t.code === code);
