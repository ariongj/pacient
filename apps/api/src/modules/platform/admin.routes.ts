import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  auditLogs,
  facilities,
  invoices,
  legalAcceptances,
  legalDocuments,
  platformSettings,
  subscriptionEvents,
  subscriptionPlans,
  subscriptions,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { LEGAL_TEMPLATES } from './legal-templates.js';
import {
  currentVersion,
  getSettings,
  LEGAL_KINDS,
  LEGAL_LOCALES,
  missingPlaceholders,
  type Settings,
} from './platform.service.js';

/**
 * Overview, operator settings, terms and privacy notice, and the administrative audit trail for
 * the platform administrator (mounted on /admin, ADMIN only): /overview, /settings, /legal, /audit.
 * Nothing here reads clinical data: counts of accounts and subscriptions, money, texts and logs.
 */
export const adminPlatformRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const n = (v: unknown) => Number(v ?? 0);

/* ------------------------------------------------------------------ overview ---------------- */

const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
] as const;

/** Administrative actions shown on the overview and in the audit view. */
const CATEGORY_FILTERS: Record<'users' | 'billing' | 'platform', SQL> = {
  users: or(
    like(auditLogs.action, 'admin.user.%'),
    inArray(auditLogs.action, [
      AuditAction.USER_INVITED,
      AuditAction.USER_DEACTIVATED,
      AuditAction.USER_REACTIVATED,
    ]),
  )!,
  // Only the operator's billing (plans, subscriptions, invoices): the facilities' own patient
  // billing (co-payments, claims) also writes billing.* actions and is not administration.
  billing: or(
    like(auditLogs.action, 'billing.plan.%'),
    like(auditLogs.action, 'billing.subscription.%'),
    like(auditLogs.action, 'billing.invoice.%'),
  )!,
  // Acceptances by users (legal.accepted) are not administrative actions: see /legal/acceptances.
  platform: or(like(auditLogs.action, 'platform.%'), like(auditLogs.action, 'legal.document.%'))!,
};

