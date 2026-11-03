import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { authChallenges, refreshTokens, users, webauthnCredentials } from '../../db/schema.js';
import { badRequest, conflict, HttpError, notFound, unauthorized } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { verifyPassword } from '../../lib/password.js';
import { hashToken, verifyMfaChallenge } from '../../lib/tokens.js';
import { audit, AuditAction, auditSafe } from '../audit/audit.service.js';
import {
  completeLogin,
  mfaRequiredFor,
  recordFailedAttempt,
  totpActive,
} from '../auth/auth.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Passkeys (WebAuthn): phishing-resistant credentials bound to the Pacient domain. A passkey can
 * be the whole sign-in (it proves possession and – with user verification – the person), or the
 * second step after the password. Challenges are stored server-side, expire after 5 minutes and
 * can be used once.
 */
const CHALLENGE_TTL_MS = 5 * 60_000;
const RECENT_AUTH_MS = 10 * 60_000;

type Purpose = 'REGISTER' | 'AUTHENTICATE';

const reauthRequired = () =>
  new HttpError(403, 'REAUTH_REQUIRED', 'Confirm your password to continue');
const passkeyFailed = () => unauthorized('The passkey could not be verified');

/** The challenge the browser signed, from the clientDataJSON of a WebAuthn response. */
export function challengeOf(response: { response?: { clientDataJSON?: string } }): string {
  try {
    const raw = Buffer.from(response.response?.clientDataJSON ?? '', 'base64url').toString('utf8');
    const challenge = (JSON.parse(raw) as { challenge?: unknown }).challenge;
    if (typeof challenge === 'string' && challenge.length >= 16) return challenge;
  } catch {
    /* fall through */
  }
  throw badRequest('Invalid passkey response');
}

async function storeChallenge(purpose: Purpose, challenge: string, userId: string | null) {
  await db.insert(authChallenges).values({
    purpose,
    challenge,
    userId,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

/** Marks a stored challenge used; throws if it is unknown, expired, used or not for this user. */
async function consumeChallenge(purpose: Purpose, challenge: string, userId?: string | null) {
  const now = new Date();
  const conditions = [
    eq(authChallenges.purpose, purpose),
    eq(authChallenges.challenge, challenge),
    isNull(authChallenges.usedAt),
    gt(authChallenges.expiresAt, now),
  ];
  if (userId) conditions.push(eq(authChallenges.userId, userId));
  const [row] = await db
    .update(authChallenges)
    .set({ usedAt: now })
    .where(and(...conditions))
    .returning({ id: authChallenges.id, userId: authChallenges.userId });
  if (!row) throw badRequest('This passkey request has expired. Please try again.');
  // Opportunistic clean-up of old challenges.
  await db.execute(sql`DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'`);
  return row;
}

async function loadUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw unauthorized();
  return user;
}

/** Signed in within the last 10 minutes (this session), or the password was just confirmed. */
export async function assertRecentAuthentication(
  ctx: AuthContext,
  opts: { password?: string; refreshToken?: string },
) {
  if (opts.password) {
    const user = await loadUser(ctx.userId);
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, opts.password))) {
      throw badRequest('Password is incorrect');
    }
    return;
  }
  if (opts.refreshToken) {
    const [token] = await db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, hashToken(opts.refreshToken)),
          eq(refreshTokens.userId, ctx.userId),
        ),
      );
    if (token) {
      const [start] = await db
        .select({ at: sql<Date>`min(${refreshTokens.createdAt})` })
        .from(refreshTokens)
        .where(eq(refreshTokens.familyId, token.familyId));
      if (start?.at && new Date(start.at).getTime() > Date.now() - RECENT_AUTH_MS) return;
    }
  }
  throw reauthRequired();
}

const userHandle = (userId: string) => new Uint8Array(Buffer.from(userId.replace(/-/g, ''), 'hex'));

/* ------------------------------------------------------------------ registration ------------ */

