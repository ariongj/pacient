/**
 * Owner-authorized recovery of a platform administrator who lost both the password and the second
 * factor (deploy/recover-admin.sh). The portal cannot help here: nobody else may reset an
 * administrator's two-step sign-in without proving who they are, and with a single administrator
 * there is nobody else. Whoever runs this on the server is the owner of the installation. No
 * outbound mail, and the link never appears in any output or log.
 */
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db, pool } from '../db/client.js';
import { oneTimeTokens, users } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { generateOpaqueToken, hashToken } from '../lib/tokens.js';
import { lockPlatformAdmins, revokeSessions } from '../modules/admin/users.service.js';
import { audit, AuditAction } from '../modules/audit/audit.service.js';
import { notifyUsers } from '../modules/notifications/notifications.service.js';
import { resetSecondFactors } from '../modules/support/support.service.js';

/** The link is handed over in person or by a channel the owner trusts, so it lasts a day. */
export const RECOVERY_LINK_HOURS = 24;

/** Audit source of the recovery, next to the first administrator's owner-authorized-* sources. */
export const RECOVERY_SOURCE = 'owner-authorized-recovery';

/** A refusal whose message is safe and useful to print (no token, no database details). */
export class RecoveryRefused extends Error {}

/**
 * For an existing, activated and enabled platform administrator: in one transaction, the old
 * password stops working (replaced by an unknown random one, so whoever may know it cannot sign
 * in without a second factor while the link waits), the authenticator app, recovery codes and
 * passkeys are removed, earlier reset links stop working, every session ends, and a password reset
 * link valid for 24 hours is written to `outputPath` (created 0600, never overwritten). Audited
 * (actor: the system, source owner-authorized-recovery) as a two-step reset and a password reset,
 * and announced to every other active administrator. The person chooses a new password with the
 * link and sets up two-step sign-in again at the next sign-in. Nothing is changed and no file is
 * left behind when it is refused.
 */
export async function recoverAdmin(email: string, outputPath: string) {
  const normalized = z.email().parse(email).toLowerCase();
  // Reserve a protected destination before changing anything. Never overwrite a handoff.
  const output = await open(outputPath, 'wx', 0o600);
  let committed = false;
  try {
    const result = await db.transaction(async (tx) => {
      // The same lock as every change of an administrator (disable, demote, invite the first).
      await lockPlatformAdmins(tx);
      const [user] = await tx
        .select({
          id: users.id,
          role: users.role,
          fullName: users.fullName,
          isActive: users.isActive,
          activated: sql<boolean>`${users.passwordHash} IS NOT NULL`,
        })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalized}`)
        .for('update');
      if (!user || user.role !== 'ADMIN') {
        throw new RecoveryRefused(
          'Refused: no platform administrator has this e-mail address. Other accounts are helped in the portal (Users).',
        );
      }
      if (!user.activated) {
        throw new RecoveryRefused(
          'Refused: this administrator has not activated the account yet. Renew the invitation under Users, or with deploy/first-admin.sh --existing-installation when no administrator can sign in.',
        );
      }
      if (!user.isActive) {
        throw new RecoveryRefused(
          'Refused: this administrator account is disabled. Another administrator enables it under Users first.',
        );
      }

      const now = new Date();
      await tx
        .update(users)
        .set({
          passwordHash: await hashPassword(generateOpaqueToken()),
          passwordChangedAt: now,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, user.id));
      await resetSecondFactors(tx, user.id);
      await tx
        .update(oneTimeTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(oneTimeTokens.userId, user.id),
            eq(oneTimeTokens.purpose, 'PASSWORD_RESET'),
            isNull(oneTimeTokens.usedAt),
          ),
        );
      const sessionsRevoked = await revokeSessions(tx, user.id);
      const token = generateOpaqueToken();
      await tx.insert(oneTimeTokens).values({
        userId: user.id,
        purpose: 'PASSWORD_RESET',
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + RECOVERY_LINK_HOURS * 3_600_000),
        createdById: null,
      });

      // Two entries, as in the portal: the account's history shows both, with the source.
      const reason = 'Lost the password and two-step sign-in; recovered on the server';
      await audit(
        {
          action: AuditAction.ADMIN_MFA_RESET,
          actor: null,
          resourceType: 'user',
          resourceId: user.id,
          metadata: { source: RECOVERY_SOURCE, reason, sessionsRevoked },
        },
        tx,
      );
      await audit(
        {
          action: AuditAction.ADMIN_PASSWORD_RESET_SENT,
          actor: null,
          resourceType: 'user',
          resourceId: user.id,
          metadata: {
            source: RECOVERY_SOURCE,
            reason,
            delivery: 'private_file',
            validHours: RECOVERY_LINK_HOURS,
          },
        },
        tx,
      );

      // Access to the server is the key to this door: the colleagues hear of every use.
      const others = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.role, 'ADMIN'),
            eq(users.isActive, true),
            isNotNull(users.passwordHash),
            ne(users.id, user.id),
          ),
        );
      await notifyUsers(
        others.map((o) => o.id),
        {
          type: 'security',
          title: 'The administrator account of {name} was recovered on the server',
          body: 'Its password and two-step sign-in were reset on the server by the owner of the installation. If nobody expected this, check who has access to the server.',
          vars: { name: user.fullName },
          link: `/admin/users/${user.id}`,
          important: true,
        },
        tx,
      );

      const url = new URL(`${env.WEB_APP_URL.replace(/\/$/, '')}/reset-password`);
      url.searchParams.set('token', token);
      await output.writeFile(`${url.href}\n`, 'utf8');
      await output.sync();
      return { userId: user.id, sessionsRevoked, notified: others.length };
    });
    committed = true;
    return result;
  } finally {
    await output.close();
    // Nothing was changed: leave no empty file behind to block the next attempt.
    if (!committed) await unlink(outputPath).catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const [email, outputPath] = args;
  if (args.length !== 2 || !email || !outputPath || args.some((a) => a.startsWith('--'))) {
    console.error('Usage: recover-admin.js ADMIN-EMAIL PRIVATE_OUTPUT_PATH');
    process.exitCode = 1;
    await pool.end();
  } else {
    try {
      const { sessionsRevoked, notified } = await recoverAdmin(email, outputPath);
      console.log(
        `Administrator recovered: password and two-step sign-in reset, ${sessionsRevoked} session(s) ended, ${notified} other administrator(s) told. Private reset link saved (valid ${RECOVERY_LINK_HOURS} hours). No email sent.`,
      );
    } catch (err) {
      // Never include the token, database connection string or query details in command output.
      console.error(
        err instanceof RecoveryRefused
          ? err.message
          : err instanceof z.ZodError
            ? 'Refused: this is not a valid e-mail address.'
            : (err as NodeJS.ErrnoException)?.code === 'EEXIST'
              ? 'Refused: the private output file exists. Use or delete the earlier link first.'
              : 'Recovery failed. Nothing was changed. Check the e-mail address and the private output path.',
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
