import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  notExists,
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
  creditNotes,
  facilities,
  invoices,
  legalAcceptances,
  legalDocuments,
  operatorRequests,
  platformSettings,
  subscriptionEvents,
  subscriptionPlans,
  subscriptions,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, notFound, reauthRequired } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { ensureRecentAuth, requireRecentAuth } from '../../middleware/recent-auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  BANK_SETTINGS,
  changedAmong,
  notifyBankDetailsChanged,
  recentBankChange,
  REAUTH_SETTINGS,
} from './bank-change.js';
import { hasReviewNote, LEGAL_TEMPLATES } from './legal-templates.js';
import {
  currentVersion,
  fillPlaceholders,
  getSettings,
  LEGAL_KINDS,
  LEGAL_LOCALES,
  missingPlaceholders,
  USER_LEGAL_KINDS,
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

type AuditCategory = 'users' | 'billing' | 'platform';

/** Administrative actions shown on the overview and in the audit view, by kind. */
const CATEGORY_FILTERS: Record<AuditCategory, SQL> = {
  users: or(
    like(auditLogs.action, 'admin.user.%'),
    inArray(auditLogs.action, [
      AuditAction.USER_INVITED,
      AuditAction.USER_DEACTIVATED,
      AuditAction.USER_REACTIVATED,
      // An administrator confirming the password for a sensitive action.
      AuditAction.AUTH_REAUTHENTICATED,
    ]),
  )!,
  // The operator's customers and their billing (facilities created for a customer, plans,
  // subscriptions, invoices, billing details, payments, credit notes, exports) and the
  // administrators' answers and status changes on requests to the operator: the facilities' own
  // patient billing (co-payments, claims) also writes billing.* actions and is not
  // administration, so the new billing actions are listed. What a facility does – a director
  // accepting an agreement, a new request or a facility's message – is not an administrator's
  // action (BY_OPERATOR leaves it out anyway): acceptances are on the facility's page and on Terms
  // and privacy, requests in the Requests inbox.
  billing: or(
    like(auditLogs.action, 'facility.%'),
    like(auditLogs.action, 'billing.plan.%'),
    like(auditLogs.action, 'billing.subscription.%'),
    like(auditLogs.action, 'billing.invoice.%'),
    inArray(auditLogs.action, [
      AuditAction.BILLING_PROFILE_CHANGED,
      AuditAction.BILLING_INVOICE_SENT,
      AuditAction.BILLING_PAYMENT_RECORDED,
      AuditAction.BILLING_PAYMENT_REVERSED,
      AuditAction.BILLING_CREDIT_NOTE_ISSUED,
      AuditAction.BILLING_EXPORTED,
      AuditAction.OPERATOR_REQUEST_MESSAGE,
      AuditAction.OPERATOR_REQUEST_STATUS_CHANGED,
    ]),
  )!,
  // Acceptances by users (legal.accepted) are not administrative actions: see /legal/acceptances.
  // platform.% includes the test e-mail and operator alerts raised and resolved.
  platform: or(like(auditLogs.action, 'platform.%'), like(auditLogs.action, 'legal.document.%'))!,
};

const patientAccount = alias(users, 'patient_account');

/**
 * Only what the operator's administrators or the system (no actor) did. Facility staff write the
 * same generic actions (a clinician inviting a patient to the portal, a director managing staff);
 * such a row names a patient together with their clinician and so their facility, which the
 * administrator must never learn. Rows about a patient never belong here either. Neither do rows
 * the system wrote about a patient's portal account: it closes one when a death is registered
 * (and opens it again when the registration is withdrawn), so a list of them would be a list of
 * deceased patients. Those rows stay in the trail and in that account's own history.
 */
const BY_OPERATOR = and(
  or(eq(auditLogs.actorRole, 'ADMIN'), isNull(auditLogs.actorUserId)),
  isNull(auditLogs.patientId),
  or(
    isNotNull(auditLogs.actorUserId),
    notExists(
      db
        .select({ id: patientAccount.id })
        .from(patientAccount)
        .where(
          and(eq(patientAccount.id, auditLogs.resourceId), eq(patientAccount.role, 'PATIENT')),
        ),
    ),
  ),
)!;

const auditWhere = (category: AuditCategory | 'all') =>
  and(
    category === 'all'
      ? or(CATEGORY_FILTERS.users, CATEGORY_FILTERS.billing, CATEGORY_FILTERS.platform)
      : CATEGORY_FILTERS[category],
    BY_OPERATOR,
  )!;

/** What is still owed on invoice `i`: its total less payments not reversed and credit notes. */
const OWED = sql.raw(`greatest(i.total_cents
  - (SELECT coalesce(sum(p.amount_cents), 0) FROM invoice_payments p
      WHERE p.invoice_id = i.id AND p.reversed_at IS NULL)
  - (SELECT coalesce(sum(c.total_cents), 0) FROM credit_notes c WHERE c.invoice_id = i.id), 0)`);

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
        -- What is still owed: an open invoice may be paid or credited in part.
        (SELECT coalesce(sum(${OWED}), 0) FROM invoices i
           WHERE status = 'OPEN' AND currency = 'EUR') AS open_cents,
        -- Overdue as the subscription worker sees it: an invoice with nothing to pay is never
        -- overdue (zero totals left open by earlier versions).
        (SELECT coalesce(sum(${OWED}), 0) FROM invoices i
           WHERE status = 'OPEN' AND currency = 'EUR' AND due_at < now()
             AND total_cents > 0) AS overdue_cents,
        (SELECT count(*) FROM invoices
           WHERE status = 'OPEN' AND due_at < now() AND total_cents > 0) AS overdue_count
    `)
  ).rows;
  const byStatusRows = await db
    .select({ status: subscriptions.status, count: sql<number>`count(*)::int` })
    .from(subscriptions)
    .groupBy(subscriptions.status);
  const byStatus = Object.fromEntries(
    SUBSCRIPTION_STATUSES.map((s) => [s, byStatusRows.find((r) => r.status === s)?.count ?? 0]),
  ) as Record<(typeof SUBSCRIPTION_STATUSES)[number], number>;

  // What renews (or ends) in the next 30 days. The next period applies a change of billing cycle
  // scheduled for it, with its price, so that is what it bills. A suspended subscription does not
  // renew, but a cancellation scheduled for the end of its period still ends it on that date.
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
      nextBillingCycle: subscriptions.nextBillingCycle,
      nextPriceCents: subscriptions.nextPriceCents,
      currency: subscriptions.currency,
    })
    .from(subscriptions)
    .innerJoin(facilities, eq(facilities.id, subscriptions.facilityId))
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(
      and(
        or(
          inArray(subscriptions.status, ['TRIAL', 'ACTIVE', 'PAST_DUE']),
          and(eq(subscriptions.status, 'SUSPENDED'), eq(subscriptions.cancelAtPeriodEnd, true)),
        ),
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
    recentActions: await auditItems(auditWhere('all'), { limit: 10, offset: 0 }),
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

/** IBAN lengths of the countries customers and operators are likely to bank in (ISO 13616). */
const IBAN_LENGTH: Record<string, number> = {
  XK: 20,
  AL: 28,
  RS: 22,
  MK: 19,
  ME: 22,
  BA: 20,
  HR: 21,
  SI: 19,
  BG: 22,
  RO: 24,
  GR: 27,
  TR: 26,
  HU: 28,
  AT: 20,
  CH: 21,
  DE: 22,
  IT: 27,
  FR: 27,
  BE: 16,
  NL: 18,
  LU: 20,
  GB: 22,
  IE: 22,
  ES: 24,
  PT: 25,
  SE: 24,
  NO: 15,
  DK: 18,
  FI: 18,
  PL: 28,
  CZ: 24,
  SK: 24,
};

/**
 * The country's IBAN length (15–34 for countries not in the table) and the ISO 13616 check
 * digits: the first four characters moved to the end, letters as numbers (A = 10 … Z = 35), the
 * whole number modulo 97 must be 1. This catches a mistyped character or two swapped neighbours.
 * Check digits are always 02–98: 00 and 01 would pass the sum where 97 and 98 are right.
 */
function validIban(iban: string): boolean {
  const s = iban.replace(/ /g, '');
  const expected = IBAN_LENGTH[s.slice(0, 2)];
  if (expected ? s.length !== expected : s.length < 15 || s.length > 34) return false;
  const check = Number(s.slice(2, 4));
  if (check < 2 || check > 98) return false;
  let rest = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of value) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/**
 * What is wrong with an IBAN, if anything. Printed on every invoice and frozen there: a mistyped
 * account must not get that far.
 */
function ibanProblem(v: string): string | null {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9 ]+$/.test(v) || v.length > 40) {
    return 'Enter the IBAN as printed by the bank, e.g. XK05 1212 0123 4567 8906';
  }
  return validIban(v) ? null : 'This IBAN is not valid: check its length and digits';
}

/**
 * The settings as the administrator's page shows them, with whether the stored IBAN passes the
 * check (one stored before the check was stricter may not): the page warns about it.
 */
const presentSettings = (s: Settings) => ({
  ...s,
  operatorIbanValid: !s.operatorIban || ibanProblem(s.operatorIban) === null,
});

const SettingsInput = z
  .object({
    operatorName: text(200).optional(),
    operatorAddress: text(500).optional(),
    operatorFiscalNumber: nullableText(40),
    operatorVatNumber: nullableText(40),
    // Checked in the handler, and only when it changes (see PUT /settings).
    operatorIban: z
      .union([z.string().max(100), z.null()])
      .transform((v) => (v ? v.toUpperCase().replace(/\s+/g, ' ').trim() : null))
      .optional(),
    operatorBank: nullableText(120),
    supportEmail: email,
    supportPhone: nullableText(40),
    // When support answers, in the operator's words (shown with the contact details).
    supportHours: nullableText(120),
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
  res.json(presentSettings(await getSettings()));
});

/**
 * "Bank details changed on …" on the platform overview: the latest change of the IBAN or bank in
 * the last 14 days, by whom, with the details now (null when there was none).
 */
adminPlatformRouter.get('/settings/bank-change', async (_req, res) => {
  res.json({ change: await recentBankChange() });
});

adminPlatformRouter.put('/settings', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(SettingsInput, req.body);
  // A new IBAN or bank, VAT rate or number, or invoice prefix changes where customers pay and what
  // every invoice says from now on: the password again first (or a sign-in in the last 10
  // minutes), before anything is changed. Other settings, sent back unchanged with them by the
  // page, ask for nothing.
  const reauthenticated = changedAmong(REAUTH_SETTINGS, input, await getSettings()).length > 0;
  if (reauthenticated) await ensureRecentAuth(req);
  const updated = await db.transaction(async (tx) => {
    const before = await getSettings(tx);
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ) as Partial<Settings>;
    const changed = Object.keys(patch).filter(
      (k) => comparable(patch[k as keyof Settings]) !== comparable(before[k as keyof Settings]),
    );
    // Another administrator changed them in the meantime, so this request now changes them after
    // all: ask for the password rather than let it through unconfirmed.
    if (!reauthenticated && changedAmong(REAUTH_SETTINGS, patch, before).length) {
      throw reauthRequired(401);
    }
    // The page sends every field. An IBAN stored before the check was stricter is sent back
    // unchanged and must not block another change (say, an urgent notice to all users); a new
    // IBAN is checked.
    if (changed.includes('operatorIban') && patch.operatorIban) {
      const problem = ibanProblem(patch.operatorIban);
      if (problem) {
        throw badRequest('Validation failed', [{ path: 'operatorIban', message: problem }]);
      }
    }
    // VAT is charged only with a VAT number to print beside it. Checked when either of them
    // changes, like the IBAN, so settings stored before never hold up another change (the
    // overview says that billing is not ready instead).
    const vatRateBp = patch.vatRateBp ?? before.vatRateBp;
    const vatNumber =
      'operatorVatNumber' in patch ? patch.operatorVatNumber : before.operatorVatNumber;
    if (
      (changed.includes('vatRateBp') || changed.includes('operatorVatNumber')) &&
      vatRateBp > 0 &&
      !vatNumber
    ) {
      throw badRequest('Validation failed', [
        {
          path: 'operatorVatNumber',
          message: 'Enter the VAT number to charge VAT, or set the VAT rate to 0',
        },
      ]);
    }
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
    // The other administrators hear of a new IBAN or bank at once, in the same transaction.
    if (changedAmong(BANK_SETTINGS, patch, before).length) {
      await notifyBankDetailsChanged(tx, ctx, row!.updatedAt);
    }
    return row!;
  });
  res.json(presentSettings(updated));
});

/* ------------------------------------------------------------------ legal documents --------- */

const Kind = z.enum(LEGAL_KINDS);
const Locale = z.enum(LEGAL_LOCALES);
const Version = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/, 'Use a short version such as 1.0 or 2026-11');
const TITLE_MAX = 200;
const Title = z.string().trim().min(2).max(TITLE_MAX);
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
  /** Published with its text as written kept (a new version can start from that). */
  hasSource: sql<boolean>`${legalDocuments.bodySource} IS NOT NULL`,
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
    current: Object.fromEntries(
      await Promise.all(LEGAL_KINDS.map(async (k) => [k, await currentVersion(k)] as const)),
    ),
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

// Users' acceptances only: a facility's acceptance of an agreement is listed under /agreements.
const AcceptanceQuery = z.object({ kind: z.enum(USER_LEGAL_KINDS), version: Version });

/**
 * Who accepted a version: count against active accounts, and the latest 50 acceptances. Patient
 * accounts are listed by role and time only: the administrator has no reason to see who among the
 * population uses the portal.
 */
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
      userName: sql<
        string | null
      >`CASE WHEN ${users.role} = 'PATIENT' THEN NULL ELSE ${users.fullName} END`,
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
 * to must be filled in first, so nobody reads an empty "operator" or contact address, and they
 * are written into the text now: a later change to the operator settings must not change what
 * users read and accepted (a new version does). Each value is written as it is, in one pass: a
 * value that looks like a {placeholder} stays as typed. The text as written, with its
 * placeholders, is kept beside it, so that a new version started from this one picks up the
 * operator details of its own publication. What every user must accept is published only after
 * the administrator confirmed the password again (or signed in within the last 10 minutes).
 */
adminPlatformRouter.post('/legal/:id/publish', requireRecentAuth(), async (req, res) => {
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
    const settings = await getSettings(tx);
    const missing = missingPlaceholders(`${doc.title}\n${doc.body}`, settings);
    if (missing.length) {
      throw badRequest(
        'Fill in the operator settings this text refers to before publishing it',
        missing.map((path) => ({ path, message: 'Not set' })),
      );
    }
    // An agreement template starts with a note asking for the lawyer's review: a facility must
    // never sign a text that still says it is a draft.
    if (hasReviewNote(`${doc.title}\n${doc.body}`)) {
      throw badRequest(
        'This text still contains the draft note at its start. Have a lawyer review it, then delete the note before publishing.',
      );
    }
    const title = fillPlaceholders(doc.title, settings);
    if (title.length > TITLE_MAX) {
      throw badRequest('With the operator details filled in, the title is too long');
    }
    // Same statement as publishedAt: the trigger that fixes published texts still lets it through.
    const [row] = await tx
      .update(legalDocuments)
      .set({
        title,
        body: fillPlaceholders(doc.body, settings),
        titleSource: doc.title,
        bodySource: doc.body,
        publishedAt: new Date(),
      })
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
 * keep their id only. A patient's portal account is never named (as in the acceptances): the row
 * says only that it was a patient account.
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
  const { names, patientAccounts } = await targetNames(rows);
  return rows.map((r) => {
    const patientAccount = Boolean(r.resourceId && patientAccounts.has(r.resourceId));
    return {
      ...r,
      // A patient account is neither named nor identified: its id would resolve to the name on
      // the account page, turning the audit view into a list of patients.
      resourceId: patientAccount ? null : r.resourceId,
      targetName:
        r.resourceType === 'platform_settings'
          ? 'Operator settings'
          : r.resourceId && !patientAccount
            ? (names.get(r.resourceId) ?? null)
            : null,
      targetPatientAccount: patientAccount,
    };
  });
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
  const patientAccounts = new Set<string>();
  const userIds = idsOf('user');
  if (userIds.length) {
    for (const u of await db
      .select({ id: users.id, name: users.fullName, role: users.role })
      .from(users)
      .where(inArray(users.id, userIds))) {
      if (u.role === 'PATIENT') patientAccounts.add(u.id);
      else names.set(u.id, u.name);
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
  const creditNoteIds = idsOf('credit_note');
  if (creditNoteIds.length) {
    for (const c of await db
      .select({ id: creditNotes.id, name: creditNotes.number })
      .from(creditNotes)
      .where(inArray(creditNotes.id, creditNoteIds))) {
      names.set(c.id, c.name);
    }
  }
  const requestIds = idsOf('operator_request');
  if (requestIds.length) {
    for (const r of await db
      .select({ id: operatorRequests.id, name: operatorRequests.reference })
      .from(operatorRequests)
      .where(inArray(operatorRequests.id, requestIds))) {
      names.set(r.id, r.name);
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
  return { names, patientAccounts };
}

/**
 * What administrators (and the system) did to accounts, customers, subscriptions and invoices,
 * settings and legal texts.
 */
adminPlatformRouter.get('/audit', async (req, res) => {
  const q = parse(AuditQuery, req.query);
  const where = auditWhere(q.category);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(where);
  const items = await auditItems(where, toOffset(q));
  res.json(paginated(items, count?.total ?? 0, q));
});
