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
import { api, refreshSession, setAccessToken, setSessionExpiredHandler } from '../api/client';
import type { Profile } from '../api/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: Status;
  user: Profile | null;
  login: (email: string, password: string) => Promise<Profile>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

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

  const login = useCallback(async (email: string, password: string) => {
    const { accessToken } = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setAccessToken(accessToken);
    const me = await api<Profile>('/auth/me');
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      clear();
    }
  }, [clear]);

  const value = useMemo(() => ({ status, user, login, logout }), [status, user, login, logout]);
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
