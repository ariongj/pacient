/**
 * Demo operator settings, the published terms of use and privacy notice (accepted by the demo
 * accounts) and demo versions of the service agreement and the data processing agreement, which
 * no facility has accepted yet (development seed only). Safe to run again on an already-seeded
 * database: settings are filled only while still empty, and each kind of document (with the
 * acceptances that go with it) is created only when its version 1.0 does not exist yet.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { LEGAL_TEMPLATES, REVIEW_NOTES } from '../modules/platform/legal-templates.js';
import { fillPlaceholders, getSettings } from '../modules/platform/platform.service.js';
import { db } from './client.js';
import { legalAcceptances, legalDocuments, platformSettings, users } from './schema.js';

const VERSION = '1.0';
const LOCALES = ['sq', 'sr', 'en'] as const;
const KINDS = ['TERMS', 'PRIVACY'] as const;
/** Accepted per facility by a director, not by every user. */
const AGREEMENTS = ['SERVICE_AGREEMENT', 'DPA'] as const;
/**
 * Replaces the lawyer-review note of the agreement templates in the demo: these are demo texts
 * of a synthetic installation, never a real agreement.
 */
const DEMO_NOTES: Record<(typeof LOCALES)[number], string> = {
  en: 'Demo text of a synthetic installation – not a real agreement and not reviewed by a lawyer.',
  sq: 'Tekst demo i një instalimi sintetik – nuk është marrëveshje e vërtetë dhe nuk është rishikuar nga një jurist.',
  sr: 'Demo tekst sintetičke instalacije – nije pravi ugovor i nije ga pregledao pravnik.',
};

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
  await db
    .update(platformSettings)
    .set({ supportHours: 'E hënë–e premte 08:00–16:00 / Pon–pet 08:00–16:00' })
    .where(and(eq(platformSettings.id, 1), isNull(platformSettings.supportHours)));

  const settings = await getSettings();
  const publishedAt = new Date();
  const exists = async (kind: (typeof KINDS | typeof AGREEMENTS)[number]) => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(legalDocuments)
      .where(and(eq(legalDocuments.kind, kind), eq(legalDocuments.version, VERSION)));
    return (row?.count ?? 0) > 0;
  };
  // Published as the API publishes: with the operator details written into the text, and the
  // text as written (with its placeholders) kept for the next version to start from.
  const publish = (
    kind: (typeof KINDS | typeof AGREEMENTS)[number],
    text: (locale: (typeof LOCALES)[number], part: 'title' | 'body') => string,
  ) =>
    db.insert(legalDocuments).values(
      LOCALES.map((locale) => ({
        kind,
        version: VERSION,
        locale,
        title: fillPlaceholders(text(locale, 'title'), settings),
        body: fillPlaceholders(text(locale, 'body'), settings),
        titleSource: text(locale, 'title'),
        bodySource: text(locale, 'body'),
        requiresAcceptance: true,
        publishedAt,
        createdById: opts.adminId,
      })),
    );

  for (const kind of AGREEMENTS) {
    if (await exists(kind)) continue;
    await publish(kind, (locale, part) =>
      LEGAL_TEMPLATES[kind][locale][part].replace(REVIEW_NOTES[locale], DEMO_NOTES[locale]),
    );
  }

  if (await exists('TERMS')) return;
  for (const kind of KINDS) {
    await publish(kind, (locale, part) => LEGAL_TEMPLATES[kind][locale][part]);
  }

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
