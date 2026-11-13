import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Bell, Building2, Car, ClipboardList, CreditCard, FileBarChart, Fuel, Gauge, Languages, LogOut, Map, MapPinned, Menu, MessageSquare,
  Route, Settings, ShieldCheck, Siren, SlidersHorizontal, Truck, UserCog, Users, Wrench, X, Cpu,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, setTenantFormat } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useRealtime } from '../lib/realtime';
import { Button, cx, useToast } from './ui';

type Item = { to: string; label: string; icon: ReactNode; perm?: string[]; any?: string[] };

export function Layout(): ReactNode {
  const { me, can, logout } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  useEffect(() => setTenantFormat(me?.tenant?.timezone, me?.tenant?.currency), [me?.tenant?.timezone, me?.tenant?.currency]);
  useEffect(() => {
    if (me?.user.locale === 'sw' || me?.user.locale === 'en') if (!localStorage.getItem('jfs.lang')) setLang(me.user.locale);
  }, [me?.user.locale]); // eslint-disable-line react-hooks/exhaustive-deps

  // live alerts -> toast + refresh badges
  useRealtime<{ title?: string; severity?: string }>('alert', (a) => {
    if (a.title) toast(`${a.severity === 'critical' ? '🚨 ' : ''}${a.title}`, a.severity === 'critical' ? 'error' : 'ok');
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    void qc.invalidateQueries({ queryKey: ['/alerts'] });
  });
  useRealtime('notification', () => void qc.invalidateQueries({ queryKey: ['notifications'] }));

  if (!me) return null;
  const isSuper = me.user.role === 'super_admin';
  const sections: { title: string; items: Item[] }[] = isSuper
    ? [
        {
          title: t('platform'),
          items: [
            { to: '/admin', label: t('dashboard'), icon: <Gauge /> },
            { to: '/admin/tenants', label: t('tenants'), icon: <Building2 /> },
            { to: '/admin/plans', label: t('plans'), icon: <SlidersHorizontal /> },
            { to: '/admin/invoices', label: t('invoices'), icon: <CreditCard /> },
            { to: '/admin/devices', label: t('devices'), icon: <Cpu /> },
            { to: '/admin/audit', label: t('audit_log'), icon: <ShieldCheck /> },
          ],
        },
      ]
    : [
        {
          title: t('operations'),
          items: [
            { to: '/', label: t('dashboard'), icon: <BarChart3 />, any: ['analytics:read', 'tracking:read'] },
            { to: '/map', label: t('live_map'), icon: <Map />, perm: ['tracking:read'] },
            { to: '/dispatch', label: t('dispatch'), icon: <Route />, perm: ['jobs:read'] },
            { to: '/messages', label: t('messages'), icon: <MessageSquare />, perm: ['messages:read'] },
            { to: '/alerts', label: t('alerts'), icon: <Siren />, perm: ['alerts:read'] },
          ],
        },
        {
          title: t('fleet'),
          items: [
            { to: '/vehicles', label: t('vehicles'), icon: <Car />, perm: ['vehicles:read'] },
            { to: '/drivers', label: t('drivers'), icon: <Users />, perm: ['drivers:read'] },
            { to: '/trips', label: t('trips'), icon: <Truck />, perm: ['trips:read'] },
            { to: '/geofences', label: t('geofences'), icon: <MapPinned />, perm: ['geofences:read'] },
            { to: '/devices', label: t('devices'), icon: <Cpu />, perm: ['devices:read'] },
          ],
        },
        {
          title: t('management'),
          items: [
            { to: '/maintenance', label: t('maintenance'), icon: <Wrench />, perm: ['maintenance:read'] },
            { to: '/fuel', label: t('fuel'), icon: <Fuel />, perm: ['fuel:read'] },
            { to: '/reports', label: t('reports'), icon: <FileBarChart />, any: ['reports:read', 'driver_scores:read'] },
            { to: '/billing', label: t('billing'), icon: <CreditCard />, perm: ['billing:read'] },
            { to: '/settings', label: t('settings'), icon: <Settings />, any: ['tenant:settings', 'users:read', 'audit:read'] },
          ],
        },
      ];

  const visible = (i: Item): boolean => (!i.perm || can(...i.perm)) && (!i.any || i.any.some((p) => can(p)));
  const suspended = me.tenant?.status === 'suspended';

  const sidebar = (
    <nav className="flex h-full flex-col bg-brand-950 text-white/80">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <img src="/favicon.svg" alt="" className="size-8" />
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">Jatelo Fleet</p>
          <p className="max-w-40 truncate text-[11px] text-white/50">{isSuper ? 'Super admin' : me.tenant?.name}</p>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-2.5 py-3 scroll-thin">
        {sections.map((s) => {
          const items = s.items.filter(visible);
          if (!items.length) return null;
          return (
            <div key={s.title}>
              <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-white/35">{s.title}</p>
              {items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.to === '/' || i.to === '/admin'}
                  className={({ isActive }) =>
                    cx(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors [&_svg]:size-[18px]',
                      isActive ? 'bg-white/10 font-medium text-white' : 'hover:bg-white/5 hover:text-white',
                    )
                  }
                >
                  {i.icon}
                  {i.label}
                </NavLink>
              ))}
            </div>
          );
        })}
      </div>
      <div className="border-t border-white/10 p-3 text-[11px] text-white/35">© Jatelo Technologies</div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-[1500] flex lg:hidden">
          <div className="w-64">{sidebar}</div>
          <button type="button" className="flex-1 bg-black/40" aria-label={t('close')} onClick={() => setOpen(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-black/[0.06] bg-white px-3 sm:px-5">
          <button type="button" className="rounded-lg p-2 hover:bg-black/5 lg:hidden" onClick={() => setOpen(true)} aria-label="Menu">
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" icon={<Languages className="size-4" />} onClick={() => setLang(lang === 'en' ? 'sw' : 'en')} aria-label={t('language')}>
            {lang === 'en' ? 'Kiswahili' : 'English'}
          </Button>
          {!isSuper && <Notifications />}
          <UserMenu name={me.user.full_name} email={me.user.email} onSecurity={() => nav('/account')} onLogout={() => void logout().then(() => nav('/login'))} />
        </header>
        {!online && <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">{t('offline_banner')}</div>}
        {suspended && (
          <div className="flex items-center justify-center gap-3 bg-red-600 px-4 py-2 text-sm text-white">
            {t('account_suspended')}
            {can('billing:read') && <Button size="sm" variant="accent" onClick={() => nav('/billing')}>{t('billing')}</Button>}
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function UserMenu({ name, email, onSecurity, onLogout }: { name: string; email: string; onSecurity: () => void; onLogout: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-black/5" aria-expanded={open}>
        <span className="flex size-8 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{initials}</span>
        <span className="hidden text-left text-sm leading-tight md:block">
          <span className="block font-medium">{name}</span>
          <span className="block text-xs text-ink/50">{email}</span>
        </span>
      </button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-[1000] cursor-default" onClick={() => setOpen(false)} aria-label={t('close')} />
          <div className="absolute right-0 z-[1001] mt-1 w-52 rounded-xl bg-white p-1 shadow-xl ring-1 ring-black/10">
            <button type="button" onClick={() => { setOpen(false); onSecurity(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-black/5">
              <UserCog className="size-4" /> {t('profile')} & {t('security')}
            </button>
            <button type="button" onClick={onLogout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50">
              <LogOut className="size-4" /> {t('sign_out')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Notifications(): ReactNode {
  const [open, setOpen] = useState(false);
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ data: Row[]; unread: number }>('/notifications', { page_size: 30 }), refetchInterval: 120_000 });
  const unread = q.data?.unread ?? 0;
  const readAll = async (): Promise<void> => {
    await api.post('/notifications/read', {});
    await qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="relative rounded-lg p-2 hover:bg-black/5" aria-label={t('notifications')}>
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white tabular">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-[1000] cursor-default" onClick={() => setOpen(false)} aria-label={t('close')} />
          <div className="absolute right-0 z-[1001] mt-1 w-[22rem] max-w-[calc(100vw-1rem)] rounded-xl bg-white shadow-xl ring-1 ring-black/10">
            <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-2.5">
              <p className="text-sm font-semibold">{t('notifications')}</p>
              {unread > 0 && <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => void readAll()}>{t('mark_all_read')}</button>}
            </div>
            <div className="max-h-96 overflow-y-auto scroll-thin">
              {(q.data?.data ?? []).length === 0 && <p className="px-4 py-8 text-center text-sm text-ink/50">{t('no_data')}</p>}
              {(q.data?.data ?? []).map((n) => (
                <button
                  key={String(n.id)}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    const link = n.link ?? (n.alert_id ? '/alerts' : null);
                    if (link) nav(String(link));
                  }}
                  className={cx('block w-full border-b border-black/[0.04] px-4 py-2.5 text-left hover:bg-black/[0.02]', !n.read_at && 'bg-brand-50/60')}
                >
                  <p className="text-sm font-medium">{String(n.title ?? '')}</p>
                  {Boolean(n.body) && <p className="line-clamp-2 text-xs text-ink/60">{String(n.body)}</p>}
                  <p className="mt-0.5 text-[11px] text-ink/40">{fmtAgo(n.created_at, lang)}</p>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}


