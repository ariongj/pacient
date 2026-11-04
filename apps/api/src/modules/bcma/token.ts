import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Wristband tokens: `PAC1.<payload>.<signature>` (base64url). The payload holds only the patient
 * id and the issue time – no name or national ID – so a lost wristband reveals nothing. The
 * signature is an HMAC-SHA256 with a key derived for this purpose only.
 */
const PREFIX = 'PAC1';
/** Wristbands are reprinted at every admission; older ones are refused after this. */
export const WRISTBAND_MAX_AGE_DAYS = 365;

const key = createHash('sha256').update(`pacient-wristband:${env.MFA_ENCRYPTION_KEY}`).digest();
const sign = (data: string) => createHmac('sha256', key).update(data).digest().subarray(0, 18);

export function signWristband(patientId: string, issuedAt = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({ p: patientId, i: Math.floor(issuedAt.getTime() / 1000) }),
  ).toString('base64url');
  return `${PREFIX}.${payload}.${sign(`${PREFIX}.${payload}`).toString('base64url')}`;
}

export type WristbandCheck =
  { valid: true; patientId: string; issuedAt: Date; expired: boolean } | { valid: false };

export function verifyWristband(token: string, now = new Date()): WristbandCheck {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { valid: false };
  const [, payload, sig] = parts as [string, string, string];
  // Only canonical base64url: Buffer decoding would otherwise ignore stray trailing characters.
  if (!/^[A-Za-z0-9_-]{24}$/.test(sig) || !/^[A-Za-z0-9_-]+$/.test(payload))
    return { valid: false };
  const expected = sign(`${PREFIX}.${payload}`);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { valid: false };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { valid: false };
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      p?: unknown;
      i?: unknown;
    };
    if (typeof data.p !== 'string' || typeof data.i !== 'number') return { valid: false };
    const issuedAt = new Date(data.i * 1000);
    const expired = now.getTime() - issuedAt.getTime() > WRISTBAND_MAX_AGE_DAYS * 86_400_000;
    return { valid: true, patientId: data.p, issuedAt, expired };
  } catch {
    return { valid: false };
  }
}
