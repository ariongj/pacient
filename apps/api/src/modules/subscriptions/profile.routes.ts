import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { facilities, facilityBillingProfiles, subscriptions, users } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import {
  parse,
  requestMeta,
  requireAuth,
  type AuthContext,
  type RequestMeta,
} from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  BILLING_FIELD_LABELS,
  missingBillingSettings,
  recordEvent,
  settingsOf,
} from './subscriptions.service.js';

/**
 * A facility's billing details (facility_billing_profiles): who is invoiced, its numbers and the
 * addresses invoices go to. Round 2, builder B1. Business data about a customer, never about
 * patients; the administrator sees and edits them, the facility's directors read them.
 *
 * `billingProfileAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   GET /admin/billing-readiness – what the operator settings still lack for invoicing
 *   GET /admin/organizations/:facilityId/billing-profile
 *   PUT /admin/organizations/:facilityId/billing-profile – audited billing.profile_changed in the
 *       same transaction, with a subscription NOTE event "billing details changed".
 *
 * `billingProfileDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET /subscription/billing-profile – the director's own facility, read-only.
 */
export const billingProfileAdminRouter = Router();
export const billingProfileDirectorRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Optional text: empty or missing is "none" (null) – a PUT replaces the whole profile. */
const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

/**
 * The billing details as the administrator enters them. Up to three billing e-mails, stored in
 * lower case and each once; the facility's active directors receive the documents as well.
 */
export const BillingProfileInput = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    businessNumber: optionalText(40),
    fiscalNumber: optionalText(40),
    vatNumber: optionalText(40),
    billingAddress: optionalText(500),
    billingEmails: z
      .array(
        z
          .string()
          .trim()
          .max(254)
          .refine((v) => EMAIL_RE.test(v), 'Enter a valid e-mail address'),
      )
      .max(3, 'Enter at most three billing e-mail addresses')
      .default([])
      .transform((list) => [...new Set(list.map((e) => e.toLowerCase()))]),
    contactName: optionalText(200),
    customerReference: optionalText(120),
  })
  .strict();
export type BillingProfileValues = z.infer<typeof BillingProfileInput>;

type Profile = typeof facilityBillingProfiles.$inferSelect;
const FIELDS = [
  'legalName',
  'businessNumber',
  'fiscalNumber',
  'vatNumber',
  'billingAddress',
  'billingEmails',
  'contactName',
  'customerReference',
] as const satisfies readonly (keyof BillingProfileValues & keyof Profile)[];

/**
 * Saves a facility's billing details (created or replaced) with the audit entry – the names of
 * the fields that changed, never their values – and, when the facility has a subscription, an
 * internal "billing details changed" entry in its history, all in the caller's transaction.
 * Saving the same details again changes nothing and is not recorded. Issued invoices keep the
 * details they were issued with; the next invoice uses these.
 */
export async function saveBillingProfile(
  tx: Executor,
  facilityId: string,
  input: BillingProfileValues,
  ctx: AuthContext,
  meta: RequestMeta,
): Promise<Profile> {
  const [before] = await tx
    .select()
    .from(facilityBillingProfiles)
    .where(eq(facilityBillingProfiles.facilityId, facilityId))
    .for('update');
  const changed = FIELDS.filter(
    (k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(input[k] ?? null),
  );
  if (before && !changed.length) return before;
  const values = { ...input, updatedById: ctx.userId, updatedAt: new Date() };
  const [row] = await tx
    .insert(facilityBillingProfiles)
    .values({ facilityId, ...values })
    .onConflictDoUpdate({ target: facilityBillingProfiles.facilityId, set: values })
    .returning();
  await audit(
    {
      action: AuditAction.BILLING_PROFILE_CHANGED,
      actor: ctx,
      resourceType: 'facility',
      resourceId: facilityId,
      meta,
      metadata: { facilityId, fields: changed, created: !before },
    },
    tx,
  );
  const [subscription] = await tx
    .select({ id: subscriptions.id, facilityId: subscriptions.facilityId })
    .from(subscriptions)
    .where(eq(subscriptions.facilityId, facilityId));
  if (subscription) {
    await recordEvent(tx, {
      subscription,
      type: 'NOTE',
      actor: ctx,
      data: { reason: 'billing details changed', fields: changed },
    });
  }
  return row!;
}

/** The details as shown: the facility's own view leaves out who changed them. */
const presentProfile = (p: Profile) => ({
  facilityId: p.facilityId,
  legalName: p.legalName,
  businessNumber: p.businessNumber,
  fiscalNumber: p.fiscalNumber,
  vatNumber: p.vatNumber,
  billingAddress: p.billingAddress,
  billingEmails: p.billingEmails,
  contactName: p.contactName,
  customerReference: p.customerReference,
  updatedAt: p.updatedAt,
});

async function adminProfile(facilityId: string) {
  const [row] = await db
    .select({ profile: facilityBillingProfiles, updatedByName: users.fullName })
    .from(facilityBillingProfiles)
    .leftJoin(users, eq(users.id, facilityBillingProfiles.updatedById))
    .where(eq(facilityBillingProfiles.facilityId, facilityId));
  return row
    ? {
        ...presentProfile(row.profile),
        updatedBy: row.profile.updatedById
          ? { id: row.profile.updatedById, fullName: row.updatedByName ?? '' }
          : null,
      }
    : null;
}

const FacilityParam = z.object({ facilityId: z.string().uuid() });

async function assertFacility(facilityId: string) {
  const [facility] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  if (!facility) throw notFound('Facility not found');
}

/** Whether invoices can be issued, and if not, which operator settings are missing. */
billingProfileAdminRouter.get('/billing-readiness', async (_req, res) => {
  const settings = await settingsOf();
  const missing = missingBillingSettings(settings);
  res.json({
    ready: missing.length === 0,
    missing: missing.map((field) => ({ field, label: BILLING_FIELD_LABELS[field] })),
    vatRateBp: settings.vatRateBp,
  });
});

billingProfileAdminRouter.get('/organizations/:facilityId/billing-profile', async (req, res) => {
  const { facilityId } = parse(FacilityParam, req.params);
  await assertFacility(facilityId);
  res.json({ profile: await adminProfile(facilityId) });
});

billingProfileAdminRouter.put('/organizations/:facilityId/billing-profile', async (req, res) => {
  const ctx = requireAuth(req);
  const { facilityId } = parse(FacilityParam, req.params);
  const input = parse(BillingProfileInput, req.body);
  await assertFacility(facilityId);
  await db.transaction((tx) => saveBillingProfile(tx, facilityId, input, ctx, requestMeta(req)));
  res.json({ profile: await adminProfile(facilityId) });
});

billingProfileDirectorRouter.get('/billing-profile', async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const [row] = await db
    .select()
    .from(facilityBillingProfiles)
    .where(eq(facilityBillingProfiles.facilityId, ctx.facilityId));
  res.json({ profile: row ? presentProfile(row) : null });
});
