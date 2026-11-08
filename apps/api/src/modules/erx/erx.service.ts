import { randomInt } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  communityDispensings,
  encounters,
  medicationCatalog,
  partnerClients,
  prescriptions,
} from '../../db/schema.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { requestMeta, type AuthContext } from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';

/**
 * National e-prescriptions for community pharmacies.
 *
 * A prescription issued as an e-prescription gets a code the patient shows (or reads out) at any
 * community pharmacy. The pharmacy's system presents the code together with the patient's national
 * ID (or date of birth) over the partner API, sees what to dispense and records each supply.
 *
 * Code: 11 random characters from an alphabet without look-alikes (no I, O, 0, 1) plus one Luhn
 * mod 32 check character, shown in groups of four ("ABCD-EFGH-JKLM"). 32^11 ≈ 3.6·10^16 codes, so a
 * code cannot be guessed, and the national ID is needed as well.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const N = CODE_ALPHABET.length;

/** Luhn mod N check character for the given body (detects single errors and most swaps). */
export function checkCharacter(body: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const code = CODE_ALPHABET.indexOf(body[i]!);
    if (code < 0) throw new Error(`Invalid e-prescription character: ${body[i]}`);
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return CODE_ALPHABET[(N - (sum % N)) % N]!;
}

/** Upper-cases and removes spaces and dashes; returns null when it is not a well-formed code. */
export function normaliseCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 12) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return checkCharacter(s.slice(0, 11)) === s[11] ? s : null;
}

/** "ABCDEFGHJKLM" → "ABCD-EFGH-JKLM". */
export const formatCode = (code: string) =>
  code
    .replace(/[\s-]/g, '')
    .match(/.{1,4}/g)!
    .join('-');

export function generateCode(): string {
  let body = '';
  for (let i = 0; i < 11; i++) body += CODE_ALPHABET[randomInt(N)];
  return body + checkCharacter(body);
}

/** Fixed code of the demo patient's active e-prescription (development seed only). */
export const DEMO_ERX_CODE_BODY = 'DEMAERX2345';
export const DEMO_ERX_CODE = DEMO_ERX_CODE_BODY + checkCharacter(DEMO_ERX_CODE_BODY);

/* ------------------------------------------------------------------ issuing rules ------- */

/**
 * Controlled medicines (opioids, benzodiazepines and related hypnotics, stimulants): no repeat
 * supplies and at most 7 days to dispense. The catalogue has no controlled-substance flag, so
 * they are recognised by ATC group and, for free-text prescriptions, by name.
 */
export const CONTROLLED_ATC_PREFIXES = ['N02A', 'N05BA', 'N05CD', 'N05CF', 'N06BA'];
const CONTROLLED_NAMES =
  /\b(morphin|morfin|tramadol|codein|kodein|oxycodon|oksikodon|fentanyl|fentanil|hydromorphon|buprenorphin|methadon|metadon|pethidin|tapentadol|diazepam|alprazolam|lorazepam|bromazepam|clonazepam|klonazepam|midazolam|nitrazepam|zolpidem|zopiclon|methylphenidat|metilfenidat)/i;

export function isControlled(atcCode: string | null | undefined, medication: string): boolean {
  if (atcCode && CONTROLLED_ATC_PREFIXES.some((p) => atcCode.toUpperCase().startsWith(p))) {
    return true;
  }
  return CONTROLLED_NAMES.test(medication);
}

export const MAX_REPEATS = 12;
export const CONTROLLED_VALID_DAYS = 7;
export const SINGLE_SUPPLY_MAX_DAYS = 90;
export const REPEATS_MAX_DAYS = 365;

export interface EPrescriptionRequest {
  repeats: number;
  validDays?: number | null;
}

export interface EPrescriptionTerms {
  repeatsAllowed: number;
  validDays: number;
  controlled: boolean;
}

/**
 * Repeats and validity: one supply is valid 30 days by default (at most 90); with repeats the
 * default is 30 days per supply, at most a year. Controlled medicines: no repeats, 7 days.
 */
