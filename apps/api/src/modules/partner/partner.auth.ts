import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import { partnerClients, type PartnerScope } from '../../db/schema.js';
import { HttpError, unauthorized } from '../../lib/errors.js';
import { requestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { hashToken } from '../../lib/tokens.js';
import { AuditAction, auditSafe } from '../audit/audit.service.js';

/**
 * Authentication and auditing for partner systems (insurance fund, civil registry, other
 * hospitals' systems, public health). A partner presents its API key as
 * `Authorization: Bearer pk_…`; only the key's SHA-256 hash is stored. Each key carries the scopes
 * it was granted, optionally an IP allowlist, and every call – allowed or refused – is audited.
 */
export interface PartnerClient {
  id: string;
  name: string;
  organisation: string;
  scopes: PartnerScope[];
}

declare module 'express-serve-static-core' {
  interface Request {
    partner?: PartnerClient;
  }
}

export const PURPOSES = ['TREATMENT', 'PAYMENT', 'PUBLIC_HEALTH'] as const;
export type Purpose = (typeof PURPOSES)[number];

export interface PartnerAuditInput {
  scope: PartnerScope | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  patientId?: string | null;
  purpose?: Purpose | null;
  practitioner?: string | null;
  /** Short machine-readable result, e.g. "ok", "consent_withdrawn". */
  result: string;
  extra?: Record<string, unknown>;
}

/**
 * Audit a partner call. The metadata carries the client's name so the patient's "who viewed my
 * record" can show e.g. "Fondi i Sigurimit Shëndetësor (API)".
 */
export async function auditPartner(req: Request, client: PartnerClient, input: PartnerAuditInput) {
  await auditSafe({
    action: AuditAction.PARTNER_API_ACCESS,
    actor: null,
    resourceType: input.patientId ? 'patient' : 'partner_api',
    resourceId: input.patientId ?? client.id,
    patientId: input.patientId ?? null,
    outcome: input.outcome ?? 'SUCCESS',
    meta: requestMeta(req),
    metadata: {
      via: 'PARTNER_API',
      clientId: client.id,
      clientName: client.name,
      organisation: client.organisation,
      actorLabel: `${client.name} (API)`,
      scope: input.scope,
      purpose: input.purpose ?? null,
      practitioner: input.practitioner ?? null,
      endpoint: `${req.method} ${req.baseUrl}${req.path}`,
      result: input.result,
      ...input.extra,
    },
  });
}

const normaliseIp = (ip: string | undefined) => (ip ?? '').replace(/^::ffff:/, '');

/** Resolves the API key to an active partner client (401 otherwise). */
export const authenticatePartner: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer pk_')) throw unauthorized('Partner API key required');
  const [client] = await db
    .select()
    .from(partnerClients)
    .where(eq(partnerClients.apiKeyHash, hashToken(header.slice(7).trim())));
  if (!client) {
    logger.warn({ ip: req.ip }, 'Partner API call with an unknown key');
    throw unauthorized('Invalid or revoked API key');
  }
  const identity: PartnerClient = {
    id: client.id,
    name: client.name,
    organisation: client.organisation,
    scopes: client.scopes as PartnerScope[],
  };
  if (!client.isActive) {
    await auditPartner(req, identity, { scope: null, outcome: 'DENIED', result: 'revoked_key' });
    throw unauthorized('Invalid or revoked API key');
  }
  if (client.allowedIps?.length && !client.allowedIps.includes(normaliseIp(req.ip))) {
    await auditPartner(req, identity, {
      scope: null,
      outcome: 'DENIED',
      result: 'ip_not_allowed',
      extra: { ip: normaliseIp(req.ip) },
    });
    throw new HttpError(
      403,
      'IP_NOT_ALLOWED',
      'Calls from this address are not allowed for this key',
    );
  }
  await db
    .update(partnerClients)
    .set({ lastSeenAt: new Date() })
    .where(eq(partnerClients.id, client.id));
  req.partner = identity;
  next();
};

/** 403 (audited) unless the key was granted the scope. */
export const requireScope =
  (scope: PartnerScope): RequestHandler =>
  async (req, _res, next) => {
    const client = req.partner!;
    if (!client.scopes.includes(scope)) {
      await auditPartner(req, client, { scope, outcome: 'DENIED', result: 'missing_scope' });
      throw new HttpError(403, 'SCOPE_REQUIRED', `This API key does not have the "${scope}" scope`);
    }
    next();
  };

/** Purpose of use (X-Purpose-Of-Use) and, for treatment, the requesting practitioner. */
export async function requirePurpose(
  req: Request,
  scope: PartnerScope,
): Promise<{ purpose: Purpose; practitioner: string | null }> {
  const client = req.partner!;
  const raw = (req.get('x-purpose-of-use') ?? '').trim().toUpperCase();
  if (!(PURPOSES as readonly string[]).includes(raw)) {
    await auditPartner(req, client, { scope, outcome: 'FAILURE', result: 'missing_purpose' });
    throw new HttpError(
      400,
      'PURPOSE_REQUIRED',
      'Send the purpose of use in the X-Purpose-Of-Use header: TREATMENT, PAYMENT or PUBLIC_HEALTH',
    );
  }
  const purpose = raw as Purpose;
  const practitioner = (req.get('x-requesting-practitioner') ?? '').trim().slice(0, 200) || null;
  if (purpose === 'TREATMENT' && (!practitioner || practitioner.length < 3)) {
    await auditPartner(req, client, {
      scope,
      purpose,
      outcome: 'FAILURE',
      result: 'missing_practitioner',
    });
    throw new HttpError(
      400,
      'PRACTITIONER_REQUIRED',
      'For treatment, name the requesting practitioner in the X-Requesting-Practitioner header',
    );
  }
  return { purpose, practitioner };
}

/** Per-key rate limit (keys are hashed into the limiter key, never stored in clear). */
export const partnerLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) => {
    const header = req.get('authorization') ?? '';
    return header.startsWith('Bearer ')
      ? `pk:${hashToken(header.slice(7).trim())}`
      : `ip:${req.ip}`;
  },
  handler: (_req: Request, res: Response, _next: NextFunction) => {
    res.status(429).json({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded (300 requests per minute)',
      },
    });
  },
});

/** Partner keys look like lab keys (pk_…) but are a separate credential with their own scopes. */
export function newPartnerKey() {
  return `pk_${randomBytes(32).toString('base64url')}`;
}
