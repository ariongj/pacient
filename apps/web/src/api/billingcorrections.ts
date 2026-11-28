import { useQuery } from '@tanstack/react-query';
import { t } from '../i18n';
import { api, downloadFile } from './client';
import type { Invoice, InvoiceStatus, PaymentMethod } from './subscriptions';

/*
 * Corrections of issued invoices and exports for the accountant. An issued invoice never changes
 * its amounts: money received is a payment (a mistake is reversed, never edited), an amount taken
 * back is a credit note. The invoice is settled once payments and credit notes reach its total;
 * anything beyond is to be refunded outside Pacient. Money in integer cents.
 */

/** Why an invoice can no longer be voided (a credit note corrects it instead). */
export type VoidBlock = 'NOT_OPEN' | 'PAYMENTS' | 'CREDIT_NOTES' | 'NOT_THIS_MONTH' | 'EMAILED';

/** What was paid and credited on an invoice; every invoice in a list carries it. */
export interface InvoiceAccount {
  /** Payments that were not reversed. */
  paidCents: number;
  creditedCents: number;
  /** Refunds the administrator recorded (made outside Pacient). */
  refundedCents: number;
  /** Still owed (0 once settled or voided). */
  balanceCents: number;
  /** Paid and credited beyond the total and not refunded yet: refunded outside Pacient. */
  toRefundCents: number;
  /** What a further credit note may still cover. */
  creditableCents: number;
  /** Administrators only: null while the invoice may still be voided. */
  voidBlock?: VoidBlock | null;
}

/** A refund made outside Pacient, as the administrator recorded it. */
export interface InvoiceRefund {
  id: string;
  amountCents: number;
  /** The day the money was given back. */
  refundedAt: string;
  reference: string | null;
  recordedAt: string;
  /** Administrators only. */
  recordedBy?: string | null;
}

export interface InvoicePayment {
  id: string;
  amountCents: number;
  paidAt: string;
  method: PaymentMethod;
  reference: string | null;
  recordedAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  /** Administrators only: who recorded and reversed it. */
  recordedBy?: string | null;
  reversedBy?: string | null;
}

export interface CreditNoteSummary {
  id: string;
  number: string;
  invoiceId: string;
  issuedAt: string;
  reason: string;
  netCents: number;
  taxCents: number;
  totalCents: number;
  /** The VAT rate of the invoice it corrects, in basis points. */
  vatRateBp: number;
  currency: string;
}

export interface CreditNoteListItem extends CreditNoteSummary {
  facilityId: string;
  facilityName: string;
  invoiceNumber: string;
}

/** A printable credit note, with the details frozen from the invoice it corrects. */
export interface CreditNote extends CreditNoteSummary {
  facilityId: string;
  subscriptionId: string;
  facilityName: string;
  issuer: Invoice['issuer'];
  customer: Invoice['customer'] & Record<string, string | null | undefined>;
  invoice: {
    id: string;
    number: string;
    issuedAt: string;
    periodStart: string;
    periodEnd: string;
    totalCents: number;
    status: InvoiceStatus;
  };
}

/** Payments, credit notes and balance of one invoice. */
export interface InvoiceAccountView extends Omit<InvoiceAccount, 'voidBlock'> {
  invoiceId: string;
  number: string;
  status: InvoiceStatus;
  currency: string;
  totalCents: number;
  /** Administrators only. */
  voidable?: boolean;
  voidBlock?: VoidBlock | null;
  payments: InvoicePayment[];
  creditNotes: CreditNoteSummary[];
  refunds: InvoiceRefund[];
}

type Scope = 'admin' | 'director';
const base = (scope: Scope) => (scope === 'admin' ? '/admin' : '/subscription');

/* Under the subscriptions key: every billing change (useBillingMutation) refreshes them. */
const KEY = ['subscriptions', 'corrections'] as const;

