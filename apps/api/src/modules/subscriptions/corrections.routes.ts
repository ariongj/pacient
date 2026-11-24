import { Router, type Request } from 'express';
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  creditNotes,
  facilities,
  invoicePayments,
  invoices,
  subscriptions,
  users,
} from '../../db/schema.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { ensureRecentAuth } from '../../middleware/recent-auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { queueBillingDocument } from './billing-documents.js';
import {
  accountOf,
  creditSplit,
  nextCreditNoteNumber,
  notifyDirectors,
  recordEvent,
  restoreStanding,
  settingsOf,
  settlementOf,
  standingAfterReversal,
  type Invoice,
} from './subscriptions.service.js';

/**
 * Corrections of issued invoices: reversing a payment and credit notes. Round 2, builder B2.
 * (Recording a payment with an amount and voiding stay in admin.routes.ts.)
 *
 * An issued invoice never changes its amounts. A payment recorded by mistake is reversed (the row
 * stays, marked reversed); an amount the customer does not owe after all is taken back by a credit
 * note – a document of its own, numbered without gaps, that the customer and the accountant
 * receive. Both need the password again (or a recent sign-in) and are audited in the same
 * transaction as the change.
 *
 * `billingCorrectionsAdminRouter` is mounted on /admin (authenticated, ADMIN only):
 *   GET  /admin/invoices/:id/account – payments (with reversals), credit notes and balance.
 *   POST /admin/payments/:id/reverse – reason; reopens a settled invoice through the invoice
 *        trigger (reversed_at is the database clock, sql`now()`).
 *   POST /admin/invoices/:id/credit-notes – amount and reason; numbered per Kosovo year, issuer
 *        and customer copied from the invoice, then queueBillingDocument(ISSUED).
 *   GET  /admin/credit-notes, GET /admin/credit-notes/:id
 *
 * `billingCorrectionsDirectorRouter` is mounted on /subscription (authenticated, DIRECTOR only):
 *   GET /subscription/invoices/:id/account, GET /subscription/credit-notes (and /:id) – the
 *   director's own facility only; anything else answers 404.
 */
export const billingCorrectionsAdminRouter = Router();
export const billingCorrectionsDirectorRouter = Router();

type Audience = 'admin' | 'director';

const IdParam = z.object({ id: z.string().uuid() });
const Reason = z.string().trim().min(5).max(500);
const ReverseInput = z.object({ reason: Reason });
const CreditNoteInput = z.object({
  /** The amount taken back, VAT included, in cents. */
  amountCents: z.number().int().min(1).max(100_000_000),
  reason: Reason,
});
const CreditNoteQuery = PaginationSchema.extend({
  facilityId: z.string().uuid().optional(),
  invoiceId: z.string().uuid().optional(),
});

/** The director's own facility (a director always has one). */
function ownFacility(req: Request) {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  return ctx.facilityId;
}

/* ------------------------------------------------------------------ reading ------------------ */

async function invoiceRow(where: SQL) {
  const [row] = await db.select().from(invoices).where(where);
  if (!row) throw notFound('Invoice not found');
  return row;
}

const recorder = alias(users, 'payment_recorder');
const reverser = alias(users, 'payment_reverser');

/**
 * What was paid and credited on an invoice and what is still owed or to be refunded. A facility
 * sees what the service operator did but not who (as in its history), and nothing about voiding.
 */
async function accountView(invoice: Invoice, audience: Audience) {
  const { voidBlock, ...account } = await accountOf(db, invoice);
  const payments = await db
    .select({
      payment: invoicePayments,
      recordedBy: recorder.fullName,
      reversedBy: reverser.fullName,
    })
    .from(invoicePayments)
    .leftJoin(recorder, eq(recorder.id, invoicePayments.recordedById))
    .leftJoin(reverser, eq(reverser.id, invoicePayments.reversedById))
    .where(eq(invoicePayments.invoiceId, invoice.id))
    .orderBy(asc(invoicePayments.paidAt), asc(invoicePayments.createdAt));
  const notes = await db
    .select()
    .from(creditNotes)
    .where(eq(creditNotes.invoiceId, invoice.id))
    .orderBy(asc(creditNotes.issuedAt), asc(creditNotes.seq));
  return {
    invoiceId: invoice.id,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    totalCents: invoice.totalCents,
    ...account,
    ...(audience === 'admin' ? { voidable: voidBlock === null, voidBlock } : {}),
    payments: payments.map(({ payment: p, recordedBy, reversedBy }) => ({
      id: p.id,
      amountCents: p.amountCents,
      paidAt: p.paidAt,
      method: p.method,
      reference: p.reference,
      recordedAt: p.createdAt,
      reversedAt: p.reversedAt,
      reversalReason: p.reversalReason,
      ...(audience === 'admin' ? { recordedBy, reversedBy } : {}),
    })),
    creditNotes: notes.map(creditNoteSummary),
  };
}

