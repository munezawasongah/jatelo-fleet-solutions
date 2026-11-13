import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, History, Link2, Power, Search, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Marker, Tooltip } from 'react-leaflet';
import { Link } from 'react-router';
import { BaseMap, FitBounds, PanTo, STATE_COLORS, vehicleIcon } from '../components/map';
import { Badge, Button, Select, StatusBadge, cx, errorText, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtNum } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useRealtime } from '../lib/realtime';

interface LiveVehicle {
  vehicle_id: string;
  plate_number: string;
  label: string | null;
  icon: string;
  group_id: string | null;
  group_name: string | null;
  driver_name: string | null;
  device_id: string | null;
  state: string;
  state_since: string | null;
  last_seen_at: string | null;
  lat: number | null;
  lng: number | null;
  speed_kph: number | null;
  heading: number | null;
  ignition: boolean | null;
  fuel_level_pct: number | null;
  ext_voltage_mv: number | null;
  gsm_signal: number | null;
  odometer_km: number | null;
  open_alerts: number;
}

/** Vehicles silent for 15 minutes are shown as offline, whatever their last state. */
const effState = (v: LiveVehicle): string =>
  !v.device_id ? 'never' : !v.last_seen_at ? 'never' : Date.now() - Date.parse(v.last_seen_at) > 15 * 60_000 ? 'offline' : v.state;

