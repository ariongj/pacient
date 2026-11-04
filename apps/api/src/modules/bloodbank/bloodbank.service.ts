import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  bloodGroupTests,
  bloodProductEnum,
  careUnits,
  transfusionRequests,
  unitStaff,
  users,
} from '../../db/schema.js';
import { publish } from '../../lib/events.js';
import { logger } from '../../lib/logger.js';

export type BloodProduct = (typeof bloodProductEnum.enumValues)[number];
export type Abo = 'O' | 'A' | 'B' | 'AB';
export type RhD = 'POS' | 'NEG';
export interface BloodGroup {
  abo: Abo;
  rhD: RhD;
}

export const ABO_GROUPS: Abo[] = ['O', 'A', 'B', 'AB'];
export const RHD: RhD[] = ['POS', 'NEG'];

/** Staff (doctors, nurses) of the facility's active blood bank units. */
export async function bloodBankStaff(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.type, 'BLOOD_BANK'),
        eq(careUnits.isActive, true),
        eq(users.isActive, true),
        inArray(users.role, ['DOCTOR', 'NURSE']),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

export async function isBloodBankStaff(
  userId: string,
  facilityId: string | null,
  executor: Executor = db,
) {
  if (!facilityId) return false;
  return (await bloodBankStaff(facilityId, executor)).includes(userId);
}

/**
 * The patient's current blood group: the latest result counts; it is "confirmed" only when at
 * least two results from different samples agree (and none contradicts the latest one).
 */
export async function currentBloodGroup(patientId: string, executor: Executor = db) {
  const tests = await executor
    .select()
    .from(bloodGroupTests)
    .where(eq(bloodGroupTests.patientId, patientId))
    .orderBy(desc(bloodGroupTests.testedAt));
  const latest = tests[0];
  if (!latest) {
    return { group: null, confirmed: false, concordantTests: 0, discordant: false, tests };
  }
  const concordant = tests.filter((t) => t.abo === latest.abo && t.rhD === latest.rhD).length;
  const discordant = tests.some((t) => t.abo !== latest.abo || t.rhD !== latest.rhD);
  return {
    group: {
      abo: latest.abo as Abo,
      rhD: latest.rhD as RhD,
      antibodyScreen: latest.antibodyScreen,
      antibodies: latest.antibodies,
      testedAt: latest.testedAt,
    },
    confirmed: concordant >= 2 && !discordant,
    concordantTests: concordant,
    discordant,
    tests,
  };
}

/** Women under 50 – RhD-negative or unknown recipients should receive RhD-negative red cells. */
export function isWomanOfChildbearingAge(p: { sex: string; dateOfBirth: string }, at = new Date()) {
  if (p.sex !== 'FEMALE') return false;
  const dob = new Date(`${p.dateOfBirth}T00:00:00Z`);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age < 50;
}

/** Red cells the recipient's plasma tolerates. */
const RED_CELL_DONORS: Record<Abo, Abo[]> = {
  O: ['O'],
  A: ['A', 'O'],
  B: ['B', 'O'],
  AB: ['AB', 'A', 'B', 'O'],
};
/** Plasma that is compatible with the recipient's red cells (AB plasma is universal). */
const PLASMA_DONORS: Record<Abo, Abo[]> = {
  O: ['O', 'A', 'B', 'AB'],
  A: ['A', 'AB'],
  B: ['B', 'AB'],
  AB: ['AB'],
};

export interface CompatibilityResult {
  ok: boolean;
  /** Why the unit may not be given (English source text; translated in the UI). */
  reason?: string;
  warnings: string[];
}

/**
 * ABO/RhD compatibility of a unit for a recipient. `recipient` is null when the blood group is
 * unknown or not yet confirmed by two concordant results – then only universal units are allowed:
 * group O red cells (RhD negative unless an emergency reason is documented) and AB plasma.
 */
