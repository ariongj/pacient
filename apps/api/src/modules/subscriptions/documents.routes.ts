import { Router } from 'express';

/**
 * Invoice and credit note PDFs, and sending them again. Round 2, builder B1 (uses
 * billing-documents.ts).
 *
 * `billingDocumentsAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   GET  /admin/invoices/:id/pdf, GET /admin/credit-notes/:id/pdf
 *   POST /admin/invoices/:id/send, POST /admin/credit-notes/:id/send – queueBillingDocument with
 *        kind RESEND, audited billing.invoice_sent in the same transaction.
 *
 * `billingDocumentsDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET /subscription/invoices/:id/pdf, GET /subscription/credit-notes/:id/pdf – documents of the
 *       director's own facility only; any other id answers 404.
 */
export const billingDocumentsAdminRouter = Router();
export const billingDocumentsDirectorRouter = Router();