function creditNoteSummary(c: typeof creditNotes.$inferSelect) {
  return {
    id: c.id,
    number: c.number,
    invoiceId: c.invoiceId,
    issuedAt: c.issuedAt,
    reason: c.reason,
    netCents: c.netCents,
    taxCents: c.taxCents,
    totalCents: c.totalCents,
    vatRateBp: c.vatRateBp,
    currency: c.currency,
  };
}

/** A printable credit note: its own frozen details and the invoice it corrects. */
async function creditNoteDetail(where: SQL) {
  const [row] = await db
    .select({
      note: creditNotes,
      invoice: {
        id: invoices.id,
        number: invoices.number,
        issuedAt: invoices.issuedAt,
        periodStart: invoices.periodStart,
        periodEnd: invoices.periodEnd,
        totalCents: invoices.totalCents,
        status: invoices.status,
      },
      facilityName: facilities.name,
    })
    .from(creditNotes)
    .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
    .innerJoin(facilities, eq(facilities.id, creditNotes.facilityId))
    .where(where);
  if (!row) throw notFound('Credit note not found');
  return {
    ...creditNoteSummary(row.note),
    facilityId: row.note.facilityId,
    subscriptionId: row.note.subscriptionId,
    issuer: row.note.issuer,
    customer: row.note.customer,
    facilityName: row.facilityName,
    invoice: row.invoice,
  };
}

async function creditNoteList(filters: SQL[], q: z.infer<typeof CreditNoteQuery>) {
  const where = filters.length ? and(...filters) : undefined;
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(creditNotes)
    .where(where);
  const rows = await db
    .select({ note: creditNotes, invoiceNumber: invoices.number, facilityName: facilities.name })
    .from(creditNotes)
    .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
    .innerJoin(facilities, eq(facilities.id, creditNotes.facilityId))
    .where(where)
    .orderBy(desc(creditNotes.issuedAt), desc(creditNotes.seq))
    .limit(toOffset(q).limit)
    .offset(toOffset(q).offset);
  return paginated(
    rows.map((r) => ({
      ...creditNoteSummary(r.note),
      facilityId: r.note.facilityId,
      invoiceNumber: r.invoiceNumber,
      facilityName: r.facilityName,
    })),
    total,
    q,
  );
}

billingCorrectionsAdminRouter.get('/invoices/:id/account', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await accountView(await invoiceRow(eq(invoices.id, id)), 'admin'));
});

billingCorrectionsAdminRouter.get('/credit-notes', async (req, res) => {
  const q = parse(CreditNoteQuery, req.query);
  const filters: SQL[] = [];
  if (q.facilityId) filters.push(eq(creditNotes.facilityId, q.facilityId));
  if (q.invoiceId) filters.push(eq(creditNotes.invoiceId, q.invoiceId));
  res.json(await creditNoteList(filters, q));
});

billingCorrectionsAdminRouter.get('/credit-notes/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await creditNoteDetail(eq(creditNotes.id, id)));
});

billingCorrectionsDirectorRouter.get('/invoices/:id/account', async (req, res) => {
  const facilityId = ownFacility(req);
  const { id } = parse(IdParam, req.params);
  const invoice = await invoiceRow(and(eq(invoices.id, id), eq(invoices.facilityId, facilityId))!);
  res.json(await accountView(invoice, 'director'));
});

billingCorrectionsDirectorRouter.get('/credit-notes', async (req, res) => {
  const facilityId = ownFacility(req);
  const q = parse(CreditNoteQuery.omit({ facilityId: true }), req.query);
  const filters = [eq(creditNotes.facilityId, facilityId)];
  if (q.invoiceId) filters.push(eq(creditNotes.invoiceId, q.invoiceId));
  res.json(await creditNoteList(filters, q));
});

