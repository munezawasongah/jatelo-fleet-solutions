import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Marker } from 'react-leaflet';
import { Link, useNavigate, useParams } from 'react-router';
import { EntityForm, RefSelect, useOptions } from '../components/forms';
import { BaseMap, vehicleIcon } from '../components/map';
import { Playback, type Track, type TrackEvent } from '../components/playback';
import { CrudPage, Table, Pager, usePaged } from '../components/table';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Tabs, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtDate, fmtDateTime, fmtDuration, fmtMoney, fmtNum, isoDay } from '../lib/format';
import { useI18n } from '../lib/i18n';

const VEHICLE_FORM = {
  order: ['plate_number', 'fleet_number', 'label', 'group_id', 'make', 'model', 'year', 'body_type', 'usage_type', 'fuel_type', 'tank_capacity_l', 'expected_l_per_100km', 'odometer_km', 'engine_hours', 'odometer_source', 'speed_limit_kph', 'status', 'icon'],
  hide: ['photo_file_id'],
};

export function VehiclesPage(): ReactNode {
  const { t } = useI18n();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const groups = useOptions('/vehicle-groups');
  const [group, setGroup] = useState('');
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <CrudPage
        path="/vehicles"
        title={t('vehicles')}
        noun={t('vehicle').toLowerCase()}
        write="vehicles:write"
        params={{ status: status || undefined, group_id: group || undefined }}
        formOpts={VEHICLE_FORM}
        onRowClick={(r) => nav(`/vehicles/${String(r.id)}`)}
        filters={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t('status')}>
              <option value="">{t('all')}</option>
              {['active', 'in_maintenance', 'inactive', 'sold', 'written_off'].map((s) => <option key={s} value={s}>{t(s)}</option>)}
            </Select>
            <Select value={group} onChange={(e) => setGroup(e.target.value)} className="w-44" aria-label={t('vehicle_groups')}>
              <option value="">{t('vehicle_groups')}: {t('all')}</option>
              {groups.options.map((g) => <option key={String(g.id)} value={String(g.id)}>{String(g.name)}</option>)}
            </Select>
          </>
        }
        columns={[
          { key: 'plate_number', render: (r) => <span className="font-semibold">{String(r.plate_number)}</span> },
          { key: 'label', render: (r) => [r.make, r.model].filter(Boolean).join(' ') || String(r.label ?? '—') },
          { key: 'group', label: t('vehicle_groups'), render: (r) => (r.group ? <Badge tone="gray"><span className="size-2 rounded-full" style={{ background: String((r.group as Row).color ?? '#999') }} />{String((r.group as Row).name)}</Badge> : '—') },
          { key: 'driver', label: t('driver'), render: (r) => String((r.driver as Row | null)?.name ?? '—') },
          { key: 'device', label: 'Tracker', render: (r) => ((r.device as Row | null) ? <span className="font-mono text-xs">{String((r.device as Row).identifier)}</span> : <Badge tone="amber">{t('no_device')}</Badge>) },
          { key: 'odometer_km', type: 'number' },
          { key: 'status', type: 'status' },
        ]}
      />
    </div>
  );
}

