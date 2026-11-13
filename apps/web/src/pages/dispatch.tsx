import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Link2, MapPin, Plus, Send, Sparkles, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { GeoJSON, Marker, Polyline, Tooltip } from 'react-leaflet';
import { Link, useNavigate, useParams } from 'react-router';
import { RefSelect, useOptions } from '../components/forms';
import { BaseMap, ClickHandler, FitBounds, pinIcon, vehicleIcon } from '../components/map';
import { CrudPage } from '../components/table';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Tabs, Textarea, cx, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtDateTime, fmtDuration, fmtNum, fmtTime, fromLocalInput, isoDay } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useRealtime } from '../lib/realtime';

const COLS = ['draft', 'scheduled', 'dispatched', 'in_progress', 'completed', 'failed', 'cancelled'];
const STOP_COLORS: Record<string, string> = { pending: '#64748b', en_route: '#7c3aed', arrived: '#2563eb', completed: '#16a34a', failed: '#dc2626', skipped: '#94a3b8' };

export function DispatchBoard(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'board' | 'routes'>('board');
  const [day, setDay] = useState(isoDay());
  const q = useQuery({ queryKey: ['/jobs', 'board', day], queryFn: () => api.get<{ totals: Row; columns: Record<string, Row[]> }>('/jobs/board', { date: day }), refetchInterval: 30_000 });
  useRealtime('job', () => void q.refetch());
  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={t('dispatch')}
        subtitle={q.data ? `${String(q.data.totals.jobs)} jobs · ${String(q.data.totals.late)} ${t('late').toLowerCase()} · ${String(q.data.totals.off_route)} ${t('off_route').toLowerCase()}` : undefined}
        actions={
          <>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-40" aria-label="Day" />
            {can('jobs:write') && <Button icon={<Plus className="size-4" />} onClick={() => nav('/dispatch/new')}>{t('new_job')}</Button>}
          </>
        }
      />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'board', label: t('jobs') }, { value: 'routes', label: t('routes') }]} />
      {tab === 'board' ? (
        !q.data ? <div className="flex justify-center py-20"><Spinner /></div> : (
          <div className="flex gap-3 overflow-x-auto pb-4">
            {COLS.filter((c) => c !== 'cancelled' || q.data.columns[c]?.length).map((c) => (
              <div key={c} className="w-72 shrink-0 rounded-xl bg-black/[0.03] p-2">
                <p className="flex items-center justify-between px-1.5 pb-2 text-xs font-semibold uppercase tracking-wide text-ink/60">{t(c)}<span className="rounded-full bg-white px-1.5 tabular">{q.data.columns[c]?.length ?? 0}</span></p>
                <div className="space-y-2">
                  {(q.data.columns[c] ?? []).map((j) => <JobCard key={String(j.id)} j={j} />)}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <CrudPage embedded path="/routes" title={t('routes')} write="routes:write" noun="route" onRowClick={() => undefined}
          columns={[{ key: 'name', render: (r) => <span className="font-medium">{String(r.name)}</span> }, { key: 'stop_count', label: t('stops'), type: 'number' }, { key: 'distance_km', type: 'number' }, { key: 'duration_s', label: 'Drive time', render: (r) => fmtDuration(r.duration_s) }, { key: 'profile' }, { key: 'optimize_order', label: 'Optimised', type: 'bool' }]}
          headerActions={<span className="text-xs text-ink/50">Create route templates by saving a job's stops, or via the API.</span>}
        />
      )}
    </div>
  );
}

function JobCard({ j }: { j: Row }): ReactNode {
  const { t } = useI18n();
  const late = j.scheduled_end && j.next_eta && Date.parse(String(j.next_eta)) > Date.parse(String(j.scheduled_end));
  return (
    <Link to={`/dispatch/${String(j.id)}`} className="block rounded-lg bg-white p-3 shadow-sm ring-1 ring-black/[0.06] hover:ring-brand-400">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold leading-snug">{String(j.title)}</p>
        {j.priority === 'urgent' || j.priority === 'high' ? <StatusBadge value={j.priority} /> : null}
      </div>
      <p className="mt-0.5 font-mono text-[11px] text-ink/45">{String(j.reference)}</p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-ink/60">
        {Boolean(j.plate_number) && <Badge>{String(j.plate_number)}</Badge>}
        {Boolean(j.driver_name) && <span>{String(j.driver_name)}</span>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/5"><div className="h-full bg-brand-500" style={{ width: `${Number(j.progress_pct ?? 0)}%` }} /></div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink/55">
        <span className="tabular">{String(j.stops_done)}/{String(j.stop_count)} {t('stops').toLowerCase()}</span>
        <span className="flex gap-1">
          {Boolean(j.off_route_since) && <Badge tone="red">{t('off_route')}</Badge>}
          {Boolean(late) && <Badge tone="amber">{t('late')}</Badge>}
          {j.next_eta ? <span className="tabular">{t('eta')} {fmtTime(j.next_eta)}</span> : j.scheduled_start ? <span className="tabular">{fmtTime(j.scheduled_start)}</span> : null}
        </span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------- editor
interface DraftStop { name: string; lat: number; lng: number; stop_type: string; address?: string; contact_name?: string; contact_phone?: string; instructions?: string; time_window_end?: string; poi_id?: string }

export function JobEditor(): ReactNode {
  const { t } = useI18n();
  const nav = useNavigate();
  const { toast } = useToast();
  const pois = useOptions('/pois');
  const routes = useOptions('/routes');
  const [job, setJob] = useState<Record<string, string>>({ priority: 'normal' });
  const [stops, setStops] = useState<DraftStop[]>([]);
  const [preview, setPreview] = useState<{ geometry: [number, number][]; distance_km: number; duration_s: number; engine: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string | null): void => setJob({ ...job, [k]: v ?? '' });
  const addStop = (s: Partial<DraftStop> & { lat: number; lng: number }): void => {
    setStops([...stops, { name: s.name ?? `Stop ${stops.length + 1}`, stop_type: stops.length === 0 ? 'pickup' : 'delivery', ...s }]);
    setPreview(null);
  };
  const move = (i: number, d: -1 | 1): void => {
    const n = [...stops];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x!);
    setStops(n);
    setPreview(null);
  };
  const optimise = async (): Promise<void> => {
    try {
      const r = await api.post<{ order: number[]; geometry: [number, number][]; distance_km: number; duration_s: number; engine: string }>('/routes/plan', { stops: stops.map((s) => ({ lat: s.lat, lng: s.lng, service_minutes: 10 })), optimize: true });
      setStops([stops[0]!, ...r.order.map((i) => stops[i + 1]!)]);
      setPreview(r);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const save = async (dispatch: boolean): Promise<void> => {
    setBusy(true);
    try {
      const body = {
        title: job.title, customer_name: job.customer_name || undefined, customer_phone: job.customer_phone || undefined, priority: job.priority,
        vehicle_id: job.vehicle_id || undefined, driver_id: job.driver_id || undefined, notes: job.notes || undefined,
        scheduled_start: fromLocalInput(job.scheduled_start ?? '') ?? undefined, scheduled_end: fromLocalInput(job.scheduled_end ?? '') ?? undefined,
        route_id: !stops.length && job.route_id ? job.route_id : undefined,
        stops: stops.map((s) => ({ ...s, time_window_end: s.time_window_end ? fromLocalInput(s.time_window_end) : undefined })),
        dispatch,
      };
      const r = await api.post<Row>('/jobs', body);
      toast(dispatch ? 'Job dispatched to the driver' : t('saved'));
      nav(`/dispatch/${String(r.id)}`);
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  const pts = stops.map((s) => [s.lat, s.lng] as [number, number]);
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="w-full shrink-0 space-y-4 overflow-y-auto p-4 lg:w-[30rem]">
        <Link to="/dispatch" className="inline-flex items-center gap-1 text-sm text-ink/60 hover:text-ink"><ArrowLeft className="size-4" />{t('dispatch')}</Link>
        <h1 className="text-xl font-semibold">{t('new_job')}</h1>
        <Field label="Title" required><Input value={job.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Deliver cement to Kisumu sites" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('customer')}><Input value={job.customer_name ?? ''} onChange={(e) => set('customer_name', e.target.value)} /></Field>
          <Field label={t('phone')}><Input type="tel" value={job.customer_phone ?? ''} onChange={(e) => set('customer_phone', e.target.value)} /></Field>
          <Field label={t('vehicle')}><RefSelect field="vehicle_id" value={job.vehicle_id} onChange={(v) => set('vehicle_id', v)} /></Field>
          <Field label={t('driver')}><RefSelect field="driver_id" value={job.driver_id} onChange={(v) => set('driver_id', v)} /></Field>
          <Field label="Start"><Input type="datetime-local" value={job.scheduled_start ?? ''} onChange={(e) => set('scheduled_start', e.target.value)} /></Field>
          <Field label="Finish by"><Input type="datetime-local" value={job.scheduled_end ?? ''} onChange={(e) => set('scheduled_end', e.target.value)} /></Field>
          <Field label={t('priority')}><Select value={job.priority} onChange={(e) => set('priority', e.target.value)}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{t(p)}</option>)}</Select></Field>
          {routes.options.length > 0 && <Field label="From route template"><Select value={job.route_id ?? ''} onChange={(e) => set('route_id', e.target.value)} disabled={stops.length > 0}><option value="">—</option>{routes.options.map((r) => <option key={String(r.id)} value={String(r.id)}>{String(r.name)}</option>)}</Select></Field>}
        </div>
        <Card title={`${t('stops')} (${stops.length})`} actions={stops.length > 2 && <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" />} onClick={() => void optimise()}>{t('optimise')}</Button>} pad={false}>
          {!stops.length && <p className="px-4 py-5 text-center text-sm text-ink/50"><MapPin className="mx-auto mb-1 size-5" />{t('click_map_to_add')}</p>}
          <ol className="divide-y divide-black/[0.05]">
            {stops.map((s, i) => (
              <li key={i} className="space-y-2 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">{i + 1}</span>
                  <Input value={s.name} onChange={(e) => setStops(stops.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} className="h-8" />
                  <Select value={s.stop_type} onChange={(e) => setStops(stops.map((x, k) => (k === i ? { ...x, stop_type: e.target.value } : x)))} className="h-8 w-28 text-xs">{['pickup', 'delivery', 'service', 'waypoint'].map((x) => <option key={x} value={x}>{t(x)}</option>)}</Select>
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 hover:bg-black/5 disabled:opacity-30" aria-label="Move up"><ArrowUp className="size-4" /></button>
                  <button type="button" disabled={i === stops.length - 1} onClick={() => move(i, 1)} className="rounded p-1 hover:bg-black/5 disabled:opacity-30" aria-label="Move down"><ArrowDown className="size-4" /></button>
                  <button type="button" onClick={() => { setStops(stops.filter((_, k) => k !== i)); setPreview(null); }} className="rounded p-1 hover:bg-red-50" aria-label={t('delete')}><Trash2 className="size-4 text-red-600" /></button>
                </div>
                <div className="grid grid-cols-3 gap-2 pl-8">
                  <Input placeholder="Contact" value={s.contact_name ?? ''} onChange={(e) => setStops(stops.map((x, k) => (k === i ? { ...x, contact_name: e.target.value } : x)))} className="h-8 text-xs" />
                  <Input placeholder="Phone" value={s.contact_phone ?? ''} onChange={(e) => setStops(stops.map((x, k) => (k === i ? { ...x, contact_phone: e.target.value } : x)))} className="h-8 text-xs" />
                  <Input type="datetime-local" title="Arrive by" value={s.time_window_end ?? ''} onChange={(e) => setStops(stops.map((x, k) => (k === i ? { ...x, time_window_end: e.target.value } : x)))} className="h-8 text-xs" />
                </div>
              </li>
            ))}
          </ol>
          {pois.options.length > 0 && (
            <div className="border-t border-black/[0.06] p-3">
              <Select value="" onChange={(e) => { const p = pois.options.find((x) => x.id === e.target.value); if (p) addStop({ name: String(p.name), lat: Number(p.lat), lng: Number(p.lng), poi_id: String(p.id), address: (p.address as string) ?? undefined }); }} aria-label="Add a saved place">
                <option value="">+ Add a saved place…</option>
                {pois.options.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>)}
              </Select>
            </div>
          )}
        </Card>
        {preview && <p className="text-sm text-ink/70">Planned: <b>{fmtNum(preview.distance_km, 1)} km</b> · {fmtDuration(preview.duration_s)} drive ({preview.engine === 'fallback' ? 'estimated' : preview.engine})</p>}
        <Field label="Notes for the driver"><Textarea rows={2} value={job.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
        <div className="flex gap-2 pb-6">
          <Button variant="secondary" loading={busy} disabled={!job.title} onClick={() => void save(false)}>{t('save')}</Button>
          <Button loading={busy} disabled={!job.title || !job.driver_id || (!stops.length && !job.route_id)} icon={<Send className="size-4" />} onClick={() => void save(true)}>{t('dispatch_now')}</Button>
        </div>
      </div>
      <div className="min-h-[50vh] flex-1">
        <BaseMap>
          <ClickHandler onClick={(lat, lng) => addStop({ lat, lng })} />
          <FitBounds points={pts} once={false} />
          {preview ? <Polyline positions={preview.geometry.map(([lng, lat]) => [lat, lng] as [number, number])} pathOptions={{ color: '#0f6b4f', weight: 4 }} /> : pts.length > 1 && <Polyline positions={pts} pathOptions={{ color: '#0f6b4f', weight: 2, dashArray: '6 6' }} />}
          {stops.map((s, i) => <Marker key={i} position={[s.lat, s.lng]} icon={pinIcon(i === 0 ? '#0b3d2e' : '#0f6b4f', String(i + 1))}><Tooltip>{s.name}</Tooltip></Marker>)}
        </BaseMap>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- detail
export function JobDetail(): ReactNode {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  const [pod, setPod] = useState<Row | null>(null);
  const [vpos, setVpos] = useState<{ lat: number; lng: number; heading: number | null; state: string } | null>(null);
  const q = useQuery({ queryKey: ['/jobs', id], queryFn: () => api.get<Row & { stops: Row[]; proof_of_delivery: Row[]; planned_geometry: unknown }>(`/jobs/${id}`) });
  const ev = useQuery({ queryKey: ['/jobs', id, 'events'], queryFn: () => api.get<{ data: Row[] }>(`/jobs/${id}/events`) });
  const live = useQuery({ queryKey: ['live'], queryFn: () => api.get<{ data: Row[] }>('/tracking/live'), enabled: can('tracking:read') });
  useRealtime<Row>('job', (p) => { if (p.job_id === id) { void q.refetch(); void ev.refetch(); } });
  useRealtime<Row>('position', (p) => { if (q.data && p.vehicle_id === q.data.vehicle_id && p.lat !== null) setVpos({ lat: Number(p.lat), lng: Number(p.lng), heading: p.heading as number | null, state: String(p.state) }); });
  if (!q.data) return <div className="flex justify-center py-24">{q.error ? <p className="text-sm text-red-600">{errorText(q.error)}</p> : <Spinner />}</div>;
  const j = q.data;
  const lv = live.data?.data.find((v) => v.vehicle_id === j.vehicle_id);
  const pos = vpos ?? (lv && lv.lat !== null ? { lat: Number(lv.lat), lng: Number(lv.lng), heading: lv.heading as number | null, state: String(lv.state) } : null);
  const write = can('jobs:write');
  const refresh = (): void => { void q.refetch(); void ev.refetch(); void qc.invalidateQueries({ queryKey: ['/jobs', 'board'] }); };
  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try { await fn(); if (ok) toast(ok); refresh(); } catch (e) { toast(errorText(e), 'error'); }
  };
  const share = async (): Promise<void> => {
    try {
      const r = await api.post<{ url: string }>('/share-links', { job_id: j.id, hours: 24, label: `${String(j.reference)} tracking` });
      await navigator.clipboard.writeText(r.url).catch(() => undefined);
      toast(`Customer tracking link copied: ${r.url}`);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const status = String(j.status);
  const pts = j.stops.map((s) => [Number(s.lat), Number(s.lng)] as [number, number]);
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="w-full shrink-0 space-y-4 overflow-y-auto p-4 lg:w-[30rem]">
        <Link to="/dispatch" className="inline-flex items-center gap-1 text-sm text-ink/60 hover:text-ink"><ArrowLeft className="size-4" />{t('dispatch')}</Link>
        <div>
          <p className="font-mono text-xs text-ink/50">{String(j.reference)}</p>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">{String(j.title)} <StatusBadge value={j.status} />{Boolean(j.off_route_since) && <Badge tone="red">{t('off_route')}</Badge>}</h1>
          <p className="text-sm text-ink/60">{[j.customer_name, j.customer_phone].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-black/[0.03] p-2.5"><p className="text-[11px] text-ink/50">{t('vehicle')} / {t('driver')}</p><p className="font-medium">{String(j.plate_number ?? '—')} · {String(j.driver_name ?? '—')}</p></div>
          <div className="rounded-lg bg-black/[0.03] p-2.5"><p className="text-[11px] text-ink/50">Planned</p><p className="font-medium tabular">{fmtNum(j.planned_distance_km, 1)} km · {fmtDuration(j.planned_duration_s)}</p></div>
          <div className="rounded-lg bg-black/[0.03] p-2.5"><p className="text-[11px] text-ink/50">Window</p><p className="font-medium tabular">{fmtDateTime(j.scheduled_start)} → {fmtTime(j.scheduled_end)}</p></div>
          <div className="rounded-lg bg-black/[0.03] p-2.5"><p className="text-[11px] text-ink/50">Progress</p><p className="font-medium tabular">{String(j.stops_done)}/{String(j.stop_count)} · {fmtNum(j.progress_pct)}%</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {write && ['draft', 'scheduled'].includes(status) && <Button icon={<Send className="size-4" />} disabled={!j.driver_id} onClick={() => void act(() => api.post(`/jobs/${id}/dispatch`, {}), 'Dispatched')}>{t('dispatch_now')}</Button>}
          {write && !['completed', 'cancelled', 'failed'].includes(status) && <Button variant="secondary" icon={<Sparkles className="size-4" />} onClick={() => void act(() => api.post(`/jobs/${id}/plan`, { optimize: true }), 'Route re-planned')}>{t('optimise')}</Button>}
          {can('share_links:create') && <Button variant="secondary" icon={<Link2 className="size-4" />} onClick={() => void share()}>Customer link</Button>}
          {write && ['dispatched', 'in_progress'].includes(status) && <Button variant="secondary" onClick={() => void act(() => api.post(`/jobs/${id}/status`, { status: 'completed' }))}>{t('completed')}</Button>}
          {write && !['completed', 'cancelled'].includes(status) && <Button variant="ghost" onClick={async () => { if (await confirm('Cancel this job?', { danger: true })) void act(() => api.post(`/jobs/${id}/status`, { status: 'cancelled' })); }}>{t('cancel')}</Button>}
        </div>
        <Card title={t('stops')} pad={false}>
          <ol className="divide-y divide-black/[0.05]">
            {j.stops.map((s) => {
              const st = String(s.status);
              const lateStop = s.time_window_end && s.eta && Date.parse(String(s.eta)) > Date.parse(String(s.time_window_end)) && ['pending', 'en_route'].includes(st);
              return (
                <li key={String(s.id)} className="px-3 py-2.5">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: STOP_COLORS[st] ?? '#64748b' }}>{String(s.seq)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{String(s.name)} <StatusBadge value={st} />{Boolean(lateStop) && <Badge tone="amber">{t('late')}</Badge>}{Boolean(s.has_pod) && <Badge tone="green">POD</Badge>}</p>
                      <p className="text-xs text-ink/55">{[t(String(s.stop_type)), s.contact_name, s.contact_phone].filter(Boolean).join(' · ')}</p>
                      <p className="text-xs tabular text-ink/55">
                        {s.arrived_at ? `Arrived ${fmtTime(s.arrived_at)}` : s.eta ? `${t('eta')} ${fmtTime(s.eta)}` : ''}
                        {s.time_window_end ? ` · by ${fmtTime(s.time_window_end)}` : ''}
                        {s.failure_reason ? ` · ${String(s.failure_reason)}` : ''}
                      </p>
                    </div>
                  </div>
                  {write && ['dispatched', 'in_progress'].includes(status) && (
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-8">
                      {['pending', 'en_route'].includes(st) && <Button size="sm" variant="secondary" onClick={() => void act(() => api.post(`/jobs/${id}/stops/${String(s.id)}/arrive`, {}))}>Arrived</Button>}
                      {['pending', 'en_route', 'arrived'].includes(st) && <Button size="sm" onClick={() => setPod(s)}>Complete</Button>}
                      {['pending', 'en_route', 'arrived'].includes(st) && <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt('Why did this stop fail?'); if (reason) void act(() => api.post(`/jobs/${id}/stops/${String(s.id)}/fail`, { reason })); }}>Failed</Button>}
                    </div>
                  )}
                  {write && ['completed', 'failed', 'skipped'].includes(st) && <div className="mt-1.5 pl-8"><button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => void act(() => api.post(`/jobs/${id}/stops/${String(s.id)}/reopen`, {}))}>Reopen</button></div>}
                </li>
              );
            })}
          </ol>
        </Card>
        {j.proof_of_delivery.length > 0 && (
          <Card title={t('proof_of_delivery')}>
            <ul className="space-y-2 text-sm">
              {j.proof_of_delivery.map((p) => (
                <li key={String(p.id)}>
                  <p className="font-medium">{String(p.recipient_name)} {p.recipient_phone ? <span className="text-ink/50">· {String(p.recipient_phone)}</span> : null}</p>
                  <p className="text-xs text-ink/55">{fmtDateTime(p.captured_at)} · {((p.photo_file_ids as string[]) ?? []).length} photo(s){p.signature_file_id ? ' · signed' : ''}{p.notes ? ` · ${String(p.notes)}` : ''}</p>
                  <PodMedia ids={[...((p.photo_file_ids as string[]) ?? []), ...(p.signature_file_id ? [String(p.signature_file_id)] : [])]} />
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card title={t('timeline')}>
          <ol className="relative space-y-3 border-l border-black/10 pl-4 text-sm">
            {(ev.data?.data ?? []).map((e) => (
              <li key={String(e.id)}>
                <span className="absolute -left-1 mt-1.5 size-2 rounded-full bg-brand-500" />
                <p className="font-medium">{t(String(e.event_type))}{e.stop_name ? ` · ${String(e.stop_name)}` : ''}</p>
                <p className="text-xs text-ink/55">{fmtDateTime(e.occurred_at)} · {String(e.actor_name ?? e.actor_type)}{describe(e.details as Row)}</p>
              </li>
            ))}
            {!ev.data?.data.length && <li className="text-ink/50">{t('no_data')}</li>}
          </ol>
        </Card>
        {Boolean(j.notes) && <Card title="Notes"><p className="whitespace-pre-wrap text-sm">{String(j.notes)}</p></Card>}
        {pos && <p className="pb-6 text-xs text-ink/50">Vehicle position updated {fmtAgo(lv?.last_seen_at, lang)}</p>}
      </div>
      <div className="min-h-[50vh] flex-1">
        <BaseMap>
          <FitBounds points={pos ? [...pts, [pos.lat, pos.lng]] : pts} />
          {Boolean(j.planned_geometry) && <GeoJSON key={String(j.updated_at)} data={j.planned_geometry as never} style={{ color: '#0f6b4f', weight: 4, opacity: 0.7 }} />}
          {j.stops.map((s) => <Marker key={String(s.id)} position={[Number(s.lat), Number(s.lng)]} icon={pinIcon(STOP_COLORS[String(s.status)] ?? '#64748b', String(s.seq))}><Tooltip>{String(s.name)}</Tooltip></Marker>)}
          {pos && <Marker position={[pos.lat, pos.lng]} icon={vehicleIcon({ state: pos.state, heading: pos.heading, label: String(j.plate_number ?? '') })} zIndexOffset={1000} />}
        </BaseMap>
      </div>
      <Modal open={Boolean(pod)} onClose={() => setPod(null)} title={`${t('proof_of_delivery')} · ${String(pod?.name ?? '')}`}>
        {pod && <PodForm jobId={String(id)} stop={pod} onDone={() => { setPod(null); refresh(); }} />}
      </Modal>
    </div>
  );
}

function describe(d: Row | null): string {
  if (!d) return '';
  if (d.from && d.to) return ` · ${String(d.from)} → ${String(d.to)}${d.reason ? ` (${String(d.reason)})` : ''}`;
  if (d.distance_m) return ` · ${String(d.distance_m)} m off route`;
  if (d.eta) return ` · new ETA ${fmtTime(d.eta)}`;
  if (d.note) return ` · ${String(d.note)}`;
  if (d.recipient) return ` · received by ${String(d.recipient)}`;
  if (d.late_minutes) return ` · ${String(d.late_minutes)} min late`;
  return '';
}

function PodMedia({ ids }: { ids: string[] }): ReactNode {
  const q = useQuery({ queryKey: ['files', ids], queryFn: () => Promise.all(ids.map((i) => api.get<{ url?: string; download_url?: string }>(`/files/${i}`).catch(() => null))), enabled: ids.length > 0 });
  if (!ids.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {(q.data ?? []).map((f, i) => (f?.url ?? f?.download_url ? <a key={i} href={f.url ?? f.download_url} target="_blank" rel="noreferrer"><img src={f.url ?? f.download_url} alt="" className="size-16 rounded-lg object-cover ring-1 ring-black/10" /></a> : null))}
    </div>
  );
}

function PodForm({ jobId, stop, onDone }: { jobId: string; stop: Row; onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState(String(stop.contact_name ?? ''));
  const [phone, setPhone] = useState(String(stop.contact_phone ?? ''));
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (withPod: boolean): Promise<void> => {
    setBusy(true);
    try {
      const photos = files ? await Promise.all([...files].map((f) => api.upload(f, 'proof_of_delivery'))) : [];
      await api.post(`/jobs/${jobId}/stops/${String(stop.id)}/complete`, withPod ? { pod: { recipient_name: name, recipient_phone: phone || null, notes: notes || null, photo_file_ids: photos } } : {});
      toast(t('saved'));
      onDone();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('recipient')} required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('phone')}><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      </div>
      <Field label="Photos"><input type="file" accept="image/*" multiple capture="environment" onChange={(e) => setFiles(e.target.files)} className="block text-sm" /></Field>
      <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className={cx('flex justify-end gap-2')}>
        <Button variant="ghost" loading={busy} onClick={() => void submit(false)}>Complete without POD</Button>
        <Button loading={busy} disabled={!name} onClick={() => void submit(true)}>{t('save')}</Button>
      </div>
      {stop.instructions ? <p className="text-xs text-ink/55">Instructions: {String(stop.instructions)}</p> : null}
    </div>
  );
}
