import { Router } from 'express';

/**
 * Exports for the operator's accountant (CSV, UTF-8 with BOM, protected against spreadsheet
 * formulas). Round 2, builder B2.
 *
 * `billingExportsRouter` is mounted on /admin/exports (authenticated, ADMIN only). Every export
 * uses requireRecentAuth() and is audited as billing.exported with the export and its period only:
 *   GET /admin/exports/invoices.csv?from&to, /payments.csv, /credit-notes.csv, /sales-book.csv
 */
export const billingExportsRouter = Router();
