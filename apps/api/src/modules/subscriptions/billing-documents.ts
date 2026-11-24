import { createRequire } from 'node:module';
import type { Executor } from '../../db/client.js';
import type { Locale } from '../../i18n/index.js';
import { notImplemented } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';

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
 *
 * Scaffold stub: queues nothing and returns 0.
 */
export async function queueBillingDocument(
  _tx: Executor,
  _input: QueueBillingDocumentInput,
): Promise<number> {
  return 0;
}

/**
 * The PDF of an issued invoice in `locale` (labels in sq, sr or en; default sq): A4, the operator
 * header, the customer as frozen on the invoice, number, issue date, supply period, lines, net,
 * VAT rate and amount (or "Not registered for VAT" when the rate is 0), total, due date, IBAN and
 * "reference: <number>", in the bundled font (PDF_FONTS). Throws notFound for an unknown id.
 * Access checks are the caller's (an administrator, or a director of that facility).
 *
 * Scaffold stub: throws 501 NOT_IMPLEMENTED.
 */
export async function renderInvoicePdf(_id: string, _locale: Locale): Promise<Buffer> {
  throw notImplemented('Invoice PDFs are not available yet');
}

/**
 * The PDF of a credit note in `locale`, like an invoice, with "Credit note for invoice <number>"
 * and the reason. Throws notFound for an unknown id.
 *
 * Scaffold stub: throws 501 NOT_IMPLEMENTED.
 */
export async function renderCreditNotePdf(_id: string, _locale: Locale): Promise<Buffer> {
  throw notImplemented('Credit note PDFs are not available yet');
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
