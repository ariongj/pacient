import { api } from './client';
import type { PatientListItem } from './types';

/**
 * The state of a patient's portal account as the facility's patient lists show it: whether the
 * invitation is still waiting to be accepted, and – for reception and directors only, who can
 * reset it – whether two-step sign-in is on. Nothing else about the account.
 */
export interface PortalState {
  /** null: no portal account; PENDING: invited, not yet activated. */
  portalAccount?: 'PENDING' | 'ACTIVE' | 'CLOSED' | null;
  /** Reception and directors only (null for other roles). */
  portalTwoStep?: boolean | null;
}

export type PatientWithPortal = PatientListItem & PortalState;

/** Invites the patient – or, for an account never activated, sends a new link (`renewed`). */
export const sendPortalInvitation = (patientId: string) =>
  api<{ activationUrl?: string; renewed?: boolean }>(`/patients/${patientId}/portal-invitation`, {
    method: 'POST',
  });

/** Reception or a director, after verifying the patient's identity in person. */
export const resetPortalTwoStep = ({ patientId, reason }: { patientId: string; reason: string }) =>
  api<{ reset: true; sessionsRevoked: number }>(
    `/patients/${patientId}/portal-account/two-step-reset`,
    { method: 'POST', body: { reason } },
  );
