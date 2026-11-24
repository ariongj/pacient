import { Router, type Request, type Response } from 'express';
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { billingDeliveries, creditNotes, emailOutbox, invoices, users } from '../../db/schema.js';
import { toLocale, type Locale } from '../../i18n/index.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { billingAttachment, queueBillingDocument } from './billing-documents.js';

/**
 * Invoice and credit note PDFs, and sending them again. Round 2, builder B1 (uses
 * billing-documents.ts).
 *
 * `billingDocumentsAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   GET  /admin/invoices/:id/pdf, GET /admin/credit-notes/:id/pdf
 *   GET  /admin/invoices/:id/deliveries, GET /admin/credit-notes/:id/deliveries – who it was
 *        e-mailed to, when, why, and whether the message went out
 *   POST /admin/invoices/:id/send, POST /admin/credit-notes/:id/send – queueBillingDocument with
 *        kind RESEND, audited billing.invoice_sent in the same transaction.
 *
 * `billingDocumentsDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET /subscription/documents – the own facility's invoices and credit notes, for downloading
 *   GET /subscription/invoices/:id/pdf, GET /subscription/credit-notes/:id/pdf – documents of the
 *       director's own facility only; any other id answers 404.
 */
export const billingDocumentsAdminRouter = Router();
export const billingDocumentsDirectorRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const PdfQuery = z.object({ locale: z.enum(['sq', 'sr', 'en']).optional() });

/** The language of a download: as asked, else the account's own language. */
async function localeFor(req: Request): Promise<Locale> {
  const { locale } = parse(PdfQuery, req.query);
  if (locale) return locale;
  const [user] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, requireAuth(req).userId));
  return toLocale(user?.locale);
}

/** Answers with a PDF as a download; never cached (it holds the customer's billing details). */
function sendPdf(res: Response, file: { filename: string; contentType: string; content: Buffer }) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.content);
}

/** Who a document was e-mailed to, newest first, with the state of each message. */
async function deliveriesWhere(where: SQL) {
  const rows = await db
    .select({
      delivery: billingDeliveries,
      queuedByName: users.fullName,
      status: emailOutbox.status,
      sentAt: emailOutbox.sentAt,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
    })
    .from(billingDeliveries)
    .innerJoin(emailOutbox, eq(emailOutbox.id, billingDeliveries.emailOutboxId))
    .leftJoin(users, eq(users.id, billingDeliveries.queuedById))
    .where(where)
    .orderBy(desc(billingDeliveries.queuedAt), asc(billingDeliveries.recipient));
  return rows.map((r) => ({
    id: r.delivery.id,
    kind: r.delivery.kind,
    // Billing addresses are the customer's business addresses: shown in full.
    recipient: r.delivery.recipient,
    queuedAt: r.delivery.queuedAt,
    queuedBy: r.delivery.queuedById
      ? { id: r.delivery.queuedById, fullName: r.queuedByName ?? '' }
      : null,
    status: r.status,
    sentAt: r.sentAt,
    attempts: r.attempts,
    lastError: r.lastError,
  }));
}

/* ------------------------------------------------------------------ administrator ----------- */

billingDocumentsAdminRouter.get('/invoices/:id/pdf', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  sendPdf(res, await billingAttachment('invoice', id, await localeFor(req)));
});

billingDocumentsAdminRouter.get('/credit-notes/:id/pdf', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  sendPdf(res, await billingAttachment('credit_note', id, await localeFor(req)));
});

billingDocumentsAdminRouter.get('/invoices/:id/deliveries', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const [invoice] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, id));
  if (!invoice) throw notFound('Invoice not found');
  res.json({ items: await deliveriesWhere(eq(billingDeliveries.invoiceId, id)) });
});

billingDocumentsAdminRouter.get('/credit-notes/:id/deliveries', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const [creditNote] = await db
    .select({ id: creditNotes.id })
    .from(creditNotes)
    .where(eq(creditNotes.id, id));
  if (!creditNote) throw notFound('Credit note not found');
  res.json({ items: await deliveriesWhere(eq(billingDeliveries.creditNoteId, id)) });
});

