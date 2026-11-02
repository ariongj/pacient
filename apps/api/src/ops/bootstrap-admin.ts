/** First-install invitation only; no default passwords, no outbound mail, no token logging. */
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db, pool } from '../db/client.js';
import { oneTimeTokens, users } from '../db/schema.js';
import { generateOpaqueToken, hashToken } from '../lib/tokens.js';
import { audit, AuditAction } from '../modules/audit/audit.service.js';

export async function bootstrapAdmin(email: string, outputPath: string): Promise<void> {
  const normalized = z.email().parse(email).toLowerCase();
  // Reserve a protected destination before creating the account. Never overwrite a handoff.
  const output = await open(outputPath, 'wx', 0o600);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(4180271)`);
      if ((await tx.select({ id: users.id }).from(users).limit(1)).length) {
        throw new Error('First-admin setup refused: users already exist');
      }
      const [user] = await tx
        .insert(users)
        .values({ email: normalized, fullName: 'Administrator', role: 'MINISTRY', facilityId: null })
        .returning();
      if (!user) throw new Error('Could not create the first administrator');
      const token = generateOpaqueToken();
      await tx.insert(oneTimeTokens).values({
        userId: user.id,
        purpose: 'ACCOUNT_ACTIVATION',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 72 * 3_600_000),
        createdById: user.id,
      });
      await audit(
        {
          action: AuditAction.USER_INVITED,
          actor: { userId: user.id, role: 'MINISTRY', facilityId: null },
          resourceType: 'user',
          resourceId: user.id,
          metadata: { source: 'owner-authorized-first-install' },
        },
        tx,
      );
      const url = new URL(`${env.WEB_APP_URL.replace(/\/$/, '')}/activate`);
      url.searchParams.set('token', token);
      await output.writeFile(`${url.href}\n`, 'utf8');
      await output.sync();
    });
  } finally {
    await output.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [email, outputPath] = process.argv.slice(2);
  if (!email || !outputPath) {
    console.error('Usage: bootstrap-admin.js EMAIL PRIVATE_OUTPUT_PATH');
    process.exitCode = 1;
    await pool.end();
  } else {
    try {
      await bootstrapAdmin(email, outputPath);
      console.log('First administrator invited; private activation file saved. No email sent.');
    } catch {
      // Never include the token, database connection string or query details in command output.
      console.error('First-admin setup failed. Check the account state and private output path.');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
