import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { CrudPage, Pager, Table, usePaged } from '../components/table';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, Stat, StatusBadge, Tabs, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtMoney, fmtNum, isoDay } from '../lib/format';
import { useI18n } from '../lib/i18n';

type Tab = 'summary' | 'logs' | 'events' | 'cards' | 'prices' | 'imports';

export default function FuelPage(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('summary');
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('fuel')} subtitle="Fill-ups, consumption against expected, sensor-detected refuels and suspected drains, fuel cards and imports." />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'summary', label: 'Summary' }, { value: 'logs', label: t('fuel_logs') }, { value: 'events', label: t('fuel_events') },
        { value: 'cards', label: t('fuel_cards') }, { value: 'prices', label: t('fuel_prices') }, ...(can('fuel:import') ? [{ value: 'imports' as const, label: t('import') }] : []),
      ]} />
      {tab === 'summary' && <Summary />}
      {tab === 'logs' && (
        <CrudPage embedded path="/fuel-logs" title={t('fuel_logs')} write="fuel:write" noun="fill-up"
          formOpts={{ order: ['vehicle_id', 'driver_id', 'filled_at', 'litres', 'unit_price', 'total_cost', 'odometer_km', 'is_full_tank', 'fuel_type', 'station_name', 'fuel_card_id', 'receipt_number'], hide: ['receipt_file_id', 'lat', 'lng', 'poi_id'] }}
          columns={[
            { key: 'filled_at', type: 'datetime' }, { key: 'plate_number', label: t('vehicle') }, { key: 'driver_name', label: t('driver') },
            { key: 'litres', type: 'number' }, { key: 'total_cost', type: 'money' }, { key: 'odometer_km', type: 'number' },
            { key: 'consumption_l_per_100km', label: 'L/100 km', render: (r) => (r.consumption_l_per_100km ? <span className="tabular">{fmtNum(r.consumption_l_per_100km, 1)}</span> : '—') },
            { key: 'station_name' },
            { key: 'flags', label: '', render: (r) => (Array.isArray(r.flags) && r.flags.length ? <Badge tone="amber">{(r.flags as string[]).join(', ').replace(/_/g, ' ')}</Badge> : r.verified ? <Badge tone="green">verified</Badge> : null) },
          ]} />
      )}
      {tab === 'events' && <Events />}
      {tab === 'cards' && (
        <CrudPage embedded path="/fuel-cards" title={t('fuel_cards')} write="fuel:write" noun="card"
          columns={[{ key: 'provider', render: (r) => t(String(r.provider)) }, { key: 'card_last4', render: (r) => `•••• ${String(r.card_last4)}` }, { key: 'label' }, { key: 'plate_number', label: t('vehicle') }, { key: 'driver_name', label: t('driver') }, { key: 'monthly_limit', type: 'money' }, { key: 'status', type: 'status' }]} />
      )}
      {tab === 'prices' && (
        <CrudPage embedded path="/fuel-prices" title={t('fuel_prices')} write="fuel:write" noun="price" searchable={false}
          columns={[{ key: 'fuel_type', render: (r) => t(String(r.fuel_type)) }, { key: 'price_per_litre', type: 'money' }, { key: 'effective_from', type: 'date' }]} />
      )}
      {tab === 'imports' && <Imports />}
    </div>
  );
}

function Summary(): ReactNode {
  const { t } = useI18n();
  const [from, setFrom] = useState(isoDay(new Date(), -29));
  const [to, setTo] = useState(isoDay());
  const q = useQuery({
    queryKey: ['/fuel/summary', from, to],
    queryFn: () => api.get<{ totals: Row; vehicles: Row[] }>('/fuel/summary', { from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() }),
  });
  const s = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Field label={t('from')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('to')}><Input type="date" value={to} max={isoDay()} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {!s ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Litres" value={fmtNum(s.totals.litres)} /><Stat label={t('fuel_cost')} value={fmtMoney(s.totals.cost)} />
            <Stat label={t('distance')} value={`${fmtNum(s.totals.distance_km)} km`} /><Stat label="L/100 km" value={fmtNum(s.totals.litres_per_100km, 1)} />
            <Stat label="Cost per km" value={fmtMoney(s.totals.cost_per_km)} /><Stat label="Suspected drained" value={`${fmtNum(s.totals.drained_litres)} L`} tone={Number(s.totals.drained_litres) > 0 ? 'bad' : 'flat'} sub={Number(s.totals.drained_litres) > 0 ? 'Review fuel events' : undefined} />
          </div>
          <Card pad={false}>
            <Table rows={s.vehicles} columns={[
              { key: 'plate_number', label: t('vehicle'), render: (r) => <span className="font-semibold">{String(r.plate_number)}</span> },
              { key: 'fills', type: 'number' }, { key: 'litres', type: 'number' }, { key: 'cost', type: 'money' }, { key: 'distance_km', type: 'number' },
              { key: 'l100', label: 'L/100 km', render: (r) => { const a = Number(r.litres_per_100km_period); const e = Number(r.expected_l_per_100km); if (!a) return '—'; const over = e ? ((a - e) / e) * 100 : 0; return <span className="inline-flex items-center gap-1.5 tabular">{fmtNum(a, 1)}{e ? <Badge tone={over > 15 ? 'red' : over > 5 ? 'amber' : 'green'}>{over >= 0 ? '+' : ''}{fmtNum(over, 0)}%</Badge> : null}</span>; } },
              { key: 'expected_l_per_100km', label: 'Expected', type: 'number' }, { key: 'cost_per_km', type: 'money' }, { key: 'idle_fuel_l', label: 'Idle (L)', type: 'number' },
              { key: 'drain_events', label: 'Drains', render: (r) => (Number(r.drain_events) ? <Badge tone="red">{String(r.drain_events)} · {fmtNum(r.drained_litres)} L</Badge> : '—') },
            ]} />
          </Card>
        </>
      )}
    </div>
  );
}