adminPlatformRouter.get('/overview', async (_req, res) => {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  const [counts] = (
    await db.execute<Record<string, string | number>>(sql`
      SELECT
        (SELECT count(*) FROM facilities WHERE is_active) AS facilities_total,
        (SELECT count(*) FROM subscriptions) AS with_subscription,
        (SELECT count(*) FROM users WHERE role NOT IN ('PATIENT', 'ADMIN') AND is_active
           AND password_hash IS NOT NULL) AS active_staff,
        (SELECT count(*) FROM users WHERE role NOT IN ('PATIENT', 'ADMIN') AND is_active
           AND password_hash IS NULL) AS pending_activation,
        (SELECT count(*) FROM users WHERE locked_until > now()) AS locked,
        (SELECT count(*) FROM users WHERE role NOT IN ('PATIENT', 'ADMIN') AND is_active
           AND password_hash IS NOT NULL AND mfa_enabled_at IS NULL) AS staff_without_two_step,
        (SELECT count(*) FROM users WHERE role = 'PATIENT' AND is_active
           AND password_hash IS NOT NULL) AS patient_accounts,
        (SELECT count(*) FROM users WHERE role = 'ADMIN' AND is_active) AS admins,
        (SELECT coalesce(sum(CASE WHEN billing_cycle = 'YEARLY' THEN round(price_cents / 12.0)
                                  ELSE price_cents END), 0)
           FROM subscriptions WHERE status IN ('ACTIVE', 'PAST_DUE') AND currency = 'EUR') AS mrr,
        (SELECT coalesce(sum(total_cents), 0) FROM invoices
           WHERE status = 'OPEN' AND currency = 'EUR') AS open_cents,
        (SELECT coalesce(sum(total_cents), 0) FROM invoices
           WHERE status = 'OPEN' AND currency = 'EUR' AND due_at < now()) AS overdue_cents,
        (SELECT count(*) FROM invoices
           WHERE status = 'OPEN' AND due_at < now()) AS overdue_count
    `)
  ).rows;
  const byStatusRows = await db
    .select({ status: subscriptions.status, count: sql<number>`count(*)::int` })
    .from(subscriptions)
    .groupBy(subscriptions.status);
  const byStatus = Object.fromEntries(
    SUBSCRIPTION_STATUSES.map((s) => [s, byStatusRows.find((r) => r.status === s)?.count ?? 0]),
  ) as Record<(typeof SUBSCRIPTION_STATUSES)[number], number>;

  const renewals = await db
    .select({
      subscriptionId: subscriptions.id,
      facilityId: facilities.id,
      facilityName: facilities.name,
      planName: subscriptionPlans.name,
      status: subscriptions.status,
      date: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      priceCents: subscriptions.priceCents,
      billingCycle: subscriptions.billingCycle,
      currency: subscriptions.currency,
    })
    .from(subscriptions)
    .innerJoin(facilities, eq(facilities.id, subscriptions.facilityId))
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(
      and(
        inArray(subscriptions.status, ['TRIAL', 'ACTIVE', 'PAST_DUE']),
        lte(subscriptions.currentPeriodEnd, in30),
      ),
    )
    .orderBy(asc(subscriptions.currentPeriodEnd))
    .limit(20);

  const actor = alias(users, 'event_actor');
  const recentEvents = await db
    .select({
      id: subscriptionEvents.id,
      type: subscriptionEvents.type,
      facilityId: subscriptionEvents.facilityId,
      facilityName: facilities.name,
      fromStatus: subscriptionEvents.fromStatus,
      toStatus: subscriptionEvents.toStatus,
      note: subscriptionEvents.note,
      actorName: actor.fullName,
      createdAt: subscriptionEvents.createdAt,
    })
    .from(subscriptionEvents)
    .innerJoin(facilities, eq(facilities.id, subscriptionEvents.facilityId))
    .leftJoin(actor, eq(actor.id, subscriptionEvents.actorId))
    .orderBy(desc(subscriptionEvents.createdAt))
    .limit(10);

  const c = counts ?? {};
  res.json({
    generatedAt: now,
    facilities: {
      total: n(c.facilities_total),
      withSubscription: n(c.with_subscription),
      byStatus,
    },
    users: {
      activeStaff: n(c.active_staff),
      pendingActivation: n(c.pending_activation),
      locked: n(c.locked),
      staffWithoutTwoStep: n(c.staff_without_two_step),
      patientAccounts: n(c.patient_accounts),
      admins: n(c.admins),
    },
    revenue: {
      currency: 'EUR',
      mrrCents: n(c.mrr),
      openCents: n(c.open_cents),
      overdueCents: n(c.overdue_cents),
      overdueCount: n(c.overdue_count),
    },
    renewals,
    recentEvents,
    recentActions: await auditItems(
      or(CATEGORY_FILTERS.users, CATEGORY_FILTERS.billing, CATEGORY_FILTERS.platform)!,
      { limit: 10, offset: 0 },
    ),
  });
});

/* ------------------------------------------------------------------ settings ---------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .transform((v) => (v ? v : null))
    .optional();
const email = z
  .union([z.string().trim().max(254), z.null()])
  .refine((v) => !v || EMAIL_RE.test(v), 'Enter a valid e-mail address')
  .transform((v) => (v ? v.toLowerCase() : null))
  .optional();
const int = (min: number, max: number) => z.number().int().min(min).max(max).optional();

const SettingsInput = z
  .object({
    operatorName: text(200).optional(),
    operatorAddress: text(500).optional(),
    operatorFiscalNumber: nullableText(40),
    operatorVatNumber: nullableText(40),
    operatorIban: z
      .union([z.string(), z.null()])
      .transform((v) => (v ? v.toUpperCase().replace(/\s+/g, ' ').trim() : null))
      .refine(
        (v) =>
          !v ||
          (/^[A-Z]{2}\d{2}[A-Z0-9 ]+$/.test(v) &&
            v.replace(/ /g, '').length <= 34 &&
            v.length <= 40),
        'Enter the IBAN as printed by the bank, e.g. XK05 1212 0123 4567 8906',
      )
      .optional(),
    operatorBank: nullableText(120),
    supportEmail: email,
    supportPhone: nullableText(40),
    privacyEmail: email,
    invoicePrefix: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => /^[A-Z0-9-]{1,10}$/.test(v), 'Use 1–10 letters, digits or dashes')
      .optional(),
    paymentTermsDays: int(0, 120),
    vatRateBp: int(0, 5000),
    trialDays: int(0, 365),
    graceDays: int(0, 365),
    noticeText: nullableText(300),
    noticeTone: z.enum(['INFO', 'WARNING']).optional(),
    noticeUntil: z
      .union([z.string().datetime({ offset: true }), z.null()])
      .transform((v) => (v ? new Date(v) : null))
      .optional(),
  })
  .strict();

const comparable = (v: unknown) => (v instanceof Date ? v.getTime() : (v ?? null));

adminPlatformRouter.get('/settings', async (_req, res) => {
  res.json(await getSettings());
});

adminPlatformRouter.put('/settings', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(SettingsInput, req.body);
  const updated = await db.transaction(async (tx) => {
    const before = await getSettings(tx);
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ) as Partial<Settings>;
    const changed = Object.keys(patch).filter(
      (k) => comparable(patch[k as keyof Settings]) !== comparable(before[k as keyof Settings]),
    );
    if (!changed.length) return before;
    const [row] = await tx
      .update(platformSettings)
      .set({ ...patch, updatedById: ctx.userId, updatedAt: new Date() })
      .where(eq(platformSettings.id, 1))
      .returning();
    await audit(
      {
        action: AuditAction.PLATFORM_SETTINGS_UPDATED,
        actor: ctx,
        resourceType: 'platform_settings',
        meta: requestMeta(req),
        metadata: { fields: changed },
      },
      tx,
    );
    return row!;
  });
  res.json(updated);
});

/* ------------------------------------------------------------------ legal documents --------- */

