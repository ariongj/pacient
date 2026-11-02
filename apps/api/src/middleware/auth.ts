import type { RequestHandler } from 'express';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { guardianships, patients, users, type Role } from '../db/schema.js';
import { forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { requestMeta } from '../lib/http.js';
import { AuditAction, auditSafe } from '../modules/audit/audit.service.js';
import { mfaRequiredFor } from '../modules/auth/auth.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { verifyAccessToken } from '../lib/tokens.js';

/**
 * Requires a valid bearer access token and attaches the caller's identity to the request.
 * The account is re-checked on every request so a deactivated user loses access immediately
 * rather than when their access token expires; role and facility always come from the database.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();

  let userId: string;
  try {
    userId = verifyAccessToken(header.slice('Bearer '.length).trim()).sub;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }

  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      facilityId: users.facilityId,
      isActive: users.isActive,
      mfaEnabledAt: users.mfaEnabledAt,
      patientId: patients.id,
    })
    .from(users)
    .leftJoin(patients, eq(patients.userId, users.id))
    .where(eq(users.id, userId));
  if (!user?.isActive) throw unauthorized('Account is disabled');

  // Staff without two-step sign-in may only reach the auth endpoints needed to enrol.
  if (
    mfaRequiredFor(user.role) &&
    !user.mfaEnabledAt &&
    !req.originalUrl.startsWith('/api/v1/auth/')
  ) {
    throw new HttpError(
      403,
      'MFA_ENROLLMENT_REQUIRED',
      'Set up two-step sign-in before using this workspace',
    );
  }

  req.auth = {
    userId: user.id,
    role: user.role,
    facilityId: user.facilityId,
    patientId: user.patientId,
  };

  // Guardian acting for a child: re-verified on every request, so revocation and expiry are
  // effective immediately.
  const actingFor = req.get('x-acting-for');
  if (actingFor) {
    if (user.role !== 'PATIENT' || !UUID.test(actingFor)) throw forbidden('Invalid proxy request');
    const now = new Date();
    const [grant] = await db
      .select({ id: guardianships.id, scope: guardianships.scope })
      .from(guardianships)
      .where(
        and(
          eq(guardianships.guardianUserId, user.id),
          eq(guardianships.patientId, actingFor),
          isNull(guardianships.revokedAt),
          lte(guardianships.validFrom, now),
          gt(guardianships.validUntil, now),
        ),
      )
      .limit(1);
    if (!grant) {
      await auditSafe({
        action: AuditAction.PROXY_ACCESS_DENIED,
        actor: req.auth,
        outcome: 'DENIED',
        patientId: actingFor,
        meta: requestMeta(req),
      });
      throw new HttpError(403, 'PROXY_NOT_AUTHORISED', 'You no longer have access to this record');
    }
    req.auth = {
      ...req.auth,
      patientId: actingFor,
      proxy: { guardianshipId: grant.id, scope: grant.scope, ownPatientId: user.patientId },
    };
  }
  next();
};

/** Coarse role gate. Fine-grained (per-patient / per-facility) checks live in the services. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };
