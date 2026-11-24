import { Router } from 'express';

/**
 * Corrections of issued invoices: reversing a payment and credit notes. Round 2, builder B2.
 * (Recording a payment with an amount and voiding stay in admin.routes.ts.)
 *
 * `billingCorrectionsAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   POST /admin/payments/:id/reverse – requireRecentAuth(); reason; reopens a settled invoice
 *        through the invoice trigger (set reversed_at to the database clock, sql`now()`).
 *   POST /admin/invoices/:id/credit-notes – requireRecentAuth(); numbered per Belgrade year,
 *        issuer and customer copied from the invoice, then queueBillingDocument(ISSUED).
 *   GET  /admin/credit-notes, GET /admin/credit-notes/:id – as needed by the pages.
 *
 * `billingCorrectionsDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET /subscription/credit-notes (and /:id) – the director's own facility only.
 */
export const billingCorrectionsAdminRouter = Router();
export const billingCorrectionsDirectorRouter = Router();
