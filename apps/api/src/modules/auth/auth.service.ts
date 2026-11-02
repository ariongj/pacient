import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { facilities, oneTimeTokens, patients, refreshTokens, users } from '../../db/schema.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/password.js';
import { maskPhone } from '../../lib/phone.js';
import {
  generateOpaqueToken,
  hashToken,
  signAccessToken,
  signMfaChallenge,
} from '../../lib/tokens.js';
import { audit, AuditAction, auditSafe } from '../audit/audit.service.js';

export const MAX_FAILED_ATTEMPTS = 5;

/** Staff accounts must use two-step sign-in when REQUIRE_STAFF_MFA is on (default in production). */
export const mfaRequiredFor = (role: AuthContext['role']) =>
  env.REQUIRE_STAFF_MFA && role !== 'PATIENT';
export const LOCKOUT_MINUTES = 15;

const GENERIC_LOGIN_ERROR = 'Invalid email or password, or the account is temporarily locked';

export interface Session {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

async function buildContext(userId: string): Promise<AuthContext> {
  const [row] = await db
    .select({
      id: users.id,
      role: users.role,
      facilityId: users.facilityId,
      patientId: patients.id,
    })
    .from(users)
    .leftJoin(patients, eq(patients.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) throw unauthorized();
  return { userId: row.id, role: row.role, facilityId: row.facilityId, patientId: row.patientId };
}

async function issueSession(
  ctx: AuthContext,
  meta: RequestMeta,
  familyId: string = randomUUID(),
): Promise<Session & { refreshTokenId: string }> {
  const refreshToken = generateOpaqueToken();
  const refreshTokenExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId: ctx.userId,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt: refreshTokenExpiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    .returning({ id: refreshTokens.id });
  return {
    accessToken: signAccessToken({
      sub: ctx.userId,
      role: ctx.role,
      facilityId: ctx.facilityId,
      patientId: ctx.patientId,
    }),
    accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    refreshTokenExpiresAt,
    refreshTokenId: row!.id,
  };
}

export type LoginResult =
  | { kind: 'session'; session: Session }
  /** Password accepted; a second factor is required before any session is issued. */
  | { kind: 'mfa'; mfaToken: string };

/** Counts a failed credential (password or second factor) and locks the account if needed. */
export async function recordFailedAttempt(user: {
  id: string;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}) {
  const attempts = user.failedLoginAttempts + 1;
  const lock = attempts >= MAX_FAILED_ATTEMPTS;
  await db
    .update(users)
    .set({
      failedLoginAttempts: lock ? 0 : attempts,
      lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : user.lockedUntil,
    })
    .where(eq(users.id, user.id));
  return lock;
}

/** Final step of any successful sign-in: reset counters, issue the session, audit. */
export async function completeLogin(userId: string, meta: RequestMeta, factors: string[]) {
  await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, userId));
  const ctx = await buildContext(userId);
  const session = await issueSession(ctx, meta);
  await auditSafe({ action: AuditAction.LOGIN_SUCCESS, actor: ctx, meta, metadata: { factors } });
  return session;
}

export async function login(
  email: string,
  password: string,
  meta: RequestMeta,
): Promise<LoginResult> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);

  if (!user || !user.passwordHash) {
    await verifyPassword(await getDummyHash(), password); // equalise timing
    await auditSafe({
      action: AuditAction.LOGIN_FAILURE,
      outcome: 'FAILURE',
      meta,
      metadata: { reason: 'unknown_or_unactivated_account' },
    });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const actor = { userId: user.id, role: user.role, facilityId: user.facilityId };

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await auditSafe({ action: AuditAction.LOGIN_LOCKED, actor, outcome: 'DENIED', meta });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid || !user.isActive) {
    const locked = await recordFailedAttempt(user);
    await auditSafe({
      action: AuditAction.LOGIN_FAILURE,
      actor,
      outcome: 'FAILURE',
      meta,
      metadata: { reason: valid ? 'inactive_account' : 'bad_password', locked },
    });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  if (user.mfaEnabledAt) {
    return { kind: 'mfa', mfaToken: signMfaChallenge(user.id) };
  }
  return { kind: 'session', session: await completeLogin(user.id, meta, ['password']) };
}

/**
 * Refresh-token rotation with reuse detection (OAuth 2.0 Security BCP). Every refresh consumes the
 * presented token and issues a new one in the same family. Presenting an already-consumed token
 * means it was stolen or replayed, so the entire family is revoked.
 */
