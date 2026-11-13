import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle as CircleIcon, Hexagon, Pencil, Spline, Trash2, Undo2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Circle, GeoJSON, Marker, Polygon, Polyline, Tooltip } from 'react-leaflet';
import { MultiRefSelect } from '../components/forms';
import { BaseMap, ClickHandler, FitBounds, pinIcon } from '../components/map';
import { CrudPage } from '../components/table';
import { Badge, Button, Card, Checkbox, Field, Input, Modal, PageHeader, Tabs, Textarea, cx, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

type Shape = 'circle' | 'polygon' | 'corridor';

export default function GeofencesPage(): ReactNode {
  const { t } = useI18n();
  const [tab, setTab] = useState<'geofences' | 'places'>('geofences');
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 sm:px-6">
        <PageHeader title={t('geofences')} subtitle="Zones that trigger entry/exit/dwell alerts and zone speed limits, and the named places your trips and stops are labelled with." />
        <Tabs value={tab} onChange={setTab} items={[{ value: 'geofences', label: t('geofences') }, { value: 'places', label: t('places') }]} />
      </div>
      {tab === 'geofences' ? <GeofenceEditor /> : <div className="px-4 pb-6 sm:px-6"><Places /></div>}
    </div>
  );
}

function GeofenceEditor(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  const q = useQuery({ queryKey: ['/geofences', 'all'], queryFn: () => api.get<{ data: Row[] }>('/geofences', { page_size: 200 }) });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id?: string; shape: Shape; points: [number, number][]; radius: number; width: number; name: string; color: string; speed: string; description: string; active: boolean } | null>(null);
  const [assign, setAssign] = useState<Row | null>(null);
  const write = can('geofences:write');
  const all = q.data?.data ?? [];

  const startNew = (shape: Shape): void => setDraft({ shape, points: [], radius: 300, width: 200, name: '', color: '#2563EB', speed: '', description: '', active: true });
  const startEdit = (g: Row): void => {
    const geom = g.geometry as { coordinates: number[][][][] } | null;
    const ring = geom?.coordinates?.[0]?.[0] ?? [];
    setDraft({
      id: String(g.id),
      shape: g.shape as Shape,
      points: g.shape === 'circle' ? [[Number(g.center_lat), Number(g.center_lng)]] : g.shape === 'polygon' ? ring.slice(0, -1).map(([lng, lat]) => [lat!, lng!] as [number, number]) : ((g.path as number[][] | undefined) ?? []).map(([lng, lat]) => [lat!, lng!] as [number, number]),
      radius: Number(g.radius_m ?? 300), width: Number(g.width_m ?? 200), name: String(g.name), color: String(g.color ?? '#2563EB'),
      speed: g.speed_limit_kph ? String(g.speed_limit_kph) : '', description: String(g.description ?? ''), active: Boolean(g.is_active),
    });
  };
  const click = (lat: number, lng: number): void => {
    if (!draft) return;
    setDraft({ ...draft, points: draft.shape === 'circle' ? [[lat, lng]] : [...draft.points, [lat, lng]] });
  };
  const save = async (): Promise<void> => {
    if (!draft) return;
    const p = draft.points;
    const body: Record<string, unknown> = {
      name: draft.name, shape: draft.shape, color: draft.color, is_active: draft.active, description: draft.description || null,
      speed_limit_kph: draft.speed ? Number(draft.speed) : null,
      ...(draft.shape === 'circle' ? { center: { lat: p[0]![0], lng: p[0]![1] }, radius_m: draft.radius } : {}),
      ...(draft.shape === 'polygon' ? { polygon: p.map(([lat, lng]) => [lng, lat]) } : {}),
      ...(draft.shape === 'corridor' ? { path: p.map(([lat, lng]) => [lng, lat]), width_m: draft.width } : {}),
    };
    try {
      if (draft.id) await api.patch(`/geofences/${draft.id}`, body);
      else await api.post('/geofences', { ...body, applies_to_all: true });
      toast(t('saved'));
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['/geofences'] });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const min = draft?.shape === 'circle' ? 1 : draft?.shape === 'polygon' ? 3 : 2;
  const pts = all.flatMap((g) => (g.center_lat ? [[Number(g.center_lat), Number(g.center_lng)] as [number, number]] : []));

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex max-h-[40%] w-full shrink-0 flex-col border-t border-black/[0.06] bg-white md:max-h-none md:w-80 md:border-r md:border-t-0">
        {write && !draft && (
          <div className="flex gap-1.5 border-b border-black/[0.06] p-3">
            <Button size="sm" variant="secondary" icon={<CircleIcon className="size-4" />} onClick={() => startNew('circle')}>Circle</Button>
            <Button size="sm" variant="secondary" icon={<Hexagon className="size-4" />} onClick={() => startNew('polygon')}>Polygon</Button>
            <Button size="sm" variant="secondary" icon={<Spline className="size-4" />} onClick={() => startNew('corridor')}>Corridor</Button>
          </div>
        )}
        {draft ? (
          <div className="space-y-3 overflow-y-auto p-4">
            <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800">
              {draft.shape === 'circle' ? 'Click the map to place the centre.' : draft.shape === 'polygon' ? 'Click the map to add corners (at least 3).' : 'Click along the road to draw the corridor centre line.'} {draft.points.length > 0 && `${draft.points.length} point(s).`}
            </p>
            <Field label={t('name')} required><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /></Field>
            {draft.shape === 'circle' && <Field label={`Radius: ${draft.radius} m`}><input type="range" min={50} max={20000} step={50} value={draft.radius} onChange={(e) => setDraft({ ...draft, radius: Number(e.target.value) })} className="w-full accent-brand-600" /></Field>}
            {draft.shape === 'corridor' && <Field label={`Width: ${draft.width} m`}><input type="range" min={20} max={5000} step={10} value={draft.width} onChange={(e) => setDraft({ ...draft, width: Number(e.target.value) })} className="w-full accent-brand-600" /></Field>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Speed limit (km/h)" hint="Optional zone limit"><Input type="number" value={draft.speed} onChange={(e) => setDraft({ ...draft, speed: e.target.value })} /></Field>
              <Field label="Colour"><input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value.toUpperCase() })} className="h-9 w-full rounded-lg ring-1 ring-black/15" /></Field>
            </div>
            <Field label={t('description')}><Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
            <Checkbox label={t('active')} checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            <div className="flex flex-wrap gap-2 pt-2">
              {draft.shape !== 'circle' && <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} disabled={!draft.points.length} onClick={() => setDraft({ ...draft, points: draft.points.slice(0, -1) })}>Undo</Button>}
              <div className="flex-1" />
              <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>{t('cancel')}</Button>
              <Button size="sm" disabled={!draft.name || draft.points.length < min} onClick={() => void save()}>{t('save')}</Button>
            </div>
          </div>
        ) : (
          <ul className="flex-1 overflow-y-auto scroll-thin">
            {all.map((g) => (
              <li key={String(g.id)} className={cx('flex items-center gap-2 border-b border-black/[0.04] px-3 py-2', selected === g.id && 'bg-brand-50')}>
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelected(String(g.id))}>
                  <span className="size-3 shrink-0 rounded" style={{ background: String(g.color ?? '#2563EB') }} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{String(g.name)}</span>
                    <span className="block text-xs text-ink/50">{String(g.shape)}{g.speed_limit_kph ? ` · ${String(g.speed_limit_kph)} km/h` : ''}{!g.is_active ? ' · inactive' : ''}</span>
                  </span>
                </button>
                {write && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setAssign(g)}>Vehicles</Button>
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} aria-label={t('edit')} onClick={() => startEdit(g)} />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-red-600" />} aria-label={t('delete')} onClick={async () => {
                      if (!(await confirm(`Delete geofence "${String(g.name)}"?`, { danger: true }))) return;
                      await api.del(`/geofences/${String(g.id)}`).then(() => qc.invalidateQueries({ queryKey: ['/geofences'] }), (e: unknown) => toast(errorText(e), 'error'));
                    }} />
                  </>
                )}
              </li>
            ))}
            {!all.length && <li className="px-4 py-10 text-center text-sm text-ink/40">{t('no_data')}</li>}
          </ul>
        )}
      </aside>
      <div className="relative min-h-[50vh] flex-1">
        <BaseMap>
          <FitBounds points={pts} />
          <ClickHandler onClick={click} />
          {all.filter((g) => g.id !== draft?.id).map((g) => (
            <GeoJSON key={`${String(g.id)}-${String(g.updated_at)}-${selected === g.id}`} data={g.geometry as never} style={{ color: String(g.color ?? '#2563EB'), weight: selected === g.id ? 3 : 1.5, fillOpacity: selected === g.id ? 0.25 : 0.12, dashArray: g.is_active ? undefined : '4 4' }} eventHandlers={{ click: () => setSelected(String(g.id)) }}>
              <Tooltip sticky>{String(g.name)}</Tooltip>
            </GeoJSON>
          ))}
          {draft?.shape === 'circle' && draft.points[0] && <Circle center={draft.points[0]} radius={draft.radius} pathOptions={{ color: draft.color }} />}
          {draft?.shape === 'polygon' && draft.points.length > 0 && <Polygon positions={draft.points} pathOptions={{ color: draft.color }} />}
          {draft?.shape === 'corridor' && draft.points.length > 0 && <Polyline positions={draft.points} pathOptions={{ color: draft.color, weight: 6, opacity: 0.6 }} />}
          {draft?.points.map((p, i) => <Marker key={i} position={p} icon={pinIcon(draft.color, String(i + 1))} />)}
        </BaseMap>
      </div>
      <Modal open={Boolean(assign)} onClose={() => setAssign(null)} title={`${String(assign?.name ?? '')} · vehicles`}>
        {assign && <Assignments geofence={assign} onDone={() => { setAssign(null); void qc.invalidateQueries({ queryKey: ['/geofences'] }); }} />}
      </Modal>
    </div>
  );
}