export function useInvoiceAccount(invoiceId: string, scope: Scope) {
  return useQuery({
    queryKey: [...KEY, 'account', scope, invoiceId],
    queryFn: () => api<InvoiceAccountView>(`${base(scope)}/invoices/${invoiceId}/account`),
  });
}

export function useCreditNote(id: string | undefined, scope: Scope) {
  return useQuery({
    queryKey: [...KEY, 'credit-note', scope, id],
    queryFn: () => api<CreditNote>(`${base(scope)}/credit-notes/${id}`),
    enabled: Boolean(id),
  });
}

/** The signed-in director's facility's credit notes, newest first. */
export function useMyCreditNotes(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'mine'],
    queryFn: () =>
      api<{ items: CreditNoteListItem[] }>('/subscription/credit-notes', {
        query: { pageSize: 100 },
      }),
    enabled,
  });
}

/* ------------------------------------------------------------------ changes ------------------ */

export const reversePayment = ({ paymentId, reason }: { paymentId: string; reason: string }) =>
  api<InvoiceAccountView>(`/admin/payments/${paymentId}/reverse`, {
    method: 'POST',
    body: { reason },
  });

export const issueCreditNote = ({
  invoiceId,
  amountCents,
  reason,
}: {
  invoiceId: string;
  amountCents: number;
  reason: string;
}) =>
  api<CreditNote>(`/admin/invoices/${invoiceId}/credit-notes`, {
    method: 'POST',
    body: { amountCents, reason },
  });

/** Records a refund made outside Pacient of what is to refund (the password is asked again). */
export const recordRefund = ({
  invoiceId,
  amountCents,
  refundedAt,
  reference,
}: {
  invoiceId: string;
  amountCents: number;
  refundedAt: string;
  reference: string | null;
}) =>
  api<InvoiceAccountView>(`/admin/invoices/${invoiceId}/refunds`, {
    method: 'POST',
    body: { amountCents, refundedAt, reference },
  });

export const creditNotePath = (id: string, scope: Scope) =>
  scope === 'admin' ? `/admin/credit-notes/${id}` : `/director/subscription/credit-notes/${id}`;

/** Why the administrator cannot void an invoice any more, in plain words. */
export const voidBlockText = (block: VoidBlock) =>
  ({
    NOT_OPEN: t('Only an open invoice can be voided.'),
    PAYMENTS: t('A payment was recorded on this invoice.'),
    CREDIT_NOTES: t('A credit note was issued for this invoice.'),
    NOT_THIS_MONTH: t('It was issued before this month.'),
    EMAILED: t('It was already e-mailed to the customer.'),
  })[block];

/* ------------------------------------------------------------------ exports ------------------ */

export type ExportName = 'invoices' | 'payments' | 'credit-notes' | 'sales-book';
export const EXPORTS: ExportName[] = ['invoices', 'payments', 'credit-notes', 'sales-book'];

export const exportLabel = (name: ExportName) =>
  ({
    invoices: t('Invoices'),
    payments: t('Payments and reversals'),
    'credit-notes': t('Credit notes'),
    'sales-book': t('Sales book (in Albanian)'),
  })[name];

export type PeriodKind = 'month' | 'quarter' | 'year';
export interface Period {
  /** First and last day, included (calendar days in Kosovo). */
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** A month (1–12), a quarter (1–4) or the whole year as a range of days. */
export function periodOf(kind: PeriodKind, year: number, index: number): Period {
  const [first, last] =
    kind === 'year' ? [1, 12] : kind === 'quarter' ? [index * 3 - 2, index * 3] : [index, index];
  return {
    from: `${year}-${pad(first)}-01`,
    to: `${year}-${pad(last)}-${pad(lastDay(year, last))}`,
  };
}

/** Downloads an export; the server asks for the password again (the shared dialog). */
export const downloadExport = (name: ExportName, period: Period) =>
  downloadFile(`/admin/exports/${name}.csv`, `pacient-${name}-${period.from}-to-${period.to}.csv`, {
    from: period.from,
    to: period.to,
  });
