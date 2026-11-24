/**
 * Owner-authorized invitation of the first administrator (or of the platform administrator of an
 * installation that has none); no default passwords, no outbound mail, no token logging.
 */
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db, pool } from '../db/client.js';
import { oneTimeTokens, users } from '../db/schema.js';
import { generateOpaqueToken, hashToken } from '../lib/tokens.js';
import { lockPlatformAdmins } from '../modules/admin/users.service.js';
import { audit, AuditAction } from '../modules/audit/audit.service.js';

/**
 * - first-install (default): the first account of a new installation – the platform administrator,
 *   who then invites the Ministry and facility directors, or, for a Ministry-run installation, a
 *   Ministry official. Refused once any account exists.
 * - existing-installation: the platform administrator for an installation that already has
 *   accounts but no administrator (bootstrapped as Ministry-run, or before the operator layer).
 *   Refused while any active platform administrator who can sign in exists, so it can never add a
 *   second, unnoticed administrator next to a working one.
 */
export type BootstrapMode = 'first-install' | 'existing-installation';

export async function bootstrapAdmin(
  email: string,
  outputPath: string,
  role: 'ADMIN' | 'MINISTRY' = 'ADMIN',
  mode: BootstrapMode = 'first-install',
): Promise<void> {
  const normalized = z.email().parse(email).toLowerCase();
  if (mode === 'existing-installation' && role !== 'ADMIN') {
    throw new Error('Only a platform administrator can be added to an existing installation');
  }
  // Reserve a protected destination before creating the account. Never overwrite a handoff.
  const output = await open(outputPath, 'wx', 0o600);
  let committed = false;
  try {
    await db.transaction(async (tx) => {
      // The same lock as every change that can add or remove an administrator.
      await lockPlatformAdmins(tx);
      let userId: string;
      if (mode === 'first-install') {
        if ((await tx.select({ id: users.id }).from(users).limit(1)).length) {
          throw new Error('First-admin setup refused: users already exist');
        }
        userId = await createAccount(tx, normalized, role);
      } else {
        const [admin] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(eq(users.role, 'ADMIN'), eq(users.isActive, true), isNotNull(users.passwordHash)),
          )
          .limit(1);
        if (admin) throw new Error('Refused: an active platform administrator already exists');
        const [existing] = await tx
          .select({
            id: users.id,
            role: users.role,
            activated: sql<boolean>`${users.passwordHash} IS NOT NULL`,
          })
          .from(users)
          .where(sql`lower(${users.email}) = ${normalized}`);
        if (existing && (existing.role !== 'ADMIN' || existing.activated)) {
          // Never turn someone's existing account into an administrator here.
          throw new Error('Refused: another account uses this e-mail address');
        }
        // A pending invitation of an earlier run (e.g. its link expired) is renewed.
        userId = existing?.id ?? (await createAccount(tx, normalized, 'ADMIN'));
        if (existing) {
          await tx.update(users).set({ isActive: true }).where(eq(users.id, existing.id));
          await tx
            .update(oneTimeTokens)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(oneTimeTokens.userId, existing.id),
                eq(oneTimeTokens.purpose, 'ACCOUNT_ACTIVATION'),
                isNull(oneTimeTokens.usedAt),
              ),
            );
        }
      }
      const token = generateOpaqueToken();
      await tx.insert(oneTimeTokens).values({
        userId,
        purpose: 'ACCOUNT_ACTIVATION',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 72 * 3_600_000),
        createdById: userId,
      });
      await audit(
        {
          action: AuditAction.USER_INVITED,
          actor: { userId, role, facilityId: null },
          resourceType: 'user',
          resourceId: userId,
          metadata: {
            source:
              mode === 'first-install'
                ? 'owner-authorized-first-install'
                : 'owner-authorized-existing-installation',
          },
        },
        tx,
      );
      const url = new URL(`${env.WEB_APP_URL.replace(/\/$/, '')}/activate`);
      url.searchParams.set('token', token);
      await output.writeFile(`${url.href}\n`, 'utf8');
      await output.sync();
    });
    committed = true;
  } finally {
    await output.close();
    // Nothing was created: leave no empty or useless file behind to block the next attempt.
    if (!committed) await unlink(outputPath).catch(() => undefined);
  }
}

async function createAccount(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  email: string,
  role: 'ADMIN' | 'MINISTRY',
) {
  const [user] = await tx
    .insert(users)
    .values({
      email,
      fullName: role === 'ADMIN' ? 'Platform administrator' : 'Administrator',
      role,
      facilityId: null,
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Could not create the first administrator');
  return user.id;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const existingInstallation = args.includes('--existing-installation');
  const [email, outputPath, roleArg = 'ADMIN'] = args.filter((a) => !a.startsWith('--'));
  const role = roleArg.toUpperCase();
  if (
    !email ||
    !outputPath ||
    (role !== 'ADMIN' && role !== 'MINISTRY') ||
    (existingInstallation && role !== 'ADMIN') ||
    args.some((a) => a.startsWith('--') && a !== '--existing-installation')
  ) {
    console.error(
      'Usage: bootstrap-admin.js EMAIL PRIVATE_OUTPUT_PATH [ADMIN|MINISTRY]\n' +
        '       bootstrap-admin.js EMAIL PRIVATE_OUTPUT_PATH ADMIN --existing-installation',
    );
    process.exitCode = 1;
    await pool.end();
  } else {
    try {
      await bootstrapAdmin(
        email,
        outputPath,
        role,
        existingInstallation ? 'existing-installation' : 'first-install',
      );
      console.log(
        `${existingInstallation ? 'Platform' : 'First'} administrator invited; private activation file saved. No email sent.`,
      );
    } catch {
      // Never include the token, database connection string or query details in command output.
      console.error(
        existingInstallation
          ? 'Administrator setup failed. It is refused while an active platform administrator exists or another account uses this e-mail address.'
          : 'First-admin setup failed. Check the account state and private output path.',
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
