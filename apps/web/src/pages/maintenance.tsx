import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useOptions } from '../components/forms';
import { CrudPage, Pager, Table, usePaged } from '../components/table';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Stat, StatusBadge, Tabs, Textarea, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '../lib/format';
import { useI18n } from '../lib/i18n';

type Tab = 'due' | 'work_orders' | 'schedules' | 'defects' | 'inspections' | 'dtc' | 'parts' | 'tasks';

export default function MaintenancePage(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('due');
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('maintenance')} subtitle="Preventive schedules by km, engine hours and days; work orders with labour and parts; driver inspections and defects; engine fault codes." />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'due', label: t('services_due') },
        { value: 'work_orders', label: t('work_orders') },
        { value: 'schedules', label: t('service_schedules') },
        { value: 'defects', label: t('defects') },
        { value: 'inspections', label: t('inspections') },
        { value: 'dtc', label: 'Fault codes' },
        ...(can('parts:read') ? [{ value: 'parts' as const, label: t('parts') }] : []),
        { value: 'tasks', label: t('service_tasks') },
      ]} />
      {tab === 'due' && <Due onWorkOrder={() => setTab('work_orders')} />}
      {tab === 'work_orders' && <WorkOrders />}
      {tab === 'schedules' && (
        <CrudPage embedded path="/service-schedules" title={t('service_schedules')} write="maintenance:write" noun="schedule"
          formOpts={{ order: ['vehicle_id', 'service_task_id', 'name', 'interval_km', 'interval_hours', 'interval_days', 'last_done_at', 'last_done_km', 'last_done_hours'] }}
          columns={[
            { key: 'plate_number', label: t('vehicle') }, { key: 'name' },
            { key: 'interval', label: 'Every', render: (r) => [r.interval_km && `${fmtNum(r.interval_km)} km`, r.interval_hours && `${fmtNum(r.interval_hours)} h`, r.interval_days && `${String(r.interval_days)} days`].filter(Boolean).join(' / ') || '—' },
            { key: 'next', label: 'Next due', render: (r) => [r.next_due_km && `${fmtNum(r.next_due_km)} km`, r.next_due_at && fmtDate(r.next_due_at)].filter(Boolean).join(' · ') || '—' },
            { key: 'status', type: 'status' },
          ]} />
      )}
      {tab === 'defects' && (
        <CrudPage embedded path="/defects" title={t('defects')} write="maintenance:write" noun="defect" canDelete={false} formOpts={{ hide: ['photo_file_ids'] }}
          columns={[
            { key: 'reported_at', type: 'datetime' }, { key: 'plate_number', label: t('vehicle') }, { key: 'title', render: (r) => <div><p className="font-medium">{String(r.title)}</p><p className="text-xs text-ink/55">{String(r.description ?? '')}</p></div> },
            { key: 'severity', type: 'status' }, { key: 'reported_by_driver', label: 'Reported by' }, { key: 'work_order_number', label: 'Work order' }, { key: 'status', type: 'status' },
          ]} />
      )}
      {tab === 'inspections' && <Inspections />}
      {tab === 'dtc' && <Dtcs />}
      {tab === 'parts' && <Parts />}
      {tab === 'tasks' && (
        <CrudPage embedded path="/service-tasks" title={t('service_tasks')} write="maintenance:write" noun="task"
          columns={[{ key: 'name' }, { key: 'category', render: (r) => t(String(r.category)) }, { key: 'est_labour_hours', type: 'number' }, { key: 'est_cost', type: 'money' }, { key: 'is_active', type: 'bool' }]} />
      )}
    </div>
  );
}

