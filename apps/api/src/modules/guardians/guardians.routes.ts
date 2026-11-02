import { Router } from 'express';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  guardianRelationshipEnum,
  guardianships,
  patients,
  proxyScopeEnum,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertDemographicsAccess, getPatientOrThrow } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { createInvitedUser } from '../auth/invitations.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Guardian (proxy) access – blueprint §3: verified, explicit, patient-specific authority with scope
 * and expiry; no household-wide sharing; reviewed at the legal-age transition.
 *
 *  - Front-desk staff (reception) or the facility director check the evidence and link one guardian
 *    to one patient of their facility.
 *  - For minors, access ends automatically at the 18th birthday.
 *  - Adults can only have a court-appointed legal guardian, with an explicit end date (≤ 5 years).
 *  - Staff accounts can never act as guardians.
 */
export const ADULT_AGE = 18;
const MAX_ADULT_GUARDIANSHIP_YEARS = 5;

const AddSchema = z.object({
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(2).max(200),
  relationship: z.enum(guardianRelationshipEnum.enumValues),
  scope: z.enum(proxyScopeEnum.enumValues).default('FULL'),
  evidence: z.string().trim().min(5).max(300),
  validUntil: z.string().date().optional(),
});
const RevokeSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const Params = z.object({ id: z.string().uuid() });
const GrantParams = Params.extend({ guardianshipId: z.string().uuid() });

export function birthdayAt(dateOfBirth: string, years: number): Date {
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  return new Date(Date.UTC(y! + years, m! - 1, d!));
}
export const isMinor = (dateOfBirth: string, now = new Date()) =>
  birthdayAt(dateOfBirth, ADULT_AGE) > now;

const listColumns = {
  id: guardianships.id,
  guardianUserId: guardianships.guardianUserId,
  guardianName: users.fullName,
  guardianEmail: users.email,
  guardianActivated: sql<boolean>`${users.passwordHash} IS NOT NULL`,
  relationship: guardianships.relationship,
  scope: guardianships.scope,
  evidence: guardianships.evidence,
  validFrom: guardianships.validFrom,
  validUntil: guardianships.validUntil,
  revokedAt: guardianships.revokedAt,
  revokeReason: guardianships.revokeReason,
  verifiedBy: sql<string>`(SELECT v.full_name FROM users v WHERE v.id = ${guardianships.verifiedById})`,
  createdAt: guardianships.createdAt,
  active: sql<boolean>`${guardianships.revokedAt} IS NULL AND ${guardianships.validFrom} <= now() AND ${guardianships.validUntil} > now()`,
};

/** Staff with demographic access, or the patient themself (not a guardian acting for them). */
async function assertCanView(ctx: AuthContext, patientId: string) {
  if (ctx.role === 'PATIENT' && ctx.proxy) throw forbidden();
  await assertDemographicsAccess(ctx, patientId);
}

async function assertFrontDesk(ctx: AuthContext, patientId: string) {
  const patient = await getPatientOrThrow(patientId);
  if (patient.primaryFacilityId !== ctx.facilityId) {
    throw forbidden('Guardians are registered by the patient’s own facility');
  }
  return patient;
}

export const guardiansRouter = Router({ mergeParams: true });
guardiansRouter.use(authenticate);

guardiansRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Params, req.params);
  await assertCanView(ctx, id);
  const rows = await db
    .select(listColumns)
    .from(guardianships)
    .innerJoin(users, eq(users.id, guardianships.guardianUserId))
    .where(eq(guardianships.patientId, id))
    .orderBy(sql`${guardianships.revokedAt} IS NOT NULL`, asc(users.fullName));
  res.json({
    items: rows.map(({ guardianEmail, ...r }) =>
      ctx.role === 'PATIENT' ? r : { ...r, guardianEmail },
    ),
  });
});

