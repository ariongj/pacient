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
  /**
   * Critical (alert) limits for manual result entry – values at or beyond them are CRITICAL.
   * Illustrative; the laboratory's own critical-value policy replaces them.
   */
  critical?: { low?: number; high?: number };
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
    critical: { low: 70, high: 200 },
  },
  {
    code: '6690-2',
    name: 'White blood cell count',
    specimen: 'Blood (EDTA)',
    unit: '10*9/L',
    referenceRange: '4.0-10.0',
    normal: [4, 10],
    decimals: 1,
    critical: { low: 1, high: 30 },
  },
  {
    code: '777-3',
    name: 'Platelet count',
    specimen: 'Blood (EDTA)',
    unit: '10*9/L',
    referenceRange: '150-400',
    normal: [150, 400],
    decimals: 0,
    critical: { low: 20, high: 1000 },
  },
  {
    code: '2345-7',
    name: 'Glucose (fasting)',
    specimen: 'Serum',
    unit: 'mmol/L',
    referenceRange: '3.9-5.5',
    normal: [3.9, 5.5],
    decimals: 1,
    critical: { low: 2.5, high: 25 },
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
    critical: { high: 500 },
  },
  {
    code: '2823-3',
    name: 'Potassium',
    specimen: 'Serum',
    unit: 'mmol/L',
    referenceRange: '3.5-5.1',
    normal: [3.5, 5.1],
    decimals: 1,
    critical: { low: 2.8, high: 6.2 },
  },
  {
    code: '2951-2',
    name: 'Sodium',
    specimen: 'Serum',
    unit: 'mmol/L',
    referenceRange: '135-145',
    normal: [135, 145],
    decimals: 0,
    critical: { low: 120, high: 160 },
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
    critical: { high: 300 },
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

/** Parses "120-160", "<5" or ">2" into bounds (null when the range is not numeric). */
export function parseRange(
  range: string | null | undefined,
): { low?: number; high?: number } | null {
  if (!range) return null;
  const r = range.replace(/\s/g, '').replace(',', '.');
  let m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(r);
  if (m) return { low: Number(m[1]), high: Number(m[2]) };
  m = /^<=?(-?\d+(?:\.\d+)?)$/.exec(r);
  if (m) return { high: Number(m[1]) };
  m = /^>=?(-?\d+(?:\.\d+)?)$/.exec(r);
  if (m) return { low: Number(m[1]) };
  return null;
}

/**
 * Flag of a manually entered value: CRITICAL beyond the critical limits, LOW/HIGH outside the
 * reference range, NORMAL otherwise. Non-numeric values are NORMAL unless marked critical.
 */
export function flagFor(
  test: Pick<CatalogTest, 'referenceRange' | 'critical'> | undefined,
  value: string,
  markedCritical = false,
): 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL' {
  if (markedCritical) return 'CRITICAL';
  const n = Number(value.replace(',', '.'));
  if (!test || !Number.isFinite(n)) return 'NORMAL';
  const c = test.critical;
  if (c && ((c.low !== undefined && n <= c.low) || (c.high !== undefined && n >= c.high))) {
    return 'CRITICAL';
  }
  const r = parseRange(test.referenceRange);
  if (r?.low !== undefined && n < r.low) return 'LOW';
  if (r?.high !== undefined && n > r.high) return 'HIGH';
  return 'NORMAL';
}
