import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  billingDeliveries,
  creditNotes,
  emailOutbox,
  facilityBillingProfiles,
  invoicePayments,
  invoices,
  legalDocuments,
  operatorRequestMessages,
  operatorRequests,
  organizationAcceptances,
  subscriptionPlans,
  subscriptions,
} from '../src/db/schema.js';
import { createFacility, createUser } from './helpers.js';

/**
 * The database rules of migration 0028 that no route enforces on its own: payments, credit notes
 * and deliveries are kept as written; a settled invoice reopens only when a payment is reversed in
 * the same transaction; agreements' acceptances and request messages are append-only.
 */
const DAY = 86_400_000;
let facilityId: string;
let subscriptionId: string;
let adminId: string;
let directorId: string;

async function newInvoice(status: 'OPEN' | 'PAID' = 'OPEN') {
  const now = new Date();
  const [row] = await db
    .insert(invoices)
    .values({
      number: `T-${randomUUID().slice(0, 12)}`,
      facilityId,
      subscriptionId,
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * DAY),
      description: 'Test plan',
      netCents: 10_000,
      totalCents: 10_000,
      dueAt: new Date(now.getTime() + 14 * DAY),
      issuer: { name: 'Operator' },
      customer: { name: 'Facility' },
      status,
      ...(status === 'PAID' ? { paidAt: now, paymentMethod: 'CASH' } : {}),
    })
    .returning();
  return row!;
}

async function pay(invoiceId: string, amountCents = 10_000) {
  const [row] = await db
    .insert(invoicePayments)
    .values({ invoiceId, amountCents, paidAt: new Date(), method: 'CASH', recordedById: adminId })
    .returning();
  return row!;
}

const reverse = () => ({
  reversedAt: sql`now()`,
  reversedById: adminId,
  reversalReason: 'Recorded twice',
});