export function eprescriptionTerms(
  req: EPrescriptionRequest,
  medicine: { atcCode: string | null | undefined; medication: string },
): EPrescriptionTerms {
  const controlled = isControlled(medicine.atcCode, medicine.medication);
  if (!Number.isInteger(req.repeats) || req.repeats < 0 || req.repeats > MAX_REPEATS) {
    throw badRequest(`Repeats must be between 0 and ${MAX_REPEATS}`);
  }
  if (controlled) {
    if (req.repeats > 0) {
      throw badRequest('Controlled medicines cannot be prescribed with repeat supplies');
    }
    if (req.validDays && req.validDays > CONTROLLED_VALID_DAYS) {
      throw badRequest(
        `A prescription for a controlled medicine is valid for at most ${CONTROLLED_VALID_DAYS} days`,
      );
    }
    return { repeatsAllowed: 0, validDays: req.validDays ?? CONTROLLED_VALID_DAYS, controlled };
  }
  const max = req.repeats > 0 ? REPEATS_MAX_DAYS : SINGLE_SUPPLY_MAX_DAYS;
  const validDays = req.validDays ?? Math.min(30 * (req.repeats + 1), REPEATS_MAX_DAYS);
  if (validDays < 1 || validDays > max) {
    throw badRequest(
      req.repeats > 0
        ? `An e-prescription with repeats is valid for at most ${REPEATS_MAX_DAYS} days`
        : `An e-prescription for one supply is valid for at most ${SINGLE_SUPPLY_MAX_DAYS} days`,
    );
  }
  return { repeatsAllowed: req.repeats, validDays, controlled };
}

export async function atcOf(catalogItemId: string | null | undefined, executor: Executor = db) {
  if (!catalogItemId) return null;
  const [item] = await executor
    .select({ atcCode: medicationCatalog.atcCode })
    .from(medicationCatalog)
    .where(eq(medicationCatalog.id, catalogItemId));
  return item?.atcCode ?? null;
}

const addDays = (isoDate: string, days: number) =>
  new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** Kosovo calendar date today (dispensing validity is by calendar day). */