const Kind = z.enum(LEGAL_KINDS);
const Locale = z.enum(LEGAL_LOCALES);
const Version = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/, 'Use a short version such as 1.0 or 2026-11');
const Title = z.string().trim().min(2).max(200);
const Body = z.string().trim().min(20).max(100_000);

const DocInput = z.object({
  kind: Kind,
  version: Version,
  locale: Locale,
  title: Title,
  body: Body,
  requiresAcceptance: z.boolean().default(true),
});
const DocPatch = z
  .object({ title: Title, body: Body, requiresAcceptance: z.boolean() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');

const docColumns = {
  id: legalDocuments.id,
  kind: legalDocuments.kind,
  version: legalDocuments.version,
  locale: legalDocuments.locale,
  title: legalDocuments.title,
  requiresAcceptance: legalDocuments.requiresAcceptance,
  publishedAt: legalDocuments.publishedAt,
  createdAt: legalDocuments.createdAt,
  updatedAt: legalDocuments.updatedAt,
  createdByName: users.fullName,
};

/**
 * Accounts that are asked to accept the texts: active, activated, and not the operator's own
 * administrators (they publish the texts; see /legal/status).
 */
const askedToAccept = and(
  eq(users.isActive, true),
  isNotNull(users.passwordHash),
  ne(users.role, 'ADMIN'),
)!;

async function activeAccounts() {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(askedToAccept);
  return row?.count ?? 0;
}

async function loadDocument(id: string) {
  const [doc] = await db.select().from(legalDocuments).where(eq(legalDocuments.id, id));
  if (!doc) throw notFound('Document not found');
  return doc;
}

/** Every version and translation, which versions are current, and how many accepted them. */
adminPlatformRouter.get('/legal', async (_req, res) => {
  const documents = await db
    .select(docColumns)
    .from(legalDocuments)
    .leftJoin(users, eq(users.id, legalDocuments.createdById))
    .orderBy(asc(legalDocuments.kind), desc(legalDocuments.createdAt), asc(legalDocuments.locale));
  const acceptance = await db
    .select({
      kind: legalAcceptances.kind,
      version: legalAcceptances.version,
      accepted: sql<number>`count(*)::int`,
    })
    .from(legalAcceptances)
    .innerJoin(users, eq(users.id, legalAcceptances.userId))
    .where(askedToAccept)
    .groupBy(legalAcceptances.kind, legalAcceptances.version);
  const settings = await getSettings();
  res.json({
    documents,
    current: {
      TERMS: await currentVersion('TERMS'),
      PRIVACY: await currentVersion('PRIVACY'),
    },
    acceptance,
    activeAccounts: await activeAccounts(),
    // Details the texts refer to that are still empty in the operator settings.
    missingSettings: (
      ['operatorName', 'operatorAddress', 'supportEmail', 'privacyEmail'] as const
    ).filter((k) => !(settings[k] ?? '').trim()),
  });
});

const TemplateQuery = z.object({ kind: Kind, locale: Locale });

/** A starting text (draft for legal review), with the {placeholders} left in. */
adminPlatformRouter.get('/legal/templates', async (req, res) => {
  const { kind, locale } = parse(TemplateQuery, req.query);
  res.json({ kind, locale, ...LEGAL_TEMPLATES[kind][locale] });
});

const AcceptanceQuery = z.object({ kind: Kind, version: Version });

/** Who accepted a version: count against active accounts, and the latest 50 acceptances. */
adminPlatformRouter.get('/legal/acceptances', async (req, res) => {
  const { kind, version } = parse(AcceptanceQuery, req.query);
  const where = and(
    eq(legalAcceptances.kind, kind),
    eq(legalAcceptances.version, version),
    askedToAccept,
  );
  const [count] = await db
    .select({ accepted: sql<number>`count(*)::int` })
    .from(legalAcceptances)
    .innerJoin(users, eq(users.id, legalAcceptances.userId))
    .where(where);
  const latest = await db
    .select({
      id: legalAcceptances.id,
      userName: users.fullName,
      role: users.role,
      locale: legalAcceptances.locale,
      acceptedAt: legalAcceptances.acceptedAt,
    })
    .from(legalAcceptances)
    .innerJoin(users, eq(users.id, legalAcceptances.userId))
    .where(where)
    .orderBy(desc(legalAcceptances.acceptedAt))
    .limit(50);
  res.json({
    kind,
    version,
    accepted: count?.accepted ?? 0,
    activeAccounts: await activeAccounts(),
    latest,
  });
});

adminPlatformRouter.get('/legal/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await loadDocument(id));
});

/** A new draft: a version of the terms of use or the privacy notice in one language. */
adminPlatformRouter.post('/legal', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(DocInput, req.body);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(legalDocuments)
      .values({ ...input, createdById: ctx.userId })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('This version already exists in this language');
    await audit(
      {
        action: AuditAction.LEGAL_DOCUMENT_SAVED,
        actor: ctx,
        resourceType: 'legal_document',
        resourceId: row.id,
        meta: requestMeta(req),
        metadata: { change: 'created', kind: row.kind, version: row.version, locale: row.locale },
      },
      tx,
    );
    return row;
  });
  res.status(201).json(created);
});