function Assignments({ geofence, onDone }: { geofence: Row; onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['geo-assign', geofence.id], queryFn: async () => ({ applies_to_all: Boolean(geofence.applies_to_all), assignments: (await api.get<{ data: Row[] }>(`/geofences/${String(geofence.id)}/assignments`)).data }) });
  const [all, setAll] = useState<boolean | null>(null);
  const [vehicles, setVehicles] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<string[] | null>(null);
  const [dwell, setDwell] = useState<string | null>(null);
  if (!q.data) return null;
  const a = q.data.assignments;
  const allV = all ?? q.data.applies_to_all;
  const vs = vehicles ?? a.filter((x) => x.vehicle_id).map((x) => String(x.vehicle_id));
  const gs = groups ?? a.filter((x) => x.group_id).map((x) => String(x.group_id));
  const dw = dwell ?? String(a[0]?.dwell_minutes ?? '');
  const save = async (): Promise<void> => {
    try {
      const extra = { alert_on_entry: true, alert_on_exit: true, dwell_minutes: dw ? Number(dw) : null };
      await api.put(`/geofences/${String(geofence.id)}/assignments`, { applies_to_all: allV, assignments: allV ? [] : [...vs.map((v) => ({ vehicle_id: v, ...extra })), ...gs.map((g) => ({ group_id: g, ...extra }))] });
      toast(t('saved'));
      onDone();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="space-y-4">
      <Checkbox label={`${t('all_vehicles')} (entry and exit alerts follow your alert rules)`} checked={allV} onChange={(e) => setAll(e.target.checked)} />
      {!allV && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('vehicles')}><MultiRefSelect path="/vehicles" label={(v) => String(v.plate_number)} value={vs} onChange={setVehicles} /></Field>
          <Field label={t('vehicle_groups')}><MultiRefSelect path="/vehicle-groups" label={(g) => String(g.name)} value={gs} onChange={setGroups} /></Field>
          <Field label="Dwell alert after (minutes)" hint="Optional"><Input type="number" min={1} value={dw} onChange={(e) => setDwell(e.target.value)} /></Field>
        </div>
      )}
      {!allV && !vs.length && !gs.length && <Badge tone="amber">No vehicles selected - this geofence will not trigger</Badge>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onDone}>{t('cancel')}</Button><Button onClick={() => void save()}>{t('save')}</Button></div>
    </div>
  );
}

