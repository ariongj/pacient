import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Authenticated encryption (AES-256-GCM) for small secrets stored in the database, such as TOTP
 * seeds. The key comes from MFA_ENCRYPTION_KEY and is kept outside the database.
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
const key = createHash('sha256').update(env.MFA_ENCRYPTION_KEY).digest();

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function open(sealed: string): string {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported sealed format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Authenticated encryption for binary content (patient documents). A separate key is derived for
 * each purpose so a document key can never decrypt TOTP seeds and vice versa.
 * Format: iv (12 bytes) ‖ tag (16 bytes) ‖ ciphertext.
 */
const bufferKeys = new Map<string, Buffer>();
function keyFor(purpose: string): Buffer {
  let k = bufferKeys.get(purpose);
  if (!k) {
    k = createHash('sha256').update(`pacient-${purpose}:${env.MFA_ENCRYPTION_KEY}`).digest();
    bufferKeys.set(purpose, k);
  }
  return k;
}

export function sealBuffer(plain: Buffer, purpose = 'documents'): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function openBuffer(sealed: Buffer, purpose = 'documents'): Buffer {
  if (sealed.length < 28) throw new Error('Sealed content is truncated');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}
