import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  admissions,
  allergies,
  beds,
  careUnits,
  edVisits,
  facilities,
  medicationAdministrations,
  medicationCatalog,
  patients,
  prescriptions,
} from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { tr, type Locale } from '../../i18n/index.js';
import { currentBloodGroup } from '../bloodbank/bloodbank.service.js';
import { checkMedication, resolveCandidate, toPublicAlert } from '../safety/engine.js';
import { normaliseBarcode } from './barcode.js';
import { doseInterval, timingCheck } from './timing.js';
import { signWristband, verifyWristband } from './token.js';

/* ------------------------------------------------------------------ wristband ------------- */

const INACTIVE_ALLERGY = ['REFUTED', 'ENTERED_IN_ERROR'] as const;

/** Where the patient currently is: an open admission or an open emergency visit. */
export async function currentStay(patientId: string) {
  const [adm] = await db
    .select({
      kind: sql<'ADMISSION'>`'ADMISSION'`,
      id: admissions.id,
      facility: facilities.name,
      unitId: admissions.unitId,
      unit: careUnits.name,
      bed: beds.label,
      since: admissions.admittedAt,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .innerJoin(facilities, eq(facilities.id, admissions.facilityId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'ADMITTED')))
    .orderBy(desc(admissions.admittedAt))
    .limit(1);
  if (adm) return adm;
  const [ed] = await db
    .select({
      kind: sql<'EMERGENCY'>`'EMERGENCY'`,
      id: edVisits.id,
      facility: facilities.name,
      unitId: edVisits.unitId,
      unit: careUnits.name,
      bed: sql<string | null>`NULL`,
      since: edVisits.arrivedAt,
    })
    .from(edVisits)
    .innerJoin(careUnits, eq(careUnits.id, edVisits.unitId))
    .innerJoin(facilities, eq(facilities.id, edVisits.facilityId))
    .where(
      and(eq(edVisits.patientId, patientId), inArray(edVisits.status, ['WAITING', 'IN_TREATMENT'])),
    )
    .orderBy(desc(edVisits.arrivedAt))
    .limit(1);
  return ed ?? null;
}

/**
 * Data printed on the wristband. Only what identifies the patient and the two facts that must
 * be seen at a glance: allergies and a laboratory-confirmed blood group.
 */
export async function wristbandData(patientId: string) {
  const [p] = await db.select().from(patients).where(eq(patients.id, patientId));
  if (!p) throw notFound('Patient not found');
  const stay = await currentStay(patientId);
  if (!stay) {
    throw conflict(
      'Wristbands are printed only for admitted patients or patients in the emergency department',
    );
  }
  const activeAllergies = await db
    .select({ substance: allergies.substance, severity: allergies.severity })
    .from(allergies)
    .where(
      and(
        eq(allergies.patientId, patientId),
        notInArray(allergies.verificationStatus, [...INACTIVE_ALLERGY]),
      ),
    );
  const blood = await currentBloodGroup(patientId);
  const bloodGroup =
    blood.group && blood.confirmed
      ? `${blood.group.abo} ${blood.group.rhD === 'POS' ? 'RhD+' : 'RhD−'}`
      : null;
  const issuedAt = new Date();
  return {
    token: signWristband(patientId, issuedAt),
    issuedAt: issuedAt.toISOString(),
    patient: {
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      dateOfBirth: p.dateOfBirth,
      sex: p.sex,
      identifier: p.nationalId,
      identifierKind: p.temporaryIdentity ? ('TEMPORARY' as const) : ('NATIONAL_ID' as const),
      temporaryIdentity: p.temporaryIdentity,
    },
    allergyStatus:
      activeAllergies.length > 0
        ? ('ALLERGIES' as const)
        : p.allergyAssessment === 'NO_KNOWN_ALLERGIES'
          ? ('NONE_KNOWN' as const)
          : ('NOT_RECORDED' as const),
    allergies: activeAllergies.map((a) => a.substance),
    bloodGroup,
    stay: {
      kind: stay.kind,
      facility: stay.facility,
      unit: stay.unit,
      bed: stay.bed,
      since: stay.since,
    },
  };
}

/* ------------------------------------------------------------------ bedside checks -------- */

export const PROBLEM_CODES = [
  'INVALID_TOKEN',
  'WRONG_PATIENT',
  'EXPIRED_TOKEN',
  'UNKNOWN_BARCODE',
  'WRONG_DRUG',
  'DIFFERENT_STRENGTH',
  'NOT_DUE',
  'ALREADY_GIVEN',
  'MAX_DOSES_REACHED',
  'ALLERGY',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** These stop the administration: no reason can override them. */
export const NEVER_OVERRIDABLE: ReadonlySet<ProblemCode> = new Set([
  'INVALID_TOKEN',
  'WRONG_PATIENT',
  'WRONG_DRUG',
]);

export interface BcmaProblem {
  code: ProblemCode;
  overridable: boolean;
  severity: 'STOP' | 'WARNING';
  message: string;
  details?: Record<string, unknown>;
}

const MESSAGES: Record<ProblemCode, string> = {
  INVALID_TOKEN:
    'This is not a valid wristband of this system. Do not give – confirm the patient’s identity and print a new wristband.',
  WRONG_PATIENT: 'Wrong patient: this wristband belongs to another patient. Do not give.',
  EXPIRED_TOKEN: 'The wristband is too old. Confirm the patient’s identity and print a new one.',
  UNKNOWN_BARCODE: 'This barcode is not in the medicines catalogue.',
  WRONG_DRUG:
    'Wrong medicine: the scanned pack ({scanned}) is not the prescribed medicine ({prescribed}). Do not give.',
  DIFFERENT_STRENGTH:
    'Same medicine, different strength ({scanned}). Check the dose before giving.',
  NOT_DUE: 'Not due yet: last given {last}, next dose due {next}.',
  ALREADY_GIVEN: 'Already given {last}.',
  MAX_DOSES_REACHED:
    'The as-needed limit is reached: {count} of {max} doses given in the last 24 hours.',
  ALLERGY: '{message}',
};

export interface ScanInput {
  prescriptionId: string;
  patientToken?: string | null;
  medicationBarcode?: string | null;
}

export interface CheckResult {
  ok: boolean;
  problems: BcmaProblem[];
  /** The wristband was read and identifies this patient. */
  patientConfirmed: boolean;
  /** The pack was read and is the prescribed medicine. */
  medicationConfirmed: boolean;
  scannedItem: { id: string; name: string; strength: string | null; form: string } | null;
  prescription: {
    id: string;
    medication: string;
    dosage: string;
    route: string;
    frequency: string;
  };
  lastGivenAt: Date | null;
  nextDueAt: Date | null;
}

type Rx = typeof prescriptions.$inferSelect;

export async function loadAdministrablePrescription(patientId: string, prescriptionId: string) {
  const [rx] = await db
    .select()
    .from(prescriptions)
    .where(and(eq(prescriptions.id, prescriptionId), eq(prescriptions.patientId, patientId)));
  if (!rx) throw notFound('Prescription not found for this patient');
  if (rx.status !== 'ACTIVE') throw conflict('The prescription is not active');
  if (rx.pharmacyStatus !== 'VERIFIED' && rx.pharmacyStatus !== 'DISPENSED') {
    throw conflict('The prescription has not been verified by the pharmacy yet');
  }
  return rx;
}

const sameSet = (a: string[], b: string[]) => {
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};
const normStrength = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, '');

/**
 * The bedside "five rights" check: right patient (wristband), right medicine (pack barcode),
 * right time (interval since the last dose), plus the allergy check of the safety engine.
 */
export async function runChecks(
  patientId: string,
  input: ScanInput,
  locale: Locale,
  opts: { rx?: Rx; now?: Date; checkTiming?: boolean } = {},
): Promise<CheckResult> {
  const now = opts.now ?? new Date();
  const rx = opts.rx ?? (await loadAdministrablePrescription(patientId, input.prescriptionId));
  const problems: BcmaProblem[] = [];
  const add = (
    code: ProblemCode,
    vars: Record<string, string | Date | null> = {},
    details?: Record<string, unknown>,
  ) =>
    problems.push({
      code,
      overridable: !NEVER_OVERRIDABLE.has(code),
      severity: NEVER_OVERRIDABLE.has(code) ? 'STOP' : 'WARNING',
      message: tr(locale, MESSAGES[code], vars),
      details,
    });

  /* Right patient. */
  let patientConfirmed = false;
  if (input.patientToken) {
    const check = verifyWristband(input.patientToken.trim(), now);
    if (!check.valid) add('INVALID_TOKEN');
    else if (check.patientId !== patientId) add('WRONG_PATIENT');
    else {
      patientConfirmed = true;
      if (check.expired) add('EXPIRED_TOKEN', {}, { issuedAt: check.issuedAt.toISOString() });
    }
  }

  /* Right medicine. */
  let medicationConfirmed = false;
  let scannedItem: CheckResult['scannedItem'] = null;
  if (input.medicationBarcode) {
    const code = normaliseBarcode(input.medicationBarcode);
    const [item] = await db
      .select({
        id: medicationCatalog.id,
        name: medicationCatalog.name,
        strength: medicationCatalog.strength,
        form: medicationCatalog.form,
        ingredients: medicationCatalog.ingredients,
      })
      .from(medicationCatalog)
      .where(eq(medicationCatalog.barcode, code))
      .limit(1);
    if (!item) {
      add('UNKNOWN_BARCODE', {}, { barcode: code });
    } else {
      scannedItem = { id: item.id, name: item.name, strength: item.strength, form: item.form };
      const label = [item.name, item.strength].filter(Boolean).join(' ');
      if (rx.catalogItemId === item.id) {
        medicationConfirmed = true;
      } else {
        const prescribed = await resolveCandidate(rx.medication, rx.catalogItemId);
        const scannedIngredients = item.ingredients?.length
          ? item.ingredients
          : (await resolveCandidate(item.name, item.id)).ingredients;
        if (
          !prescribed.ingredients.length ||
          !sameSet(prescribed.ingredients, scannedIngredients)
        ) {
          add('WRONG_DRUG', { scanned: label, prescribed: rx.medication });
        } else {
          medicationConfirmed = true;
          let prescribedStrength: string | null = null;
          if (rx.catalogItemId) {
            const [p] = await db
              .select({ strength: medicationCatalog.strength })
              .from(medicationCatalog)
              .where(eq(medicationCatalog.id, rx.catalogItemId));
            prescribedStrength = p?.strength ?? null;
          }
          if (
            prescribedStrength &&
            normStrength(prescribedStrength) !== normStrength(item.strength)
          ) {
            add('DIFFERENT_STRENGTH', { scanned: label });
          }
        }
      }
    }
  }

  /* Right time. */
  const [last] = await db
    .select({ at: medicationAdministrations.administeredAt })
    .from(medicationAdministrations)
    .where(
      and(
        eq(medicationAdministrations.prescriptionId, rx.id),
        eq(medicationAdministrations.status, 'GIVEN'),
      ),
    )
    .orderBy(desc(medicationAdministrations.administeredAt))
    .limit(1);
  const timing = timingCheck(doseInterval(rx), last?.at ?? null, now);
  if (opts.checkTiming !== false && timing.problem) {
    add(timing.problem, { last: timing.lastGivenAt, next: timing.nextDueAt });
  }
  if (opts.checkTiming !== false && rx.maxDosesPer24h) {
    const [given] = await db
      .select({ n: count() })
      .from(medicationAdministrations)
      .where(
        and(
          eq(medicationAdministrations.prescriptionId, rx.id),
          eq(medicationAdministrations.status, 'GIVEN'),
          gt(medicationAdministrations.administeredAt, new Date(now.getTime() - 86_400_000)),
        ),
      );
    const n = Number(given?.n ?? 0);
    if (n >= rx.maxDosesPer24h)
      add('MAX_DOSES_REACHED', { count: String(n), max: String(rx.maxDosesPer24h) });
  }

  /* Allergy (the prescriber may have overridden it, but the nurse must see it at the bedside). */
  const alerts = await checkMedication(
    patientId,
    rx.medication,
    scannedItem?.id ?? rx.catalogItemId,
    {
      excludePrescriptionIds: [rx.id],
    },
  );
  for (const a of alerts.filter((x) => x.kind === 'ALLERGY')) {
    const pub = toPublicAlert(a, locale);
    add('ALLERGY', { message: pub.message }, { alertCode: a.code, severity: a.severity });
  }

  return {
    ok: problems.length === 0,
    problems,
    patientConfirmed,
    medicationConfirmed,
    scannedItem,
    prescription: {
      id: rx.id,
      medication: rx.medication,
      dosage: rx.dosage,
      route: rx.route,
      frequency: rx.frequency,
    },
    lastGivenAt: timing.lastGivenAt,
    nextDueAt: timing.nextDueAt,
  };
}

/* ------------------------------------------------------------------ compliance ------------ */

/**
 * Scanning compliance of the patient's current ward: share of doses given in the period where
 * both the wristband and the pack were scanned.
 */
export async function unitCompliance(unitId: string, days: number, now = new Date()) {
  const from = new Date(now.getTime() - days * 86_400_000);
  const [row] = await db
    .select({
      given: sql<number>`count(*)::int`,
      bothScanned: sql<number>`count(*) filter (where ${medicationAdministrations.patientScanned} and ${medicationAdministrations.medicationScanned})::int`,
      patientScanned: sql<number>`count(*) filter (where ${medicationAdministrations.patientScanned})::int`,
      medicationScanned: sql<number>`count(*) filter (where ${medicationAdministrations.medicationScanned})::int`,
      overridden: sql<number>`count(*) filter (where ${medicationAdministrations.scanOverrideReason} is not null)::int`,
    })
    .from(medicationAdministrations)
    .innerJoin(
      admissions,
      and(
        eq(admissions.patientId, medicationAdministrations.patientId),
        eq(admissions.unitId, unitId),
        lte(admissions.admittedAt, medicationAdministrations.administeredAt),
        or(
          isNull(admissions.dischargedAt),
          gte(admissions.dischargedAt, medicationAdministrations.administeredAt),
        ),
      ),
    )
    .where(
      and(
        eq(medicationAdministrations.status, 'GIVEN'),
        gte(medicationAdministrations.administeredAt, from),
        lte(medicationAdministrations.administeredAt, now),
      ),
    );
  const given = row?.given ?? 0;
  return {
    unitId,
    days,
    given,
    bothScanned: row?.bothScanned ?? 0,
    patientScanned: row?.patientScanned ?? 0,
    medicationScanned: row?.medicationScanned ?? 0,
    overridden: row?.overridden ?? 0,
    compliancePct: given ? Math.round(((row?.bothScanned ?? 0) / given) * 1000) / 10 : null,
  };
}