export function VehicleDetail(): ReactNode {
  const { id } = useParams();
  const { t, f } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'history' | 'trips' | 'documents' | 'maintenance'>('overview');
  const [edit, setEdit] = useState(false);
  const v = useQuery({ queryKey: ['/vehicles', id], queryFn: () => api.get<Row>(`/vehicles/${id}`) });
  if (!v.data) return <div className="flex justify-center py-24">{v.error ? <p className="text-sm text-red-600">{errorText(v.error)}</p> : <Spinner />}</div>;
  const r = v.data;
  const live = (r.live as Row | null) ?? {};
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <Link to="/vehicles" className="mb-3 inline-flex items-center gap-1 text-sm text-ink/60 hover:text-ink"><ArrowLeft className="size-4" />{t('vehicles')}</Link>
      <PageHeader
        title={<span className="flex items-center gap-3">{String(r.plate_number)} <StatusBadge value={r.status} /></span>}
        subtitle={[r.make, r.model, r.year, (r.group as Row | null)?.name].filter(Boolean).join(' · ')}
        actions={can('vehicles:write') && <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>{t('edit')}</Button>}
      />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'overview', label: t('details') },
        { value: 'history', label: t('playback') },
        { value: 'trips', label: t('trips') },
        { value: 'documents', label: 'Documents' },
        { value: 'maintenance', label: t('maintenance') },
      ]} />
      {tab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title={t('details')} className="lg:col-span-1">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {[
                ['fleet_number', r.fleet_number], ['vin', r.vin], ['body_type', t(String(r.body_type ?? ''))], ['fuel_type', t(String(r.fuel_type ?? ''))],
                ['tank_capacity_l', fmtNum(r.tank_capacity_l)], ['expected_l_per_100km', fmtNum(r.expected_l_per_100km, 1)],
                ['odometer_km', fmtNum(r.odometer_km)], ['engine_hours', fmtNum(r.engine_hours)], ['speed_limit_kph', r.speed_limit_kph ?? '—'], ['purchase_date', fmtDate(r.purchase_date)],
              ].map(([k, val]) => (
                <div key={String(k)}><dt className="text-[11px] uppercase tracking-wide text-ink/45">{f(String(k))}</dt><dd className="font-medium">{String(val ?? '—') || '—'}</dd></div>
              ))}
            </dl>
          </Card>
          <Card title={t('live_map')} pad={false} className="overflow-hidden lg:col-span-2">
            <div className="h-72">
              {live.lat !== null && live.lat !== undefined ? (
                <BaseMap center={[Number(live.lat), Number(live.lng)]} zoom={14}>
                  <Marker position={[Number(live.lat), Number(live.lng)]} icon={vehicleIcon({ state: String(live.state ?? 'stopped'), heading: live.heading as number | null, label: String(r.plate_number) })} />
                </BaseMap>
              ) : <Empty title={t('never')} />}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-black/[0.06] px-4 py-2.5 text-sm">
              <span>{t('status')}: <StatusBadge value={live.state} /></span>
              <span>{t('speed')}: <b className="tabular">{fmtNum(live.speed_kph)} km/h</b></span>
              <span>{t('last_seen')}: <b>{fmtAgo(live.last_seen_at)}</b></span>
            </div>
          </Card>
          <Assignments vehicle={r} onChange={() => void qc.invalidateQueries({ queryKey: ['/vehicles'] })} />
          <Card title="Compliance" className="lg:col-span-2">
            <p className="text-sm">{Number((r.compliance as Row)?.expired_documents ?? 0) > 0 ? <Badge tone="red">{String((r.compliance as Row).expired_documents)} expired documents</Badge> : <Badge tone="green">All documents valid</Badge>}
              {Boolean((r.compliance as Row)?.next_expiry) && <span className="ml-3 text-ink/60">Next expiry: {fmtDate((r.compliance as Row).next_expiry)}</span>}</p>
          </Card>
        </div>
      )}
      {tab === 'history' && <History vehicleId={String(r.id)} />}
      {tab === 'trips' && <TripList params={{ vehicle_id: String(r.id) }} />}
      {tab === 'documents' && <Documents vehicleId={String(r.id)} />}
      {tab === 'maintenance' && <ServiceHistory vehicleId={String(r.id)} />}
      <Modal open={edit} onClose={() => setEdit(false)} title={`${t('edit')} ${String(r.plate_number)}`} size="lg">
        {edit && <EntityForm path="/vehicles" row={r} opts={VEHICLE_FORM} onCancel={() => setEdit(false)} onSaved={() => { setEdit(false); void qc.invalidateQueries({ queryKey: ['/vehicles'] }); }} />}
      </Modal>
    </div>
  );
}

function Assignments({ vehicle, onChange }: { vehicle: Row; onChange: () => void }): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const { toast, confirm } = useToast();
  const [driver, setDriver] = useState<string | null>(null);
  const [device, setDevice] = useState('');
  const devices = useOptions('/devices', can('devices:assign'));
  const free = devices.options.filter((d) => !d.vehicle);
  const dev = vehicle.device as Row | null;
  const drv = vehicle.driver as Row | null;
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      toast(t('saved'));
      onChange();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <Card title="Tracker & driver">
      <div className="space-y-4 text-sm">
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-ink/45">Tracker</p>
          {dev ? (
            <div className="flex items-center justify-between gap-2">
              <span><span className="font-mono">{String(dev.identifier)}</span> <span className="text-ink/50">· {String(dev.model ?? dev.protocol)}</span></span>
              {can('devices:assign') && <Button size="sm" variant="ghost" onClick={async () => { if (await confirm(`Remove tracker ${String(dev.identifier)} from ${String(vehicle.plate_number)}?`)) void run(() => api.post(`/devices/${String(dev.id)}/unassign`)); }}>Unassign</Button>}
            </div>
          ) : can('devices:assign') ? (
            <div className="flex gap-2">
              <Select value={device} onChange={(e) => setDevice(e.target.value)}>
                <option value="">— {free.length ? 'Choose a free tracker' : 'No free trackers'} —</option>
                {free.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.identifier)} · {String(d.model ?? d.protocol)}</option>)}
              </Select>
              <Button size="sm" disabled={!device} onClick={() => void run(() => api.post(`/devices/${device}/assign`, { vehicle_id: vehicle.id }))}>{t('save')}</Button>
            </div>
          ) : <Badge tone="amber">{t('no_device')}</Badge>}
        </div>
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-ink/45">{t('driver')}</p>
          {drv ? (
            <div className="flex items-center justify-between gap-2">
              <Link to={`/drivers/${String(drv.id)}`} className="font-medium text-brand-700 hover:underline">{String(drv.name)}</Link>
              {can('drivers:write') && <Button size="sm" variant="ghost" onClick={() => void run(() => api.post(`/drivers/${String(drv.id)}/unassign`))}>Unassign</Button>}
            </div>
          ) : can('drivers:write') ? (
            <div className="flex gap-2">
              <RefSelect field="driver_id" value={driver} onChange={setDriver} />
              <Button size="sm" disabled={!driver} onClick={() => void run(() => api.post(`/drivers/${driver}/assign`, { vehicle_id: vehicle.id }))}>{t('save')}</Button>
            </div>
          ) : '—'}
        </div>
      </div>
    </Card>
  );
}

