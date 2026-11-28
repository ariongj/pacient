import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { AgreementKind, LegalLocale, LegalText } from './platform';

/**
 * The service agreement and the data processing agreement, accepted once per facility by one of
 * its directors. A missing acceptance never blocks anything: directors see a notice, the
 * administrator a list.
 */

export interface AgreementAcceptance {
  id: string;
  kind: AgreementKind;
  version: string;
  /** The language of the text that was accepted. */
  locale: LegalLocale;
  signerName: string;
  signerTitle: string;
  /** The director's account that accepted it. */
  acceptedByName: string | null;
  acceptedAt: string;
}

export interface AgreementState {
  kind: AgreementKind;
  /** Null while nothing is published. */
  currentVersion: string | null;
  /** The current version asks facilities to accept it. */
  requiresAcceptance: boolean;
  /** The facility still has to accept the current version. */
  pending: boolean;
  /** The facility's acceptance of the current version, in any language. */
  acceptedCurrent: AgreementAcceptance | null;
  /** Every acceptance of this agreement, newest first. */
  acceptances: AgreementAcceptance[];
}

export interface MyAgreements {
  facility: { id: string; name: string } | null;
  agreements: (AgreementState & { document: LegalText | null })[];
  /**
   * The facility is a customer (its subscription has not ended): only then are its directors
   * shown a notice while an agreement is pending. Any facility may accept.
   */
  asked: boolean;
  /** How many agreements the facility still has to accept (0 when it is not asked). */
  pending: number;
}

export interface OrganizationAgreements {
  facility: { id: string; name: string };
  agreements: AgreementState[];
  asked: boolean;
  pending: number;
}

export interface AgreementsOverview {
  /** Customers: active facilities whose subscription has not ended. */
  customers: number;
  kinds: {
    kind: AgreementKind;
    currentVersion: string | null;
    requiresAcceptance: boolean;
    upToDate: number;
    pending: number;
  }[];
  items: {
    facilityId: string;
    facilityName: string;
    facilityCode: string;
    subscriptionStatus: string;
    missing: AgreementKind[];
  }[];
}

export interface AgreementAcceptanceList {
  kind: AgreementKind;
  version: string;
  accepted: number;
  latest: (AgreementAcceptance & { facilityId: string; facilityName: string })[];
}

const KEY = ['agreements'] as const;

/** The director's facility's agreements, with the current texts in the reader's language. */
export function useMyAgreements(locale: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'mine', locale],
    queryFn: () => api<MyAgreements>('/subscription/agreements', { query: { locale } }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useAcceptAgreement(locale: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { documentId: string; signerName: string; signerTitle: string }) =>
      api<MyAgreements>(`/subscription/agreements/${v.documentId}/accept`, {
        method: 'POST',
        query: { locale },
        body: { signerName: v.signerName, signerTitle: v.signerTitle },
      }),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, 'mine', locale], data);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => {
      // A newer version was published meanwhile: show it instead of asking for a reload.
      if (err instanceof ApiError && err.status === 409) {
        void qc.invalidateQueries({ queryKey: KEY });
      }
    },
  });
}

export function useOrganizationAgreements(facilityId: string) {
  return useQuery({
    queryKey: [...KEY, 'organization', facilityId],
    queryFn: () => api<OrganizationAgreements>(`/admin/organizations/${facilityId}/agreements`),
  });
}

/** Customers without the current agreements, and per agreement how many are up to date. */
export function useAgreementsOverview() {
  return useQuery({
    queryKey: [...KEY, 'overview'],
    queryFn: () => api<AgreementsOverview>('/admin/agreements/missing'),
  });
}

export function useAgreementAcceptances(kind: AgreementKind, version: string | null) {
  return useQuery({
    queryKey: [...KEY, 'acceptances', kind, version],
    queryFn: () =>
      api<AgreementAcceptanceList>('/admin/agreements/acceptances', {
        query: { kind, version: version! },
      }),
    enabled: Boolean(version),
  });
}