billingCorrectionsDirectorRouter.get('/credit-notes/:id', async (req, res) => {
  const facilityId = ownFacility(req);
  const { id } = parse(IdParam, req.params);
  res.json(
    await creditNoteDetail(and(eq(creditNotes.id, id), eq(creditNotes.facilityId, facilityId))!),
  );
});

/* ------------------------------------------------------------------ changes ------------------ */

/**
 * Locks an invoice and its subscription, in the order every change of an invoice takes (invoice
 * first), so that two corrections of the same invoice never work from the same figures.
 */
async function lockInvoice(tx: Executor, invoiceId: string) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for('update');
  if (!invoice) throw notFound('Invoice not found');
  const [subscription] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, invoice.subscriptionId))
    .for('update');
  return { invoice, subscription: subscription! };
}

const OPENED = {
  status: 'OPEN',
  paidAt: null,
  paymentMethod: null,
  paymentReference: null,
} as const;

/**
 * Reverses a payment recorded by mistake (a bounced transfer, the wrong invoice): the row stays,
 * marked reversed with the reason. A settled invoice that is no longer paid in full opens again –
 * the invoice trigger allows that only together with a reversal in the same transaction – and an
 * active subscription whose invoice is then overdue is past due again (never suspended here). An
 * invoice still settled by what remains (a credit note) keeps PAID, described by that.
 */
billingCorrectionsAdminRouter.post('/payments/:id/reverse', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReverseInput, req.body);
  await ensureRecentAuth(req);
  const meta = requestMeta(req);
  const invoiceId = await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ invoiceId: invoicePayments.invoiceId })
      .from(invoicePayments)
      .where(eq(invoicePayments.id, id));
    if (!found) throw notFound('Payment not found');
    const { invoice, subscription } = await lockInvoice(tx, found.invoiceId);
    const [payment] = await tx
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.id, id))
      .for('update');
    if (payment!.reversedAt) throw conflict('This payment was already reversed');
    await tx
      .update(invoicePayments)
      .set({ reversedAt: sql`now()`, reversedById: ctx.userId, reversalReason: reason })
      .where(eq(invoicePayments.id, id));
    let reopened = false;
    if (invoice.status === 'PAID') {
      const settlement = await settlementOf(tx, invoice);
      if (!settlement) {
        await tx.update(invoices).set(OPENED).where(eq(invoices.id, invoice.id));
        reopened = true;
      } else if (
        settlement.paidAt.getTime() !== invoice.paidAt?.getTime() ||
        settlement.paymentMethod !== invoice.paymentMethod ||
        settlement.paymentReference !== invoice.paymentReference
      ) {
        // Still settled, but no longer by the reversed payment: the details follow what settles
        // it now. The trigger lets a paid invoice change only by opening (with this reversal);
        // settling it again is an ordinary change of an open invoice.
        await tx.update(invoices).set(OPENED).where(eq(invoices.id, invoice.id));
        await tx
          .update(invoices)
          .set({ status: 'PAID', ...settlement })
          .where(eq(invoices.id, invoice.id));
      }
    }
    await recordEvent(tx, {
      subscription,
      type: 'PAYMENT_RECORDED',
      actor: ctx,
      data: {
        reversal: true,
        invoiceId: invoice.id,
        paymentId: payment!.id,
        number: invoice.number,
        amountCents: payment!.amountCents,
        currency: invoice.currency,
        method: payment!.method,
        paidAt: payment!.paidAt,
        reopened,
      },
      note: reason,
    });
    await audit(
      {
        action: AuditAction.BILLING_PAYMENT_REVERSED,
        actor: ctx,
        resourceType: 'invoice',
        resourceId: invoice.id,
        meta,
        metadata: {
          paymentId: payment!.id,
          number: invoice.number,
          facilityId: invoice.facilityId,
          amountCents: payment!.amountCents,
          reopened,
        },
      },
      tx,
    );
    if (reopened) await standingAfterReversal(tx, subscription, { actor: ctx, meta });
    return invoice.id;
  });
  res.json(await accountView(await invoiceRow(eq(invoices.id, invoiceId)), 'admin'));
});

