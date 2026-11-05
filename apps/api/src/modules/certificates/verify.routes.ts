import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { notFound } from '../../lib/errors.js';
import { requestMeta } from '../../lib/http.js';
import { auditSafe, AuditAction } from '../audit/audit.service.js';
import { VERIFICATION_CODE_PATTERN, verifyByCode } from './certificates.service.js';

/**
 * Public verification of a medical certificate by its QR code (no sign-in): validity, kind, dates
 * and issuer only – never the diagnosis or remarks. The code is a 144-bit random value, so it
 * cannot be guessed; the strict per-IP limit only bounds scraping. Every verification is recorded
 * for the patient, who sees it in their access log.
 */
export const certificateVerifyRouter = Router();

/** Strict: 30 checks per 10 minutes per address (kept on in tests so the headers can be checked). */
export const verifyLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req: Request) => `verify:${req.ip}`,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' },
    });
  },
});

const recentVerifications = new Map<string, number>();

certificateVerifyRouter.get('/:code', verifyLimiter, async (req, res) => {
  const code = String(req.params.code);
  res.set('Cache-Control', 'no-store');
  // Malformed codes get the same answer as unknown ones.
  const found = VERIFICATION_CODE_PATTERN.test(code) ? await verifyByCode(code) : null;
  if (!found) throw notFound('No certificate matches this code');

  // One access-log entry per certificate and address every 10 minutes (pages get reloaded).
  const key = `${found.certificateId}:${req.ip}`;
  const now = Date.now();
  if ((recentVerifications.get(key) ?? 0) <= now - 10 * 60_000) {
    recentVerifications.set(key, now);
    if (recentVerifications.size > 20_000) recentVerifications.clear();
    await auditSafe({
      action: AuditAction.CERTIFICATE_VERIFIED,
      actor: null,
      resourceType: 'medical_certificate',
      resourceId: found.certificateId,
      patientId: found.patientId,
      meta: requestMeta(req),
      metadata: { actorLabel: 'External verification (QR code)', state: found.body.state },
    });
  }
  res.json(found.body);
});
