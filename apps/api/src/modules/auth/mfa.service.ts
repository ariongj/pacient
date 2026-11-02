import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { mfaRecoveryCodes, oneTimeTokens, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { open, seal } from '../../lib/secret-box.js';
import { generateOpaqueToken, hashToken, verifyMfaChallenge } from '../../lib/tokens.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import { audit, AuditAction, auditSafe } from '../audit/audit.service.js';
import { enqueueEmail } from '../email/outbox.js';
import {
  completeLogin,
  mfaRequiredFor,
  recordFailedAttempt,
  revokeAllSessions,
} from './auth.service.js';
import { toLocale } from '../../i18n/index.js';

const RECOVERY_CODE_COUNT = 10;
const RESET_TTL_MINUTES = 60;

function newRecoveryCodes(): string[] {
  // 10 random characters, grouped for readability: e.g. "k7qd2-x9mpa".
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomBytes(8)
      .toString('base64url')
      .replace(/[-_]/g, '')
      .toLowerCase()
      .slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
const normaliseRecovery = (code: string) => code.trim().toLowerCase().replace(/\s+/g, '');

async function storeRecoveryCodes(userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx
      .insert(mfaRecoveryCodes)
      .values(codes.map((c) => ({ userId, codeHash: hashToken(normaliseRecovery(c)) })));
  });
  return codes;
}

async function loadUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw unauthorized();
  return user;
}

/** Checks a TOTP code and records the step so the same code cannot be replayed. */
async function consumeTotp(user: typeof users.$inferSelect, code: string): Promise<boolean> {
  if (!user.mfaSecretEncrypted) return false;
  const step = verifyTotp(open(user.mfaSecretEncrypted), code);
  if (step === null || (user.mfaLastUsedStep !== null && step <= user.mfaLastUsedStep))
    return false;
  const updated = await db
    .update(users)
    .set({ mfaLastUsedStep: step })
    .where(
      and(
        eq(users.id, user.id),
        sql`(${users.mfaLastUsedStep} IS NULL OR ${users.mfaLastUsedStep} < ${step})`,
      ),
    )
    .returning({ id: users.id });
  return updated.length === 1;
}

/* ------------------------------------------------------------------ enrollment ---------------- */

export async function beginEnrollment(ctx: AuthContext) {
  const user = await loadUser(ctx.userId);
  if (user.mfaEnabledAt) throw conflict('Two-step sign-in is already enabled');
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ mfaSecretEncrypted: seal(secret), mfaLastUsedStep: null })
    .where(eq(users.id, ctx.userId));
  return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
}

export async function confirmEnrollment(ctx: AuthContext, code: string, meta: RequestMeta) {
  const user = await loadUser(ctx.userId);
  if (user.mfaEnabledAt) throw conflict('Two-step sign-in is already enabled');
  if (!user.mfaSecretEncrypted) throw badRequest('Start enrollment first');
  if (!(await consumeTotp(user, code)))
    throw badRequest('The code is not valid. Check your device clock and try again.');
  await db.update(users).set({ mfaEnabledAt: new Date() }).where(eq(users.id, ctx.userId));
  const recoveryCodes = await storeRecoveryCodes(ctx.userId);
  await audit({
    action: AuditAction.MFA_ENABLED,
    actor: ctx,
    meta,
    resourceType: 'user',
    resourceId: ctx.userId,
  });
  return { recoveryCodes };
}

export async function disableMfa(
  ctx: AuthContext,
  password: string,
  code: string,
  meta: RequestMeta,
) {
  if (mfaRequiredFor(ctx.role)) throw forbidden('Two-step sign-in is mandatory for staff accounts');
  const user = await loadUser(ctx.userId);
  if (!user.mfaEnabledAt) throw badRequest('Two-step sign-in is not enabled');
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    throw badRequest('Password is incorrect');
  }
  if (!(await consumeTotp(user, code))) throw badRequest('The code is not valid');
  await db
    .update(users)
    .set({ mfaEnabledAt: null, mfaSecretEncrypted: null, mfaLastUsedStep: null })
    .where(eq(users.id, ctx.userId));
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, ctx.userId));
  await audit({
    action: AuditAction.MFA_DISABLED,
    actor: ctx,
    meta,
    resourceType: 'user',
    resourceId: ctx.userId,
  });
}

