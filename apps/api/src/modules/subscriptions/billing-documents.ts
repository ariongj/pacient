import { createRequire } from 'node:module';
import { and, asc, eq, sql } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { db, type Executor } from '../../db/client.js';
import {
  billingDeliveries,
  creditNotes,
  facilityBillingProfiles,
  invoices,
  subscriptionEvents,
  users,
} from '../../db/schema.js';
import { DEFAULT_LOCALE, toLocale, tr, type Locale, type TrVars } from '../../i18n/index.js';
import { notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';
import { enqueueEmail } from '../email/outbox.js';
import type { BillingDocumentEmail } from '../email/templates.js';
import { lastDayOf } from './subscriptions.service.js';

/**
 * Billing documents: the PDF of an issued invoice or credit note, and e-mailing it to the
 * customer. Declared by the round 2 scaffold so that every module can call them; builder B1
 * implements them (B2 calls them for credit notes). The contracts below are binding.
 *
 * Nothing PDF-shaped is stored: a queued e-mail names its document (email_outbox.attachment_kind
 * and attachment_id) and the e-mail worker renders the PDF from the immutable invoice or credit
 * note when it sends.
 */

/** Why a document is sent: on issue, as an overdue reminder, or again by the administrator. */
export type BillingDeliveryKind = 'ISSUED' | 'REMINDER' | 'RESEND';

export interface QueueBillingDocumentInput {
  /** The invoice to send. Exactly one of invoiceId and creditNoteId is given. */
  invoiceId?: string;
  /** The credit note to send. */
  creditNoteId?: string;
  kind: BillingDeliveryKind;
  /** The administrator who asked for it (RESEND); null or absent when the system sends it. */
  actor?: Pick<AuthContext, 'userId'> | null;
}

type InvoiceRow = typeof invoices.$inferSelect;
type CreditNoteRow = typeof creditNotes.$inferSelect;

/* ------------------------------------------------------------------ formatting -------------- */

/*
 * Documents print calendar dates in Kosovo (Europe/Belgrade) as "24.11.2026" in every language,
 * and amounts as the language writes them: "1 234,50 €" (Albanian), "1.234,50 €" (Serbian),
 * "€1,234.50" (English).
 */
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Belgrade',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** "24.11.2026": the calendar day of an instant in Kosovo. */
export const documentDate = (d: Date) => dayFormat.format(d).replace(/\//g, '.');

/** "01.12.2026 – 31.12.2026": a period's first and last day (its end is exclusive). */
export const documentPeriod = (start: Date, end: Date) =>
  `${documentDate(start)} – ${documentDate(lastDayOf(end))}`;

/** A no-break space: keeps an amount or a rate on one line. */
const NBSP = String.fromCharCode(0xa0);

/** An amount in cents as the language writes it. */
export function documentMoney(cents: number, currency: string, locale: Locale): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const decimals = String(abs % 100).padStart(2, '0');
  const group = locale === 'en' ? ',' : locale === 'sr' ? '.' : NBSP;
  const units = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const symbol = currency === 'EUR' ? '€' : currency;
  return locale === 'en'
    ? `${sign}${symbol}${units}.${decimals}`
    : `${sign}${units},${decimals}${NBSP}${symbol}`;
}

/** A VAT rate in basis points: "18 %", "18,5 %" (Albanian and Serbian), "18.5 %" (English). */
export function documentRate(bp: number, locale: Locale): string {
  const value = String(bp / 100);
  return `${locale === 'en' ? value : value.replace('.', ',')}${NBSP}%`;
}

/* ------------------------------------------------------------------ content ----------------- */

/**
 * What a billing document says, line by line, in one language: the PDF draws exactly this. Kept
 * apart from the drawing so that it can be read (and checked) as text.
 */
export interface BillingDocumentContent {
  /** File name of the PDF ("PAC-2026-00001.pdf"). */
  filename: string;
  /** "INVOICE" or "CREDIT NOTE" in the document's language. */
  title: string;
  number: string;
  /** The operator: name first, then address, numbers and contacts. */
  issuer: string[];
  /** Number, issue date, due date, service period. */
  meta: [string, string][];
  customerLabel: string;
  /** The customer as frozen on the document: name first. */
  customer: string[];
  /** Credit notes: which invoice they correct, and why. */
  intro: string[];
  table: { head: [string, string, string]; rows: [string, string, string][] };
  /** Net, VAT (or "Not registered for VAT") and the total, which is last. */
  totals: [string, string][];
  /** How to pay (invoices) or what the credit note does. */
  payment: string[];
  /** "Paid on …" or "Voided on …" when the invoice is no longer open. */
  status: string | null;
  footer: string;
}

const present = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');

type Translate = (text: string, vars?: TrVars) => string;

function issuerLines(issuer: Record<string, string | null>, L: Translate) {
  return [
    issuer.name || '—',
    ...present(
      issuer.address,
      issuer.fiscalNumber && `${L('Fiscal number (NUI)')}: ${issuer.fiscalNumber}`,
      issuer.vatNumber && `${L('VAT number')}: ${issuer.vatNumber}`,
      issuer.email,
      issuer.phone,
    ),
  ];
}

/**
 * The customer as it was when the document was issued: the legal entity of the facility's
 * billing details when it had them, otherwise the facility itself.
 */
function customerLines(customer: Record<string, string | null>, L: Translate) {
  const name = customer.legalName || customer.name || '—';
  const place = present(customer.municipality, customer.region).join(', ');
  return [
    name,
    ...present(
      customer.legalName && customer.name && customer.legalName !== customer.name
        ? `${L('Facility')}: ${customer.name}`
        : null,
      ...(customer.billingAddress ? [customer.billingAddress] : [customer.address, place]),
      customer.businessNumber && `${L('Business number (NUI)')}: ${customer.businessNumber}`,
      customer.fiscalNumber && `${L('Fiscal number')}: ${customer.fiscalNumber}`,
      customer.vatNumber && `${L('VAT number')}: ${customer.vatNumber}`,
      customer.code && `${L('Facility code')}: ${customer.code}`,
      customer.customerReference && `${L('Your reference')}: ${customer.customerReference}`,
    ),
  ];
}

const footerOf = (issuer: Record<string, string | null>) =>
  present(issuer.name, issuer.email, issuer.phone).join(' · ');

/** The plan and cycle an invoice was issued for (its INVOICE_ISSUED history entry). */
async function lineOf(executor: Executor, invoiceId: string) {
  const [row] = await executor
    .select({ data: subscriptionEvents.data })
    .from(subscriptionEvents)
    .where(
      and(
        eq(subscriptionEvents.type, 'INVOICE_ISSUED'),
        eq(sql`${subscriptionEvents.data}->>'invoiceId'`, invoiceId),
      ),
    )
    .limit(1);
  const data = row?.data as { planName?: unknown; cycle?: unknown } | undefined;
  return typeof data?.planName === 'string'
    ? { planName: data.planName, yearly: data.cycle === 'YEARLY' }
    : null;
}

async function loadInvoice(executor: Executor, id: string) {
  const [invoice] = await executor.select().from(invoices).where(eq(invoices.id, id));
  if (!invoice) throw notFound('Invoice not found');
  return invoice;
}

async function loadCreditNote(executor: Executor, id: string) {
  const [creditNote] = await executor.select().from(creditNotes).where(eq(creditNotes.id, id));
  if (!creditNote) throw notFound('Credit note not found');
  const invoice = await loadInvoice(executor, creditNote.invoiceId);
  return { creditNote, invoice };
}

function invoiceContent(
  inv: InvoiceRow,
  line: { planName: string; yearly: boolean } | null,
  locale: Locale,
): BillingDocumentContent {
  const L: Translate = (text, vars) => tr(locale, text, vars);
  const money = (cents: number) => documentMoney(cents, inv.currency, locale);
  const period = documentPeriod(inv.periodStart, inv.periodEnd);
  const description = line
    ? L('Subscription to the Pacient service: {line}', {
        line: L(line.yearly ? '{plan} plan – yearly' : '{plan} plan – monthly', {
          plan: line.planName,
        }),
      })
    : inv.description;
  const vat = inv.taxRateBp > 0;
  const iban = inv.issuer.iban;
  const payment =
    inv.totalCents === 0
      ? [L('There is nothing to pay.')]
      : present(
          L('Please pay {amount} by bank transfer by {date}.', {
            amount: money(inv.totalCents),
            date: documentDate(inv.dueAt),
          }),
          inv.issuer.bank && `${L('Bank')}: ${inv.issuer.bank}`,
          `IBAN: ${iban || '—'}`,
          `${L('Payment reference')}: ${inv.number}`,
        );
  let status: string | null = null;
  if (inv.status === 'PAID' && inv.totalCents > 0 && inv.paidAt) {
    status = L('Paid on {date}', { date: documentDate(inv.paidAt) });
  }
  if (inv.status === 'VOID') {
    status = present(
      L('Voided on {date}', { date: inv.voidedAt ? documentDate(inv.voidedAt) : '—' }),
      inv.voidReason,
    ).join(' · ');
  }
  return {
    filename: `${inv.number}.pdf`,
    title: L('INVOICE'),
    number: inv.number,
    issuer: issuerLines(inv.issuer, L),
    meta: [
      [L('No.'), inv.number],
      [L('Issued'), documentDate(inv.issuedAt)],
      [L('Due date'), documentDate(inv.dueAt)],
      [L('Service period'), period],
    ],
    customerLabel: L('Bill to'),
    customer: customerLines(inv.customer, L),
    intro: [],
    table: {
      head: [L('Description'), L('Period'), L('Amount')],
      rows: [[description, period, money(inv.netCents)]],
    },
    // Without VAT registration the document says so instead of printing "VAT 0 %".
    totals: vat
      ? [
          [L('Amount without VAT'), money(inv.netCents)],
          [L('VAT {rate}', { rate: documentRate(inv.taxRateBp, locale) }), money(inv.taxCents)],
          [L('Total to pay'), money(inv.totalCents)],
        ]
      : [
          [L('Not registered for VAT'), ''],
          [L('Total to pay'), money(inv.totalCents)],
        ],
    payment,
    status,
    footer: footerOf(inv.issuer),
  };
}

function creditNoteContent(
  cn: CreditNoteRow,
  inv: InvoiceRow,
  locale: Locale,
): BillingDocumentContent {
  const L: Translate = (text, vars) => tr(locale, text, vars);
  const money = (cents: number) => documentMoney(cents, cn.currency, locale);
  const period = documentPeriod(inv.periodStart, inv.periodEnd);
  const vat = cn.vatRateBp > 0;
  return {
    filename: `${cn.number}.pdf`,
    title: L('CREDIT NOTE'),
    number: cn.number,
    issuer: issuerLines(cn.issuer, L),
    meta: [
      [L('No.'), cn.number],
      [L('Issued'), documentDate(cn.issuedAt)],
      [L('Invoice'), inv.number],
      [L('Service period'), period],
    ],
    customerLabel: L('Customer'),
    customer: customerLines(cn.customer, L),
    intro: [
      L('Credit note for invoice {number}', { number: inv.number }),
      `${L('Reason')}: ${cn.reason}`,
    ],
    table: {
      head: [L('Description'), L('Period'), L('Amount')],
      rows: [
        [L('Correction of invoice {number}', { number: inv.number }), period, money(cn.netCents)],
      ],
    },
    totals: vat
      ? [
          [L('Amount without VAT'), money(cn.netCents)],
          [L('VAT {rate}', { rate: documentRate(cn.vatRateBp, locale) }), money(cn.taxCents)],
          [L('Total credited'), money(cn.totalCents)],
        ]
      : [
          [L('Not registered for VAT'), ''],
          [L('Total credited'), money(cn.totalCents)],
        ],
    payment: [
      L('This credit note reduces the amount of invoice {number} by {amount}.', {
        number: inv.number,
        amount: money(cn.totalCents),
      }),
    ],
    status: null,
    footer: footerOf(cn.issuer),
  };
}

/** What the PDF of an invoice says, in `locale`. Throws notFound for an unknown id. */
export async function invoiceDocumentContent(id: string, locale: Locale, executor: Executor = db) {
  const invoice = await loadInvoice(executor, id);
  return invoiceContent(invoice, await lineOf(executor, id), locale);
}

/** What the PDF of a credit note says, in `locale`. Throws notFound for an unknown id. */
export async function creditNoteDocumentContent(
  id: string,
  locale: Locale,
  executor: Executor = db,
) {
  const { creditNote, invoice } = await loadCreditNote(executor, id);
  return creditNoteContent(creditNote, invoice, locale);
}

/* ------------------------------------------------------------------ PDF --------------------- */

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 50;
const INK = '#111111';
const MUTED = '#555555';
const RULE = '#bbbbbb';

/** Draws the content on one A4 page (a very long reason may run onto a second). */
function drawPdf(c: BillingDocumentContent, locale: Locale): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    // A small bottom margin leaves room for the footer line without starting a new page.
    margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: 30 },
    font: PDF_FONTS.regular,
    lang: locale,
    info: {
      Title: `${c.title} ${c.number}`,
      Author: c.issuer[0] ?? '',
      Creator: 'Pacient',
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('regular', PDF_FONTS.regular);
  doc.registerFont('bold', PDF_FONTS.bold);

  const left = MARGIN;
  const right = A4_WIDTH - MARGIN;
  const width = right - left;
  const regular = (size: number, color = INK) =>
    doc.font('regular').fontSize(size).fillColor(color);
  const bold = (size: number, color = INK) => doc.font('bold').fontSize(size).fillColor(color);
  const rule = (y: number, x1 = left, x2 = right, weight = 0.6, color = RULE) =>
    doc.moveTo(x1, y).lineTo(x2, y).lineWidth(weight).strokeColor(color).stroke();

  // The operator (left) and the document's title and dates (right, label and value per row).
  const issuerWidth = 250;
  bold(13).text(c.issuer[0] ?? '', left, MARGIN, { width: issuerWidth });
  regular(9);
  for (const line of c.issuer.slice(1)) doc.text(line, { width: issuerWidth });
  const issuerBottom = doc.y;
  const titleX = left + issuerWidth + 15;
  const titleWidth = right - titleX;
  const labelWidth = 95;
  bold(20).text(c.title, titleX, MARGIN, { width: titleWidth, align: 'right' });
  let metaY = doc.y + 6;
  for (const [label, value] of c.meta) {
    regular(9, MUTED).text(label, titleX, metaY, { width: labelWidth });
    const labelBottom = doc.y;
    bold(9).text(value, titleX + labelWidth, metaY, {
      width: titleWidth - labelWidth,
      align: 'right',
    });
    metaY = Math.max(labelBottom, doc.y) + 2;
  }
  let y = Math.max(issuerBottom, metaY) + 26;

  // The customer.
  regular(8, MUTED).text(c.customerLabel.toUpperCase(), left, y, { characterSpacing: 0.5 });
  bold(11).text(c.customer[0] ?? '', { width: 320 });
  regular(9);
  for (const line of c.customer.slice(1)) doc.text(line, { width: 320 });
  y = doc.y + 18;

  // What a credit note corrects.
  if (c.intro.length) {
    bold(10).text(c.intro[0]!, left, y, { width });
    regular(9);
    for (const line of c.intro.slice(1)) doc.text(line, { width });
    y = doc.y + 14;
  }

  // The lines.
  const cols = [
    { x: left, w: 255, align: 'left' as const },
    { x: left + 265, w: 140, align: 'left' as const },
    { x: left + 415, w: width - 415, align: 'right' as const },
  ];
  c.table.head.forEach((h, i) =>
    regular(8, MUTED).text(h.toUpperCase(), cols[i]!.x, y, {
      width: cols[i]!.w,
      align: cols[i]!.align,
    }),
  );
  y = doc.y + 4;
  rule(y);
  y += 6;
  for (const row of c.table.rows) {
    let bottom = y;
    row.forEach((cell, i) => {
      regular(9.5).text(cell, cols[i]!.x, y, { width: cols[i]!.w, align: cols[i]!.align });
      bottom = Math.max(bottom, doc.y);
    });
    y = bottom + 6;
    rule(y);
    y += 8;
  }

  // The totals, on the right; the last one is the total.
  const labelX = left + 230;
  const valueX = left + 405;
  c.totals.forEach(([label, value], i) => {
    const last = i === c.totals.length - 1;
    if (last) {
      rule(y, labelX, right, 1, INK);
      y += 5;
    }
    (last ? bold(11.5) : regular(9.5)).text(label, labelX, y, { width: valueX - labelX - 10 });
    const labelBottom = doc.y;
    (last ? bold(11.5) : regular(9.5)).text(value, valueX, y, {
      width: right - valueX,
      align: 'right',
    });
    y = Math.max(labelBottom, doc.y) + 4;
  });
  y += 14;

  // How to pay, or what the credit note does, in a box.
  if (c.payment.length) {
    const boxTop = y;
    regular(9.5);
    let textY = boxTop + 8;
    for (const line of c.payment) {
      doc.text(line, left + 10, textY, { width: width - 20 });
      textY = doc.y + 2;
    }
    const boxBottom = textY + 6;
    doc
      .roundedRect(left, boxTop, width, boxBottom - boxTop, 3)
      .lineWidth(0.6)
      .strokeColor(RULE)
      .stroke();
    y = boxBottom + 14;
  }
  if (c.status) {
    bold(11).text(c.status, left, y, { width });
  }

  // The footer on the bottom of the (first) page.
  regular(7.5, MUTED).text(c.footer, left, A4_HEIGHT - 45, { width, align: 'center' });
  doc.end();
  return done;
}

