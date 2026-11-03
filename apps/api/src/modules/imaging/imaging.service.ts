import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { careUnits, imagingModalityEnum, unitStaff, users } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';

export type Modality = (typeof imagingModalityEnum.enumValues)[number];

/** Accession number shown on the request and in the radiology system: IMG + yymmdd + 6 hex. */
export function newAccessionNumber(now = new Date()): string {
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `IMG${date}${randomBytes(3).toString('hex').toUpperCase()}`;
}

const YesNoUnknown = z.enum(['NO', 'YES', 'UNKNOWN']);
const note = z.string().trim().max(500).optional().nullable();

/** Answers the ordering doctor gives before an examination (stored with the order). */
export const SafetyChecksSchema = z
  .object({
    pregnancy: YesNoUnknown.optional(),
    contrast: z.boolean().optional(),
    contrastAllergy: YesNoUnknown.optional(),
    renalImpairment: YesNoUnknown.optional(),
    implants: z.enum(['NO', 'YES']).optional(),
    implantsNote: note,
    note,
  })
  .strict()
  .default({});
export type SafetyChecks = z.infer<typeof SafetyChecksSchema>;

/** Examinations with ionising radiation, where pregnancy must be asked about. */
const IONISING: Modality[] = ['XRAY', 'CT', 'FLUOROSCOPY', 'MAMMOGRAPHY'];
const CONTRAST_CAPABLE: Modality[] = ['CT', 'MRI'];

export function ageOn(dateOfBirth: string, at = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * Safety screening rules. Throws 400 with a message the ordering doctor can act on; returns the
 * checks normalised to what applies to this modality.
 */
export function validateSafetyChecks(
  modality: Modality,
  patient: { sex: string; dateOfBirth: string },
  checks: SafetyChecks,
): SafetyChecks {
  const out: SafetyChecks = {};
  const age = ageOn(patient.dateOfBirth);
  if (IONISING.includes(modality) && patient.sex === 'FEMALE' && age >= 12 && age <= 55) {
    if (!checks.pregnancy) {
      throw badRequest('Pregnancy status is required for this examination (patient aged 12–55)');
    }
  }
  if (checks.pregnancy) out.pregnancy = checks.pregnancy;
  if (CONTRAST_CAPABLE.includes(modality)) {
    if (checks.contrast === undefined) {
      throw badRequest('State whether contrast is requested');
    }
    out.contrast = checks.contrast;
    if (checks.contrast) {
      if (!checks.contrastAllergy || !checks.renalImpairment) {
        throw badRequest('Contrast requires answers on contrast allergy and kidney function');
      }
      out.contrastAllergy = checks.contrastAllergy;
      out.renalImpairment = checks.renalImpairment;
    }
  }
  if (modality === 'MRI') {
    if (!checks.implants) throw badRequest('MRI requires implant and pacemaker screening');
    out.implants = checks.implants;
    if (checks.implants === 'YES') {
      if (!checks.implantsNote || checks.implantsNote.length < 5) {
        throw badRequest('Describe the implant or pacemaker so radiology can check MRI safety');
      }
      out.implantsNote = checks.implantsNote;
    }
  }
  if (checks.note) out.note = checks.note;
  return out;
}

/** Staff (optionally limited to roles) of the facility's active radiology units. */
export async function radiologyStaff(
  facilityId: string,
  roles: ('DOCTOR' | 'NURSE')[] = ['DOCTOR', 'NURSE'],
  executor: Executor = db,
) {
  const rows = await executor
    .select({ id: users.id, role: users.role })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.type, 'RADIOLOGY'),
        eq(careUnits.isActive, true),
        eq(users.isActive, true),
        inArray(users.role, roles),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

export async function isRadiologyStaff(
  userId: string,
  facilityId: string | null,
  roles: ('DOCTOR' | 'NURSE')[] = ['DOCTOR', 'NURSE'],
  executor: Executor = db,
) {
  if (!facilityId) return false;
  return (await radiologyStaff(facilityId, roles, executor)).includes(userId);
}