function Due({ onWorkOrder }: { onWorkOrder: () => void }): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['/service-schedules', 'due'], queryFn: () => api.get<{ data: Row[] }>('/service-schedules/due') });
  const open = async (r: Row): Promise<void> => {
    try {
      await api.post('/work-orders', { vehicle_id: r.vehicle_id, title: String(r.name), wo_type: 'preventive', items: [] });
      toast('Work order created');
      onWorkOrder();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <Card pad={false}>
      <Table rows={q.data?.data ?? []} loading={q.isPending} empty={<div className="py-10 text-center text-sm text-ink/50">Nothing due. All vehicles are within their service intervals.</div>} columns={[
        { key: 'plate_number', label: t('vehicle'), render: (r) => <span className="font-semibold">{String(r.plate_number)}</span> },
        { key: 'name' },
        { key: 'due', label: 'Due', render: (r) => <div className="text-xs">{r.km_remaining !== null && r.km_remaining !== undefined && <p>{Number(r.km_remaining) < 0 ? `${fmtNum(-Number(r.km_remaining))} km overdue` : `in ${fmtNum(r.km_remaining)} km`}</p>}{r.days_remaining !== null && r.days_remaining !== undefined && <p>{Number(r.days_remaining) < 0 ? `${-Number(r.days_remaining)} days overdue` : `in ${String(r.days_remaining)} days`}</p>}{r.hours_remaining !== null && r.hours_remaining !== undefined && <p>{`${fmtNum(r.hours_remaining)} engine h`}</p>}</div> },
        { key: 'status', type: 'status' },
      ]} rowActions={can('maintenance:write') ? (r) => <Button size="sm" variant="secondary" onClick={() => void open(r)}>Create work order</Button> : undefined} />
    </Card>
  );
}