/**
 * The PDF of an issued invoice in `locale` (labels in sq, sr or en; default sq): A4, the operator
 * header, the customer as frozen on the invoice, number, issue date, supply period, lines, net,
 * VAT rate and amount (or "Not registered for VAT" when the rate is 0), total, due date, IBAN and
 * "reference: <number>", in the bundled font (PDF_FONTS). Throws notFound for an unknown id.
 * Access checks are the caller's (an administrator, or a director of that facility).
 */
export async function renderInvoicePdf(id: string, locale: Locale): Promise<Buffer> {
  return drawPdf(await invoiceDocumentContent(id, locale), locale);
}

/**
 * The PDF of a credit note in `locale`, like an invoice, with "Credit note for invoice <number>"
 * and the reason. Throws notFound for an unknown id.
 */
export async function renderCreditNotePdf(id: string, locale: Locale): Promise<Buffer> {
  return drawPdf(await creditNoteDocumentContent(id, locale), locale);
}

/** A document as an e-mail attachment (the outbox worker calls this when it sends). */
export async function billingAttachment(
  kind: 'invoice' | 'credit_note',
  id: string,
  locale: Locale,
) {
  const content =
    kind === 'invoice'
      ? await invoiceDocumentContent(id, locale)
      : await creditNoteDocumentContent(id, locale);
  return {
    filename: content.filename,
    contentType: 'application/pdf',
    content: await drawPdf(content, locale),
  };
}