function Places(): ReactNode {
  const { t } = useI18n();
  return (
    <CrudPage
      path="/pois"
      title={t('places')}
      embedded
      write="geofences:write"
      noun="place"
      formOpts={{
        order: ['name', 'category', 'lat', 'lng', 'radius_m', 'address'],
        custom: { lat: (v, set) => <LatLngPicker value={v as number | undefined} set={set} />, lng: (v, set) => <Input type="number" step="any" value={v === undefined || v === null ? '' : String(v)} onChange={(e) => set(Number(e.target.value))} /> },
      }}
      columns={[
        { key: 'name', render: (r) => <span className="font-medium">{String(r.name)}</span> },
        { key: 'category', render: (r) => t(String(r.category)) },
        { key: 'address' },
        { key: 'radius_m', type: 'number' },
        { key: 'contact_phone' },
      ]}
    />
  );
}

/** Latitude input with a hint: coordinates can be pasted as "lat, lng" (e.g. from Google Maps). */
function LatLngPicker({ value, set }: { value: number | undefined; set: (v: unknown) => void }): ReactNode {
  return <Input type="text" inputMode="decimal" value={value === undefined || value === null ? '' : String(value)} placeholder="-0.0917" onChange={(e) => { const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(e.target.value); set(m ? Number(m[1]) : undefined); }} />;
}

