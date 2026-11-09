import { randomBytes } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { mfaRecoveryCodes, supportTickets, users, webauthnCredentials } from '../../db/schema.js';

/**
 * IT support desk (blueprint §3 roles): account and access problems of a facility's staff.
 *
 * IT_SUPPORT staff never see patient data and never change roles. They unlock accounts and send
 * password-reset links themselves; resetting two-step sign-in and access changes need a director's
 * approval first (and the access change itself is made by the director on the staff page).
 */

export const TICKET_KINDS = [
  'ACCOUNT_LOCKED',
  'MFA_RESET',
  'PASSWORD_RESET',
  'ACCESS_CHANGE',
  'DEVICE',
  'OTHER',
] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RESOLVED',
  'REJECTED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Kinds that need a director's approval before IT support may act. */
export const NEEDS_APPROVAL: TicketKind[] = ['MFA_RESET', 'ACCESS_CHANGE'];

export const OPEN_TICKET_STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL'];

/** e.g. IT-2611-7KQ4M2 (year, month, random). */
export function newReference(now = new Date()) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  const ym = now.toISOString().slice(2, 7).replace('-', '');
  return `IT-${ym}-${code}`;
}

/** Active IT support staff of a facility. */
export async function itStaffOf(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'IT_SUPPORT'), eq(users.isActive, true)),
    );
  return rows.map((r) => r.id);
}

/** Active directors of a facility. */
export async function directorsOf(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    );
  return rows.map((r) => r.id);
}

/** A staff account of the facility (never a patient account, never the Ministry). */
export async function staffAccountOf(userId: string, facilityId: string, executor: Executor = db) {
  const [u] = await executor
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.facilityId, facilityId), ne(users.role, 'PATIENT')));
  return u ?? null;
}

/** What IT support may see of an account: no clinical or personal data beyond the account. */
export function accountView(u: typeof users.$inferSelect, now = new Date()) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    activated: u.passwordHash !== null,
    locked: Boolean(u.lockedUntil && u.lockedUntil > now),
    lockedUntil: u.lockedUntil,
    failedLoginAttempts: u.failedLoginAttempts,
    twoStepEnabled: u.mfaEnabledAt !== null,
    lastLoginAt: u.lastLoginAt,
  };
}

/** Removes every second factor; the user enrols again at the next sign-in. */
export async function resetSecondFactors(tx: Executor, userId: string) {
  await tx
    .update(users)
    .set({ mfaEnabledAt: null, mfaSecretEncrypted: null, mfaLastUsedStep: null })
    .where(eq(users.id, userId));
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));
}

export type Ticket = typeof supportTickets.$inferSelect;