/* ------------------------------------------------------------------ e-mail ------------------ */

interface Recipient {
  email: string;
  userId: string | null;
  name: string | null;
  locale: Locale;
}

/**
 * Who receives a facility's billing documents: its active directors (in their own language) and
 * the billing e-mails of its billing details (Albanian), each address once whatever its case –
 * a billing address that is also a director's is the director's.
 */
async function recipientsOf(executor: Executor, facilityId: string): Promise<Recipient[]> {
  const directors = await executor
    .select({ id: users.id, email: users.email, fullName: users.fullName, locale: users.locale })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    )
    .orderBy(asc(users.email));
  const [profile] = await executor
    .select({ billingEmails: facilityBillingProfiles.billingEmails })
    .from(facilityBillingProfiles)
    .where(eq(facilityBillingProfiles.facilityId, facilityId));
  const byAddress = new Map<string, Recipient>();
  for (const d of directors) {
    const key = d.email.trim().toLowerCase();
    if (!byAddress.has(key)) {
      byAddress.set(key, {
        email: d.email.trim(),
        userId: d.id,
        name: d.fullName,
        locale: toLocale(d.locale),
      });
    }
  }
  for (const address of profile?.billingEmails ?? []) {
    const key = address.trim().toLowerCase();
    if (key && !byAddress.has(key)) {
      byAddress.set(key, {
        email: address.trim(),
        userId: null,
        name: null,
        locale: DEFAULT_LOCALE,
      });
    }
  }
  return [...byAddress.values()];
}

