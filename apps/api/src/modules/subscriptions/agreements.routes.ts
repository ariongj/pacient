import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  facilities,
  legalDocuments,
  organizationAcceptances,
  subscriptions,
  users,
} from '../../db/schema.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  currentDocument,
  currentVersion,
  getSettings,
  LEGAL_LOCALES,
  ORGANIZATION_LEGAL_KINDS,
  presentDocument,
  type OrganizationLegalKind,
} from '../platform/platform.service.js';

/**
 * The service agreement and the data processing agreement, accepted once per facility by a
 * director (organization_acceptances). Nothing is ever blocked by a missing acceptance: directors
 * of a customer see a notice, the administrator a list (H74). Round 2, builder G.
 *
 * `agreementsDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET  /subscription/agreements
 *   POST /subscription/agreements/:documentId/accept – signer name and title as typed; audited
 *        legal.organization_accepted in the same transaction.
 *
 * `agreementsAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   GET /admin/organizations/:facilityId/agreements – acceptances of one facility.
 *   GET /admin/agreements/missing – facilities without the current agreements (AdminHome), with
 *       the current versions and how many customers are up to date (Terms and privacy page).
 *   GET /admin/agreements/acceptances?kind&version – which facilities accepted a version.
 */
export const agreementsDirectorRouter = Router();
export const agreementsAdminRouter = Router();

/**
 * The operator's customers: active facilities whose subscription has not ended. They are the
 * ones the agreements are with and the only ones asked to accept them: the directors' notice and
 * the administrator's list and counts follow this one rule. A facility without a subscription
 * (say, one the Ministry runs, or one whose subscription has not started yet), or whose
 * subscription was cancelled or expired, is not asked, but may still accept on its subscription
 * page.
 */
const CUSTOMER_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'] as const;

const isCustomer = and(
  eq(facilities.isActive, true),
  inArray(subscriptions.status, [...CUSTOMER_STATUSES]),
);

/** Whether a facility is a customer now (see CUSTOMER_STATUSES). */
async function customer(facilityId: string) {
  const [row] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .innerJoin(subscriptions, eq(subscriptions.facilityId, facilities.id))
    .where(and(eq(facilities.id, facilityId), isCustomer))
    .limit(1);
  return Boolean(row);
}

const acceptedBy = sql<string>`(SELECT full_name FROM users u WHERE u.id = ${organizationAcceptances.acceptedById})`;
const acceptanceColumns = {
  id: organizationAcceptances.id,
  kind: organizationAcceptances.kind,
  version: organizationAcceptances.version,
  locale: legalDocuments.locale,
  signerName: organizationAcceptances.signerName,
  signerTitle: organizationAcceptances.signerTitle,
  acceptedByName: acceptedBy,
  acceptedAt: organizationAcceptances.acceptedAt,
};

/**
 * Which of the given facilities still have to accept the current version of a kind: those that
 * accepted neither the latest version that asked for acceptance nor a version published after
 * it. Versions are ordered by their first publication, as for the users' terms of use: a later
 * version for information only (a typo correction) does not ask again those who accepted, but a
 * facility that never accepted accepts the current one. Nothing published, or no version ever
 * asked: nobody is pending.
 */
async function pendingFacilities(
  kind: OrganizationLegalKind,
  facilityIds: string[],
  executor: Executor = db,
): Promise<Set<string>> {
  if (!facilityIds.length) return new Set();
  const { rows } = await executor.execute<{ id: string }>(sql`
    WITH versions AS (
      SELECT version, min(published_at) AS first, bool_or(requires_acceptance) AS requires
        FROM ${legalDocuments}
       WHERE kind = ${kind} AND published_at IS NOT NULL
       GROUP BY version
    ), required AS (
      SELECT max(first) AS since FROM versions WHERE requires
    )
    SELECT f.id
      FROM ${facilities} f
     WHERE f.id IN (${sql.join(
       facilityIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND (SELECT since FROM required) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM ${organizationAcceptances} a
           JOIN versions v ON v.version = a.version
          WHERE a.facility_id = f.id AND a.kind = ${kind}
            AND v.first >= (SELECT since FROM required)
       )
  `);
  return new Set(rows.map((r) => r.id));
}

