import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { api, setAccessToken } from './client';

/** Passkeys, sessions and sign-in history (see apps/api/src/modules/security). */
export interface Passkey {
  id: string;
  deviceName: string;
  backedUp: boolean;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ActiveSession {
  id: string;
  /** "Chrome · Windows" – browser and system names are not translated. */
  device: string;
  network: string | null;
  startedAt: string;
  lastUsedAt: string;
  current: boolean;
}

export interface SecurityEvent {
  id: string;
  occurredAt: string;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  device: string | null;
  network: string | null;
  factors: string[] | null;
  reason: string | null;
}

/** Profile fields added by the security module (the shared Profile type may not list them yet). */
export interface SecurityProfile {
  totpEnabled?: boolean;
  passkeyCount?: number;
}

export const passkeysSupported = () => {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
};
export const passkeyAutofillSupported = () => browserSupportsWebAuthnAutofill().catch(() => false);

/** The user cancelled the browser's passkey dialog (not an error worth showing). */
export const isPasskeyCancel = (err: unknown) =>
  err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');

/** Registers a new passkey on this device. Pass the password when the server asks to re-confirm. */
export async function registerPasskey(deviceName: string, password?: string) {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    '/auth/security/passkeys/options',
    { method: 'POST', body: password ? { password } : {} },
  );
  const response = await startRegistration({ optionsJSON });
  return api<{ id: string; deviceName: string }>('/auth/security/passkeys', {
    method: 'POST',
    body: { response, deviceName },
  });
}

type AuthOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/**
 * Signs in with a passkey (discoverable credential). With `autofill`, waits for the user to pick
 * a passkey from the browser's username autofill (conditional UI). Stores the access token; the
 * caller reloads the profile.
 */
export async function signInWithPasskey(opts: { autofill?: boolean } = {}) {
  const optionsJSON = await api<AuthOptions>('/auth/security/passkeys/login/options', {
    method: 'POST',
    body: {},
  });
  const response = await startAuthentication({
    optionsJSON,
    useBrowserAutofill: Boolean(opts.autofill),
  });
  const { accessToken } = await api<{ accessToken: string }>('/auth/security/passkeys/login', {
    method: 'POST',
    body: { response },
  });
  setAccessToken(accessToken);
}

/** Whether a passkey can complete this password sign-in (the account has at least one). */
export async function passkeyMfaOptions(mfaToken: string): Promise<AuthOptions | null> {
  try {
    return await api<AuthOptions>('/auth/security/passkeys/mfa/options', {
      method: 'POST',
      body: { mfaToken },
    });
  } catch {
    return null;
  }
}

/** Second step after the password, with a passkey. */
export async function completeMfaWithPasskey(mfaToken: string, optionsJSON: AuthOptions) {
  const response = await startAuthentication({ optionsJSON });
  const { accessToken } = await api<{ accessToken: string }>('/auth/security/passkeys/mfa', {
    method: 'POST',
    body: { mfaToken, response },
  });
  setAccessToken(accessToken);
}

/** A sensible default name for the passkey being added on this device. */
export function suggestedDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone/iPad'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return [os, browser].filter(Boolean).join(' – ') || 'Passkey';
}