type EmailFields = Omit<BillingDocumentEmail, 'template' | 'name' | 'kind'>;

/** The facts the e-mail states about the document, written in the recipient's language. */
function invoiceEmailFields(inv: InvoiceRow, locale: Locale): EmailFields {
  return {
    document: 'invoice',
    number: inv.number,
    operator: inv.issuer.name || 'Pacient',
    period: documentPeriod(inv.periodStart, inv.periodEnd),
    total: documentMoney(inv.totalCents, inv.currency, locale),
    dueDate: documentDate(inv.dueAt),
    iban: inv.issuer.iban ?? null,
    reference: inv.number,
    nothingToPay: inv.totalCents === 0,
    invoiceNumber: null,
  };
}

function creditNoteEmailFields(cn: CreditNoteRow, inv: InvoiceRow, locale: Locale): EmailFields {
  return {
    document: 'credit_note',
    number: cn.number,
    operator: cn.issuer.name || 'Pacient',
    period: documentPeriod(inv.periodStart, inv.periodEnd),
    total: documentMoney(cn.totalCents, cn.currency, locale),
    dueDate: null,
    iban: null,
    reference: null,
    nothingToPay: false,
    invoiceNumber: inv.number,
  };
}

/**
 * Queues the document by e-mail **in the caller's transaction** (it exists only if the change
 * that caused it commits):
 *
 *  - recipients: every billing e-mail of the facility's billing profile plus every active
 *    director of the facility, deduplicated case-insensitively;
 *  - one outbox message per recipient, template 'billing_document' in the recipient's language
 *    (a director's own locale; billing addresses without an account: sq), with number, period,
 *    total, due date, IBAN and payment reference, never clinical data; the PDF is attached when
 *    the message is sent (attachment_kind 'invoice' | 'credit_note', attachment_id);
 *  - one billing_deliveries row per message (kind, recipient, email_outbox_id, queued_by_id =
 *    actor's user id or null).
 *
 * Returns the number of messages queued (0 when there is nobody to send to; never throws for
 * that). Throws for an unknown document. It does not audit: a route that resends audits
 * billing.invoice_sent itself, in the same transaction.
 */
