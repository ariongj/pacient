import type { vaccineSchedule } from '../../db/schema.js';

/**
 * ILLUSTRATIVE routine childhood calendar, modelled on Kosovo's immunization programme (birth
 * doses, hexavalent and pneumococcal primary series at 2, 3 and 4 months, MMR at 12 months and
 * school entry, boosters, HPV and Td in adolescence). It MUST be verified against the official
 * calendar of the National Institute of Public Health of Kosovo (IKShPK) before real use; the
 * Ministry can edit every dose in the app (Vaccination coverage → schedule).
 */
export const CALENDAR_NOTE =
  'Illustrative calendar – verify against the official calendar of the National Institute of Public Health of Kosovo (IKShPK).';

const M = 30.44; // average days per month
const days = (months: number) => Math.round(months * M);
const years = (y: number) => Math.round(y * 365.25);

export const DEFAULT_SCHEDULE: (typeof vaccineSchedule.$inferInsert)[] = [
  {
    code: 'BCG',
    vaccine: 'BCG',
    doseNumber: 1,
    recommendedAgeDays: 0,
    overdueAgeDays: days(2),
    description: 'Tuberculosis, at birth',
  },
  {
    code: 'HEPB_0',
    vaccine: 'Hepatitis B (birth dose)',
    doseNumber: 1,
    recommendedAgeDays: 0,
    overdueAgeDays: 7,
    description: 'Hepatitis B, within the first days of life',
  },
  ...[1, 2, 3].map((dose) => ({
    code: `HEXA_${dose}`,
    vaccine: 'DTaP-IPV-Hib-HepB',
    doseNumber: dose,
    recommendedAgeDays: days(dose + 1),
    overdueAgeDays: days(dose + 2),
    description:
      'Diphtheria, tetanus, pertussis, polio, Haemophilus influenzae type b and hepatitis B (hexavalent)',
  })),
  ...[1, 2, 3].map((dose) => ({
    code: `PCV_${dose}`,
    vaccine: 'Pneumococcal conjugate (PCV)',
    doseNumber: dose,
    recommendedAgeDays: days(dose + 1),
    overdueAgeDays: days(dose + 2),
    description: 'Pneumococcal disease',
  })),
  {
    code: 'MMR_1',
    vaccine: 'MMR',
    doseNumber: 1,
    recommendedAgeDays: days(12),
    overdueAgeDays: days(15),
    description: 'Measles, mumps and rubella',
  },
  {
    code: 'DTAP_IPV_B1',
    vaccine: 'DTaP-IPV (booster)',
    doseNumber: 1,
    recommendedAgeDays: days(18),
    overdueAgeDays: days(24),
    description: 'Diphtheria, tetanus, pertussis and polio booster',
  },
  {
    code: 'MMR_2',
    vaccine: 'MMR',
    doseNumber: 2,
    recommendedAgeDays: years(6),
    overdueAgeDays: years(7),
    description: 'Measles, mumps and rubella, second dose at school entry',
  },
  {
    code: 'DTAP_IPV_B2',
    vaccine: 'DTaP-IPV (booster)',
    doseNumber: 2,
    recommendedAgeDays: years(6),
    overdueAgeDays: years(7),
    description: 'Diphtheria, tetanus, pertussis and polio booster at school entry',
  },
  {
    code: 'HPV_1',
    vaccine: 'HPV',
    doseNumber: 1,
    recommendedAgeDays: years(12),
    overdueAgeDays: years(13),
    description: 'Human papillomavirus, if part of the national programme',
  },
  {
    code: 'TD',
    vaccine: 'Td',
    doseNumber: 1,
    recommendedAgeDays: years(14),
    overdueAgeDays: years(15),
    description: 'Tetanus and diphtheria booster in adolescence',
  },
].map((row, i) => ({ ...row, sortOrder: (i + 1) * 10 }));