function WorkOrders(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const qc = useQueryClient();
  const list = usePaged('/work-orders', { status: status || undefined });
  return (
    <>
      <Card pad={false} title={t('work_orders')} actions={
        <>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t('status')}>
            <option value="">{t('all')}</option>
            {['open', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'].map((s) => <option key={s} value={s}>{t(s)}</option>)}
          </Select>
          {can('maintenance:write') && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>{t('add')}</Button>}
        </>
      }>
        <Table rows={list.rows} loading={list.isPending} onRowClick={(r) => setOpen(String(r.id))} columns={[
          { key: 'number', render: (r) => <span className="font-mono text-xs">{String(r.number)}</span> }, { key: 'plate_number', label: t('vehicle') },
          { key: 'title' }, { key: 'wo_type', render: (r) => t(String(r.wo_type)) }, { key: 'priority', type: 'status' }, { key: 'assigned_to_name', label: 'Assigned to' },
          { key: 'scheduled_for', type: 'date' }, { key: 'total_cost', type: 'money' }, { key: 'status', type: 'status' },
        ]} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={t('work_orders')} size="xl">{open && <WorkOrderDetail id={open} />}</Modal>
      <Modal open={create} onClose={() => setCreate(false)} title={`${t('new')} work order`} size="lg">
        {create && <NewWorkOrder onDone={(id) => { setCreate(false); void qc.invalidateQueries({ queryKey: ['/work-orders'] }); if (id) setOpen(id); }} />}
      </Modal>
    </>
  );
}

function NewWorkOrder({ onDone }: { onDone: (id?: string) => void }): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const vehicles = useOptions('/vehicles');
  const users = useOptions('/users');
  const [b, setB] = useState<Record<string, string>>({ wo_type: 'corrective', priority: 'normal' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string): void => setB({ ...b, [k]: v });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        const r = await api.post<Row>('/work-orders', { ...Object.fromEntries(Object.entries(b).filter(([, v]) => v)), scheduled_for: b.scheduled_for ? new Date(b.scheduled_for).toISOString() : undefined, items: [] });
        onDone(String(r.id));
      } catch (x) { toast(errorText(x), 'error'); } finally { setBusy(false); }
    }}>
      <Field label={t('vehicle')} required><Select required value={b.vehicle_id ?? ''} onChange={(e) => set('vehicle_id', e.target.value)}><option value="" />{vehicles.options.map((v) => <option key={String(v.id)} value={String(v.id)}>{String(v.plate_number)}</option>)}</Select></Field>
      <Field label="Title" required><Input required value={b.title ?? ''} onChange={(e) => set('title', e.target.value)} /></Field>
      <Field label="Type"><Select value={b.wo_type} onChange={(e) => set('wo_type', e.target.value)}>{['preventive', 'corrective', 'inspection', 'accident', 'tyre', 'other'].map((x) => <option key={x} value={x}>{t(x)}</option>)}</Select></Field>
      <Field label={t('priority')}><Select value={b.priority} onChange={(e) => set('priority', e.target.value)}>{['low', 'normal', 'high', 'urgent'].map((x) => <option key={x} value={x}>{t(x)}</option>)}</Select></Field>
      <Field label="Mechanic"><Select value={b.assigned_to ?? ''} onChange={(e) => set('assigned_to', e.target.value)}><option value="">—</option>{users.options.filter((u) => u.role === 'mechanic' || u.role === 'fleet_manager').map((u) => <option key={String(u.id)} value={String(u.id)}>{String(u.full_name)}</option>)}</Select></Field>
      <Field label="Outside garage"><Input value={b.vendor_name ?? ''} onChange={(e) => set('vendor_name', e.target.value)} /></Field>
      <Field label="Scheduled for"><Input type="datetime-local" value={b.scheduled_for ?? ''} onChange={(e) => set('scheduled_for', e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label={t('description')}><Textarea value={b.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field></div>
      <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={() => onDone()}>{t('cancel')}</Button><Button type="submit" loading={busy}>{t('save')}</Button></div>
    </form>
  );
}

function WorkOrderDetail({ id }: { id: string }): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['/work-orders', id], queryFn: () => api.get<Row & { items: Row[] }>(`/work-orders/${id}`) });
  const parts = useOptions('/parts', can('parts:read'));
  const [item, setItem] = useState<Record<string, string>>({ item_type: 'labour', quantity: '1' });
  const [odo, setOdo] = useState('');
  if (!q.data) return <div className="flex justify-center py-16"><Spinner /></div>;
  const w = q.data;
  const write = can('maintenance:write') && !['completed', 'cancelled'].includes(String(w.status));
  const refresh = (): void => { void q.refetch(); void qc.invalidateQueries({ queryKey: ['/work-orders'] }); };
  const status = async (s: string): Promise<void> => {
    try {
      await api.post(`/work-orders/${id}/status`, { status: s, ...(s === 'completed' && odo ? { odometer_km: Number(odo) } : {}) });
      refresh();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const addItem = async (): Promise<void> => {
    try {
      await api.post(`/work-orders/${id}/items`, { items: [{ item_type: item.item_type, description: item.description, quantity: Number(item.quantity || 1), unit_cost: Number(item.unit_cost || 0), part_id: item.part_id || undefined }] });
      setItem({ item_type: item.item_type, quantity: '1' });
      refresh();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink/50">{String(w.number)}</p>
          <p className="text-lg font-semibold">{String(w.title)}</p>
          <p className="text-sm text-ink/60">{String(w.plate_number)} · {t(String(w.wo_type))} · {String(w.assigned_to_name ?? w.vendor_name ?? 'Unassigned')}</p>
        </div>
        <StatusBadge value={w.status} />
      </div>
      {Boolean(w.description) && <p className="rounded-lg bg-black/[0.03] p-3 text-sm">{String(w.description)}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Labour" value={fmtMoney(w.labour_cost, String(w.currency))} /><Stat label="Parts" value={fmtMoney(w.parts_cost, String(w.currency))} />
        <Stat label="Total" value={fmtMoney(w.total_cost, String(w.currency))} /><Stat label="Downtime" value={w.downtime_hours ? `${fmtNum(w.downtime_hours, 1)} h` : '—'} />
      </div>
      <Table rows={w.items} columns={[
        { key: 'item_type', render: (r) => <Badge>{t(String(r.item_type))}</Badge> }, { key: 'description' }, { key: 'quantity', type: 'number' },
        { key: 'unit_cost', type: 'money' }, { key: 'total_cost', label: 'Amount', render: (r) => fmtMoney(Number(r.quantity) * Number(r.unit_cost), String(w.currency)), align: 'right' },
      ]} rowActions={write ? (r) => <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-red-600" />} aria-label={t('delete')} onClick={() => void api.del(`/work-orders/${id}/items/${String(r.id)}`).then(refresh, (e: unknown) => toast(errorText(e), 'error'))} /> : undefined} />
      {write && (
        <div className="grid items-end gap-2 rounded-lg bg-black/[0.02] p-3 sm:grid-cols-[8rem_1fr_6rem_8rem_auto]">
          <Select value={item.item_type} onChange={(e) => setItem({ ...item, item_type: e.target.value })} aria-label="Type">{['labour', 'part', 'service', 'other'].map((x) => <option key={x} value={x}>{t(x)}</option>)}</Select>
          {item.item_type === 'part' && parts.options.length ? (
            <Select value={item.part_id ?? ''} onChange={(e) => { const p = parts.options.find((x) => x.id === e.target.value); setItem({ ...item, part_id: e.target.value, description: String(p?.name ?? ''), unit_cost: String(p?.unit_cost ?? '') }); }} aria-label="Part">
              <option value="">Choose a part from stock…</option>{parts.options.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)} ({fmtNum(p.quantity_on_hand)} in stock)</option>)}
            </Select>
          ) : <Input placeholder={t('description')} value={item.description ?? ''} onChange={(e) => setItem({ ...item, description: e.target.value })} />}
          <Input type="number" min={0} step="any" placeholder="Qty" value={item.quantity ?? ''} onChange={(e) => setItem({ ...item, quantity: e.target.value })} />
          <Input type="number" min={0} step="any" placeholder="Unit cost" value={item.unit_cost ?? ''} onChange={(e) => setItem({ ...item, unit_cost: e.target.value })} />
          <Button disabled={!item.description} icon={<Plus className="size-4" />} onClick={() => void addItem()}>{t('add')}</Button>
        </div>
      )}
      {write && (
        <div className="flex flex-wrap items-center gap-2 border-t border-black/[0.06] pt-4">
          {w.status !== 'in_progress' && <Button variant="secondary" onClick={() => void status('in_progress')}>Start work</Button>}
          {w.status === 'in_progress' && <Button variant="secondary" onClick={() => void status('on_hold')}>On hold</Button>}
          <div className="flex-1" />
          <Input type="number" placeholder="Odometer at completion (km)" value={odo} onChange={(e) => setOdo(e.target.value)} className="w-56" />
          <Button onClick={() => void status('completed')}>Complete</Button>
          <Button variant="ghost" onClick={() => void status('cancelled')}>{t('cancel')} WO</Button>
        </div>
      )}
      {!write && w.completed_at ? <p className="text-sm text-ink/60">Completed {fmtDateTime(w.completed_at)}</p> : null}
    </div>
  );
}

function Inspections(): ReactNode {
  const { t } = useI18n();
  const [result, setResult] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = usePaged('/inspections', { result: result || undefined });
  const d = useQuery({ queryKey: ['/inspections', open], queryFn: () => api.get<Row & { results: Row[] }>(`/inspections/${open}`), enabled: Boolean(open) });
  const answers = d.data?.results ?? [];
  return (
    <>
      <Card pad={false} title={t('inspections')} actions={
        <Select value={result} onChange={(e) => setResult(e.target.value)} className="w-36" aria-label="Result"><option value="">{t('all')}</option><option value="pass">Pass</option><option value="fail">Fail</option></Select>
      }>
        <Table rows={list.rows} loading={list.isPending} onRowClick={(r) => setOpen(String(r.id))} columns={[
          { key: 'submitted_at', type: 'datetime' }, { key: 'plate_number', label: t('vehicle') }, { key: 'driver_name', label: t('driver') },
          { key: 'inspection_type', render: (r) => t(String(r.inspection_type)) }, { key: 'defects', type: 'number' },
          { key: 'result', render: (r) => <Badge tone={r.result === 'pass' ? 'green' : 'red'}>{String(r.result).toUpperCase()}</Badge> },
        ]} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={t('inspections')} size="lg">
        {!d.data ? <Spinner /> : (
          <ul className="divide-y divide-black/[0.05] text-sm">
            {answers.map((a, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2">
                <span>{String(a.label ?? '')}{a.is_critical ? <Badge tone="red">critical item</Badge> : null}{a.note ? <span className="block text-xs text-ink/55">{String(a.note)}</span> : null}</span>
                <Badge tone={a.status === 'ok' ? 'green' : a.status === 'na' ? 'gray' : 'red'}>{String(a.status).toUpperCase()}</Badge>
              </li>
            ))}
            {!answers.length && <li className="py-6 text-center text-ink/50">{t('no_data')}</li>}
          </ul>
        )}
      </Modal>
    </>
  );
}

function Dtcs(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState('active');
  const list = usePaged('/dtc-codes', { status: status || undefined });
  return (
    <Card pad={false} title="Engine fault codes (from CAN-bus trackers)" actions={
      <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36" aria-label={t('status')}><option value="">{t('all')}</option><option value="active">{t('active')}</option><option value="cleared">Cleared</option></Select>
    }>
      <Table rows={list.rows} loading={list.isPending} columns={[
        { key: 'first_seen_at', label: 'First seen', type: 'datetime' }, { key: 'last_seen_at', label: 'Last seen', type: 'datetime' }, { key: 'plate_number', label: t('vehicle') },
        { key: 'code', render: (r) => <span className="font-mono font-semibold">{String(r.code)}</span> }, { key: 'description', render: (r) => String(r.description ?? r.catalog_description ?? '—') },
        { key: 'severity', type: 'status' }, { key: 'status', type: 'status' },
      ]} rowActions={can('maintenance:write') ? (r) => (r.status === 'active' ? <Button size="sm" variant="ghost" onClick={() => void api.post(`/dtc-codes/${String(r.id)}/clear`).then(() => list.refetch(), (e: unknown) => toast(errorText(e), 'error'))}>Mark cleared</Button> : null) : undefined} />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

function Parts(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [move, setMove] = useState<Row | null>(null);
  const [m, setM] = useState<Record<string, string>>({ movement_type: 'purchase' });
  return (
    <>
      <CrudPage embedded path="/parts" title={t('parts')} write="parts:write" noun="part"
        extraActions={can('parts:write') ? (r) => <Button size="sm" variant="secondary" onClick={() => { setMove(r); setM({ movement_type: 'purchase' }); }}>Stock</Button> : undefined}
        columns={[
          { key: 'part_number', render: (r) => <span className="font-mono text-xs">{String(r.part_number ?? '—')}</span> }, { key: 'name' }, { key: 'location' },
          { key: 'quantity_on_hand', label: 'In stock', render: (r) => <span className="inline-flex items-center gap-1.5 tabular">{fmtNum(r.quantity_on_hand, 2)} {String(r.unit)} {Boolean(r.low_stock) && <Badge tone="red">Low</Badge>}</span> },
          { key: 'unit_cost', type: 'money' }, { key: 'stock_value', type: 'money' },
        ]} />
      <Modal open={Boolean(move)} onClose={() => setMove(null)} title={`Stock movement · ${String(move?.name ?? '')}`}>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const qty = Number(m.quantity);
            const neg = ['issue', 'transfer_out'].includes(m.movement_type!);
            await api.post(`/parts/${String(move!.id)}/movements`, { movement_type: m.movement_type, quantity: neg ? -Math.abs(qty) : m.movement_type === 'adjustment' ? qty : Math.abs(qty), unit_cost: m.unit_cost ? Number(m.unit_cost) : undefined, reference: m.reference || undefined, notes: m.notes || undefined });
            toast(t('saved'));
            setMove(null);
            void qc.invalidateQueries({ queryKey: ['/parts'] });
          } catch (x) { toast(errorText(x), 'error'); }
        }}>
          <Field label="Movement"><Select value={m.movement_type} onChange={(e) => setM({ ...m, movement_type: e.target.value })}>{['purchase', 'issue', 'return', 'adjustment', 'transfer_in', 'transfer_out'].map((x) => <option key={x} value={x}>{t(x)}</option>)}</Select></Field>
          <Field label="Quantity" hint={m.movement_type === 'adjustment' ? 'Use a negative number to reduce stock' : undefined}><Input type="number" step="any" required value={m.quantity ?? ''} onChange={(e) => setM({ ...m, quantity: e.target.value })} /></Field>
          <Field label="Unit cost"><Input type="number" step="any" value={m.unit_cost ?? ''} onChange={(e) => setM({ ...m, unit_cost: e.target.value })} /></Field>
          <Field label="Reference (invoice / GRN)"><Input value={m.reference ?? ''} onChange={(e) => setM({ ...m, reference: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Notes"><Textarea rows={2} value={m.notes ?? ''} onChange={(e) => setM({ ...m, notes: e.target.value })} /></Field></div>
          <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={() => setMove(null)}>{t('cancel')}</Button><Button type="submit">{t('save')}</Button></div>
        </form>
      </Modal>
    </>
  );
}
