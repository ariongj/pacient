import argon2 from 'argon2';
import { z } from 'zod';

/** OWASP-recommended argon2id parameters (m=19 MiB, t=2, p=1). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Password policy (NIST SP 800-63B): favour length over composition rules, cap length to bound
 * hashing cost, and reject a handful of obviously weak choices.
 */
const COMMON_PASSWORDS = new Set([
  'password1234',
  '123456789012',
  'qwertyuiop12',
  'passwordpassword',
  'iloveyou1234',
  'administrator',
]);

export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'This password is too common')
  .refine((p) => new Set(p).size >= 5, 'Password is too repetitive');

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** A real hash used to equalise timing when the account does not exist (prevents enumeration). */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  return dummyHash;
}