const PUBLISHED_FIXED = 'A published document cannot be changed. Create a new version instead.';

adminPlatformRouter.patch('/legal/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const patch = parse(DocPatch, req.body);
  const updated = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(legalDocuments)
      .where(eq(legalDocuments.id, id))
      .for('update');
    if (!doc) throw notFound('Document not found');
    if (doc.publishedAt) throw conflict(PUBLISHED_FIXED);
    const [row] = await tx
      .update(legalDocuments)
      .set(patch)
      .where(eq(legalDocuments.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.LEGAL_DOCUMENT_SAVED,
        actor: ctx,
        resourceType: 'legal_document',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { change: 'edited', fields: Object.keys(patch) },
      },
      tx,
    );
    return row!;
  });
  res.json(updated);
});

adminPlatformRouter.delete('/legal/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(legalDocuments)
      .where(eq(legalDocuments.id, id))
      .for('update');
    if (!doc) throw notFound('Document not found');
    if (doc.publishedAt) {
      throw conflict('A published document cannot be deleted. Publish a new version instead.');
    }
    await tx.delete(legalDocuments).where(eq(legalDocuments.id, id));
    await audit(
      {
        action: AuditAction.LEGAL_DOCUMENT_SAVED,
        actor: ctx,
        resourceType: 'legal_document',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { change: 'deleted', kind: doc.kind, version: doc.version, locale: doc.locale },
      },
      tx,
    );
  });
  res.status(204).end();
});

/**
 * Publish a draft. From now on the text is fixed (also by a database trigger); when it asks for
 * acceptance, every user accepts it at their next sign-in. The operator details the text refers
 * to must be filled in first, so nobody reads an empty "operator" or contact address.
 */
adminPlatformRouter.post('/legal/:id/publish', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const published = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(legalDocuments)
      .where(eq(legalDocuments.id, id))
      .for('update');
    if (!doc) throw notFound('Document not found');
    if (doc.publishedAt) throw conflict('This document is already published');
    const missing = missingPlaceholders(`${doc.title}\n${doc.body}`, await getSettings(tx));
    if (missing.length) {
      throw badRequest(
        'Fill in the operator settings this text refers to before publishing it',
        missing.map((path) => ({ path, message: 'Not set' })),
      );
    }
    const [row] = await tx
      .update(legalDocuments)
      .set({ publishedAt: new Date() })
      .where(eq(legalDocuments.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.LEGAL_DOCUMENT_PUBLISHED,
        actor: ctx,
        resourceType: 'legal_document',
        resourceId: id,
        meta: requestMeta(req),
        metadata: {
          kind: doc.kind,
          version: doc.version,
          locale: doc.locale,
          requiresAcceptance: doc.requiresAcceptance,
        },
      },
      tx,
    );
    return row!;
  });
  res.json(published);
});

