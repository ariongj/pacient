import { env, isProd } from '../../config/env.js';
import type { Executor } from '../../db/client.js';
import { oneTimeTokens, users, type Role } from '../../db/schema.js';
import { generateOpaqueToken, hashToken } from '../../lib/tokens.js';
import { enqueueEmail } from '../email/outbox.js';

const ACTIVATION_TTL_HOURS = 72;

export interface NewAccount {
  email: string;
  fullName: string;
  role: Role;
  facilityId: string | null;
  specialty?: string | null;
  licenseNumber?: string | null;
}

/**
 * Creates an account without a password and issues a single-use activation token. The person
 * chooses their own password, so administrators never know user credentials.
 */
export async function createInvitedUser(tx: Executor, account: NewAccount, invitedById: string) {
  const [user] = await tx
    .insert(users)
    .values({
      email: account.email.toLowerCase(),
      fullName: account.fullName,
      role: account.role,
      facilityId: account.facilityId,
      specialty: account.specialty ?? null,
      licenseNumber: account.licenseNumber ?? null,
      // Patients (and guardians) get every notification by email by default; staff the important ones.
      emailNotifications: account.role === 'PATIENT' ? 'ALL' : 'IMPORTANT',
    })
    .returning();
  if (!user) throw new Error('Failed to create user');

  const token = generateOpaqueToken();
  await tx.insert(oneTimeTokens).values({
    userId: user.id,
    purpose: 'ACCOUNT_ACTIVATION',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ACTIVATION_TTL_HOURS * 3_600_000),
    createdById: invitedById,
  });

  const activationUrl = `${env.WEB_APP_URL}/activate?token=${encodeURIComponent(token)}`;
  // Delivered by the outbox worker only if this transaction commits.
  await enqueueEmail(tx, {
    to: user.email,
    userId: user.id,
    template: 'activation',
    name: user.fullName,
    url: activationUrl,
  });

  return {
    user,
    // Outside production the link is returned so the system can be used without an email server.
    activationUrl: isProd ? undefined : activationUrl,
  };
}