function History({ vehicleId }: { vehicleId: string }): ReactNode {
  const { t } = useI18n();
  const [day, setDay] = useState(isoDay());
  const [hours, setHours] = useState(24);
  const from = new Date(`${day}T00:00:00`);
  const to = new Date(from.getTime() + hours * 3_600_000);
  const q = useQuery({
    queryKey: ['positions', vehicleId, day, hours],
    queryFn: () => api.get<{ t: (number | string)[]; lat: number[]; lng: number[]; speed: number[]; heading: (number | null)[] }>(`/vehicles/${vehicleId}/positions`, { from: from.toISOString(), to: to.toISOString(), valid_only: true }),
  });
  const ev = useQuery({ queryKey: ['events', vehicleId, day, hours], queryFn: () => api.get<{ data: TrackEvent[] }>('/driving-events', { vehicle_id: vehicleId, from: from.toISOString(), to: to.toISOString(), page_size: 200 }) });
  const track: Track | null = q.data ? { ...q.data, t: q.data.t.map((x) => (typeof x === 'number' ? x : Date.parse(x))) } : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Day"><Input type="date" value={day} max={isoDay()} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Hours">
          <Select value={String(hours)} onChange={(e) => setHours(Number(e.target.value))}>{[6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h} h</option>)}</Select>
        </Field>
        {q.data && <p className="pb-2 text-sm text-ink/60">{fmtNum(q.data.t.length)} points</p>}
      </div>
      {q.isPending ? <div className="flex justify-center py-16"><Spinner /></div> : track && track.t.length ? <Playback track={track} events={ev.data?.data ?? []} /> : <Card><Empty title={t('no_data')}>No positions recorded in this period.</Empty></Card>}
    </div>
  );
}

export function TripList({ params }: { params: Record<string, string | undefined> }): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const list = usePaged('/trips', params);
  return (
    <>
      <Card pad={false}>
        <Table
          rows={list.rows}
          loading={list.isPending}
          onRowClick={(r) => setOpen(String(r.id))}
          columns={[
            { key: 'started_at', type: 'datetime' },
            { key: 'plate_number', label: t('vehicle') },
            { key: 'driver_name', label: t('driver') },
            { key: 'from', label: t('from'), render: (r) => String(r.start_place ?? r.start_address ?? '—') },
            { key: 'to', label: t('to'), render: (r) => (r.ended_at ? String(r.end_place ?? r.end_address ?? '—') : <Badge tone="violet">{t('in_progress')}</Badge>) },
            { key: 'distance_km', type: 'number' },
            { key: 'duration_s', label: 'Duration', render: (r) => fmtDuration(r.duration_s) },
            { key: 'max_speed_kph', type: 'number' },
            { key: 'events', label: 'Events', render: (r) => (Number(r.harsh_event_count ?? 0) + Number(r.overspeed_count ?? 0) > 0 ? <Badge tone="amber">{Number(r.harsh_event_count ?? 0) + Number(r.overspeed_count ?? 0)}</Badge> : '—') },
          ]}
        />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={t('trips')} size="xl">{open && <TripDetail id={open} />}</Modal>
    </>
  );
}

