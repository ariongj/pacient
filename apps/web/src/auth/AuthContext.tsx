import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setSessionExpiredHandler } from '../api/client';
import type { Profile } from '../api/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

/** Password accepted, second factor pending. */
export interface MfaChallenge {
  mfaToken: string;
}

interface AuthValue {
  status: Status;
  user: Profile | null;
  /** Returns the profile, or a challenge when two-step sign-in is enabled for the account. */
  login: (email: string, password: string) => Promise<Profile | MfaChallenge>;
  verifyMfa: (mfaToken: string, input: { code?: string; recoveryCode?: string }) => Promise<Profile>;
  logout: () => Promise<void>;
  /** Re-reads the profile (e.g. after enabling two-step sign-in). */
  reloadProfile: () => Promise<Profile>;
}

const AuthContext = createContext<AuthValue | null>(null);

export const isChallenge = (r: Profile | MfaChallenge): r is MfaChallenge => 'mfaToken' in r;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<Profile | null>(null);

  const clear = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('anonymous');
    // Never leave another person's health data in memory after sign-out.
    queryClient.clear();
  }, [queryClient]);

  const loadProfile = useCallback(async () => {
    const me = await api<Profile>('/auth/me');
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  // Restore an existing session from the httpOnly refresh cookie on page load.
  useEffect(() => {
    setSessionExpiredHandler(clear);
    let cancelled = false;
    (async () => {
      if (await refreshSession()) {
        try {
          const me = await api<Profile>('/auth/me');
          if (!cancelled) {
            setUser(me);
            setStatus('authenticated');
          }
          return;
        } catch {
          /* fall through */
        }
      }
      if (!cancelled) setStatus('anonymous');
    })();
    return () => {
      cancelled = true;
    };
  }, [clear]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ accessToken?: string; mfaRequired?: boolean; mfaToken?: string }>(
        '/auth/login',
        { method: 'POST', body: { email, password } },
      );
      if (res.mfaRequired && res.mfaToken) return { mfaToken: res.mfaToken };
      setAccessToken(res.accessToken!);
      return loadProfile();
    },
    [loadProfile],
  );

  const verifyMfa = useCallback(
    async (mfaToken: string, input: { code?: string; recoveryCode?: string }) => {
      const { accessToken } = await api<{ accessToken: string }>('/auth/mfa/verify', {
        method: 'POST',
        body: { mfaToken, ...input },
      });
      setAccessToken(accessToken);
      return loadProfile();
    },
    [loadProfile],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      clear();
    }
  }, [clear]);

  const value = useMemo(
    () => ({ status, user, login, verifyMfa, logout, reloadProfile: loadProfile }),
    [status, user, login, verifyMfa, logout, loadProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Use inside role workspaces, where a signed-in user is guaranteed by the route guard. */
export function useUser(): Profile {
  const { user } = useAuth();
  if (!user) throw new Error('No authenticated user');
  return user;
}

export const HOME_BY_ROLE: Record<Profile['role'], string> = {
  PATIENT: '/portal',
  DOCTOR: '/doctor',
  DIRECTOR: '/director',
  MINISTRY: '/ministry',
};

/** Staff who must enrol in two-step sign-in are sent here before anything else. */
export const MFA_SETUP_PATH = '/setup-two-step';
export const needsMfaEnrollment = (u: Profile | null) => Boolean(u && u.mfaRequired && !u.mfaEnabled);