export function checkCompatibility(
  product: BloodProduct,
  recipient: BloodGroup | null,
  unit: BloodGroup,
  opts: { preferRhNegative?: boolean; emergencyReason?: string | null } = {},
): CompatibilityResult {
  const warnings: string[] = [];
  const emergency = Boolean(opts.emergencyReason && opts.emergencyReason.trim().length >= 10);

  if (product === 'RED_CELLS' || product === 'WHOLE_BLOOD') {
    if (product === 'WHOLE_BLOOD') {
      if (!recipient) {
        return { ok: false, reason: 'Whole blood needs a confirmed blood group', warnings };
      }
      if (unit.abo !== recipient.abo) {
        return { ok: false, reason: 'Whole blood must be ABO-identical', warnings };
      }
    } else {
      const allowed = recipient ? RED_CELL_DONORS[recipient.abo] : (['O'] as Abo[]);
      if (!allowed.includes(unit.abo)) {
        return {
          ok: false,
          reason: recipient
            ? 'ABO-incompatible red cells'
            : 'Blood group not confirmed (two concordant tests needed) – only group O red cells may be issued',
          warnings,
        };
      }
    }
    const needsNegative = !recipient || recipient.rhD === 'NEG';
    if (needsNegative && unit.rhD === 'POS') {
      const mustBeNegative = opts.preferRhNegative || (recipient && recipient.rhD === 'NEG');
      if (mustBeNegative || !recipient) {
        if (!emergency) {
          return {
            ok: false,
            reason:
              'RhD-positive red cells for an RhD-negative or unknown recipient need a documented emergency reason',
            warnings,
          };
        }
        warnings.push('RhD-positive red cells given in an emergency – arrange anti-D follow-up');
      }
    }
    return { ok: true, warnings };
  }

  if (product === 'PLASMA' || product === 'CRYOPRECIPITATE') {
    const allowed = recipient ? PLASMA_DONORS[recipient.abo] : (['AB'] as Abo[]);
    if (!allowed.includes(unit.abo)) {
      return {
        ok: false,
        reason: recipient
          ? 'ABO-incompatible plasma'
          : 'Blood group not confirmed – only group AB plasma may be issued',
        warnings,
      };
    }
    return { ok: true, warnings };
  }

  // Platelets: ABO-identical preferred; RhD-negative recipients (especially women) preferably neg.
  if (recipient && unit.abo !== recipient.abo) {
    warnings.push('Platelets are not ABO-identical – acceptable, but monitor the increment');
  }
  if ((!recipient || recipient.rhD === 'NEG') && unit.rhD === 'POS') {
    warnings.push(
      opts.preferRhNegative
        ? 'RhD-positive platelets for an RhD-negative woman of childbearing age – give anti-D'
        : 'RhD-positive platelets for an RhD-negative recipient',
    );
  }
  return { ok: true, warnings };
}

/** Active doctors and nurses of a facility (bedside second checkers), except the caller. */
export async function facilityClinicians(facilityId: string, exceptUserId: string) {
  return db
    .select({ id: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.facilityId, facilityId),
        eq(users.isActive, true),
        inArray(users.role, ['DOCTOR', 'NURSE']),
        ne(users.id, exceptUserId),
      ),
    )
    .orderBy(users.fullName);
}

/** Refresh blood bank screens of the facility's blood bank staff and the requesting doctor. */
export async function publishBloodBank(facilityId: string, requestId?: string | null) {
  try {
    const ids = await bloodBankStaff(facilityId);
    if (requestId) {
      const [r] = await db
        .select({ by: transfusionRequests.requestedById })
        .from(transfusionRequests)
        .where(eq(transfusionRequests.id, requestId));
      if (r) ids.push(r.by);
    }
    if (ids.length) await publish(ids, { type: 'bloodbank.board' });
  } catch (err) {
    logger.warn({ err }, 'Blood bank update could not be published');
  }
}
