import type { Request } from 'express';
import type { z, ZodTypeAny } from 'zod';
import type { Role } from '../db/schema.js';
import { badRequest, unauthorized } from './errors.js';

export interface AuthContext {
  userId: string;
  role: Role;
  facilityId: string | null;
  /** Set for PATIENT accounts: the patient record the portal user owns. */
  patientId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
    requestId?: string;
  }
}

/** Validate untrusted input against a schema, producing a uniform 400 response on failure. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestMeta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    requestId: req.requestId ?? null,
  };
}
