import { t } from '../i18n';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  refreshSession,
  setAccessToken,
  setActingFor,
  setSessionExpiredHandler,
} from '../api/client';
import type { Dependant, Profile } from '../api/types';

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
  verifyMfa: (
    mfaToken: string,
    input: { code?: string; recoveryCode?: string },
  ) => Promise<Profile>;
  logout: () => Promise<void>;
  /** Re-reads the profile (e.g. after enabling two-step sign-in). */
  reloadProfile: () => Promise<Profile>;
  /** Records this patient account may open as a guardian. */
  dependants: Dependant[];
  /** The child (or other dependant) currently being viewed, or null for the user's own record. */
  acting: Dependant | null;
  setActing: (patientId: string | null) => void;
  reloadDependants: () => Promise<Dependant[]>;
}

const ACTING_KEY = 'pacient.actingFor';
const readActing = () => {
  try {
    return sessionStorage.getItem(ACTING_KEY);
  } catch {
    return null;
  }
};
const writeActing = (id: string | null) => {
  try {
    if (id) sessionStorage.setItem(ACTING_KEY, id);
    else sessionStorage.removeItem(ACTING_KEY);
  } catch {
    /* storage unavailable: selection lasts for this page only */
  }
};

const AuthContext = createContext<AuthValue | null>(null);

export const isChallenge = (r: Profile | MfaChallenge): r is MfaChallenge => 'mfaToken' in r;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<Profile | null>(null);
  const [dependants, setDependants] = useState<Dependant[]>([]);
  const [acting, setActingState] = useState<Dependant | null>(null);

  const clear = useCallback(() => {
    setAccessToken(null);
    setActingFor(null);
    writeActing(null);
    setActingState(null);
    setDependants([]);
    setUser(null);
    setStatus('anonymous');
    // Never leave another person's health data in memory after sign-out.
    queryClient.clear();
  }, [queryClient]);

  /**
   * Loads the records this patient account may act for and restores the previous selection (per
   * browser tab). Guardian-only accounts (no record of their own) open their first dependant.
   */
  const loadDependants = useCallback(async (me: Profile) => {
    if (me.role !== 'PATIENT') return [];
    setActingFor(null);
    const { items } = await api<{ items: Dependant[] }>('/portal/dependants');
    setDependants(items);
    const stored = readActing();
    const next =
      items.find((d) => d.patientId === stored) ?? (me.patientId ? null : (items[0] ?? null));
    setActingFor(next?.patientId ?? null);
    setActingState(next);
    return items;
  }, []);

  const loadProfile = useCallback(async () => {
    setActingFor(null);
    const me = await api<Profile>('/auth/me');
    await loadDependants(me);
    setUser(me);
    setStatus('authenticated');
    return me;
  }, [loadDependants]);

  const setActing = useCallback(
    (patientId: string | null) => {
      const next = dependants.find((d) => d.patientId === patientId) ?? null;
      // Never show one person's cached data while viewing another person's record.
      queryClient.clear();
      setActingFor(next?.patientId ?? null);
      writeActing(next?.patientId ?? null);
      setActingState(next);
    },
    [dependants, queryClient],
  );

  const reloadDependants = useCallback(
    async () => (user ? loadDependants(user) : []),
    [user, loadDependants],
  );

  // Restore an existing session from the httpOnly refresh cookie on page load.
  useEffect(() => {
    setSessionExpiredHandler(clear);
    let cancelled = false;
    (async () => {
      if (await refreshSession()) {
        try {
          const me = await api<Profile>('/auth/me');
          await loadDependants(me);
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
  }, [clear, loadDependants]);

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
    () => ({
      status,
      user,
      login,
      verifyMfa,
      logout,
      reloadProfile: loadProfile,
      dependants,
      acting,
      setActing,
      reloadDependants,
    }),
    [
      status,
      user,
      login,
      verifyMfa,
      logout,
      loadProfile,
      dependants,
      acting,
      setActing,
      reloadDependants,
    ],
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
  if (!user) throw new Error(t('No authenticated user'));
  return user;
}

export const HOME_BY_ROLE: Record<Profile['role'], string> = {
  PATIENT: '/portal',
  DOCTOR: '/doctor',
  NURSE: '/nurse',
  PHARMACIST: '/pharmacy',
  RECEPTION: '/reception',
  DIRECTOR: '/director',
  MINISTRY: '/ministry',
};

/** Staff who must enrol in two-step sign-in are sent here before anything else. */
export const MFA_SETUP_PATH = '/setup-two-step';
export const needsMfaEnrollment = (u: Profile | null) =>
  Boolean(u && u.mfaRequired && !u.mfaEnabled);
