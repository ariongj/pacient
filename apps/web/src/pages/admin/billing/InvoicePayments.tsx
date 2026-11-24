import type { Invoice } from '../../../api/subscriptions';

/**
 * Invoice page (InvoiceView, shared by administrators and directors), below the printable sheet:
 * Payments of the invoice with their reversals, the balance and "to refund"; reversing a payment (administrators).
 * Not printed (class "no-print"). Round 2, builder B2. Renders nothing until built.
 */
export function InvoicePayments(_props: { invoice: Invoice; admin: boolean }) {
  return null;
}
