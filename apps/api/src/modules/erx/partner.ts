import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  allergies,
  communityDispensings,
  facilities,
  medicationCatalog,
  patients,
  prescriptions,
  users,
} from '../../db/schema.js';
import { conflict, HttpError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { hashToken } from '../../lib/tokens.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import { auditPartner, requireScope } from '../partner/partner.auth.js';
import {
  dispensingsFor,
  effectiveDispensings,
  eprescriptionStatus,
  formatCode,
  isControlled,
  normaliseCode,
  presentDispensings,
} from './erx.service.js';

/**
 * Community pharmacy systems (scope prescriptions.dispense) look up a national e-prescription and
 * record what they dispensed. The pharmacy must present both the code and the patient's national
 * ID (or date of birth): a wrong pair gets the same 404 as an unknown code. Dispensing is a supply
 * for treatment, so no X-Purpose-Of-Use header is needed; the pharmacist is named in every
 * dispensing. Every call is audited for the patient under the pharmacy system's name, so the
 * patient sees in their access log which pharmacy read or dispensed their prescription.
 */
export const erxPartnerRouter = Router();
erxPartnerRouter.use(requireScope('prescriptions.dispense'));

const partnerKey = (req: Request) => {
  const header = req.get('authorization') ?? '';
  return `erx:${hashToken(header.slice(7).trim())}`;
};

/**
 * Failed look-ups (wrong code or wrong patient) are limited per pharmacy system: 20 in 10 minutes,
 * so codes cannot be tried at scale even with a stolen key.
 */
const failedLookupLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: partnerKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: 'TOO_MANY_FAILED_LOOKUPS',
        message: 'Too many unsuccessful e-prescription look-ups. Try again in 10 minutes.',
      },
    });
  },
});

const CodeParam = z.object({ code: z.string().trim().min(12).max(20) });
const IdentityQuery = z
  .object({
    nationalId: z.string().trim().min(5).max(20).optional(),
    dateOfBirth: z.string().date().optional(),
  })
  .refine((q) => q.nationalId || q.dateOfBirth, {
    message: "Give the patient's national ID (or date of birth)",
    path: ['nationalId'],
  });

const NOT_FOUND = 'No e-prescription matches this code and patient';

/** The prescription for a code and patient identity, or null (never says which part was wrong). */
async function findForPharmacy(
  executor: Executor,
  rawCode: string,
  identity: { nationalId?: string; dateOfBirth?: string },
  lock = false,
) {
  const code = normaliseCode(rawCode);
  if (!code) return null;
  const query = executor
    .select({ rx: prescriptions, patient: patients })
    .from(prescriptions)
    .innerJoin(patients, eq(patients.id, prescriptions.patientId))
    .where(eq(prescriptions.ePrescriptionCode, code));
  const [row] = lock ? await query.for('update', { of: prescriptions }) : await query;
  if (!row) return null;
  const matches = identity.nationalId
    ? row.patient.nationalId === identity.nationalId.replace(/\s/g, '')
    : row.patient.dateOfBirth === identity.dateOfBirth;
  return matches ? row : null;
}

