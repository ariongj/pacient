import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tone } from '../components/ui';
import { t } from '../i18n';
import { api, downloadFile } from './client';

/*
 * Billing documents: whether invoices can be issued (the operator settings), facilities' billing
 * details, invoice and credit note PDFs, and who they were e-mailed to. Business data only –
 * billing addresses are a customer's business addresses and are shown in full.
 */

/** An operator setting an invoice cannot do without. */
export interface MissingSetting {
  field: string;
  label: string;
}

export interface BillingReadiness {
  ready: boolean;
  missing: MissingSetting[];
  vatRateBp: number;
}

export interface BillingProfile {
  facilityId: string;
  /** The legal entity that is invoiced. */
  legalName: string;
  /** NUI. */
  businessNumber: string | null;
  fiscalNumber: string | null;
  vatNumber: string | null;
  billingAddress: string | null;
  /** Up to three; the facility's active directors receive the documents as well. */
  billingEmails: string[];
  contactName: string | null;
  /** The customer's purchase order or contract number, printed on invoices. */
  customerReference: string | null;
  updatedAt: string;
  /** Administrator's view only. */
  updatedBy?: { id: string; fullName: string } | null;
}

export type BillingProfileInput = Omit<BillingProfile, 'facilityId' | 'updatedAt' | 'updatedBy'>;

export type DeliveryKind = 'ISSUED' | 'REMINDER' | 'RESEND';
/** CANCELLED: withdrawn before it went out, because the invoice was voided. */
export type DeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';

export interface BillingDelivery {
  id: string;
  kind: DeliveryKind;
  recipient: string;
  queuedAt: string;
  /** The administrator who sent it again; null when the system sent it. */
  queuedBy: { id: string; fullName: string } | null;
  status: DeliveryStatus;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
}

export interface MyDocuments {
  invoices: {
    id: string;
    number: string;
    status: 'OPEN' | 'PAID' | 'VOID';
    issuedAt: string;
    totalCents: number;
    currency: string;
  }[];
  creditNotes: {
    id: string;
    number: string;
    issuedAt: string;
    totalCents: number;
    currency: string;
    invoiceId: string;
    invoiceNumber: string;
  }[];
}

/* ------------------------------------------------------------------ queries ------------------ */

const KEY = ['billingdocs'] as const;

/** Whether invoices can be issued (administrator). */
export function useBillingReadiness(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'readiness'],
    queryFn: () => api<BillingReadiness>('/admin/billing-readiness'),
    enabled,
    staleTime: 30_000,
  });
}

/** A facility's billing details (administrator). */
export function useBillingProfile(facilityId: string) {
  return useQuery({
    queryKey: [...KEY, 'profile', facilityId],
    queryFn: () =>
      api<{ profile: BillingProfile | null }>(`/admin/organizations/${facilityId}/billing-profile`),
  });
}

/** The signed-in director's facility's billing details. */
export function useMyBillingProfile() {
  return useQuery({
    queryKey: [...KEY, 'mine', 'profile'],
    queryFn: () => api<{ profile: BillingProfile | null }>('/subscription/billing-profile'),
  });
}

/** The signed-in director's facility's invoices and credit notes, to download. */
export function useMyDocuments() {
  return useQuery({
    queryKey: [...KEY, 'mine', 'documents'],
    queryFn: () => api<MyDocuments>('/subscription/documents'),
  });
}

export type DocumentKind = 'invoice' | 'credit_note';
const segment = (kind: DocumentKind) => (kind === 'invoice' ? 'invoices' : 'credit-notes');

/** Who an invoice or credit note was e-mailed to (administrator). */
export function useDeliveries(kind: DocumentKind, id: string) {
  return useQuery({
    queryKey: [...KEY, 'deliveries', kind, id],
    queryFn: () => api<{ items: BillingDelivery[] }>(`/admin/${segment(kind)}/${id}/deliveries`),
    // A message waiting in the queue goes out within seconds: show when it did.
    refetchInterval: (q) =>
      q.state.data?.items.some((d) => d.status === 'PENDING' || d.status === 'SENDING')
        ? 10_000
        : false,
  });
}

/* ------------------------------------------------------------------ changes ------------------ */

/** Afterwards the billing views and the subscription views (invoices, history) are refreshed. */
function useRefreshing<V, R>(fn: (vars: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
    },
  });
}

export const useSaveBillingProfile = (facilityId: string) =>
  useRefreshing((body: BillingProfileInput) =>
    api<{ profile: BillingProfile }>(`/admin/organizations/${facilityId}/billing-profile`, {
      method: 'PUT',
      body,
    }),
  );

/** E-mails the document again to the billing e-mails and active directors (administrator). */
export const useSendAgain = (kind: DocumentKind, id: string) =>
  useRefreshing(() =>
    api<{ queued: number; items: BillingDelivery[] }>(`/admin/${segment(kind)}/${id}/send`, {
      method: 'POST',
    }),
  );

/**
 * Downloads the PDF of an invoice or credit note: the administrator's (any document) or a
 * director's (own facility). It is written in the account's own language.
 */
export function downloadPdf(
  kind: DocumentKind,
  doc: { id: string; number: string },
  scope: 'admin' | 'director',
) {
  const base = scope === 'admin' ? '/admin' : '/subscription';
  return downloadFile(`${base}/${segment(kind)}/${doc.id}/pdf`, `${doc.number}.pdf`);
}

/* ------------------------------------------------------------------ wording ------------------ */

/** An operator setting in the reader's language (as on the settings page). */
export function settingLabel(m: MissingSetting): string {
  const labels: Record<string, () => string> = {
    operatorName: () => t('Operator name'),
    operatorAddress: () => t('Operator address'),
    operatorFiscalNumber: () => t('Fiscal number (NUI)'),
    operatorIban: () => t('IBAN'),
    operatorVatNumber: () => t('VAT number'),
  };
  return labels[m.field]?.() ?? m.label;
}

export const deliveryKindLabel = (k: DeliveryKind) =>
  ({
    ISSUED: t('On issue'),
    REMINDER: t('Overdue reminder'),
    RESEND: t('Sent again'),
  })[k] ?? k;

export const deliveryStatusLabel = (s: DeliveryStatus) =>
  ({
    PENDING: t('Waiting to be sent'),
    SENDING: t('Being sent'),
    SENT: t('Sent|e-mail'),
    FAILED: t('Not delivered'),
    CANCELLED: t('Not sent – the invoice was voided'),
  })[s] ?? s;

export const DELIVERY_TONE: Record<DeliveryStatus, Tone> = {
  PENDING: 'info',
  SENDING: 'info',
  SENT: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

/** Billing e-mails typed in one field, separated by commas, semicolons or spaces. */
export const parseEmails = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