guardiansRouter.post('/', requireRole('RECEPTION', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Params, req.params);
  const input = parse(AddSchema, req.body);
  const patient = await assertFrontDesk(ctx, id);

  const now = new Date();
  let validUntil: Date;
  if (isMinor(patient.dateOfBirth, now)) {
    const adulthood = birthdayAt(patient.dateOfBirth, ADULT_AGE);
    validUntil = input.validUntil ? new Date(`${input.validUntil}T00:00:00Z`) : adulthood;
    if (validUntil > adulthood) validUntil = adulthood; // never beyond the 18th birthday
  } else {
    if (input.relationship !== 'LEGAL_GUARDIAN') {
      throw badRequest('Adults can only have a court-appointed legal guardian');
    }
    if (!input.validUntil) throw badRequest('Set an end date from the court order');
    validUntil = new Date(`${input.validUntil}T00:00:00Z`);
    const max = new Date(now);
    max.setUTCFullYear(max.getUTCFullYear() + MAX_ADULT_GUARDIANSHIP_YEARS);
    if (validUntil > max)
      throw badRequest(
        `Adult guardianships must be reviewed within ${MAX_ADULT_GUARDIANSHIP_YEARS} years`,
      );
  }
  if (validUntil <= now) throw badRequest('The end date must be in the future');

  const [existingUser] = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`);
  if (existingUser && existingUser.role !== 'PATIENT') {
    throw badRequest('Staff accounts cannot be used as guardians; use a personal email address');
  }
  if (existingUser && existingUser.id === patient.userId) {
    throw badRequest('A patient cannot be their own guardian');
  }
  if (existingUser && !existingUser.isActive) throw badRequest('That account is deactivated');

  const result = await db.transaction(async (tx) => {
    let guardianUserId = existingUser?.id;
    let activationUrl: string | undefined;
    if (!guardianUserId) {
      const invited = await createInvitedUser(
        tx,
        { email: input.email, fullName: input.fullName, role: 'PATIENT', facilityId: null },
        ctx.userId,
      );
      guardianUserId = invited.user.id;
      activationUrl = invited.activationUrl;
    }
    const [active] = await tx
      .select({ id: guardianships.id })
      .from(guardianships)
      .where(
        and(
          eq(guardianships.patientId, id),
          eq(guardianships.guardianUserId, guardianUserId),
          isNull(guardianships.revokedAt),
        ),
      );
    if (active) throw conflict('This person is already a guardian of the patient');
    const [row] = await tx
      .insert(guardianships)
      .values({
        patientId: id,
        guardianUserId,
        relationship: input.relationship,
        scope: input.scope,
        evidence: input.evidence,
        verifiedById: ctx.userId,
        validUntil,
      })
      .returning();
    await audit(
      {
        action: AuditAction.GUARDIAN_ADDED,
        actor: ctx,
        resourceType: 'guardianship',
        resourceId: row!.id,
        patientId: id,
        meta: requestMeta(req),
        metadata: {
          relationship: input.relationship,
          scope: input.scope,
          validUntil: validUntil.toISOString(),
        },
      },
      tx,
    );
    await notifyUsers(
      [guardianUserId],
      {
        type: 'guardian',
        title: 'You have been given access to a family member’s health record',
        link: '/portal',
        important: true,
      },
      tx,
    );
    // Transparency: if the patient has their own account, tell them too.
    await notifyUsers(
      [patient.userId],
      {
        type: 'guardian',
        title: 'A guardian was given access to your record',
        link: '/portal/account',
        important: true,
      },
      tx,
    );
    return { guardianship: row!, activationUrl };
  });
  res.status(201).json(result);
});

/**
 * Revocation: by the facility front desk / director, or by an adult patient themself. It takes
 * effect on the guardian's next request.
 */
guardiansRouter.post('/:guardianshipId/revoke', async (req, res) => {
  const ctx = requireAuth(req);
  const { id, guardianshipId } = parse(GrantParams, req.params);
  const { reason } = parse(RevokeSchema, req.body);
  const patient = await getPatientOrThrow(id);
  const isSelf = ctx.role === 'PATIENT' && !ctx.proxy && ctx.patientId === id;
  if (isSelf) {
    if (isMinor(patient.dateOfBirth))
      throw forbidden('Ask your facility to change guardian access');
  } else if (ctx.role === 'RECEPTION' || ctx.role === 'DIRECTOR') {
    await assertFrontDesk(ctx, id);
  } else {
    throw forbidden();
  }
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(guardianships)
      .set({ revokedAt: new Date(), revokedById: ctx.userId, revokeReason: reason })
      .where(
        and(
          eq(guardianships.id, guardianshipId),
          eq(guardianships.patientId, id),
          isNull(guardianships.revokedAt),
        ),
      )
      .returning();
    if (!updated) throw notFound('Active guardianship not found');
    await audit(
      {
        action: AuditAction.GUARDIAN_REVOKED,
        actor: ctx,
        resourceType: 'guardianship',
        resourceId: guardianshipId,
        patientId: id,
        meta: requestMeta(req),
        metadata: { reason },
      },
      tx,
    );
    await notifyUsers(
      [updated.guardianUserId],
      {
        type: 'guardian',
        title: 'Your access to a family member’s record has ended',
        link: '/portal',
        important: true,
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

/** The records a guardian may act for (used by the portal's "viewing as" switcher). */
export async function activeDependants(guardianUserId: string) {
  const now = new Date();
  return db
    .select({
      guardianshipId: guardianships.id,
      patientId: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      relationship: guardianships.relationship,
      scope: guardianships.scope,
      validUntil: guardianships.validUntil,
    })
    .from(guardianships)
    .innerJoin(patients, eq(patients.id, guardianships.patientId))
    .where(
      and(
        eq(guardianships.guardianUserId, guardianUserId),
        isNull(guardianships.revokedAt),
        lte(guardianships.validFrom, now),
        gt(guardianships.validUntil, now),
      ),
    )
    .orderBy(asc(patients.firstName));
}