export async function registrationOptions(
  ctx: AuthContext,
  opts: { password?: string; refreshToken?: string },
) {
  await assertRecentAuthentication(ctx, opts);
  const user = await loadUser(ctx.userId);
  const existing = await db
    .select({ id: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, ctx.userId));
  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userName: user.email,
    userDisplayName: user.fullName,
    userID: userHandle(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  await storeChallenge('REGISTER', options.challenge, ctx.userId);
  return options;
}

export async function registerPasskey(
  ctx: AuthContext,
  input: { response: RegistrationResponseJSON; deviceName: string },
  meta: RequestMeta,
) {
  const challenge = challengeOf(input.response);
  await consumeChallenge('REGISTER', challenge, ctx.userId);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: env.WEBAUTHN_ORIGINS,
      expectedRPID: env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
    });
  } catch {
    throw badRequest('The passkey could not be registered');
  }
  if (!verification.verified || !verification.registrationInfo.userVerified) {
    throw badRequest('The passkey could not be registered');
  }
  const info = verification.registrationInfo;
  const credential = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(webauthnCredentials)
      .values({
        userId: ctx.userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? null,
        deviceName: input.deviceName,
        backedUp: info.credentialBackedUp,
      })
      .onConflictDoNothing()
      .returning({ id: webauthnCredentials.id, deviceName: webauthnCredentials.deviceName });
    if (!row) throw conflict('This passkey is already registered');
    // A passkey counts as two-step sign-in (see mfa.service: TOTP is tracked separately).
    await tx
      .update(users)
      .set({ mfaEnabledAt: sql`coalesce(${users.mfaEnabledAt}, now())` })
      .where(eq(users.id, ctx.userId));
    await audit(
      {
        action: AuditAction.PASSKEY_REGISTERED,
        actor: ctx,
        meta,
        resourceType: 'user',
        resourceId: ctx.userId,
        metadata: { deviceName: input.deviceName, backedUp: info.credentialBackedUp },
      },
      tx,
    );
    await notifyUsers(
      [ctx.userId],
      {
        type: 'security',
        title: 'A passkey was added to your account',
        body: 'Passkey "{name}". If you did not add it, remove it under Account › Security and change your password.',
        vars: { name: input.deviceName },
        link: '/account/security',
        important: true,
      },
      tx,
    );
    return row;
  });
  return credential;
}

export async function listPasskeys(userId: string) {
  return db
    .select({
      id: webauthnCredentials.id,
      deviceName: webauthnCredentials.deviceName,
      backedUp: webauthnCredentials.backedUp,
      transports: webauthnCredentials.transports,
      createdAt: webauthnCredentials.createdAt,
      lastUsedAt: webauthnCredentials.lastUsedAt,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .orderBy(asc(webauthnCredentials.createdAt));
}

export async function renamePasskey(ctx: AuthContext, id: string, deviceName: string) {
  const rows = await db
    .update(webauthnCredentials)
    .set({ deviceName })
    .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, ctx.userId)))
    .returning({ id: webauthnCredentials.id, deviceName: webauthnCredentials.deviceName });
  if (!rows.length) throw notFound('Passkey not found');
  return rows[0]!;
}

export async function passkeyCount(userId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  return row?.n ?? 0;
}

export async function removePasskey(
  ctx: AuthContext,
  id: string,
  opts: { password?: string; refreshToken?: string },
  meta: RequestMeta,
) {
  await assertRecentAuthentication(ctx, opts);
  const user = await loadUser(ctx.userId);
  const [cred] = await db
    .select({ id: webauthnCredentials.id, deviceName: webauthnCredentials.deviceName })
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, ctx.userId)));
  if (!cred) throw notFound('Passkey not found');
  const remaining = (await passkeyCount(ctx.userId)) - 1;
  const hasTotp = totpActive(user);
  if (remaining === 0 && !hasTotp && mfaRequiredFor(ctx.role)) {
    throw conflict(
      'Staff accounts need a second factor. Add another passkey or set up an authenticator app first.',
    );
  }
  await db.transaction(async (tx) => {
    await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.id, id));
    if (remaining === 0 && !hasTotp) {
      await tx.update(users).set({ mfaEnabledAt: null }).where(eq(users.id, ctx.userId));
    }
    await audit(
      {
        action: AuditAction.PASSKEY_REMOVED,
        actor: ctx,
        meta,
        resourceType: 'user',
        resourceId: ctx.userId,
        metadata: { deviceName: cred.deviceName },
      },
      tx,
    );
  });
}

