import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { legalAcceptances, legalDocuments, platformSettings } from '../../db/schema.js';
import type { LegalKind, LegalLocale } from './legal-templates.js';

/** Every kind of legal text the administrator drafts, publishes and versions. */
export const LEGAL_KINDS = [
  'TERMS',
  'PRIVACY',
  'SERVICE_AGREEMENT',
  'DPA',
] as const satisfies readonly LegalKind[];
/**
 * The texts every user accepts at sign-in (the legal gate). The service agreement and the data
 * processing agreement are accepted once per facility by a director and never gate anyone, so
 * they must never be added here.
 */
export const USER_LEGAL_KINDS = ['TERMS', 'PRIVACY'] as const satisfies readonly LegalKind[];
/**
 * The agreements a facility accepts once, through one of its directors (organization_acceptances).
 * A missing acceptance shows a notice to the directors and blocks nothing (H74).
 */
export const ORGANIZATION_LEGAL_KINDS = [
  'SERVICE_AGREEMENT',
  'DPA',
] as const satisfies readonly LegalKind[];
export type OrganizationLegalKind = (typeof ORGANIZATION_LEGAL_KINDS)[number];
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

/**
 * Fills the operator details into a legal text ("—" where a detail is not set), in one pass: a
 * value is inserted as it is, even if it looks like a placeholder itself.
 */
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

/**
 * Whether the user has accepted the latest version of a kind that asked for acceptance, or a
 * version published after it. Versions are ordered by their first publication, as for the current
 * version. True when no version ever asked for acceptance.
 */
async function acceptedLatestRequired(
  userId: string,
  kind: LegalKind,
  executor: Executor,
): Promise<boolean> {
  const { rows } = await executor.execute<{ satisfied: boolean }>(sql`
    WITH versions AS (
      SELECT version, min(published_at) AS first, bool_or(requires_acceptance) AS requires
        FROM ${legalDocuments}
       WHERE kind = ${kind} AND published_at IS NOT NULL
       GROUP BY version
    ), required AS (
      SELECT max(first) AS since FROM versions WHERE requires
    )
    SELECT (SELECT since FROM required) IS NULL OR EXISTS (
      SELECT 1
        FROM ${legalAcceptances} a
        JOIN versions v ON v.version = a.version
       WHERE a.user_id = ${userId} AND a.kind = ${kind}
         AND v.first >= (SELECT since FROM required)
    ) AS satisfied
  `);
  return Boolean(rows[0]?.satisfied);
}

/**
 * Current versions this user still has to accept, in their language. A current version that asks
 * for acceptance is pending until it is accepted. One that does not (say, a typo correction) is
 * still pending for a user who never accepted the latest version that did, e.g. an account
 * created since: otherwise nobody new would ever agree to the terms. Accepting the current
 * version satisfies both.
 */
export async function pendingDocuments(
  userId: string,
  locale: string,
  executor: Executor = db,
): Promise<CurrentDocument[]> {
  const pending: CurrentDocument[] = [];
  for (const kind of USER_LEGAL_KINDS) {
    const current = await currentDocument(kind, locale, executor);
    if (current && !(await acceptedLatestRequired(userId, kind, executor))) pending.push(current);
  }
  return pending;
}

/**
 * A legal document as shown to readers. Publishing writes the operator details into the text and
 * keeps the text as written beside it (the source), so a published text with a source is shown
 * exactly as stored: it reads as it was accepted whatever the settings say today, even where a
 * value written into it looks like a placeholder. Only texts published before the details were
 * written in (no source) still hold placeholders, which are filled from the current settings.
 */
export function presentDocument(c: CurrentDocument, s: Settings) {
  const legacy = c.doc.bodySource === null;
  return {
    id: c.doc.id,
    kind: c.doc.kind,
    version: c.version,
    locale: c.doc.locale,
    title: legacy ? fillPlaceholders(c.doc.title, s) : c.doc.title,
    body: legacy ? fillPlaceholders(c.doc.body, s) : c.doc.body,
    publishedAt: c.doc.publishedAt,
    requiresAcceptance: c.requiresAcceptance,
  };
}