export async function refresh(rawToken: string, meta: RequestMeta): Promise<Session> {
  const tokenHash = hashToken(rawToken);
  const [existing] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash));
  if (!existing) throw unauthorized('Invalid session');

  if (existing.revokedAt) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)));
    await auditSafe({
      action: AuditAction.REFRESH_REUSE_DETECTED,
      actor: null,
      outcome: 'DENIED',
      meta,
      resourceType: 'user',
      resourceId: existing.userId,
    });
    throw unauthorized('Session revoked');
  }
  if (existing.expiresAt <= new Date()) throw unauthorized('Session expired');

  // Atomically consume the token; a concurrent refresh with the same token loses the race.
  const consumed = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, existing.id), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  if (consumed.length === 0) throw unauthorized('Session revoked');

  const [user] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, existing.userId));
  if (!user?.isActive) throw unauthorized('Account disabled');

  const ctx = await buildContext(existing.userId);
  const session = await issueSession(ctx, meta, existing.familyId);
  await db
    .update(refreshTokens)
    .set({ replacedById: session.refreshTokenId })
    .where(eq(refreshTokens.id, existing.id));
  return session;
}

export async function logout(
  rawToken: string | undefined,
  actor: AuthContext | null,
  meta: RequestMeta,
) {
  if (rawToken) {
    const [token] = await db
      .select({ familyId: refreshTokens.familyId, userId: refreshTokens.userId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken)));
    if (token) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.familyId, token.familyId), isNull(refreshTokens.revokedAt)));
      await auditSafe({
        action: AuditAction.LOGOUT,
        actor,
        meta,
        resourceType: 'user',
        resourceId: token.userId,
      });
    }
  }
}

export async function revokeAllSessions(userId: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function activateAccount(rawToken: string, password: string, meta: RequestMeta) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [token] = await tx
      .update(oneTimeTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(oneTimeTokens.tokenHash, hashToken(rawToken)),
          eq(oneTimeTokens.purpose, 'ACCOUNT_ACTIVATION'),
          isNull(oneTimeTokens.usedAt),
          gt(oneTimeTokens.expiresAt, now),
        ),
      )
      .returning();
    if (!token) throw badRequest('Activation link is invalid or has expired');

    const [user] = await tx
      .update(users)
      .set({ passwordHash: await hashPassword(password), passwordChangedAt: now })
      .where(eq(users.id, token.userId))
      .returning();
    await audit(
      {
        action: AuditAction.ACCOUNT_ACTIVATED,
        actor: { userId: user!.id, role: user!.role, facilityId: user!.facilityId },
        meta,
        resourceType: 'user',
        resourceId: user!.id,
      },
      tx,
    );
  });
}

export async function changePassword(
  ctx: AuthContext,
  currentPassword: string,
  newPassword: string,
  meta: RequestMeta,
) {
  const [user] = await db.select().from(users).where(eq(users.id, ctx.userId));
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw badRequest('Current password is incorrect');
  }
  if (currentPassword === newPassword)
    throw badRequest('New password must differ from the current one');
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() })
    .where(eq(users.id, ctx.userId));
  // Invalidate every session so a compromised device loses access immediately.
  await revokeAllSessions(ctx.userId);
  await audit({
    action: AuditAction.PASSWORD_CHANGED,
    actor: ctx,
    meta,
    resourceType: 'user',
    resourceId: ctx.userId,
  });
}

export async function getProfile(ctx: AuthContext) {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      specialty: users.specialty,
      lastLoginAt: users.lastLoginAt,
      mfaEnabledAt: users.mfaEnabledAt,
      emailNotifications: users.emailNotifications,
      smsNotifications: users.smsNotifications,
      phone: users.phone,
      phoneVerifiedAt: users.phoneVerifiedAt,
      facility: {
        id: facilities.id,
        name: facilities.name,
        code: facilities.code,
        region: facilities.region,
      },
    })
    .from(users)
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .where(eq(users.id, ctx.userId));
  if (!row) throw unauthorized();
  const { phone, phoneVerifiedAt, ...rest } = row;
  return {
    ...rest,
    phone: phone && phoneVerifiedAt ? maskPhone(phone) : null,
    facility: row.facility?.id ? row.facility : null,
    patientId: ctx.patientId,
    mfaEnabled: Boolean(row.mfaEnabledAt),
    mfaRequired: mfaRequiredFor(ctx.role),
  };
}