/**
 * Issues a credit note for part or all of an invoice that is not voided: at most the invoice
 * total less earlier credit notes. Issuer and customer are those of the invoice (not today's
 * settings), the VAT is split at the invoice's rate. A credit note that brings the balance to 0
 * settles an open invoice (method CREDIT_NOTE); on an invoice already paid it is money to give
 * back ("to refund"), which happens outside Pacient. The facility's directors are told, and the
 * document is e-mailed with the invoice's recipients.
 */
billingCorrectionsAdminRouter.post('/invoices/:id/credit-notes', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(CreditNoteInput, req.body);
  await ensureRecentAuth(req);
  const meta = requestMeta(req);
  const noteId = await db.transaction(async (tx) => {
    const { invoice, subscription } = await lockInvoice(tx, id);
    if (invoice.status === 'VOID') {
      throw conflict('A voided invoice is not owed, so there is nothing to credit');
    }
    const [earlier] = await tx
      .select({
        netCents: sql<number>`coalesce(sum(${creditNotes.netCents}), 0)::int`,
        taxCents: sql<number>`coalesce(sum(${creditNotes.taxCents}), 0)::int`,
        totalCents: sql<number>`coalesce(sum(${creditNotes.totalCents}), 0)::int`,
      })
      .from(creditNotes)
      .where(eq(creditNotes.invoiceId, invoice.id));
    const creditable = invoice.totalCents - earlier!.totalCents;
    if (creditable <= 0) throw conflict('Nothing is left to credit on this invoice');
    if (input.amountCents > creditable) {
      throw conflict(
        'A credit note cannot be more than the invoice total less its earlier credit notes',
      );
    }
    const before = await accountOf(tx, invoice);
    const now = new Date();
    const settings = await settingsOf(tx);
    const { number, year, seq } = await nextCreditNoteNumber(tx, settings.invoicePrefix, now);
    const [note] = await tx
      .insert(creditNotes)
      .values({
        number,
        year,
        seq,
        invoiceId: invoice.id,
        facilityId: invoice.facilityId,
        subscriptionId: invoice.subscriptionId,
        reason: input.reason,
        ...creditSplit(invoice, earlier!, input.amountCents),
        totalCents: input.amountCents,
        vatRateBp: invoice.taxRateBp,
        currency: invoice.currency,
        issuer: invoice.issuer,
        customer: invoice.customer,
        issuedAt: now,
        createdById: ctx.userId,
      })
      .returning();
    const settled = invoice.status === 'OPEN' && input.amountCents >= before.balanceCents;
    if (settled) {
      await tx
        .update(invoices)
        .set({
          status: 'PAID',
          paidAt: now,
          paymentMethod: 'CREDIT_NOTE',
          paymentReference: number,
        })
        .where(eq(invoices.id, invoice.id));
    }
    const toRefundCents = Math.max(
      0,
      before.paidCents + before.creditedCents + input.amountCents - invoice.totalCents,
    );
    // Not an invoice, but issued like one: the history shows it as a credit note (no invoiceId,
    // so it is never taken for the invoice's own entry).
    await recordEvent(tx, {
      subscription,
      type: 'INVOICE_ISSUED',
      actor: ctx,
      data: {
        creditNote: true,
        creditNoteId: note!.id,
        number,
        invoiceNumber: invoice.number,
        totalCents: input.amountCents,
        currency: invoice.currency,
        settled,
        toRefundCents,
      },
      note: input.reason,
      at: now,
    });
    await audit(
      {
        action: AuditAction.BILLING_CREDIT_NOTE_ISSUED,
        actor: ctx,
        resourceType: 'credit_note',
        resourceId: note!.id,
        meta,
        metadata: {
          number,
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          facilityId: invoice.facilityId,
          totalCents: input.amountCents,
          settled,
          toRefundCents,
        },
      },
      tx,
    );
    await queueBillingDocument(tx, { creditNoteId: note!.id, kind: 'ISSUED', actor: ctx });
    await notifyDirectors(
      tx,
      invoice.facilityId,
      'Your facility’s subscription: credit note {number} was issued',
      { number },
    );
    if (settled) {
      await restoreStanding(tx, subscription, { actor: ctx, meta, now, reason: 'credited' });
    }
    return note!.id;
  });
  res.status(201).json(await creditNoteDetail(eq(creditNotes.id, noteId)));
});
