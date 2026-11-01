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

/** Strict limit for credential endpoints (complements per-account lockout). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler,
});
