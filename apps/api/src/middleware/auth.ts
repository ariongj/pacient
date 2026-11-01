import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { patients, users, type Role } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';
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
      patientId: patients.id,
    })
    .from(users)
    .leftJoin(patients, eq(patients.userId, users.id))
    .where(eq(users.id, userId));
  if (!user?.isActive) throw unauthorized('Account is disabled');

  req.auth = {
    userId: user.id,
    role: user.role,
    facilityId: user.facilityId,
    patientId: user.patientId,
  };
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
