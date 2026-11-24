import { Router, type Request, type Response } from 'express';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { creditNotes, invoicePayments, invoices, users } from '../../db/schema.js';
import { toLocale, tr, type Locale } from '../../i18n/index.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { ensureRecentAuth } from '../../middleware/recent-auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { accountsOf, lastDayOf, localInstant } from './subscriptions.service.js';

/**
 * Exports for the operator's accountant (CSV, UTF-8 with BOM, protected against spreadsheet
 * formulas). Round 2, builder B2.
 *
 * `billingExportsRouter` is mounted on /admin/exports (authenticated, ADMIN only). Every export
 * needs the password again (or a recent sign-in) and is audited as billing.exported with the
 * export and its period only:
 *   GET /admin/exports/invoices.csv?from&to, /payments.csv, /credit-notes.csv, /sales-book.csv
 *
 * The period is a range of calendar days in Kosovo (`from` and `to` included), as on the
 * documents. The files hold business data of the operator's customers – never anything about
 * patients. Column headers follow the administrator's language; the sales book is always in
 * Albanian (the format of the tax administration).
 */
export const billingExportsRouter = Router();

/* ------------------------------------------------------------------ period ------------------- */

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a valid date');
/** The same day a year later: a period ends before it (a whole leap year still fits). */
const yearAfter = (day: string) => `${Number(day.slice(0, 4)) + 1}${day.slice(4)}`;
const PeriodQuery = z
  .object({ from: Day, to: Day })
  .refine((p) => p.from <= p.to, { message: 'The period ends before it starts', path: ['to'] })
  .refine((p) => p.to < yearAfter(p.from), {
    message: 'An export covers at most one year',
    path: ['to'],
  });
type Period = z.infer<typeof PeriodQuery>;

/** The instants of a period: from the start of `from` to the end of `to`, in Kosovo. */
function bounds(p: Period) {
  const [fy, fm, fd] = p.from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = p.to.split('-').map(Number) as [number, number, number];
  return { start: localInstant(fy, fm, fd), end: localInstant(ty, tm, td + 1) };
}

/* ------------------------------------------------------------------ CSV ---------------------- */

/** A cell: text, or a number/amount written as it is. */
type Cell = string | number | null | undefined;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Every cell quoted; text that a spreadsheet would run as a formula (=, +, -, @, tab, CR at the
 * start) gets a leading apostrophe and stays text. Plain numbers – negative amounts included –
 * are not formulas and stay numbers.
 */
function csvCell(value: Cell) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Comma-separated, every cell quoted, CRLF lines, with a UTF-8 byte order mark for Excel. */
export function toBillingCsv(header: string[], rows: Cell[][]): string {
  return `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Euros with a decimal point: 14900 → "149.00", −14900 → "-149.00". */
const euros = (cents: number) => (cents / 100).toFixed(2);
/** VAT rate in percent: 1800 → "18". */
const percent = (bp: number) => String(bp / 100);

const isoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Belgrade',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** The calendar day in Kosovo, as 2026-11-24. */
const day = (d: Date | null) => (d ? isoDay.format(d) : '');

/** The customer as frozen on the document: billing details when it had them, else the facility. */
function customerOf(c: Record<string, string | null>) {
  return {
    name: c.legalName || c.name || '',
    code: c.code ?? '',
    businessNumber: c.businessNumber ?? '',
    fiscalNumber: c.fiscalNumber ?? '',
    vatNumber: c.vatNumber ?? '',
  };
}

/* ------------------------------------------------------------------ sending ------------------ */

type ExportName = 'invoices' | 'payments' | 'credit-notes' | 'sales-book';

async function localeOf(userId: string): Promise<Locale> {
  const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  return toLocale(row?.locale);
}

/**
 * Asks for the password again (after the period is checked), builds the file, audits the export
 * with its period only, and sends it.
 */
async function sendExport(
  req: Request,
  res: Response,
  name: ExportName,
  build: (period: Period, locale: Locale) => Promise<{ header: string[]; rows: Cell[][] }>,
) {
  const ctx = requireAuth(req);
  const period = parse(PeriodQuery, req.query);
  await ensureRecentAuth(req);
  const { header, rows } = await build(period, await localeOf(ctx.userId));
  await audit({
    action: AuditAction.BILLING_EXPORTED,
    actor: ctx,
    meta: requestMeta(req),
    metadata: { export: name, from: period.from, to: period.to },
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pacient-${name}-${period.from}-to-${period.to}.csv"`,
  );
  res.send(toBillingCsv(header, rows));
}

/** An invoice is "settled" when paid or credited in full. */
const STATUS: Record<string, string> = { OPEN: 'Open', PAID: 'Settled', VOID: 'Voided' };
const METHOD: Record<string, string> = {
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  CARD: 'Card',
  OTHER: 'Other',
};

/* ------------------------------------------------------------------ the exports -------------- */