export default function LiveMap(): ReactNode {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { toast, confirm } = useToast();
  const [q, setQ] = useState('');
  const [stateF, setStateF] = useState('');
  const [groupF, setGroupF] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [, setTick] = useState(0);

  const live = useQuery({ queryKey: ['live'], queryFn: () => api.get<{ data: LiveVehicle[] }>('/tracking/live'), refetchInterval: 60_000 });

  useRealtime<Partial<LiveVehicle> & { vehicle_id: string; recorded_at?: string }>('position', (p) => {
    qc.setQueryData<{ data: LiveVehicle[] }>(['live'], (old) =>
      old
        ? {
            data: old.data.map((v) =>
              v.vehicle_id === p.vehicle_id
                ? { ...v, ...Object.fromEntries(Object.entries(p).filter(([, x]) => x !== null && x !== undefined)), last_seen_at: p.recorded_at ?? v.last_seen_at }
                : v,
            ),
          }
        : old,
    );
    setTick((x) => x + 1);
  });
  useRealtime<{ vehicle_id?: string }>('alert', (a) => {
    if (a.vehicle_id) qc.setQueryData<{ data: LiveVehicle[] }>(['live'], (old) => old && { data: old.data.map((v) => (v.vehicle_id === a.vehicle_id ? { ...v, open_alerts: v.open_alerts + 1 } : v)) });
  });

  const vehicles = live.data?.data ?? [];
  const groups = useMemo(() => [...new Map(vehicles.filter((v) => v.group_id).map((v) => [v.group_id!, v.group_name ?? ''])).entries()], [vehicles]);
  const filtered = vehicles.filter(
    (v) =>
      (!q || `${v.plate_number} ${v.label ?? ''} ${v.driver_name ?? ''}`.toLowerCase().includes(q.toLowerCase())) &&
      (!stateF || effState(v) === stateF) &&
      (!groupF || v.group_id === groupF),
  );
  const counts = vehicles.reduce<Record<string, number>>((a, v) => ({ ...a, [effState(v)]: (a[effState(v)] ?? 0) + 1 }), {});
  const sel = vehicles.find((v) => v.vehicle_id === selected) ?? null;
  const points = filtered.filter((v) => v.lat !== null && v.lng !== null).map((v) => [v.lat!, v.lng!] as [number, number]);

  const share = async (v: LiveVehicle): Promise<void> => {
    try {
      const r = await api.post<{ url: string }>('/share-links', { vehicle_id: v.vehicle_id, hours: 4, label: `${v.plate_number} live location` });
      await navigator.clipboard.writeText(r.url).catch(() => undefined);
      toast(`Link copied (valid 4 h): ${r.url}`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const command = async (v: LiveVehicle, type: 'immobilize' | 'restore'): Promise<void> => {
    if (!v.device_id) return;
    if (type === 'immobilize' && !(await confirm(`${t('immobilize')}: ${v.plate_number}? The engine will be cut when the vehicle is slow or stopped.`, { danger: true, label: t('immobilize') }))) return;
    try {
      const r = await api.post<{ message: string }>(`/devices/${v.device_id}/commands`, { command_type: type, confirm: true });
      toast(r.message);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex max-h-[45%] w-full shrink-0 flex-col border-b border-black/[0.06] bg-white md:max-h-none md:w-80 md:border-b-0 md:border-r">
        <div className="space-y-2 border-b border-black/[0.06] p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink/40" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-9 w-full rounded-lg bg-black/[0.04] pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div className="flex flex-wrap gap-1">
            {['', 'moving', 'idle', 'stopped', 'offline'].map((s) => (
              <button
                key={s || 'all'}
                type="button"
                onClick={() => setStateF(s)}
                className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset', stateF === s ? 'bg-brand-600 text-white ring-brand-600' : 'ring-black/10 hover:bg-black/[0.03]')}
              >
                {s && <span className="size-2 rounded-full" style={{ background: STATE_COLORS[s] }} />}
                {s ? t(s) : t('all')} <span className="tabular opacity-70">{s ? (counts[s] ?? 0) : vehicles.length}</span>
              </button>
            ))}
          </div>
          {groups.length > 1 && (
            <Select value={groupF} onChange={(e) => setGroupF(e.target.value)} aria-label={t('vehicle_groups')}>
              <option value="">{t('all_vehicles')}</option>
              {groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          )}
        </div>
        <ul className="flex-1 overflow-y-auto scroll-thin">
          {filtered.map((v) => {
            const st = effState(v);
            return (
              <li key={v.vehicle_id}>
                <button
                  type="button"
                  onClick={() => setSelected(v.vehicle_id)}
                  className={cx('flex w-full items-start gap-3 border-b border-black/[0.04] px-3 py-2.5 text-left hover:bg-black/[0.02]', selected === v.vehicle_id && 'bg-brand-50')}
                >
                  <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: STATE_COLORS[st] }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{v.plate_number}</span>
                      <span className="text-xs tabular text-ink/60">{st === 'moving' ? `${fmtNum(v.speed_kph)} km/h` : t(st)}</span>
                    </span>
                    <span className="block truncate text-xs text-ink/55">{v.driver_name ?? v.label ?? '—'}</span>
                    <span className="block text-[11px] text-ink/40">{fmtAgo(v.last_seen_at, lang)}</span>
                  </span>
                  {v.open_alerts > 0 && <Badge tone="red">{v.open_alerts}</Badge>}
                </button>
              </li>
            );
          })}
          {!filtered.length && <li className="px-4 py-10 text-center text-sm text-ink/40">{live.isPending ? t('loading') : t('no_data')}</li>}
        </ul>
      </aside>
      <div className="relative min-h-0 flex-1">
        <BaseMap>
          <FitBounds points={points} />
          {follow && sel?.lat !== null && sel?.lat !== undefined && <PanTo to={[sel.lat, sel.lng!]} />}
          {filtered.map((v) =>
            v.lat === null || v.lng === null ? null : (
              <Marker
                key={v.vehicle_id}
                position={[v.lat, v.lng]}
                icon={vehicleIcon({ state: effState(v), heading: v.heading, label: v.plate_number, selected: v.vehicle_id === selected })}
                eventHandlers={{ click: () => setSelected(v.vehicle_id) }}
                zIndexOffset={v.vehicle_id === selected ? 1000 : 0}
              >
                <Tooltip direction="top" offset={[0, -14]}>{v.plate_number}</Tooltip>
              </Marker>
            ),
          )}
        </BaseMap>
        {sel && (
          <div className="absolute right-3 top-3 z-[500] w-[min(22rem,calc(100%-1.5rem))] rounded-xl bg-white shadow-xl ring-1 ring-black/10">
            <div className="flex items-start justify-between border-b border-black/[0.06] p-4">
              <div>
                <p className="text-base font-semibold">{sel.plate_number}</p>
                <p className="text-xs text-ink/55">{[sel.label, sel.group_name].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge value={effState(sel)} />
                <button type="button" onClick={() => setSelected(null)} className="rounded p-1 hover:bg-black/5" aria-label={t('close')}><X className="size-4" /></button>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 p-4 text-sm">
              <Info k={t('speed')} v={`${fmtNum(sel.speed_kph)} km/h`} />
              <Info k={t('ignition')} v={sel.ignition === null ? '—' : sel.ignition ? t('on') : t('off')} />
              <Info k={t('driver')} v={sel.driver_name ?? '—'} />
              <Info k={t('last_seen')} v={fmtAgo(sel.last_seen_at, lang)} />
              <Info k="Odometer" v={`${fmtNum(sel.odometer_km)} km`} />
              <Info k="Fuel" v={sel.fuel_level_pct === null ? '—' : `${fmtNum(sel.fuel_level_pct)}%`} />
              <Info k="Power" v={sel.ext_voltage_mv ? `${(sel.ext_voltage_mv / 1000).toFixed(1)} V` : '—'} />
              <Info k="GSM" v={sel.gsm_signal === null ? '—' : `${sel.gsm_signal}/5`} />
            </dl>
            {sel.lat !== null && <p className="px-4 pb-2 font-mono text-[11px] text-ink/45">{sel.lat?.toFixed(5)}, {sel.lng?.toFixed(5)}</p>}
            <div className="flex flex-wrap gap-2 border-t border-black/[0.06] p-3">
              <Button size="sm" variant={follow ? 'primary' : 'secondary'} icon={<Crosshair className="size-4" />} onClick={() => setFollow(!follow)}>{t('follow')}</Button>
              <Link to={`/vehicles/${sel.vehicle_id}`}><Button size="sm" variant="secondary" icon={<History className="size-4" />}>{t('playback')}</Button></Link>
              {can('share_links:create') && <Button size="sm" variant="secondary" icon={<Link2 className="size-4" />} onClick={() => void share(sel)}>{t('share_location')}</Button>}
              {can('devices:assign') && sel.device_id && (
                <>
                  <Button size="sm" variant="danger" icon={<Power className="size-4" />} onClick={() => void command(sel, 'immobilize')}>{t('immobilize')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void command(sel, 'restore')}>{t('restore_engine')}</Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Info({ k, v }: { k: string; v: ReactNode }): ReactNode {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-ink/45">{k}</dt>
      <dd className="font-medium tabular">{v}</dd>
    </div>
  );
}

