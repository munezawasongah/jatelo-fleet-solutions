import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, clearTokens, loadSession, onAuth, saveTokens, request } from './api';

export interface Home {
  driver: { id: string; full_name: string; employee_number: string | null; phone: string | null; vehicle_id: string | null; plate_number: string | null; vehicle_label: string | null; odometer_km: number | null; fuel_type: string | null; tank_capacity_l: number | null; has_hardware: boolean };
  shift: { id: string; vehicle_id: string | null; plate_number: string | null; starts_at: string; ends_at: string; status: string; actual_start: string | null; actual_end: string | null } | null;
  counts: { jobs: number; unread: number; open_defects: number };
  inspection_templates: { id: string; name: string; inspection_type: string; is_default: boolean; items: { id: string; label: string; label_sw: string | null; category: string; is_critical: boolean; requires_photo_on_fail: boolean }[] }[];
  company: { name: string; currency: string; timezone: string; locale: string };
}

interface Ctx { ready: boolean; signedIn: boolean; home: Home | undefined; refreshHome: () => void; signIn: (email: string, password: string) => Promise<void>; signOut: () => Promise<void> }
const Session = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    void loadSession().then((s) => { setSignedIn(s); setReady(true); });
    return onAuth(setSignedIn);
  }, []);
  const home = useQuery({ queryKey: ['home'], queryFn: () => api.get<Home>('/driver-app/me'), enabled: signedIn, refetchInterval: 60_000 });
  const value: Ctx = {
    ready,
    signedIn,
    home: home.data,
    refreshHome: () => void home.refetch(),
    signIn: async (email, password) => {
      const r = await request<{ access_token?: string; refresh_token?: string; mfa_required?: boolean }>('POST', '/auth/login', { email: email.trim().toLowerCase(), password });
      if (r.mfa_required || !r.access_token || !r.refresh_token) throw new Error('This account needs the web dashboard (two-step verification). Use your driver login.');
      await saveTokens(r.access_token, r.refresh_token);
      const me = await api.get<{ user: { role: string } }>('/auth/me');
      if (me.user.role !== 'driver') {
        await clearTokens();
        throw new Error('This app is for drivers. Managers should use the Jatelo Fleet web dashboard.');
      }
    },
    signOut: async () => {
      try { await api.post('/auth/logout'); } catch { /* offline */ }
      await clearTokens();
      qc.clear();
    },
  };
  return <Session.Provider value={value}>{children}</Session.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(Session);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}