/**
 * Invoices issued in the period (also voided ones, so that the numbers have no gaps), with what
 * was paid and credited on them and the balance as of the export.
 */
billingExportsRouter.get('/invoices.csv', (req, res) =>
  sendExport(req, res, 'invoices', async (period, locale) => {
    const { start, end } = bounds(period);
    const rows = await db
      .select()
      .from(invoices)
      .where(and(gte(invoices.issuedAt, start), lt(invoices.issuedAt, end)))
      .orderBy(asc(invoices.issuedAt), asc(invoices.number));
    const accounts = await accountsOf(db, rows);
    const h = (s: string) => tr(locale, s);
    return {
      header: [
        h('Invoice number'),
        h('Issue date'),
        h('Due date'),
        h('Customer'),
        h('Facility code'),
        h('Customer business number'),
        h('Customer fiscal number'),
        h('Customer VAT number'),
        h('Service from'),
        h('Service to'),
        h('Net amount'),
        h('VAT rate (%)'),
        h('VAT amount'),
        h('Total amount'),
        h('Currency'),
        h('Invoice status'),
        h('Paid amount'),
        h('Credited amount'),
        h('Balance'),
        h('Settled on'),
        h('Voided on'),
      ],
      rows: rows.map((i) => {
        const c = customerOf(i.customer);
        const a = accounts.get(i.id)!;
        return [
          i.number,
          day(i.issuedAt),
          day(i.dueAt),
          c.name,
          c.code,
          c.businessNumber,
          c.fiscalNumber,
          c.vatNumber,
          day(i.periodStart),
          day(lastDayOf(i.periodEnd)),
          euros(i.netCents),
          percent(i.taxRateBp),
          euros(i.taxCents),
          euros(i.totalCents),
          i.currency,
          h(STATUS[i.status] ?? i.status),
          euros(a.paidCents),
          euros(a.creditedCents),
          euros(a.balanceCents),
          i.status === 'PAID' ? day(i.paidAt) : '',
          day(i.voidedAt),
        ];
      }),
    };
  }),
);

/**
 * Money received in the period by payment date, and reversals of payments in the period by the
 * day they were reversed, as negative rows: a period already handed to the accountant never
 * changes because of a later correction.
 */
billingExportsRouter.get('/payments.csv', (req, res) =>
  sendExport(req, res, 'payments', async (period, locale) => {
    const { start, end } = bounds(period);
    const select = () =>
      db
        .select({ payment: invoicePayments, number: invoices.number, customer: invoices.customer })
        .from(invoicePayments)
        .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId));
    const paid = await select().where(
      and(gte(invoicePayments.paidAt, start), lt(invoicePayments.paidAt, end)),
    );
    const reversed = await select().where(
      and(gte(invoicePayments.reversedAt, start), lt(invoicePayments.reversedAt, end)),
    );
    const h = (s: string) => tr(locale, s);
    const lines = [
      ...paid.map((r) => ({ at: r.payment.paidAt, sign: 1, reversal: false, ...r })),
      ...reversed.map((r) => ({ at: r.payment.reversedAt!, sign: -1, reversal: true, ...r })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.number.localeCompare(b.number));
    return {
      header: [
        h('Date'),
        h('Entry'),
        h('Invoice number'),
        h('Customer'),
        h('Payment method'),
        h('Payment reference'),
        h('Amount'),
        h('Currency'),
        h('Reversal reason'),
      ],
      rows: lines.map((l) => [
        day(l.at),
        l.reversal ? h('Payment reversed') : h('Payment received'),
        l.number,
        customerOf(l.customer).name,
        h(METHOD[l.payment.method] ?? l.payment.method),
        l.payment.reference,
        euros(l.sign * l.payment.amountCents),
        'EUR',
        l.reversal ? l.payment.reversalReason : '',
      ]),
    };
  }),
);

/** Credit notes issued in the period. */
billingExportsRouter.get('/credit-notes.csv', (req, res) =>
  sendExport(req, res, 'credit-notes', async (period, locale) => {
    const { start, end } = bounds(period);
    const rows = await db
      .select({ note: creditNotes, invoiceNumber: invoices.number })
      .from(creditNotes)
      .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
      .where(and(gte(creditNotes.issuedAt, start), lt(creditNotes.issuedAt, end)))
      .orderBy(asc(creditNotes.issuedAt), asc(creditNotes.number));
    const h = (s: string) => tr(locale, s);
    return {
      header: [
        h('Credit note number'),
        h('Issue date'),
        h('Invoice number'),
        h('Customer'),
        h('Customer business number'),
        h('Customer fiscal number'),
        h('Customer VAT number'),
        h('Reason'),
        h('Net amount'),
        h('VAT rate (%)'),
        h('VAT amount'),
        h('Total amount'),
        h('Currency'),
      ],
      rows: rows.map(({ note: n, invoiceNumber }) => {
        const c = customerOf(n.customer);
        return [
          n.number,
          day(n.issuedAt),
          invoiceNumber,
          c.name,
          c.businessNumber,
          c.fiscalNumber,
          c.vatNumber,
          n.reason,
          euros(n.netCents),
          percent(n.vatRateBp),
          euros(n.taxCents),
          euros(n.totalCents),
          n.currency,
        ];
      }),
    };
  }),
);