async function describe(row: NonNullable<Awaited<ReturnType<typeof findForPharmacy>>>) {
  const { rx, patient } = row;
  const [[prescriber], catalog, allergyRows, dispensings] = await Promise.all([
    db
      .select({
        name: users.fullName,
        licenceNumber: users.licenseNumber,
        facilityCode: facilities.code,
        facilityName: facilities.name,
      })
      .from(users)
      .leftJoin(facilities, eq(facilities.id, users.facilityId))
      .where(eq(users.id, rx.doctorId)),
    rx.catalogItemId
      ? db
          .select({
            name: medicationCatalog.name,
            strength: medicationCatalog.strength,
            form: medicationCatalog.form,
            atcCode: medicationCatalog.atcCode,
          })
          .from(medicationCatalog)
          .where(eq(medicationCatalog.id, rx.catalogItemId))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select({ substance: allergies.substance, severity: allergies.severity })
      .from(allergies)
      .where(
        and(
          eq(allergies.patientId, patient.id),
          inArray(allergies.verificationStatus, ['CONFIRMED', 'UNCONFIRMED']),
        ),
      ),
    dispensingsFor([rx.id]),
  ]);
  const rows = dispensings.get(rx.id) ?? [];
  const state = eprescriptionStatus(rx, rows);
  return {
    code: formatCode(rx.ePrescriptionCode!),
    ...state,
    validUntil: rx.communityValidUntil,
    issuedAt: rx.createdAt,
    patient: {
      firstName: patient.firstName,
      lastName: patient.lastName,
      dateOfBirth: patient.dateOfBirth,
      sex: patient.sex,
    },
    medication: rx.medication,
    catalogItem: catalog,
    dosage: rx.dosage,
    frequency: rx.frequency,
    route: rx.route,
    durationDays: rx.durationDays,
    instructions: rx.instructions,
    repeatsAllowed: rx.repeatsAllowed,
    controlled: isControlled(catalog?.atcCode, rx.medication),
    prescriber: prescriber ?? null,
    /**
     * Pharmacists check allergies before dispensing; they get the substances and severity only,
     * never diagnoses or other parts of the record.
     */
    allergies: {
      status:
        allergyRows.length > 0
          ? 'ALLERGIES_RECORDED'
          : patient.allergyAssessment === 'NO_KNOWN_ALLERGIES'
            ? 'NO_KNOWN_ALLERGIES'
            : 'NOT_RECORDED',
      substances: allergyRows,
    },
    dispensings: presentDispensings(rows),
  };
}

erxPartnerRouter.get('/:code', failedLookupLimiter, async (req, res) => {
  const client = req.partner!;
  const { code } = parse(CodeParam, req.params);
  const identity = parse(IdentityQuery, req.query);
  const row = await findForPharmacy(db, code, identity);
  if (!row) {
    await auditPartner(req, client, {
      scope: 'prescriptions.dispense',
      outcome: 'FAILURE',
      result: 'not_found',
    });
    throw notFound(NOT_FOUND);
  }
  await auditPartner(req, client, {
    scope: 'prescriptions.dispense',
    patientId: row.patient.id,
    practitioner: (req.get('x-requesting-practitioner') ?? '').trim().slice(0, 200) || null,
    result: 'e_prescription_read',
    extra: { prescriptionId: row.rx.id },
  });
  res.json(await describe(row));
});

const DispenseBody = z
  .object({
    nationalId: z.string().trim().min(5).max(20).optional(),
    dateOfBirth: z.string().date().optional(),
    pharmacyName: z.string().trim().min(2).max(200),
    pharmacistName: z.string().trim().min(3).max(200),
    pharmacistLicence: z.string().trim().min(2).max(60).optional().nullable(),
    /** What was handed over (a generic substitute is allowed). */
    productName: z.string().trim().min(2).max(200),
    quantity: z.string().trim().min(1).max(100),
  })
  .refine((b) => b.nationalId || b.dateOfBirth, {
    message: "Give the patient's national ID (or date of birth)",
    path: ['nationalId'],
  });

