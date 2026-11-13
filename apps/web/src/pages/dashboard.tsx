import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Route as RouteIcon, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, PageHeader, Select, Spinner, Stat, cx } from '../components/ui';
import { STATE_COLORS } from '../components/map';
import { api, type Row } from '../lib/api';
import { fmtNum, isoDay } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface Kpi { label: string; value: number | null; display: string; previous: string; change: string; trend: 'good' | 'bad' | 'flat' }
interface Dash {
  period: { from: string; to: string };
  currency: string;
  live: Record<string, number>;
  kpis: Record<string, Kpi>;
  operations: Record<string, number>;
  series: Row[];
  top_vehicles: Row[];
  best_drivers: Row[];
  drivers_needing_coaching: Row[];
}

const RANGES = { '7': 6, '30': 29, '90': 89 } as const;

export default function Dashboard(): ReactNode {
  const { t } = useI18n();
  const [range, setRange] = useState<keyof typeof RANGES>('30');
  const q = useQuery({
    queryKey: ['dashboard', range],
    queryFn: () => api.get<Dash>('/analytics/dashboard', { from: isoDay(new Date(), -RANGES[range]), to: isoDay() }),
    refetchInterval: 60_000,
  });
  const d = q.data;
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader
        title={t('dashboard')}
        subtitle={d ? `${d.period.from} → ${d.period.to}` : undefined}
        actions={
          <Select value={range} onChange={(e) => setRange(e.target.value as keyof typeof RANGES)} className="w-40" aria-label={t('period')}>
            <option value="7">{t('last_7_days')}</option>
            <option value="30">{t('last_30_days')}</option>
            <option value="90">90 days</option>
          </Select>
        }
      />
      {!d ? (
        <div className="flex justify-center py-24"><Spinner className="size-7 text-brand-600" /></div>
      ) : (
        <div className="space-y-5">
          <FleetStatus live={d.live} />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {(['km', 'trips', 'util', 'fuel_cost', 'cost_per_km', 'score'] as const).map((k) => {
              const x = d.kpis[k];
              if (!x) return null;
              return <Stat key={k} label={x.label} value={x.display} sub={`${x.change} ${t('vs_previous')}`} tone={x.trend} />;
            })}
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title={`${t('distance')} · ${t('trend_30d')}`} className="lg:col-span-2">
              <div className="h-64">
                <ResponsiveContainer>
                  <AreaChart data={d.series} margin={{ left: -10, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="km" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0f6b4f" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#0f6b4f" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#0001" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v) => [`${fmtNum(v)} km`, t('distance')]} />
                    <Area type="monotone" dataKey="distance_km" stroke="#0f6b4f" strokeWidth={2} fill="url(#km)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title={t('operations')}>
              <ul className="space-y-2.5 text-sm">
                <OpsRow to="/alerts" icon={<AlertTriangle className="size-4 text-red-600" />} label={t('open_alerts')} value={d.operations.open_alerts} sub={d.operations.critical_alerts ? `${d.operations.critical_alerts} ${t('critical')}` : undefined} />
                <OpsRow to="/dispatch" icon={<RouteIcon className="size-4 text-violet-600" />} label={t('active_jobs')} value={d.operations.active_jobs} sub={d.operations.off_route_jobs ? `${d.operations.off_route_jobs} ${t('off_route')}` : undefined} />
                <OpsRow to="/maintenance" icon={<CalendarClock className="size-4 text-amber-600" />} label={t('services_due')} value={d.operations.services_due} sub={d.operations.services_overdue ? `${d.operations.services_overdue} ${t('overdue')}` : undefined} />
                <OpsRow to="/maintenance" icon={<Wrench className="size-4 text-sky-600" />} label={t('work_orders')} value={d.operations.open_work_orders} sub={d.operations.critical_defects ? `${d.operations.critical_defects} critical defects` : undefined} />
                <OpsRow to="/fuel" icon={<span className="text-sm">⛽</span>} label="Suspected fuel drains" value={d.operations.open_fuel_drains} />
              </ul>
            </Card>
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Safety events">
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={d.series} margin={{ left: -20, right: 4, top: 8 }}>
                    <CartesianGrid stroke="#0001" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(8)} fontSize={11} tickLine={false} axisLine={false} minTickGap={8} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="harsh" stackId="a" fill="#f59e0b" name="Harsh" />
                    <Bar dataKey="overspeed" stackId="a" fill="#dc2626" name="Overspeed" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title={t('top_vehicles')} pad={false}>
              <ul className="divide-y divide-black/[0.05]">
                {d.top_vehicles.map((v) => (
                  <li key={String(v.id)}>
                    <Link to={`/vehicles/${String(v.id)}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-black/[0.02]">
                      <span className="font-medium">{String(v.plate_number)}</span>
                      <span className="tabular text-ink/60">{fmtNum(v.distance_km)} km · {fmtNum(v.utilisation_pct, 0)}%</span>
                    </Link>
                  </li>
                ))}
                {!d.top_vehicles.length && <li className="px-4 py-8 text-center text-sm text-ink/40">{t('no_data')}</li>}
              </ul>
            </Card>
            <Card title={t('best_drivers')} pad={false}>
              <ul className="divide-y divide-black/[0.05]">
                {d.best_drivers.map((v) => <DriverRow key={String(v.id)} r={v} />)}
                {d.drivers_needing_coaching.length > 0 && <li className="bg-red-50/60 px-4 py-1.5 text-xs font-medium text-red-700">{t('needs_coaching')}</li>}
                {d.drivers_needing_coaching.map((v) => <DriverRow key={`c${String(v.id)}`} r={v} />)}
                {!d.best_drivers.length && <li className="px-4 py-8 text-center text-sm text-ink/40">{t('no_data')}</li>}
              </ul>
            </Card>
          </div>
          <Card title="All KPIs" pad={false}>
            <div className="grid divide-black/[0.05] sm:grid-cols-2 lg:grid-cols-3 [&>div]:border-b [&>div]:border-black/[0.05]">
              {Object.entries(d.kpis).map(([k, x]) => (
                <div key={k} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-ink/70">{x.label}</span>
                  <span className="text-right tabular">
                    <span className="font-medium">{x.display}</span>
                    <span className={cx('ml-2 text-xs', x.trend === 'good' ? 'text-emerald-700' : x.trend === 'bad' ? 'text-red-600' : 'text-ink/40')}>{x.change}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function FleetStatus({ live }: { live: Record<string, number> }): ReactNode {
  const { t } = useI18n();
  const parts = [
    { k: 'moving', c: STATE_COLORS.moving },
    { k: 'idle', c: STATE_COLORS.idle },
    { k: 'stopped', c: STATE_COLORS.stopped },
    { k: 'offline', c: STATE_COLORS.offline },
    { k: 'never', c: '#94a3b8' },
    { k: 'no_device', c: '#e2e8f0' },
  ];
  const known = ['moving', 'idle', 'stopped', 'offline', 'no_device'].reduce((a, k) => a + (live[k] ?? 0), 0);
  live = { ...live, never: Math.max(0, (live.total ?? 0) - known) };
  const total = Math.max(1, live.total ?? 0);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink/55">{t('fleet_status')}</p>
          <p className="text-2xl font-semibold tabular">{live.total} <span className="text-sm font-normal text-ink/50">{t('vehicles').toLowerCase()}</span></p>
        </div>
        <Link to="/map" className="text-sm font-medium text-brand-700 hover:underline">{t('live_map')} →</Link>
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-black/5" role="img" aria-label={t('fleet_status')}>
        {parts.map((p) => <div key={p.k} style={{ width: `${((live[p.k] ?? 0) / total) * 100}%`, background: p.c }} />)}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {parts.map((p) => (
          <span key={p.k} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: p.c }} />
            {t(p.k)} <b className="tabular">{live[p.k] ?? 0}</b>
          </span>
        ))}
      </div>
    </Card>
  );
}

function OpsRow({ to, icon, label, value, sub }: { to: string; icon: ReactNode; label: string; value?: number; sub?: string }): ReactNode {
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-black/[0.02]">
        <span className="flex size-8 items-center justify-center rounded-lg bg-black/[0.04]">{icon}</span>
        <span className="flex-1">
          <span className="block">{label}</span>
          {sub && <span className="block text-xs text-red-600">{sub}</span>}
        </span>
        <span className="text-lg font-semibold tabular">{value ?? 0}</span>
      </Link>
    </li>
  );
}

function DriverRow({ r }: { r: Row }): ReactNode {
  const s = Number(r.score);
  return (
    <li>
      <Link to={`/drivers/${String(r.id)}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-black/[0.02]">
        <span className="font-medium">{String(r.full_name)}</span>
        <span className={cx('rounded-md px-1.5 py-0.5 text-xs font-semibold tabular', s >= 85 ? 'bg-emerald-50 text-emerald-700' : s >= 70 ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-700')}>{fmtNum(s, 1)}</span>
      </Link>
    </li>
  );
}