/** Albanian column headers and texts of the sales book (libri i shitjes). */
const SALES_BOOK = {
  header: [
    'Nr. rendor',
    'Data',
    'Numri i dokumentit',
    'Lloji i dokumentit',
    'Fatura e lidhur',
    'Blerësi',
    'NUI i blerësit',
    'Numri fiskal i blerësit',
    'Numri i TVSH-së i blerësit',
    'Vlera pa TVSH',
    'Norma e TVSH-së (%)',
    'TVSH',
    'Vlera me TVSH',
    'Shënim',
  ],
  invoice: 'Faturë',
  creditNote: 'Notë krediti',
  voided: 'E anuluar',
  totalAt: (rate: string) => `Gjithsej me normë TVSH ${rate}%`,
  total: 'Gjithsej',
};

/**
 * The sales book of the period: invoices and credit notes by number, credit notes negative,
 * voided invoices listed with nothing (so that the numbers have no gaps), then the totals per VAT
 * rate and the grand total. Always in Albanian.
 */
billingExportsRouter.get('/sales-book.csv', (req, res) =>
  sendExport(req, res, 'sales-book', async (period) => {
    const { start, end } = bounds(period);
    const issued = await db
      .select()
      .from(invoices)
      .where(and(gte(invoices.issuedAt, start), lt(invoices.issuedAt, end)))
      .orderBy(asc(invoices.number));
    const credited = await db
      .select({ note: creditNotes, invoiceNumber: invoices.number })
      .from(creditNotes)
      .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
      .where(and(gte(creditNotes.issuedAt, start), lt(creditNotes.issuedAt, end)))
      .orderBy(asc(creditNotes.number));
    type Line = {
      at: Date;
      number: string;
      kind: string;
      related: string;
      customer: Record<string, string | null>;
      net: number;
      rateBp: number;
      tax: number;
      total: number;
      note: string;
    };
    const lines: Line[] = [
      ...issued.map((i) => {
        const voided = i.status === 'VOID';
        return {
          at: i.issuedAt,
          number: i.number,
          kind: SALES_BOOK.invoice,
          related: '',
          customer: i.customer,
          net: voided ? 0 : i.netCents,
          rateBp: i.taxRateBp,
          tax: voided ? 0 : i.taxCents,
          total: voided ? 0 : i.totalCents,
          note: voided ? SALES_BOOK.voided : '',
        };
      }),
      ...credited.map(({ note: n, invoiceNumber }) => ({
        at: n.issuedAt,
        number: n.number,
        kind: SALES_BOOK.creditNote,
        related: invoiceNumber,
        customer: n.customer,
        net: -n.netCents,
        rateBp: n.vatRateBp,
        tax: -n.taxCents,
        total: -n.totalCents,
        note: '',
      })),
    ];
    const byRate = new Map<number, { net: number; tax: number; total: number }>();
    for (const l of lines) {
      const t = byRate.get(l.rateBp) ?? { net: 0, tax: 0, total: 0 };
      t.net += l.net;
      t.tax += l.tax;
      t.total += l.total;
      byRate.set(l.rateBp, t);
    }
    const sum = [...byRate.values()].reduce(
      (a, t) => ({ net: a.net + t.net, tax: a.tax + t.tax, total: a.total + t.total }),
      { net: 0, tax: 0, total: 0 },
    );
    const blanks = (n: number) => Array<Cell>(n).fill('');
    return {
      header: SALES_BOOK.header,
      rows: [
        ...lines.map((l, i) => {
          const c = customerOf(l.customer);
          return [
            i + 1,
            day(l.at),
            l.number,
            l.kind,
            l.related,
            c.name,
            c.businessNumber,
            c.fiscalNumber,
            c.vatNumber,
            euros(l.net),
            percent(l.rateBp),
            euros(l.tax),
            euros(l.total),
            l.note,
          ];
        }),
        blanks(SALES_BOOK.header.length),
        ...[...byRate.entries()]
          .sort(([a], [b]) => a - b)
          .map(([rateBp, t]) => [
            ...blanks(5),
            SALES_BOOK.totalAt(percent(rateBp)),
            ...blanks(3),
            euros(t.net),
            percent(rateBp),
            euros(t.tax),
            euros(t.total),
            '',
          ]),
        [
          ...blanks(5),
          SALES_BOOK.total,
          ...blanks(3),
          euros(sum.net),
          '',
          euros(sum.tax),
          euros(sum.total),
          '',
        ],
      ],
    };
  }),
);
