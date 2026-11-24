/**
 * Demo operator settings and published terms of use and privacy notice, accepted by the demo
 * accounts (development seed only). Safe to run again on an already-seeded database: settings are
 * filled only while still empty, and documents (and the acceptances that go with them) are created
 * only when version 1.0 does not exist yet.
 */
import { and, eq, sql } from 'drizzle-orm';
import { LEGAL_TEMPLATES } from '../modules/platform/legal-templates.js';
import { fillPlaceholders, getSettings } from '../modules/platform/platform.service.js';
import { db } from './client.js';
import { legalAcceptances, legalDocuments, platformSettings, users } from './schema.js';

const VERSION = '1.0';
const LOCALES = ['sq', 'sr', 'en'] as const;
const KINDS = ['TERMS', 'PRIVACY'] as const;

export async function seedPlatform(opts: { adminId: string }) {
  await db.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();
  // Clearly synthetic operator details: never a real company, account or address.
  await db
    .update(platformSettings)
    .set({
      operatorName: 'Pacient Demo SH.P.K. (demo)',
      operatorAddress: 'Rr. Agim Ramadani 15, 10000 Prishtinë',
      operatorFiscalNumber: '810000000',
      operatorIban: 'XK05 1212 0123 4567 8906',
      operatorBank: 'Demo Bank',
      supportEmail: 'support@pacient.local',
      supportPhone: '+383 38 000 000',
      privacyEmail: 'privacy@pacient.local',
      updatedById: opts.adminId,
      updatedAt: new Date(),
    })
    .where(and(eq(platformSettings.id, 1), eq(platformSettings.operatorName, '')));

  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(legalDocuments)
    .where(eq(legalDocuments.version, VERSION));
  if ((existing?.count ?? 0) > 0) return;

  // Published as the API publishes: with the operator details written into the text.
  const settings = await getSettings();
  const publishedAt = new Date();
  await db.insert(legalDocuments).values(
    KINDS.flatMap((kind) =>
      LOCALES.map((locale) => ({
        kind,
        version: VERSION,
        locale,
        title: fillPlaceholders(LEGAL_TEMPLATES[kind][locale].title, settings),
        body: fillPlaceholders(LEGAL_TEMPLATES[kind][locale].body, settings),
        requiresAcceptance: true,
        publishedAt,
        createdById: opts.adminId,
      })),
    ),
  );

  // The demo accounts that exist now have accepted version 1.0; accounts created later (a new
  // patient activating the portal, a newly invited colleague) accept it at their first sign-in.
  const everyone = await db.select({ id: users.id, locale: users.locale }).from(users);
  const rows = everyone.flatMap((u) =>
    KINDS.map((kind) => ({
      userId: u.id,
      kind,
      version: VERSION,
      locale: (LOCALES as readonly string[]).includes(u.locale) ? u.locale : 'sq',
      acceptedAt: publishedAt,
    })),
  );
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(legalAcceptances)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing();
  }
}
