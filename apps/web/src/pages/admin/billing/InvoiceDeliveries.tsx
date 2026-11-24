import type { Invoice } from '../../../api/subscriptions';

/**
 * Invoice page (InvoiceView, shared by administrators and directors), below the printable sheet:
 * Who the invoice was e-mailed to, when and why (on issue, reminder, sent again), with the outbox status, and "Send again". Administrators only.
 * Not printed (class "no-print"). Round 2, builder B1. Renders nothing until built.
 */
export function InvoiceDeliveries(_props: { invoice: Invoice }) {
  return null;
}