/* ------------------------------------------------------------------ sign-in ----------------- */

export async function loginOptions() {
  // Discoverable credentials: the authenticator offers the passkeys it holds for this site, so
  // the server never reveals whether an email address has passkeys.
  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    userVerification: 'required',
  });
  await storeChallenge('AUTHENTICATE', options.challenge, null);
  return options;
}

async function verifyAssertion(
  response: AuthenticationResponseJSON,
  meta: RequestMeta,
  expectUserId: string | null,
) {
  const challenge = challengeOf(response);
  await consumeChallenge('AUTHENTICATE', challenge, expectUserId);
  const [cred] = await db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credentialId, response.id));
  if (!cred || (expectUserId && cred.userId !== expectUserId)) {
    await auditSafe({
      action: AuditAction.LOGIN_FAILURE,
      outcome: 'FAILURE',
      meta,
      metadata: { reason: 'unknown_passkey' },
    });
    throw passkeyFailed();
  }
  const user = await loadUser(cred.userId);
  const actor = { userId: user.id, role: user.role, facilityId: user.facilityId };
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await auditSafe({ action: AuditAction.LOGIN_LOCKED, actor, outcome: 'DENIED', meta });
    throw passkeyFailed();
  }
  if (!user.isActive) {
    await auditSafe({
      action: AuditAction.LOGIN_FAILURE,
      actor,
      outcome: 'FAILURE',
      meta,
      metadata: { reason: 'inactive_account', factor: 'passkey' },
    });
    throw passkeyFailed();
  }
  let verified = false;
  let newCounter = cred.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: env.WEBAUTHN_ORIGINS,
      expectedRPID: env.WEBAUTHN_RP_ID,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports ?? undefined,
      },
      requireUserVerification: true,
    });
    verified = result.verified && result.authenticationInfo.userVerified;
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    verified = false;
  }
  // A signature counter that does not increase may mean a cloned authenticator.
  const counterOk = (cred.counter === 0 && newCounter === 0) || newCounter > cred.counter;
  if (!verified || !counterOk) {
    const locked = await recordFailedAttempt(user);
    await auditSafe({
      action: AuditAction.LOGIN_FAILURE,
      actor,
      outcome: 'FAILURE',
      meta,
      metadata: { reason: counterOk ? 'bad_passkey' : 'passkey_counter_regression', locked },
    });
    throw passkeyFailed();
  }
  await db
    .update(webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(webauthnCredentials.id, cred.id));
  await auditSafe({
    action: AuditAction.PASSKEY_LOGIN,
    actor,
    meta,
    resourceType: 'user',
    resourceId: user.id,
    metadata: { deviceName: cred.deviceName },
  });
  return user;
}

/** Complete sign-in with a passkey (no password): satisfies two-step sign-in on its own. */
export async function passkeyLogin(response: AuthenticationResponseJSON, meta: RequestMeta) {
  const user = await verifyAssertion(response, meta, null);
  return completeLogin(user.id, meta, ['passkey']);
}

function userFromMfaToken(mfaToken: string) {
  try {
    return verifyMfaChallenge(mfaToken);
  } catch {
    throw unauthorized('Your sign-in attempt expired. Please start again.');
  }
}

/** Second step after the password, with one of the user's passkeys. */
export async function mfaOptions(mfaToken: string) {
  const userId = userFromMfaToken(mfaToken);
  const creds = await db
    .select({ id: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  if (!creds.length) throw badRequest('No passkey is registered for this account');
  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    userVerification: 'required',
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
  });
  await storeChallenge('AUTHENTICATE', options.challenge, userId);
  return options;
}

export async function completeMfaWithPasskey(
  mfaToken: string,
  response: AuthenticationResponseJSON,
  meta: RequestMeta,
) {
  const userId = userFromMfaToken(mfaToken);
  const user = await verifyAssertion(response, meta, userId);
  return completeLogin(user.id, meta, ['password', 'passkey']);
}
