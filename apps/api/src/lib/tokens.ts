import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { Role } from '../db/schema.js';

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  facilityId: string | null;
  patientId: string | null;
}

const ISSUER = 'pacient-api';
const AUDIENCE = 'pacient-web';

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(
    { role: claims.role, facilityId: claims.facilityId, patientId: claims.patientId },
    env.JWT_ACCESS_SECRET,
    {
      algorithm: 'HS256',
      subject: claims.sub,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    },
  );
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload === 'string' || !payload.sub) throw new Error('Malformed token');
  return {
    sub: payload.sub,
    role: payload.role as Role,
    facilityId: (payload.facilityId as string | null) ?? null,
    patientId: (payload.patientId as string | null) ?? null,
  };
}

/** Cryptographically random opaque token (256 bits), URL-safe. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Opaque tokens are stored only as SHA-256 hashes so a database leak cannot be replayed. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
