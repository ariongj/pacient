import type { Invoice } from '../../../api/subscriptions';

/**
 * Invoice page (InvoiceView, shared by administrators and directors), below the printable sheet:
 * Credit notes of the invoice (directors see them too); issuing one (administrators).
 * Not printed (class "no-print"). Round 2, builder B2. Renders nothing until built.
 */
export function InvoiceCreditNotes(_props: { invoice: Invoice; admin: boolean }) {
  return null;
}
