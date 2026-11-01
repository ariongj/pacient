import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { isTest } from '../config/env.js';

const handler = (_req: Request, res: Response) => {
  res.status(429).json({
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' },
  });
};

/** General API limit per client IP. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
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
  limit: 20,
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
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler,
});