/** Whether the current version of a kind asks facilities to accept it (any translation asks). */
async function currentAsks(kind: OrganizationLegalKind, version: string | null) {
  if (!version) return false;
  const [row] = await db
    .select({ asks: sql<boolean>`bool_or(${legalDocuments.requiresAcceptance})` })
    .from(legalDocuments)
    .where(
      and(
        eq(legalDocuments.kind, kind),
        eq(legalDocuments.version, version),
        isNotNull(legalDocuments.publishedAt),
      ),
    );
  return Boolean(row?.asks);
}

async function acceptancesOf(facilityId: string) {
  return db
    .select(acceptanceColumns)
    .from(organizationAcceptances)
    .innerJoin(legalDocuments, eq(legalDocuments.id, organizationAcceptances.documentId))
    .where(eq(organizationAcceptances.facilityId, facilityId))
    .orderBy(desc(organizationAcceptances.acceptedAt));
}

/**
 * Where a facility stands with each agreement: the current version, whether the facility still
 * has to accept it, and its acceptances (newest first). With `locale`, the current text in that
 * language for the director to read. `asked`: the facility is a customer, so its directors see
 * the notice while an agreement is pending; `pending` counts the agreements still to accept, for a
 * customer only (as in the administrator's list). Any facility can accept on its subscription
 * page.
 */
async function facilityAgreements(facilityId: string, locale?: string) {
  const settings = locale ? await getSettings() : null;
  const history = await acceptancesOf(facilityId);
  const asked = await customer(facilityId);
  const agreements = [];
  for (const kind of ORGANIZATION_LEGAL_KINDS) {
    const version = await currentVersion(kind);
    const current = locale && version ? await currentDocument(kind, locale) : null;
    const pending = (await pendingFacilities(kind, [facilityId])).has(facilityId);
    const acceptances = history.filter((a) => a.kind === kind);
    agreements.push({
      kind,
      currentVersion: version,
      requiresAcceptance: await currentAsks(kind, version),
      pending,
      /** The facility's acceptance of the current version, if any (in any language). */
      acceptedCurrent: acceptances.find((a) => a.version === version) ?? null,
      acceptances,
      ...(locale
        ? { document: current && settings ? presentDocument(current, settings) : null }
        : {}),
    });
  }
  return { agreements, asked, pending: asked ? agreements.filter((a) => a.pending).length : 0 };
}

/* ------------------------------------------------------------------ directors ---------------- */

function ownFacility(req: Parameters<typeof requireAuth>[0]) {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  return { ctx, facilityId: ctx.facilityId };
}

const LocaleQuery = z.object({ locale: z.enum(LEGAL_LOCALES).optional() });

/** The director's language unless the page asks for another one. */
async function localeOf(userId: string, requested?: string) {
  if (requested) return requested;
  const [u] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  return u?.locale ?? 'sq';
}

