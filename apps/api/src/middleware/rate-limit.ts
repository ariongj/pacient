import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { isTest } from '../config/env.js';
import { verifyAccessToken } from '../lib/tokens.js';

/**
 * Hospitals typically put every workstation behind one public IP, so limiting purely per IP would
 * throttle a whole facility at once. Authenticated traffic is therefore limited per user; only
 * anonymous traffic falls back to the client IP.
 */
function userOrIpKey(req: Request): string {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      return `user:${verifyAccessToken(header.slice(7).trim()).sub}`;
    } catch {
      /* invalid token: fall back to IP */
    }
  }
  return `ip:${req.ip}`;
}

const handler = (_req: Request, res: Response) => {
  res.status(429).json({
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' },
  });
};

/** General API limit, per user when signed in (per IP otherwise). */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  keyGenerator: userOrIpKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler,
});

/**
 * Strict limit for credential endpoints (complements per-account lockout). Only failed attempts
 * count, so a user signing in successfully is never throttled, while guessing is.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  // Per IP and shared by everyone behind a hospital NAT, so sized generously; targeted guessing
  // is stopped by the per-account lockout (5 failures).
  limit: 100,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler,
});

/**
 * Session refresh runs on every page load and every access-token expiry, so it needs a much higher
 * ceiling than credential endpoints. Refresh tokens are 256-bit random values, so guessing is not
 * the threat here; this limit only bounds abuse.
 */
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60_000,
  // Per IP (refresh tokens rotate, so they cannot serve as a stable key). Sized for a facility of
  // a few hundred staff sharing one public address.
  limit: 3000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler,
});