/* ------------------------------------------------------------------ audit ------------------- */

const AuditQuery = PaginationSchema.extend({
  category: z.enum(['all', 'users', 'billing', 'platform']).default('all'),
});

/**
 * Audit rows with actor and target names. Targets are resolved per resource type; unknown types
 * keep their id only.
 */
async function auditItems(where: SQL, page: { limit: number; offset: number }) {
  const actor = alias(users, 'audit_actor');
  const rows = await db
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      action: auditLogs.action,
      outcome: auditLogs.outcome,
      actorId: auditLogs.actorUserId,
      actorName: actor.fullName,
      actorRole: auditLogs.actorRole,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .leftJoin(actor, eq(actor.id, auditLogs.actorUserId))
    .where(where)
    .orderBy(desc(auditLogs.occurredAt))
    .limit(page.limit)
    .offset(page.offset);
  const names = await targetNames(rows);
  return rows.map((r) => ({
    ...r,
    targetName:
      r.resourceType === 'platform_settings'
        ? 'Operator settings'
        : r.resourceId
          ? (names.get(r.resourceId) ?? null)
          : null,
  }));
}

async function targetNames(rows: { resourceType: string | null; resourceId: string | null }[]) {
  const idsOf = (...types: string[]) => [
    ...new Set(
      rows
        .filter((r) => r.resourceId && r.resourceType && types.includes(r.resourceType))
        .map((r) => r.resourceId!),
    ),
  ];
  const names = new Map<string, string>();
  const userIds = idsOf('user');
  if (userIds.length) {
    for (const u of await db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(inArray(users.id, userIds))) {
      names.set(u.id, u.name);
    }
  }
  const facilityIds = idsOf('facility');
  if (facilityIds.length) {
    for (const f of await db
      .select({ id: facilities.id, name: facilities.name })
      .from(facilities)
      .where(inArray(facilities.id, facilityIds))) {
      names.set(f.id, f.name);
    }
  }
  const subscriptionIds = idsOf('subscription');
  if (subscriptionIds.length) {
    for (const s of await db
      .select({ id: subscriptions.id, name: facilities.name })
      .from(subscriptions)
      .innerJoin(facilities, eq(facilities.id, subscriptions.facilityId))
      .where(inArray(subscriptions.id, subscriptionIds))) {
      names.set(s.id, s.name);
    }
  }
  const invoiceIds = idsOf('invoice');
  if (invoiceIds.length) {
    for (const i of await db
      .select({ id: invoices.id, name: invoices.number })
      .from(invoices)
      .where(inArray(invoices.id, invoiceIds))) {
      names.set(i.id, i.name);
    }
  }
  const planIds = idsOf('plan', 'subscription_plan');
  if (planIds.length) {
    for (const p of await db
      .select({ id: subscriptionPlans.id, name: subscriptionPlans.name })
      .from(subscriptionPlans)
      .where(inArray(subscriptionPlans.id, planIds))) {
      names.set(p.id, p.name);
    }
  }
  const docIds = idsOf('legal_document');
  if (docIds.length) {
    for (const d of await db
      .select({
        id: legalDocuments.id,
        kind: legalDocuments.kind,
        version: legalDocuments.version,
        locale: legalDocuments.locale,
      })
      .from(legalDocuments)
      .where(inArray(legalDocuments.id, docIds))) {
      names.set(d.id, `${d.kind} ${d.version} (${d.locale})`);
    }
  }
  return names;
}

/** Administrative actions on accounts, subscriptions and invoices, settings and legal texts. */
adminPlatformRouter.get('/audit', async (req, res) => {
  const q = parse(AuditQuery, req.query);
  const where =
    q.category === 'all'
      ? or(CATEGORY_FILTERS.users, CATEGORY_FILTERS.billing, CATEGORY_FILTERS.platform)!
      : CATEGORY_FILTERS[q.category];
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(where);
  const items = await auditItems(where, toOffset(q));
  res.json(paginated(items, count?.total ?? 0, q));
});
