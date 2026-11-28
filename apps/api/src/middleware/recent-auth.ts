import { and, eq, sql } from 'drizzle-orm';
import type { Request, RequestHandler } from 'express';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  badRequest,
  HttpError,
  reauthRequired,
  tooManyRequests,
  unauthorized,
} from '../lib/errors.js';
import { requestMeta } from '../lib/http.js';
import { AuditAction, auditSafe } from '../modules/audit/audit.service.js';
import { REFRESH_COOKIE } from '../modules/auth/auth.routes.js';
import { recordFailedAttempt } from '../modules/auth/auth.service.js';
import { assertRecentAuthentication } from '../modules/security/passkeys.js';

/** Header the web client sends, once, after asking for the password again (ReauthDialog). */
export const REAUTH_HEADER = 'X-Reauth-Password';

/**
 * The password travels as `b64:` followed by the base64 of its UTF-8 bytes, and only so. A header
 * value can hold only Latin-1 characters, so a password with č, ć, đ, š, ž or Cyrillic letters
 * could not be sent as it is, and HTTP removes spaces at either end of a value, so a password that
 * begins or ends with one would always arrive wrong (and count toward the lockout).
 */
const ENCODED_PREFIX = 'b64:';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The longest password (128 characters of up to 4 UTF-8 bytes each), encoded. */
const ENCODED_MAX = ENCODED_PREFIX.length + Math.ceil((128 * 4) / 3) * 4;
const NOT_ENCODED = 'Send the password as b64: followed by the base64 of its UTF-8 bytes';

/**
 * The password from the header, or undefined without one. A value not encoded as above is refused
 * (400) and is not counted as a wrong password: nothing was checked.
 */
export function reauthPasswordOf(req: Request): string | undefined {
  const value = req.get(REAUTH_HEADER);
  if (!value) return undefined;
  const encoded = value.startsWith(ENCODED_PREFIX) ? value.slice(ENCODED_PREFIX.length) : '';
  if (encoded && value.length <= ENCODED_MAX && BASE64.test(encoded)) {
    try {
      const password = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(encoded, 'base64'),
      );
      if (password) return password;
    } catch {
      /* not UTF-8 */
    }
  }
  throw badRequest(NOT_ENCODED);
}

/**
 * Proof that the person at the keyboard is the account holder, for actions that would do harm in
 * the hands of someone who found a signed-in screen or a stolen access token (bank details,
 * administrator accounts, credit notes, exports …):
 *
 *  - the password in the X-Reauth-Password header, encoded as above (checked, never stored or
 *    logged), or
 *  - a sign-in within the last 10 minutes: a refresh-token family started that recently, via the
 *    refresh cookie (a token still valid: not signed out, revoked or expired). Browsers send that
 *    cookie only to /api/v1/auth, so for other paths this applies only to clients that send the
 *    cookie themselves; the web app asks for the password.
 *
 * Otherwise it throws 401 with code REAUTH_REQUIRED (the code of the passkey settings, which
 * answer 403); with a wrong password, the same with the message "Password is incorrect". The web
 * client recognises the code, asks for the password in one shared dialog and retries the request
 * once with the header. Must run after `authenticate`. A confirmed password is audited
 * (auth.reauthenticated), a wrong one as a failure.
 *
 * A wrong password counts like one at sign-in: after five the account is locked for 15 minutes
 * (sign-in and this check alike, 429 meanwhile). Each wrong password is counted in one statement,
 * so guesses sent in parallel all count, and the lock is checked again after the (slow) check of a
 * right password, so one sent among them is refused as well. Since an administrator cannot unlock
 * their own account (admin/users.routes.ts), whoever holds a stolen access token cannot use the
 * header to guess the password. A confirmed password clears the count, as a sign-in does.
 */
export async function ensureRecentAuth(req: Request): Promise<void> {
  const ctx = req.auth;
  if (!ctx) throw unauthorized();
  const password = reauthPasswordOf(req);
  const refreshToken = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  const locked = async () => {
    await auditSafe({
      action: AuditAction.AUTH_REAUTHENTICATED,
      actor: ctx,
      outcome: 'DENIED',
      resourceType: 'user',
      resourceId: ctx.userId,
      meta: requestMeta(req),
      metadata: { path: req.baseUrl + req.path, reason: 'locked' },
    });
    // The lockout of sign-in (LOCKOUT_MINUTES).
    return tooManyRequests('Too many wrong passwords. Try again in 15 minutes.');
  };
  if (password) {
    const [account] = await db
      .select({ locked: sql<boolean>`coalesce(${users.lockedUntil} > now(), false)` })
      .from(users)
      .where(eq(users.id, ctx.userId));
    if (account?.locked) throw await locked();
  }
  try {
    await assertRecentAuthentication(ctx, { password, refreshToken });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.code === 'REAUTH_REQUIRED') throw reauthRequired(401);
    if (!password || err.status !== 400) throw err;
    // A wrong password: the same answer, so the dialog stays open and asks again.
    const lockedNow = await recordFailedAttempt({ id: ctx.userId });
    await auditSafe({
      action: AuditAction.AUTH_REAUTHENTICATED,
      actor: ctx,
      outcome: 'FAILURE',
      resourceType: 'user',
      resourceId: ctx.userId,
      meta: requestMeta(req),
      metadata: { path: req.baseUrl + req.path, locked: lockedNow },
    });
    throw new HttpError(401, 'REAUTH_REQUIRED', 'Password is incorrect');
  }
  if (password) {
    // Cleared only if wrong passwords sent at the same time did not lock the account meanwhile;
    // otherwise the right one is refused like any other attempt during the lock.
    const [cleared] = await db
      .update(users)
      .set({ failedLoginAttempts: 0 })
      .where(
        and(
          eq(users.id, ctx.userId),
          sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= now())`,
        ),
      )
      .returning({ id: users.id });
    if (!cleared) throw await locked();
    await auditSafe({
      action: AuditAction.AUTH_REAUTHENTICATED,
      actor: ctx,
      resourceType: 'user',
      resourceId: ctx.userId,
      meta: requestMeta(req),
      metadata: { path: req.baseUrl + req.path },
    });
  }
}

/**
 * Middleware form of `ensureRecentAuth` for routes that always need it:
 * `router.post('/payments/:id/reverse', requireRecentAuth(), handler)`. Routes that need it only
 * in some cases (e.g. when the IBAN changes) call `await ensureRecentAuth(req)` themselves,
 * before they change anything.
 */
export function requireRecentAuth(): RequestHandler {
  return async (req, _res, next) => {
    await ensureRecentAuth(req);
    next();
  };
}