async function directorView(facilityId: string, locale: string) {
  const [facility] = await db
    .select({ id: facilities.id, name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  return { facility: facility ?? null, ...(await facilityAgreements(facilityId, locale)) };
}

agreementsDirectorRouter.get('/agreements', async (req, res) => {
  const { ctx, facilityId } = ownFacility(req);
  const { locale } = parse(LocaleQuery, req.query);
  res.json(await directorView(facilityId, await localeOf(ctx.userId, locale)));
});

const DocumentParam = z.object({ documentId: z.string().uuid() });
const AcceptInput = z.object({
  signerName: z.string().trim().min(2).max(200),
  signerTitle: z.string().trim().min(2).max(200),
});

/**
 * Accept the current version of an agreement for the director's facility. The signer's name and
 * title are typed (the director may sign for the facility under another title than their role).
 * Accepting a version the facility already accepted, in any language, changes nothing.
 */
agreementsDirectorRouter.post('/agreements/:documentId/accept', async (req, res) => {
  const { ctx, facilityId } = ownFacility(req);
  const { documentId } = parse(DocumentParam, req.params);
  const { locale } = parse(LocaleQuery, req.query);
  const input = parse(AcceptInput, req.body);
  const meta = requestMeta(req);
  const [doc] = await db.select().from(legalDocuments).where(eq(legalDocuments.id, documentId));
  const kind = doc?.kind as OrganizationLegalKind | undefined;
  if (!doc || !doc.publishedAt || !kind || !ORGANIZATION_LEGAL_KINDS.includes(kind)) {
    throw notFound('Agreement not found');
  }
  if ((await currentVersion(kind)) !== doc.version) {
    throw conflict('This is not the current version. Reload the page and read the current text.');
  }
  const created = await db.transaction(async (tx) => {
    // One acceptance per version and facility: two directors accepting at once (perhaps in two
    // languages) wait for each other here, and the second finds the first.
    await tx
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.id, facilityId))
      .for('update');
    const [existing] = await tx
      .select({ id: organizationAcceptances.id })
      .from(organizationAcceptances)
      .where(
        and(
          eq(organizationAcceptances.facilityId, facilityId),
          eq(organizationAcceptances.kind, kind),
          eq(organizationAcceptances.version, doc.version),
        ),
      );
    if (existing) return false;
    const [row] = await tx
      .insert(organizationAcceptances)
      .values({
        facilityId,
        documentId: doc.id,
        kind,
        version: doc.version,
        acceptedById: ctx.userId,
        signerName: input.signerName,
        signerTitle: input.signerTitle,
        ip: meta.ipAddress?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .returning({ id: organizationAcceptances.id });
    await audit(
      {
        action: AuditAction.LEGAL_ORGANIZATION_ACCEPTED,
        actor: ctx,
        resourceType: 'legal_document',
        resourceId: doc.id,
        meta,
        metadata: {
          kind,
          version: doc.version,
          locale: doc.locale,
          facilityId,
          acceptanceId: row!.id,
        },
      },
      tx,
    );
    return true;
  });
  res
    .status(created ? 201 : 200)
    .json(await directorView(facilityId, await localeOf(ctx.userId, locale)));
});

/* ------------------------------------------------------------------ administrator ------------ */

const FacilityParam = z.object({ facilityId: z.string().uuid() });

agreementsAdminRouter.get('/organizations/:facilityId/agreements', async (req, res) => {
  const { facilityId } = parse(FacilityParam, req.params);
  const [facility] = await db
    .select({ id: facilities.id, name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  if (!facility) throw notFound('Facility not found');
  res.json({ facility, ...(await facilityAgreements(facilityId)) });
});

/**
 * The customers that have not accepted the current agreements, for the overview; with the
 * current versions and, per kind, how many customers are up to date (Terms and privacy page).
 */
agreementsAdminRouter.get('/agreements/missing', async (_req, res) => {
  const customers = await db
    .select({
      facilityId: facilities.id,
      facilityName: facilities.name,
      facilityCode: facilities.code,
      subscriptionStatus: subscriptions.status,
    })
    .from(facilities)
    .innerJoin(subscriptions, eq(subscriptions.facilityId, facilities.id))
    .where(isCustomer)
    .orderBy(asc(facilities.name));
  const ids = customers.map((c) => c.facilityId);
  const kinds = [];
  const pendingByKind = new Map<OrganizationLegalKind, Set<string>>();
  for (const kind of ORGANIZATION_LEGAL_KINDS) {
    const version = await currentVersion(kind);
    const pending = await pendingFacilities(kind, ids);
    pendingByKind.set(kind, pending);
    kinds.push({
      kind,
      currentVersion: version,
      requiresAcceptance: await currentAsks(kind, version),
      upToDate: ids.length - pending.size,
      pending: pending.size,
    });
  }
  const items = customers
    .map((c) => ({
      ...c,
      missing: ORGANIZATION_LEGAL_KINDS.filter((k) => pendingByKind.get(k)!.has(c.facilityId)),
    }))
    .filter((c) => c.missing.length > 0);
  res.json({ customers: ids.length, kinds, items });
});

const AcceptancesQuery = z.object({
  kind: z.enum(ORGANIZATION_LEGAL_KINDS),
  version: z.string().trim().min(1).max(20),
});

/** Which facilities accepted a version, who signed and when (the latest 50). */
agreementsAdminRouter.get('/agreements/acceptances', async (req, res) => {
  const { kind, version } = parse(AcceptancesQuery, req.query);
  const where = and(
    eq(organizationAcceptances.kind, kind),
    eq(organizationAcceptances.version, version),
  );
  const [count] = await db
    .select({ accepted: sql<number>`count(DISTINCT ${organizationAcceptances.facilityId})::int` })
    .from(organizationAcceptances)
    .where(where);
  const latest = await db
    .select({
      ...acceptanceColumns,
      facilityId: facilities.id,
      facilityName: facilities.name,
    })
    .from(organizationAcceptances)
    .innerJoin(legalDocuments, eq(legalDocuments.id, organizationAcceptances.documentId))
    .innerJoin(facilities, eq(facilities.id, organizationAcceptances.facilityId))
    .where(where)
    .orderBy(desc(organizationAcceptances.acceptedAt))
    .limit(50);
  res.json({ kind, version, accepted: count?.accepted ?? 0, latest });
});