export async function queueBillingDocument(
  tx: Executor,
  input: QueueBillingDocumentInput,
): Promise<number> {
  if (Boolean(input.invoiceId) === Boolean(input.creditNoteId)) {
    throw new Error('queueBillingDocument needs exactly one of invoiceId and creditNoteId');
  }
  const document = input.invoiceId
    ? { invoice: await loadInvoice(tx, input.invoiceId), creditNote: null }
    : await loadCreditNote(tx, input.creditNoteId!);
  const recipients = await recipientsOf(tx, document.invoice.facilityId);
  for (const r of recipients) {
    const fields = document.creditNote
      ? creditNoteEmailFields(document.creditNote, document.invoice, r.locale)
      : invoiceEmailFields(document.invoice, r.locale);
    const emailOutboxId = await enqueueEmail(tx, {
      to: r.email,
      userId: r.userId,
      locale: r.locale,
      template: 'billing_document',
      name: r.name,
      kind: input.kind,
      ...fields,
      attachment: document.creditNote
        ? { kind: 'credit_note', id: document.creditNote.id }
        : { kind: 'invoice', id: document.invoice.id },
    });
    await tx.insert(billingDeliveries).values({
      invoiceId: document.creditNote ? null : document.invoice.id,
      creditNoteId: document.creditNote?.id ?? null,
      kind: input.kind,
      recipient: r.email,
      emailOutboxId,
      queuedById: input.actor?.userId ?? null,
    });
  }
  return recipients.length;
}

const require = createRequire(import.meta.url);

/**
 * TrueType fonts for billing PDFs (DejaVu Sans, from the dejavu-fonts-ttf package, a production
 * dependency; licence in its LICENSE file). The standard PDF fonts cannot print č, ć or đ.
 */
export const PDF_FONTS = {
  regular: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'),
  bold: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'),
} as const;