function Events(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const { toast } = useToast();
  const [type, setType] = useState('');
  const [status, setStatus] = useState('open');
  const list = usePaged('/fuel-events', { event_type: type || undefined, status: status || undefined });
  const review = async (r: Row, s: 'confirmed' | 'dismissed'): Promise<void> => {
    try {
      await api.post(`/fuel-events/${String(r.id)}/review`, { status: s });
      void list.refetch();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <Card pad={false} title="Detected by fuel-level sensors" actions={
      <>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-32" aria-label="Type"><option value="">{t('all')}</option><option value="refuel">Refuel</option><option value="drain">Drain</option></Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36" aria-label={t('status')}><option value="">{t('all')}</option>{['open', 'confirmed', 'dismissed'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select>
      </>
    }>
      <Table rows={list.rows} loading={list.isPending} columns={[
        { key: 'started_at', type: 'datetime' }, { key: 'plate_number', label: t('vehicle') },
        { key: 'event_type', render: (r) => <Badge tone={r.event_type === 'drain' ? 'red' : 'green'}>{String(r.event_type)}</Badge> },
        { key: 'change_l', label: 'Litres', render: (r) => <span className="tabular font-medium">{Number(r.change_l) > 0 ? '+' : ''}{fmtNum(r.change_l, 1)}</span>, align: 'right' },
        { key: 'level', label: 'Level', render: (r) => `${fmtNum(r.level_before_l)} → ${fmtNum(r.level_after_l)} L` },
        { key: 'location', label: 'Location', render: (r) => (r.lat ? `${Number(r.lat).toFixed(4)}, ${Number(r.lng).toFixed(4)}` : '—') },
        { key: 'status', type: 'status' },
      ]} rowActions={can('fuel:write') ? (r) => (r.status === 'open' ? <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => void review(r, 'confirmed')}>Confirm</Button><Button size="sm" variant="ghost" onClick={() => void review(r, 'dismissed')}>Dismiss</Button></div> : <StatusBadge value={r.status} />) : undefined} />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

function Imports(): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState('totalenergies');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Row | null>(null);
  const list = usePaged('/fuel-imports', {});
  const run = async (): Promise<void> => {
    const f = file.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const id = await api.upload(f, 'import');
      const r = await api.post<Row>('/fuel-imports', { file_id: id, provider });
      setResult(r);
      void list.refetch();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Card title="Import a fuel card statement (CSV or Excel)">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Provider">
            <Select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-48">{['totalenergies', 'rubis', 'shell', 'vivo', 'ola', 'puma', 'kobil', 'other'].map((p) => <option key={p} value={p}>{t(p)}</option>)}</Select>
          </Field>
          <Field label="File"><input ref={file} type="file" accept=".csv,.xlsx" className="block text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700" /></Field>
          <Button loading={busy} icon={<Upload className="size-4" />} onClick={() => void run()}>{t('import')}</Button>
        </div>
        <p className="mt-3 text-xs text-ink/55">Columns are matched by name: date, plate/registration, litres, amount, price, odometer, station, card, receipt. Rows that match an existing fill-up are skipped.</p>
        {result && <pre className="mt-3 overflow-x-auto rounded-lg bg-black/[0.03] p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>}
      </Card>
      <Card pad={false} title="Previous imports">
        <Table rows={list.rows} loading={list.isPending} columns={[{ key: 'created_at', type: 'datetime' }, { key: 'provider' }, { key: 'rows_total', label: 'Rows', type: 'number' }, { key: 'rows_imported', label: 'Imported', type: 'number' }, { key: 'rows_skipped', label: 'Skipped', type: 'number' }, { key: 'status', type: 'status' }]} />
      </Card>
    </div>
  );
}