export async function regenerateRecoveryCodes(ctx: AuthContext, code: string, meta: RequestMeta) {
  const user = await loadUser(ctx.userId);
  if (!user.mfaEnabledAt) throw badRequest('Two-step sign-in is not enabled');
  if (!(await consumeTotp(user, code))) throw badRequest('The code is not valid');
  const recoveryCodes = await storeRecoveryCodes(ctx.userId);
  await audit({
    action: AuditAction.MFA_RECOVERY_CODES_REGENERATED,
    actor: ctx,
    meta,
    resourceType: 'user',
    resourceId: ctx.userId,
  });
  return { recoveryCodes };
}

/* ------------------------------------------------------------------ sign-in challenge --------- */

export async function completeMfaChallenge(
  mfaToken: string,
  input: { code?: string; recoveryCode?: string },
  meta: RequestMeta,
) {
  let userId: string;
  try {
    userId = verifyMfaChallenge(mfaToken);
  } catch {
    throw unauthorized('Your sign-in attempt expired. Please start again.');
  }
  const user = await loadUser(userId);
  const actor = { userId: user.id, role: user.role, facilityId: user.facilityId };
  if (!user.isActive || !user.mfaEnabledAt) throw unauthorized('Sign-in failed');
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await auditSafe({ action: AuditAction.LOGIN_LOCKED, actor, outcome: 'DENIED', meta });
    throw unauthorized('Invalid code, or the account is temporarily locked');
  }

  let ok = false;
  let factor = 'totp';
  if (input.code) {
    ok = await consumeTotp(user, input.code);
  } else if (input.recoveryCode) {
    factor = 'recovery_code';
    const used = await db
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mfaRecoveryCodes.userId, user.id),
          eq(mfaRecoveryCodes.codeHash, hashToken(normaliseRecovery(input.recoveryCode))),
          isNull(mfaRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: mfaRecoveryCodes.id });
    ok = used.length === 1;
  }

  if (!ok) {
    const locked = await recordFailedAttempt(user);
    await auditSafe({
      action: AuditAction.MFA_CHALLENGE_FAILED,
      actor,
      outcome: 'FAILURE',
      meta,
      metadata: { factor, locked },
    });
    throw unauthorized('Invalid code, or the account is temporarily locked');
  }
  if (factor === 'recovery_code') {
    await auditSafe({ action: AuditAction.MFA_RECOVERY_CODE_USED, actor, meta });
  }
  return completeLogin(user.id, meta, ['password', factor]);
}

/* ------------------------------------------------------------------ password reset ----------- */

/**
 * Always succeeds from the caller's point of view, so the endpoint cannot be used to discover
 * which email addresses have accounts.
 */
export async function requestPasswordReset(email: string, meta: RequestMeta) {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  if (!user || !user.isActive || !user.passwordHash) return;

  const token = generateOpaqueToken();
  await db.transaction(async (tx) => {
    await tx.insert(oneTimeTokens).values({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    });
    await enqueueEmail(tx, {
      to: user.email,
      userId: user.id,
      template: 'password_reset',
      locale: toLocale(user.locale),
      name: user.fullName,
      url: `${env.WEB_APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
    });
  });
  await auditSafe({
    action: AuditAction.PASSWORD_RESET_REQUESTED,
    actor: { userId: user.id, role: user.role, facilityId: user.facilityId },
    meta,
  });
}

export async function resetPassword(rawToken: string, password: string, meta: RequestMeta) {
  const now = new Date();
  const user = await db.transaction(async (tx) => {
    const [token] = await tx
      .update(oneTimeTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(oneTimeTokens.tokenHash, hashToken(rawToken)),
          eq(oneTimeTokens.purpose, 'PASSWORD_RESET'),
          isNull(oneTimeTokens.usedAt),
          gt(oneTimeTokens.expiresAt, now),
        ),
      )
      .returning();
    if (!token) throw badRequest('This reset link is invalid or has expired');
    const [u] = await tx
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        passwordChangedAt: now,
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, token.userId))
      .returning();
    await audit(
      {
        action: AuditAction.PASSWORD_RESET_COMPLETED,
        actor: { userId: u!.id, role: u!.role, facilityId: u!.facilityId },
        meta,
        resourceType: 'user',
        resourceId: u!.id,
      },
      tx,
    );
    return u!;
  });
  // Any session opened with the old password is ended.
  await revokeAllSessions(user.id);
}