erxPartnerRouter.post('/:code/dispense', failedLookupLimiter, async (req, res) => {
  const client = req.partner!;
  const { code } = parse(CodeParam, req.params);
  const body = parse(DispenseBody, req.body);
  const result = await db.transaction(async (tx) => {
    // The prescription row is locked, so two pharmacies cannot both hand over the last supply.
    const row = await findForPharmacy(tx, code, body, true);
    if (!row) return null;
    const { rx, patient } = row;
    const rows = await tx
      .select()
      .from(communityDispensings)
      .where(eq(communityDispensings.prescriptionId, rx.id));
    const state = eprescriptionStatus(rx, rows);
    if (patient.deceasedAt) {
      throw new HttpError(409, 'NOT_DISPENSABLE', 'This e-prescription can no longer be dispensed');
    }
    switch (state.status) {
      case 'CANCELLED':
      case 'STOPPED':
        throw new HttpError(
          409,
          'NOT_DISPENSABLE',
          'The prescriber has cancelled or stopped this e-prescription',
        );
      case 'EXPIRED':
        throw new HttpError(409, 'EXPIRED', 'This e-prescription has expired');
      case 'DISPENSED':
        throw new HttpError(
          409,
          'FULLY_DISPENSED',
          'All supplies of this e-prescription have been dispensed',
        );
      default:
        break;
    }
    const [created] = await tx
      .insert(communityDispensings)
      .values({
        prescriptionId: rx.id,
        patientId: patient.id,
        partnerClientId: client.id,
        pharmacyName: body.pharmacyName,
        pharmacistName: body.pharmacistName,
        pharmacistLicence: body.pharmacistLicence ?? null,
        supplyNumber: state.suppliesDispensed,
        productName: body.productName,
        quantity: body.quantity,
      })
      .returning();
    await notifyPatient(
      patient.id,
      {
        type: 'prescription',
        title: 'Your e-prescription was dispensed at {pharmacy}',
        vars: { pharmacy: body.pharmacyName },
        link: '/portal/e-prescriptions',
      },
      tx,
    );
    return {
      created: created!,
      patientId: patient.id,
      substituted: body.productName.trim().toLowerCase() !== rx.medication.trim().toLowerCase(),
      remaining: state.suppliesRemaining - 1,
    };
  });
  if (!result) {
    await auditPartner(req, client, {
      scope: 'prescriptions.dispense',
      outcome: 'FAILURE',
      result: 'not_found',
    });
    throw notFound(NOT_FOUND);
  }
  await auditPartner(req, client, {
    scope: 'prescriptions.dispense',
    patientId: result.patientId,
    practitioner: body.pharmacistName,
    result: 'e_prescription_dispensed',
    extra: {
      dispensingId: result.created.id,
      supplyNumber: result.created.supplyNumber,
      pharmacyName: body.pharmacyName,
      substituted: result.substituted,
    },
  });
  res.status(201).json({
    id: result.created.id,
    supplyNumber: result.created.supplyNumber,
    dispensedAt: result.created.dispensedAt,
    productName: result.created.productName,
    quantity: result.created.quantity,
    substituted: result.substituted,
    suppliesRemaining: result.remaining,
  });
});

/** A dispensing recorded in error can be reversed by the same system within 24 hours. */
export const REVERSAL_WINDOW_MS = 24 * 3_600_000;

erxPartnerRouter.post('/dispensings/:id/reverse', async (req, res) => {
  const client = req.partner!;
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
  const result = await db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(communityDispensings)
      .where(
        and(
          eq(communityDispensings.id, id),
          eq(communityDispensings.partnerClientId, client.id),
          sql`${communityDispensings.reversesId} IS NULL`,
        ),
      );
    // Another system's dispensing is "not found" for this one.
    if (!original) return null;
    await tx
      .select({ id: prescriptions.id })
      .from(prescriptions)
      .where(eq(prescriptions.id, original.prescriptionId))
      .for('update');
    if (Date.now() - original.dispensedAt.getTime() > REVERSAL_WINDOW_MS) {
      throw new HttpError(
        409,
        'REVERSAL_WINDOW_PASSED',
        'A dispensing can only be reversed within 24 hours',
      );
    }
    const [already] = await tx
      .select({ id: communityDispensings.id })
      .from(communityDispensings)
      .where(eq(communityDispensings.reversesId, original.id));
    if (already) throw conflict('This dispensing has already been reversed');
    const [reversal] = await tx
      .insert(communityDispensings)
      .values({
        prescriptionId: original.prescriptionId,
        patientId: original.patientId,
        partnerClientId: client.id,
        pharmacyName: original.pharmacyName,
        pharmacistName: original.pharmacistName,
        pharmacistLicence: original.pharmacistLicence,
        supplyNumber: original.supplyNumber,
        productName: original.productName,
        quantity: original.quantity,
        reversesId: original.id,
        reason,
      })
      .returning();
    const rows = await tx
      .select()
      .from(communityDispensings)
      .where(eq(communityDispensings.prescriptionId, original.prescriptionId));
    return { original, reversal: reversal!, effective: effectiveDispensings(rows).length };
  });
  if (!result) throw notFound('Dispensing not found');
  await auditPartner(req, client, {
    scope: 'prescriptions.dispense',
    patientId: result.original.patientId,
    result: 'e_prescription_dispensing_reversed',
    extra: { dispensingId: result.original.id, reason },
  });
  res.status(201).json({
    id: result.reversal.id,
    reverses: result.original.id,
    reversedAt: result.reversal.dispensedAt,
    suppliesDispensed: result.effective,
  });
});
