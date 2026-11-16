import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { legalAcceptances, legalDocuments, platformSettings } from '../../db/schema.js';
import type { LegalKind, LegalLocale } from './legal-templates.js';

export const LEGAL_KINDS = ['TERMS', 'PRIVACY'] as const satisfies readonly LegalKind[];
export const LEGAL_LOCALES = ['sq', 'sr', 'en'] as const satisfies readonly LegalLocale[];

export type Settings = typeof platformSettings.$inferSelect;
export type LegalDocumentRow = typeof legalDocuments.$inferSelect;

/** The single settings row (created by the migration; recreated if it was ever removed). */
export async function getSettings(executor: Executor = db): Promise<Settings> {
  const [row] = await executor.select().from(platformSettings).where(eq(platformSettings.id, 1));
  if (row) return row;
  await executor.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();
  const [created] = await executor
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, 1));
  return created!;
}

/** Operator details a legal text may refer to, e.g. "{privacyEmail}". */
export const PLACEHOLDERS = [
  'operatorName',
  'operatorAddress',
  'supportEmail',
  'supportPhone',
  'privacyEmail',
] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];
const PLACEHOLDER_RE = /\{(operatorName|operatorAddress|supportEmail|supportPhone|privacyEmail)\}/g;

const settingValue = (s: Settings, key: Placeholder) => (s[key] ?? '').trim();

/** Placeholders used in a text whose operator setting is still empty. */
export function missingPlaceholders(text: string, s: Settings): Placeholder[] {
  const used = new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as Placeholder));
  return [...used].filter((k) => !settingValue(s, k));
}

/** Fills the operator details into a legal text ("—" where a detail is not set). */
export function fillPlaceholders(text: string, s: Settings): string {
  return text.replace(PLACEHOLDER_RE, (_, key: Placeholder) => settingValue(s, key) || '—');
}

/** The notice to all users while it is set and has not expired. */
export function activeNotice(s: Settings, now = new Date()) {
  if (!s.noticeText?.trim()) return null;
  if (s.noticeUntil && s.noticeUntil <= now) return null;
  return {
    text: s.noticeText,
    tone: s.noticeTone === 'WARNING' ? ('WARNING' as const) : ('INFO' as const),
    until: s.noticeUntil,
  };
}

/**
 * The current version of a kind: the version first published most recently. (Publishing a
 * late translation of an older version does not make that version current again.)
 */
export async function currentVersion(
  kind: LegalKind,
  executor: Executor = db,
): Promise<string | null> {
  const rows = await executor
    .select({
      version: legalDocuments.version,
      first: sql<Date>`min(${legalDocuments.publishedAt})`.as('first'),
    })
    .from(legalDocuments)
    .where(and(eq(legalDocuments.kind, kind), isNotNull(legalDocuments.publishedAt)))
    .groupBy(legalDocuments.version)
    .orderBy(sql`min(${legalDocuments.publishedAt}) DESC`)
    .limit(1);
  return rows[0]?.version ?? null;
}

export interface CurrentDocument {
  doc: LegalDocumentRow;
  version: string;
  /** A version must be accepted when any of its published translations asks for it. */
  requiresAcceptance: boolean;
}

/** The published text of the current version in the preferred language (else sq, en, any). */
export async function currentDocument(
  kind: LegalKind,
  locale: string,
  executor: Executor = db,
): Promise<CurrentDocument | null> {
  const version = await currentVersion(kind, executor);
  if (!version) return null;
  const docs = await executor
    .select()
    .from(legalDocuments)
    .where(
      and(
        eq(legalDocuments.kind, kind),
        eq(legalDocuments.version, version),
        isNotNull(legalDocuments.publishedAt),
      ),
    );
  const doc =
    [locale, 'sq', 'en'].map((l) => docs.find((d) => d.locale === l)).find(Boolean) ?? docs[0];
  if (!doc) return null;
  return { doc, version, requiresAcceptance: docs.some((d) => d.requiresAcceptance) };
}

/** Current versions this user still has to accept, in their language. */
export async function pendingDocuments(
  userId: string,
  locale: string,
  executor: Executor = db,
): Promise<CurrentDocument[]> {
  const current = (
    await Promise.all(LEGAL_KINDS.map((kind) => currentDocument(kind, locale, executor)))
  ).filter((c): c is CurrentDocument => Boolean(c?.requiresAcceptance));
  if (!current.length) return [];
  const accepted = await executor
    .select({ kind: legalAcceptances.kind, version: legalAcceptances.version })
    .from(legalAcceptances)
    .where(
      and(
        eq(legalAcceptances.userId, userId),
        inArray(
          legalAcceptances.kind,
          current.map((c) => c.doc.kind),
        ),
      ),
    );
  return current.filter(
    (c) => !accepted.some((a) => a.kind === c.doc.kind && a.version === c.version),
  );
}

/** A legal document as shown to readers: placeholders filled. */
export function presentDocument(c: CurrentDocument, s: Settings) {
  return {
    id: c.doc.id,
    kind: c.doc.kind,
    version: c.version,
    locale: c.doc.locale,
    title: fillPlaceholders(c.doc.title, s),
    body: fillPlaceholders(c.doc.body, s),
    publishedAt: c.doc.publishedAt,
    requiresAcceptance: c.requiresAcceptance,
  };
}