const NOBODY =
  'There is nobody to send it to: add a billing e-mail to the facility’s billing details, or a director.';

billingDocumentsAdminRouter.post('/invoices/:id/send', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const queued = await db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id));
    if (!invoice) throw notFound('Invoice not found');
    // A voided invoice is no longer owed: sending it would only confuse the customer.
    if (invoice.status === 'VOID') throw conflict('A voided invoice is not sent.');
    const n = await queueBillingDocument(tx, { invoiceId: id, kind: 'RESEND', actor: ctx });
    if (!n) throw conflict(NOBODY);
    await audit(
      {
        action: AuditAction.BILLING_INVOICE_SENT,
        actor: ctx,
        resourceType: 'invoice',
        resourceId: id,
        meta,
        metadata: { number: invoice.number, facilityId: invoice.facilityId, recipients: n },
      },
      tx,
    );
    return n;
  });
  res.json({ queued, items: await deliveriesWhere(eq(billingDeliveries.invoiceId, id)) });
});

billingDocumentsAdminRouter.post('/credit-notes/:id/send', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const queued = await db.transaction(async (tx) => {
    const [creditNote] = await tx.select().from(creditNotes).where(eq(creditNotes.id, id));
    if (!creditNote) throw notFound('Credit note not found');
    const n = await queueBillingDocument(tx, { creditNoteId: id, kind: 'RESEND', actor: ctx });
    if (!n) throw conflict(NOBODY);
    await audit(
      {
        action: AuditAction.BILLING_INVOICE_SENT,
        actor: ctx,
        resourceType: 'credit_note',
        resourceId: id,
        meta,
        metadata: {
          number: creditNote.number,
          facilityId: creditNote.facilityId,
          invoiceId: creditNote.invoiceId,
          recipients: n,
        },
      },
      tx,
    );
    return n;
  });
  res.json({ queued, items: await deliveriesWhere(eq(billingDeliveries.creditNoteId, id)) });
});

/* ------------------------------------------------------------------ the facility's directors - */

function ownFacility(req: Request) {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  return ctx.facilityId;
}

billingDocumentsDirectorRouter.get('/documents', async (req, res) => {
  const facilityId = ownFacility(req);
  const invoiceRows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      issuedAt: invoices.issuedAt,
      totalCents: invoices.totalCents,
      currency: invoices.currency,
    })
    .from(invoices)
    .where(eq(invoices.facilityId, facilityId))
    .orderBy(desc(invoices.issuedAt), desc(invoices.number));
  const creditNoteRows = await db
    .select({
      id: creditNotes.id,
      number: creditNotes.number,
      issuedAt: creditNotes.issuedAt,
      totalCents: creditNotes.totalCents,
      currency: creditNotes.currency,
      invoiceId: creditNotes.invoiceId,
      invoiceNumber: invoices.number,
    })
    .from(creditNotes)
    .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
    .where(eq(creditNotes.facilityId, facilityId))
    .orderBy(desc(creditNotes.issuedAt), desc(creditNotes.number));
  res.json({ invoices: invoiceRows, creditNotes: creditNoteRows });
});

/** Another facility's document answers 404, like one that does not exist. */
billingDocumentsDirectorRouter.get('/invoices/:id/pdf', async (req, res) => {
  const facilityId = ownFacility(req);
  const { id } = parse(IdParam, req.params);
  const [invoice] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.facilityId, facilityId)));
  if (!invoice) throw notFound('Invoice not found');
  sendPdf(res, await billingAttachment('invoice', id, await localeFor(req)));
});

billingDocumentsDirectorRouter.get('/credit-notes/:id/pdf', async (req, res) => {
  const facilityId = ownFacility(req);
  const { id } = parse(IdParam, req.params);
  const [creditNote] = await db
    .select({ id: creditNotes.id })
    .from(creditNotes)
    .where(and(eq(creditNotes.id, id), eq(creditNotes.facilityId, facilityId)));
  if (!creditNote) throw notFound('Credit note not found');
  sendPdf(res, await billingAttachment('credit_note', id, await localeFor(req)));
});
