import { Router } from 'express';

/**
 * A facility's billing details (facility_billing_profiles): who is invoiced, its numbers and the
 * addresses invoices go to. Round 2, builder B1.
 *
 * `billingProfileAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   GET /admin/organizations/:facilityId/billing-profile
 *   PUT /admin/organizations/:facilityId/billing-profile – audited billing.profile_changed in the
 *       same transaction, with a subscription NOTE event "billing details changed".
 *
 * `billingProfileDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET /subscription/billing-profile – the director's own facility, read-only.
 */
export const billingProfileAdminRouter = Router();
export const billingProfileDirectorRouter = Router();
