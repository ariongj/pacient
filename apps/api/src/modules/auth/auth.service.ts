import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  facilities,
  oneTimeTokens,
  patients,
  refreshTokens,
  users,
  webauthnCredentials,
} from '../../db/schema.js';
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
import { noteSignInDevice } from '../security/devices.js';

export const MAX_FAILED_ATTEMPTS = 5;

/** Staff accounts must use two-step sign-in when REQUIRE_STAFF_MFA is on (default in production). */
export const mfaRequiredFor = (role: AuthContext['role']) =>
  env.REQUIRE_STAFF_MFA && role !== 'PATIENT';
export const LOCKOUT_MINUTES = 15;

/**
 * `users.mfaEnabledAt` means "two-step sign-in is on" – with an authenticator app (TOTP), one or
 * more passkeys, or both. TOTP itself is active once its secret was confirmed (confirmation
 * records the time step).
 */
export const totpActive = (u: {
  mfaEnabledAt: Date | null;
  mfaSecretEncrypted: string | null;
  mfaLastUsedStep: number | null;
}) => Boolean(u.mfaEnabledAt && u.mfaSecretEncrypted && u.mfaLastUsedStep !== null);

async function passkeyTotal(userId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  return row?.n ?? 0;
}

export type SecondFactor = 'totp' | 'passkey';

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

/**
 * When a session (refresh-token family) ends at the latest, or null when each refresh extends it.
 * A platform administrator's session ends ADMIN_SESSION_HOURS after signing in, however active it
 * is: the operator's accounts change bank details, administrators and published texts, so a
 * session left open on a shared computer, or stolen, must not be kept alive for days by refreshing.
 * The sign-in time is the first token of the family, so rotation cannot move it.
 */
async function sessionDeadline(ctx: AuthContext, familyId: string | null): Promise<Date | null> {
  if (ctx.role !== 'ADMIN') return null;
  let startedAt = Date.now();
  if (familyId) {
    const [first] = await db
      .select({ at: sql<string | Date | null>`min(${refreshTokens.createdAt})` })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));
    if (first?.at) startedAt = new Date(first.at).getTime();
  }
  return new Date(startedAt + env.ADMIN_SESSION_HOURS * 3_600_000);
}

/** A new session (sign-in), or the next token of an existing one (`familyId`, on refresh). */
async function issueSession(
  ctx: AuthContext,
  meta: RequestMeta,
  familyId?: string,
): Promise<Session & { refreshTokenId: string }> {
  const now = Date.now();
  const deadline = await sessionDeadline(ctx, familyId ?? null);
  // Also catches a session started before the limit applied (its tokens expire later).
  if (deadline && deadline.getTime() <= now) throw unauthorized('Session expired');
  const refreshToken = generateOpaqueToken();
  const refreshTokenExpiresAt = new Date(
    Math.min(now + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000, deadline?.getTime() ?? Infinity),
  );
  // Nor does the access token outlive the session.
  const accessTokenExpiresIn = deadline
    ? Math.min(env.ACCESS_TOKEN_TTL_SECONDS, Math.ceil((deadline.getTime() - now) / 1000))
    : env.ACCESS_TOKEN_TTL_SECONDS;
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId: ctx.userId,
      tokenHash: hashToken(refreshToken),
      familyId: familyId ?? randomUUID(),
      expiresAt: refreshTokenExpiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    .returning({ id: refreshTokens.id });
  return {
    accessToken: signAccessToken(
      {
        sub: ctx.userId,
        role: ctx.role,
        facilityId: ctx.facilityId,
        patientId: ctx.patientId,
      },
      accessTokenExpiresIn,
    ),
    accessTokenExpiresIn,
    refreshToken,
    refreshTokenExpiresAt,
    refreshTokenId: row!.id,
  };
}

export type LoginResult =
  | { kind: 'session'; session: Session }
  /** Password accepted; a second factor is required before any session is issued. */
  | { kind: 'mfa'; mfaToken: string; methods: SecondFactor[] };

/**
 * Counts a failed credential (password, second factor or the password asked again) and locks the
 * account at the fifth, in one statement on the current row: concurrent wrong attempts each count.
 * (Counting from a value read before the slow password check let a burst of parallel guesses all
 * write the same count, so the lock was never reached.) The count starts again from zero with the
 * lock. Returns whether this attempt locked the account.
 */