function TripDetail({ id }: { id: string }): ReactNode {
  const q = useQuery({ queryKey: ['/trips', id], queryFn: () => api.get<Row & { points: [number, number, number, number][]; events: TrackEvent[] }>(`/trips/${id}`) });
  if (!q.data) return <div className="flex justify-center py-16"><Spinner /></div>;
  const p = q.data.points;
  const track: Track = { t: p.map((x) => x[0]), lat: p.map((x) => x[1]), lng: p.map((x) => x[2]), speed: p.map((x) => x[3]) };
  const r = q.data;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <Mini k="Start" v={fmtDateTime(r.started_at)} /><Mini k="End" v={fmtDateTime(r.ended_at)} /><Mini k="Distance" v={`${fmtNum(r.distance_km, 1)} km`} />
        <Mini k="Duration" v={fmtDuration(r.duration_s)} /><Mini k="Max speed" v={`${fmtNum(r.max_speed_kph)} km/h`} />
      </div>
      {p.length ? <Playback track={track} events={r.events} height="h-[55vh]" /> : <Empty />}
    </div>
  );
}
const Mini = ({ k, v }: { k: string; v: ReactNode }): ReactNode => (
  <div className="rounded-lg bg-black/[0.03] px-3 py-2"><p className="text-[11px] text-ink/50">{k}</p><p className="font-medium tabular">{v}</p></div>
);

function Documents({ vehicleId }: { vehicleId: string }): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const q = useQuery({ queryKey: ['/vehicles', vehicleId, 'docs'], queryFn: () => api.get<{ data: Row[] }>(`/vehicles/${vehicleId}/documents`) });
  const write = can('vehicles:write');
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['/vehicles', vehicleId, 'docs'] });
  return (
    <Card title="Documents" actions={write && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEdit(null)}>{t('add')}</Button>} pad={false}>
      <Table
        rows={q.data?.data ?? []}
        loading={q.isPending}
        columns={[
          { key: 'doc_type', render: (r) => t(String(r.doc_type)) },
          { key: 'document_number' },
          { key: 'provider' },
          { key: 'issued_on', type: 'date' },
          { key: 'expires_on', type: 'date' },
          { key: 'expiry_status', label: t('status'), type: 'status' },
        ]}
        rowActions={write ? (r) => (
          <>
            <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEdit(r)} aria-label={t('edit')} />
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-red-600" />} aria-label={t('delete')} onClick={async () => {
              if (!(await confirm('Delete this document?', { danger: true }))) return;
              await api.del(`/vehicle-documents/${String(r.id)}`).then(refresh, (e: unknown) => toast(errorText(e), 'error'));
            }} />
          </>
        ) : undefined}
      />
      <Modal open={edit !== undefined} onClose={() => setEdit(undefined)} title="Document">
        {edit !== undefined && (
          <DocForm vehicleId={vehicleId} row={edit} onDone={() => { setEdit(undefined); refresh(); }} />
        )}
      </Modal>
    </Card>
  );
}

function DocForm({ vehicleId, row, onDone }: { vehicleId: string; row: Row | null; onDone: () => void }): ReactNode {
  // create goes to /vehicles/{id}/documents, edits to /vehicle-documents/{id}
  return row ? (
    <EntityForm path="/vehicle-documents" row={row} onSaved={onDone} onCancel={onDone} opts={{ hide: ['file_id'] }} />
  ) : (
    <EntityForm path={`/vehicles/${vehicleId}/documents`} onSaved={onDone} onCancel={onDone} opts={{ hide: ['file_id'] }} schemaPath="/vehicles/{id}/documents" />
  );
}

function ServiceHistory({ vehicleId }: { vehicleId: string }): ReactNode {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['/vehicles', vehicleId, 'service'], queryFn: () => api.get<{ data: Row[]; totals: Row }>(`/vehicles/${vehicleId}/service-history`) });
  return (
    <div className="space-y-4">
      {q.data && (
        <div className="grid grid-cols-3 gap-3">
          <Mini k="Completed jobs" v={fmtNum(q.data.totals.completed)} /><Mini k="Total cost" v={fmtMoney(q.data.totals.total_cost)} /><Mini k="Last 12 months" v={fmtMoney(q.data.totals.cost_12m)} />
        </div>
      )}
      <Card pad={false}>
        <Table rows={q.data?.data ?? []} loading={q.isPending} columns={[
          { key: 'number' }, { key: 'title' }, { key: 'wo_type', render: (r) => t(String(r.wo_type)) }, { key: 'status', type: 'status' },
          { key: 'completed_at', type: 'date' }, { key: 'total_cost', type: 'money' },
        ]} />
      </Card>
    </div>
  );
}