beforeAll(async () => {
  const f = await createFacility();
  facilityId = f.id;
  adminId = (await createUser('ADMIN')).id;
  directorId = (await createUser('DIRECTOR', f.id)).id;
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      code: `T-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Test plan',
      monthlyPriceCents: 10_000,
      yearlyPriceCents: 100_000,
    })
    .returning();
  const [s] = await db
    .insert(subscriptions)
    .values({
      facilityId,
      planId: plan!.id,
      status: 'ACTIVE',
      priceCents: 10_000,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    })
    .returning();
  subscriptionId = s!.id;
});

describe('payments', () => {
  it('are never changed or deleted, and reversed once', async () => {
    const invoice = await newInvoice();
    const p = await pay(invoice.id);
    await expect(
      db.update(invoicePayments).set({ amountCents: 1 }).where(eq(invoicePayments.id, p.id)),
    ).rejects.toThrow();
    await expect(db.delete(invoicePayments).where(eq(invoicePayments.id, p.id))).rejects.toThrow();
    // The three reversal columns go together.
    await expect(
      db
        .update(invoicePayments)
        .set({ reversedAt: new Date() })
        .where(eq(invoicePayments.id, p.id)),
    ).rejects.toThrow();
    await db.update(invoicePayments).set(reverse()).where(eq(invoicePayments.id, p.id));
    await expect(
      db
        .update(invoicePayments)
        .set({ reversalReason: 'Another reason' })
        .where(eq(invoicePayments.id, p.id)),
    ).rejects.toThrow();
    await expect(pay(invoice.id, 0)).rejects.toThrow();
  });

  it('are never recorded already reversed (a settled invoice could reopen without one)', async () => {
    const invoice = await newInvoice();
    const err = await db
      .insert(invoicePayments)
      .values({
        invoiceId: invoice.id,
        amountCents: 10_000,
        paidAt: new Date(),
        method: 'CASH',
        recordedById: adminId,
        ...reverse(),
      })
      .then(
        () => null,
        (e: unknown) => e as { cause?: { message?: string } },
      );
    expect(err?.cause?.message).toMatch(/recorded first and reversed afterwards/);
  });
});

describe('a settled invoice', () => {
  const reopen = {
    status: 'OPEN' as const,
    paidAt: null,
    paymentMethod: null,
    paymentReference: null,
  };

  it('opens again only when one of its payments is reversed in the same transaction', async () => {
    const invoice = await newInvoice('PAID');
    const p = await pay(invoice.id);
    await expect(
      db.update(invoices).set(reopen).where(eq(invoices.id, invoice.id)),
    ).rejects.toThrow();

    await db.transaction(async (tx) => {
      await tx.update(invoicePayments).set(reverse()).where(eq(invoicePayments.id, p.id));
      await tx.update(invoices).set(reopen).where(eq(invoices.id, invoice.id));
    });
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(after!.status).toBe('OPEN');
    expect(after!.paidAt).toBeNull();
  });

  it('keeps its payment details unless it reopens with them cleared, and never becomes void', async () => {
    const invoice = await newInvoice('PAID');
    const p = await pay(invoice.id);
    await expect(
      db.transaction(async (tx) => {
        await tx.update(invoicePayments).set(reverse()).where(eq(invoicePayments.id, p.id));
        await tx.update(invoices).set({ status: 'OPEN' }).where(eq(invoices.id, invoice.id));
      }),
    ).rejects.toThrow();
    await expect(
      db
        .update(invoices)
        .set({ status: 'VOID', voidReason: 'x', voidedAt: new Date() })
        .where(eq(invoices.id, invoice.id)),
    ).rejects.toThrow();
    // A reversal from an earlier transaction does not reopen it later.
    await db.update(invoicePayments).set(reverse()).where(eq(invoicePayments.id, p.id));
    await expect(
      db.update(invoices).set(reopen).where(eq(invoices.id, invoice.id)),
    ).rejects.toThrow();
  });
});

describe('credit notes and deliveries', () => {
  it('keeps an issued credit note as it is, and refuses one for nothing', async () => {
    const invoice = await newInvoice();
    const values = {
      number: `T-CN-${randomUUID().slice(0, 10)}`,
      year: 2099,
      seq: Math.floor(Math.random() * 1e9),
      invoiceId: invoice.id,
      facilityId,
      subscriptionId,
      reason: 'Price agreed after issue',
      netCents: 1_000,
      taxCents: 0,
      totalCents: 1_000,
      vatRateBp: 0,
      issuer: invoice.issuer,
      customer: invoice.customer,
      createdById: adminId,
    };
    const [cn] = await db.insert(creditNotes).values(values).returning();
    await expect(
      db.update(creditNotes).set({ reason: 'Rewritten' }).where(eq(creditNotes.id, cn!.id)),
    ).rejects.toThrow();
    await expect(db.delete(creditNotes).where(eq(creditNotes.id, cn!.id))).rejects.toThrow();
    await expect(
      db.insert(creditNotes).values({
        ...values,
        number: `${values.number}-0`,
        seq: values.seq + 1,
        netCents: 0,
        totalCents: 0,
      }),
    ).rejects.toThrow();
  });

  it('records a delivery of exactly one document and keeps it', async () => {
    const invoice = await newInvoice();
    const [mail] = await db
      .insert(emailOutbox)
      .values({
        toEmail: 'billing@facility.test',
        template: 'billing_document',
        attachmentKind: 'invoice',
        attachmentId: invoice.id,
      })
      .returning();
    const [d] = await db
      .insert(billingDeliveries)
      .values({
        invoiceId: invoice.id,
        kind: 'ISSUED',
        recipient: 'billing@facility.test',
        emailOutboxId: mail!.id,
      })
      .returning();
    await expect(
      db.update(billingDeliveries).set({ kind: 'RESEND' }).where(eq(billingDeliveries.id, d!.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(billingDeliveries).where(eq(billingDeliveries.id, d!.id)),
    ).rejects.toThrow();
    await expect(
      db.insert(billingDeliveries).values({
        kind: 'ISSUED',
        recipient: 'billing@facility.test',
        emailOutboxId: mail!.id,
      }),
    ).rejects.toThrow();
    // An attachment names both its kind and its document.
    await expect(
      db
        .insert(emailOutbox)
        .values({ toEmail: 'x@y.test', template: 'billing_document', attachmentKind: 'invoice' }),
    ).rejects.toThrow();
  });

  it('takes at most three billing e-mails of a sensible length', async () => {
    const f = await createFacility();
    const profile = { facilityId: f.id, legalName: 'Clinic LLC' };
    await expect(
      db
        .insert(facilityBillingProfiles)
        .values({ ...profile, billingEmails: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'] }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(facilityBillingProfiles)
        .values({ ...profile, billingEmails: [`${'a'.repeat(250)}@x.test`] }),
    ).rejects.toThrow();
    await db
      .insert(facilityBillingProfiles)
      .values({ ...profile, billingEmails: ['a@x.test', 'b@x.test', 'c@x.test'] });
  });
});

describe('agreements and requests', () => {
  it('keeps a facility’s acceptance of an agreement as given, for agreements only', async () => {
    const [doc] = await db
      .insert(legalDocuments)
      .values({
        kind: 'TERMS',
        version: `t-${randomUUID().slice(0, 8)}`,
        locale: 'en',
        title: 'Terms',
        body: 'Test terms that are long enough.',
        publishedAt: new Date(),
      })
      .returning();
    const acceptance = {
      facilityId,
      documentId: doc!.id,
      version: doc!.version,
      acceptedById: directorId,
      signerName: 'A. Director',
      signerTitle: 'Director',
    };
    await expect(
      db.insert(organizationAcceptances).values({ ...acceptance, kind: 'TERMS' }),
    ).rejects.toThrow();
    const [row] = await db
      .insert(organizationAcceptances)
      .values({ ...acceptance, kind: 'DPA' })
      .returning();
    await expect(
      db
        .update(organizationAcceptances)
        .set({ signerName: 'Someone else' })
        .where(eq(organizationAcceptances.id, row!.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(organizationAcceptances).where(eq(organizationAcceptances.id, row!.id)),
    ).rejects.toThrow();
  });

  it('keeps request messages and the resolved time consistent', async () => {
    const [request] = await db
      .insert(operatorRequests)
      .values({
        reference: `REQ-T-${randomUUID().slice(0, 8)}`,
        facilityId,
        requesterId: directorId,
        category: 'TECHNICAL',
        subject: 'Printer settings',
      })
      .returning();
    await expect(
      db
        .update(operatorRequests)
        .set({ status: 'RESOLVED' })
        .where(eq(operatorRequests.id, request!.id)),
    ).rejects.toThrow();
    await db
      .update(operatorRequests)
      .set({ status: 'RESOLVED', resolvedAt: new Date() })
      .where(eq(operatorRequests.id, request!.id));

    const [message] = await db
      .insert(operatorRequestMessages)
      .values({ requestId: request!.id, authorId: directorId, body: 'The printer is offline.' })
      .returning();
    await expect(
      db
        .update(operatorRequestMessages)
        .set({ body: 'Edited' })
        .where(eq(operatorRequestMessages.id, message!.id)),
    ).rejects.toThrow();
    await expect(
      db.insert(operatorRequestMessages).values({
        requestId: request!.id,
        authorId: directorId,
        body: 'x'.repeat(4001),
      }),
    ).rejects.toThrow();
  });
});