export async function recordFailedAttempt(user: { id: string }): Promise<boolean> {
  const reached = sql`${users.failedLoginAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}`;
  const [row] = await db
    .update(users)
    .set({
      failedLoginAttempts: sql`CASE WHEN ${reached} THEN 0 ELSE ${users.failedLoginAttempts} + 1 END`,
      lockedUntil: sql`CASE WHEN ${reached} THEN now() + make_interval(mins => ${LOCKOUT_MINUTES}) ELSE ${users.lockedUntil} END`,
    })
    .where(eq(users.id, user.id))
    .returning({ attempts: users.failedLoginAttempts });
  // Zero after the increment only when this attempt reached the limit.
  return row?.attempts === 0;
}

/** Whether the account is locked now (read again, after a slow check of a credential). */
export async function isLocked(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ locked: sql<boolean>`coalesce(${users.lockedUntil} > now(), false)` })
    .from(users)
    .where(eq(users.id, userId));
  return Boolean(row?.locked);
}

/**
 * Final step of any successful sign-in: reset counters, issue the session, audit. Refused when
 * wrong attempts made at the same time locked the account while this one was being checked: the
 * counters are reset only if it is not locked, in the same statement.
 */
export async function completeLogin(userId: string, meta: RequestMeta, factors: string[]) {
  const [unlocked] = await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(
      and(
        eq(users.id, userId),
        sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= now())`,
      ),
    )
    .returning({ id: users.id });
  if (!unlocked) {
    const [u] = await db
      .select({ role: users.role, facilityId: users.facilityId })
      .from(users)
      .where(eq(users.id, userId));
    await auditSafe({
      action: AuditAction.LOGIN_LOCKED,
      actor: u ? { userId, role: u.role, facilityId: u.facilityId } : null,
      outcome: 'DENIED',
      meta,
    });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  const ctx = await buildContext(userId);
  const session = await issueSession(ctx, meta);
  await auditSafe({ action: AuditAction.LOGIN_SUCCESS, actor: ctx, meta, metadata: { factors } });
  await noteSignInDevice({ id: ctx.userId, role: ctx.role, facilityId: ctx.facilityId }, meta);
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
  // Wrong passwords sent at the same time may have locked the account during the check: the
  // right one among them must not get through (nor tell that it was right).
  if (await isLocked(user.id)) {
    await auditSafe({ action: AuditAction.LOGIN_LOCKED, actor, outcome: 'DENIED', meta });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  if (user.mfaEnabledAt) {
    const methods: SecondFactor[] = [];
    if (totpActive(user)) methods.push('totp');
    if ((await passkeyTotal(user.id)) > 0) methods.push('passkey');
    return {
      kind: 'mfa',
      mfaToken: signMfaChallenge(user.id),
      methods: methods.length ? methods : ['totp'],
    };
  }
  return { kind: 'session', session: await completeLogin(user.id, meta, ['password']) };
}

/**
 * Whether this is a platform administrator's session nobody used for ADMIN_IDLE_MINUTES: the
 * presented token was issued at the previous refresh (or at sign-in), and the web app refreshes
 * at least every 15 minutes while it is in use (when its access token runs out, and while the
 * administrator types or clicks; components/AdminIdleSignOut.tsx). The browser's idle sign-out
 * holds only while the page stays open; this ends the session for a browser that was closed, or a
 * tab that was discarded, and opened again later – the refresh cookie lives until the 12-hour
 * deadline.
 */
async function idleAdminSession(token: { userId: string; createdAt: Date }) {
  if (token.createdAt.getTime() > Date.now() - env.ADMIN_IDLE_MINUTES * 60_000) return false;
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, token.userId));
  return user?.role === 'ADMIN';
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
  if (await idleAdminSession(existing)) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)));
    throw unauthorized('Session expired');
  }

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
      mfaSecretEncrypted: users.mfaSecretEncrypted,
      mfaLastUsedStep: users.mfaLastUsedStep,
      emailNotifications: users.emailNotifications,
      smsNotifications: users.smsNotifications,
      locale: users.locale,
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
  const { phone, phoneVerifiedAt, mfaSecretEncrypted, mfaLastUsedStep, ...rest } = row;
  return {
    ...rest,
    /** Authenticator app (TOTP) confirmed. */
    totpEnabled: totpActive({
      mfaEnabledAt: row.mfaEnabledAt,
      mfaSecretEncrypted,
      mfaLastUsedStep,
    }),
    passkeyCount: await passkeyTotal(ctx.userId),
    phone: phone && phoneVerifiedAt ? maskPhone(phone) : null,
    facility: row.facility?.id ? row.facility : null,
    patientId: ctx.patientId,
    mfaEnabled: Boolean(row.mfaEnabledAt),
    mfaRequired: mfaRequiredFor(ctx.role),
  };
}