export function todayInKosovo(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Gives the prescription its code, repeats and validity (inside the prescribing transaction). */
export async function issueEPrescription(
  tx: Executor,
  prescriptionId: string,
  startDate: string,
  terms: EPrescriptionTerms,
) {
  // Validity counts from the later of the start date and today.
  const from = startDate > todayInKosovo() ? startDate : todayInKosovo();
  const validUntil = addDays(from, terms.validDays - 1);
  for (let attempt = 0; ; attempt++) {
    const code = generateCode();
    try {
      const [row] = await tx
        .update(prescriptions)
        .set({
          ePrescriptionCode: code,
          repeatsAllowed: terms.repeatsAllowed,
          communityValidUntil: validUntil,
        })
        // Never replace a code already issued (two simultaneous requests: one wins).
        .where(and(eq(prescriptions.id, prescriptionId), isNull(prescriptions.ePrescriptionCode)))
        .returning();
      if (!row) throw conflict('This prescription is already an e-prescription');
      return row;
    } catch (err) {
      // A collision is astronomically unlikely; retry a couple of times on the unique index.
      if (attempt >= 2 || !String((err as { code?: string }).code ?? '').startsWith('23')) {
        throw err;
      }
    }
  }
}

/* ------------------------------------------------------------------ status --------------- */

export type DispensingRow = typeof communityDispensings.$inferSelect;
export type EPrescriptionStatus =
  'ACTIVE' | 'PARTLY_DISPENSED' | 'DISPENSED' | 'EXPIRED' | 'CANCELLED' | 'STOPPED';

/** Supplies that count: dispensings that are not reversals and have not been reversed. */
export function effectiveDispensings(rows: DispensingRow[]): DispensingRow[] {
  const reversed = new Set(rows.filter((r) => r.reversesId).map((r) => r.reversesId!));
  return rows.filter((r) => !r.reversesId && !reversed.has(r.id));
}

export function eprescriptionStatus(
  rx: {
    status: string;
    repeatsAllowed: number;
    communityValidUntil: string | null;
  },
  rows: DispensingRow[],
  today = todayInKosovo(),
): {
  status: EPrescriptionStatus;
  suppliesTotal: number;
  suppliesDispensed: number;
  suppliesRemaining: number;
} {
  const suppliesTotal = rx.repeatsAllowed + 1;
  const suppliesDispensed = effectiveDispensings(rows).length;
  const suppliesRemaining = Math.max(0, suppliesTotal - suppliesDispensed);
  let status: EPrescriptionStatus;
  if (rx.status === 'CANCELLED') status = 'CANCELLED';
  else if (rx.status !== 'ACTIVE') status = 'STOPPED';
  else if (suppliesRemaining === 0) status = 'DISPENSED';
  else if (rx.communityValidUntil && today > rx.communityValidUntil) status = 'EXPIRED';
  else status = suppliesDispensed > 0 ? 'PARTLY_DISPENSED' : 'ACTIVE';
  return { status, suppliesTotal, suppliesDispensed, suppliesRemaining };
}

/** Dispensing rows (with the dispensing system's name) for the given prescriptions. */
export async function dispensingsFor(prescriptionIds: string[], executor: Executor = db) {
  if (!prescriptionIds.length) return new Map<string, (DispensingRow & { client: string })[]>();
  const rows = await executor
    .select({ d: communityDispensings, client: partnerClients.name })
    .from(communityDispensings)
    .innerJoin(partnerClients, eq(partnerClients.id, communityDispensings.partnerClientId))
    .where(inArray(communityDispensings.prescriptionId, prescriptionIds))
    .orderBy(asc(communityDispensings.dispensedAt));
  const map = new Map<string, (DispensingRow & { client: string })[]>();
  for (const r of rows) {
    const list = map.get(r.d.prescriptionId) ?? [];
    list.push({ ...r.d, client: r.client });
    map.set(r.d.prescriptionId, list);
  }
  return map;
}

/** Dispensing history as shown to the doctor, the patient and the pharmacy. */
export function presentDispensings(rows: (DispensingRow & { client?: string })[]) {
  const reversedBy = new Map(rows.filter((r) => r.reversesId).map((r) => [r.reversesId!, r]));
  return rows
    .filter((r) => !r.reversesId)
    .map((r) => {
      const reversal = reversedBy.get(r.id);
      return {
        id: r.id,
        supplyNumber: r.supplyNumber,
        dispensedAt: r.dispensedAt,
        pharmacyName: r.pharmacyName,
        pharmacistName: r.pharmacistName,
        productName: r.productName,
        quantity: r.quantity,
        system: r.client ?? null,
        reversedAt: reversal?.dispensedAt ?? null,
        reversalReason: reversal?.reason ?? null,
      };
    });
}

/* ------------------------------------------------------------------ issuing ------------- */

export const EPrescriptionRequestSchema = z.object({
  repeats: z.coerce.number().int().min(0).max(MAX_REPEATS).default(0),
  validDays: z.coerce.number().int().min(1).max(365).optional().nullable(),
});

/** Audit and patient notification for a newly issued e-prescription (in the transaction). */
export async function recordIssued(
  tx: Executor,
  ctx: AuthContext,
  req: Request,
  rx: typeof prescriptions.$inferSelect,
  controlled: boolean,
) {
  await audit(
    {
      action: AuditAction.EPRESCRIPTION_ISSUED,
      actor: ctx,
      resourceType: 'prescription',
      resourceId: rx.id,
      patientId: rx.patientId,
      meta: requestMeta(req),
      metadata: {
        repeatsAllowed: rx.repeatsAllowed,
        validUntil: rx.communityValidUntil,
        controlled,
      },
    },
    tx,
  );
  const confidential = await confidentialFromGuardians(tx, rx);
  // Never the code or the medicine in a notification: the portal shows both after sign-in.
  await notifyPatient(
    rx.patientId,
    {
      type: 'prescription',
      title: 'A new e-prescription is ready in your portal',
      link: '/portal/e-prescriptions',
    },
    tx,
    { guardians: confidential ? 'none' : 'full' },
  );
}

/** True when the prescription belongs to a visit kept confidential from guardians. */
export async function confidentialFromGuardians(
  tx: Executor,
  rx: Pick<typeof prescriptions.$inferSelect, 'encounterId'>,
): Promise<boolean> {
  if (!rx.encounterId) return false;
  const [e] = await tx
    .select({ c: encounters.confidentialFromGuardians })
    .from(encounters)
    .where(eq(encounters.id, rx.encounterId));
  return e?.c === true;
}

export async function notifyEPrescriptionCancelled(
  tx: Executor,
  rx: typeof prescriptions.$inferSelect,
) {
  await notifyPatient(
    rx.patientId,
    {
      type: 'prescription',
      title: 'Your doctor cancelled an e-prescription',
      link: '/portal/e-prescriptions',
    },
    tx,
    { guardians: (await confidentialFromGuardians(tx, rx)) ? 'none' : 'full' },
  );
}
