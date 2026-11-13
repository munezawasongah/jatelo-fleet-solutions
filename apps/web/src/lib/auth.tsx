import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onAuthChange, refresh, setToken } from './api';

export interface Me {
  user: { id: string; email: string; full_name: string; role: string; locale: string; phone: string | null; avatar_url: string | null; mfa_enabled: boolean };
  tenant: { id: string; name: string; slug: string; country_code: string; currency: string; timezone: string; locale: string; status: string; trial_ends_at: string | null } | null;
  permissions: string[];
  mfa_setup_required?: boolean;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
  mfa_setup_required?: boolean;
}
export type LoginResult = { ok: true; mfaSetup: boolean } | { ok: false; mfaToken: string };

interface Ctx {
  ready: boolean;
  me: Me | null;
  can: (...perms: string[]) => boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  loginMfa: (mfaToken: string, code: string) => Promise<void>;
  acceptTokens: (t: TokenPair) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const [booted, setBooted] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => onAuthChange(setSignedIn), []);
  useEffect(() => {
    void refresh().finally(() => setBooted(true));
  }, []);

  const meQ = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), enabled: signedIn, staleTime: 60_000 });

  const acceptTokens = useCallback(
    async (t: TokenPair) => {
      setToken(t.access_token);
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    [qc],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const r = await api.post<TokenPair | { mfa_required: true; mfa_token: string }>('/auth/login', { email, password });
      if ('mfa_required' in r) return { ok: false, mfaToken: r.mfa_token };
      await acceptTokens(r);
      return { ok: true, mfaSetup: Boolean(r.mfa_setup_required) };
    },
    [acceptTokens],
  );

  const loginMfa = useCallback(
    async (mfaToken: string, code: string) => {
      await acceptTokens(await api.post<TokenPair>('/auth/login/mfa', { mfa_token: mfaToken, code }));
    },
    [acceptTokens],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* already signed out */
    }
    setToken(null);
    qc.clear();
  }, [qc]);

  const value = useMemo<Ctx>(() => {
    const me = signedIn ? (meQ.data ?? null) : null;
    const perms = new Set(me?.permissions ?? []);
    return {
      ready: booted && (!signedIn || !meQ.isPending),
      me,
      can: (...p) => p.every((x) => perms.has(x)),
      login,
      loginMfa,
      acceptTokens,
      logout,
      reload: async () => void (await meQ.refetch()),
    };
  }, [booted, signedIn, meQ, login, loginMfa, acceptTokens, logout]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}

export const ADMIN_ROLES = ['super_admin', 'company_admin'];
