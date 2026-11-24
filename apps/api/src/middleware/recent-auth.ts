import { eq } from 'drizzle-orm';
import type { Request, RequestHandler } from 'express';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { HttpError, reauthRequired, tooManyRequests, unauthorized } from '../lib/errors.js';
import { requestMeta } from '../lib/http.js';
import { AuditAction, auditSafe } from '../modules/audit/audit.service.js';
import { REFRESH_COOKIE } from '../modules/auth/auth.routes.js';
import { recordFailedAttempt } from '../modules/auth/auth.service.js';
import { assertRecentAuthentication } from '../modules/security/passkeys.js';

/** Header the web client sends, once, after asking for the password again (ReauthDialog). */
export const REAUTH_HEADER = 'X-Reauth-Password';

/**
 * Proof that the person at the keyboard is the account holder, for actions that would do harm in
 * the hands of someone who found a signed-in screen or a stolen access token (bank details,
 * administrator accounts, credit notes, exports …):
 *
 *  - the password in the X-Reauth-Password header (checked, never stored or logged), or
 *  - a sign-in within the last 10 minutes: a refresh-token family started that recently, via the
 *    refresh cookie. Browsers send that cookie only to /api/v1/auth, so for other paths this
 *    applies only to clients that send the cookie themselves; the web app asks for the password.
 *
 * Otherwise it throws 401 with code REAUTH_REQUIRED (the code of the passkey settings, which
 * answer 403); with a wrong password, the same with the message "Password is incorrect". The web
 * client recognises the code, asks for the password in one shared dialog and retries the request
 * once with the header. Must run after `authenticate`. A confirmed password is audited
 * (auth.reauthenticated), a wrong one as a failure.
 *
 * A wrong password counts like one at sign-in: after five the account is locked for 15 minutes
 * (sign-in and this check alike, 429 meanwhile), so whoever holds a stolen access token cannot use
 * the header to guess the password. A confirmed password clears the count, as a sign-in does.
 */
export async function ensureRecentAuth(req: Request): Promise<void> {
  const ctx = req.auth;
  if (!ctx) throw unauthorized();
  const password = req.get(REAUTH_HEADER) || undefined;
  const refreshToken = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  const [account] = password
    ? await db
        .select({
          id: users.id,
          failedLoginAttempts: users.failedLoginAttempts,
          lockedUntil: users.lockedUntil,
        })
        .from(users)
        .where(eq(users.id, ctx.userId))
    : [];
  if (account?.lockedUntil && account.lockedUntil > new Date()) {
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
    throw tooManyRequests('Too many wrong passwords. Try again in 15 minutes.');
  }
  try {
    await assertRecentAuthentication(ctx, { password, refreshToken });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.code === 'REAUTH_REQUIRED') throw reauthRequired(401);
    if (!password || err.status !== 400) throw err;
    // A wrong password: the same answer, so the dialog stays open and asks again.
    const locked = account ? await recordFailedAttempt(account) : false;
    await auditSafe({
      action: AuditAction.AUTH_REAUTHENTICATED,
      actor: ctx,
      outcome: 'FAILURE',
      resourceType: 'user',
      resourceId: ctx.userId,
      meta: requestMeta(req),
      metadata: { path: req.baseUrl + req.path, locked },
    });
    throw new HttpError(401, 'REAUTH_REQUIRED', 'Password is incorrect');
  }
  if (account?.failedLoginAttempts) {
    await db.update(users).set({ failedLoginAttempts: 0 }).where(eq(users.id, account.id));
  }
  if (password) {
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
