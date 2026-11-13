import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Pager, SearchBox, Table, usePaged } from '../components/table';
import { Button, Card, Checkbox, Field, Input, Modal, PageHeader, Select, Spinner, Stat, StatusBadge, Textarea, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { fmtAgo, fmtDate, fmtDateTime, fmtMoney, fmtNum } from '../lib/format';
import { useI18n } from '../lib/i18n';

const money = (o: unknown): string => (o && typeof o === 'object' ? Object.entries(o as Record<string, number>).map(([c, v]) => fmtMoney(v, c)).join(' · ') || '—' : '—');

export function AdminHome(): ReactNode {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['admin-stats'], queryFn: () => api.get<Row>('/admin/stats'), refetchInterval: 60_000 });
  const s = q.data;
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title="Jatelo Fleet · platform" subtitle="All companies, revenue and tracker estate at a glance." />
      {!s ? <Spinner /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('tenants')} value={fmtNum(Object.values((s.tenants as Record<string, number>) ?? {}).reduce((a, b) => a + Number(b), 0))} sub={Object.entries((s.tenants as Record<string, number>) ?? {}).map(([k, v]) => `${String(v)} ${k}`).join(' · ')} />
            <Stat label={t('vehicles')} value={fmtNum(s.vehicles)} sub={`${fmtNum(s.trips_24h)} trips in 24 h`} />
            <Stat label="Trackers" value={fmtNum(s.active_devices)} sub={`${fmtNum(s.online_devices)} online · ${fmtNum(s.devices_in_stock)} in stock`} />
            <Stat label="Alerts (24 h)" value={fmtNum(s.alerts_24h)} />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Stat label="Monthly recurring revenue" value={<span className="text-lg">{money(s.mrr)}</span>} />
            <Stat label="Collected this month" value={<span className="text-lg">{money(s.collected_this_month)}</span>} tone="good" />
            <Stat label="Overdue" value={<span className="text-lg">{money(s.overdue)}</span>} tone={s.overdue ? 'bad' : 'flat'} />
          </div>
          <div className="flex gap-2"><Link to="/admin/tenants"><Button>{t('tenants')}</Button></Link><Link to="/admin/invoices"><Button variant="secondary">{t('invoices')}</Button></Link></div>
        </div>
      )}
    </div>
  );
}

export function AdminTenants(): ReactNode {
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [create, setCreate] = useState(false);
  const list = usePaged('/admin/tenants', { q: search || undefined, status: status || undefined });
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('tenants')} actions={<Button icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>Onboard company</Button>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-black/[0.06] px-4 py-3">
          <SearchBox value={search} onChange={setSearch} />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t('status')}><option value="">{t('all')}</option>{['trial', 'active', 'suspended', 'cancelled'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select>
        </div>
        <Table rows={list.rows} loading={list.isPending} onRowClick={(r) => nav(`/admin/tenants/${String(r.id)}`)} columns={[
          { key: 'name', render: (r) => <div><p className="font-medium">{String(r.name)}</p><p className="text-xs text-ink/50">{String(r.slug)} · {String(r.country_code)}</p></div> },
          { key: 'plan_name', label: 'Plan', render: (r) => <span>{String(r.plan_name ?? '—')} <StatusBadge value={r.subscription_status} /></span> },
          { key: 'vehicles', type: 'number' }, { key: 'devices', label: 'Trackers', render: (r) => `${fmtNum(r.online_devices)}/${fmtNum(r.devices)} online` },
          { key: 'active_users', label: t('users'), type: 'number' },
          { key: 'balance', label: t('balance_due'), render: (r) => (Number(r.balance) ? <span className="text-red-700">{fmtMoney(r.balance, String(r.currency))}</span> : '—'), align: 'right' },
          { key: 'status', type: 'status' },
        ]} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={create} onClose={() => setCreate(false)} title="Onboard a company" size="lg">{create && <NewTenant onDone={(id) => { setCreate(false); void qc.invalidateQueries({ queryKey: ['/admin/tenants'] }); if (id) nav(`/admin/tenants/${id}`); }} />}</Modal>
    </div>
  );
}

function NewTenant({ onDone }: { onDone: (id?: string) => void }): ReactNode {
  const { toast } = useToast();
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get<{ data: Row[] }>('/admin/plans') });
  const [b, setB] = useState<Record<string, string>>({ country_code: 'KE', plan_code: 'professional', vehicle_quota: '25', trial_days: '14', locale: 'en' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string): void => setB({ ...b, [k]: v, ...(k === 'name' && !b.slugTouched ? { slug: v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) } : {}) });
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<Row>('/admin/tenants', {
        name: b.name, slug: b.slug, country_code: b.country_code, legal_name: b.legal_name || undefined, tax_id: b.tax_id || undefined, email: b.email || undefined,
        phone: b.phone || undefined, locale: b.locale, plan_code: b.plan_code, vehicle_quota: Number(b.vehicle_quota), trial_days: Number(b.trial_days),
        admin: { email: b.admin_email, full_name: b.admin_name, phone: b.admin_phone || undefined },
      });
      toast(r.dev_invite_url ? `Created. Admin invite (dev): ${String(r.dev_invite_url)}` : 'Company created and administrator invited');
      onDone(String(r.id));
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Company name" required><Input value={b.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="Short name (slug)" required><Input value={b.slug ?? ''} onChange={(e) => setB({ ...b, slug: e.target.value, slugTouched: '1' })} /></Field>
      <Field label="Country"><Select value={b.country_code} onChange={(e) => set('country_code', e.target.value)}><option value="KE">Kenya</option><option value="TZ">Tanzania</option><option value="UG">Uganda</option><option value="RW">Rwanda</option></Select></Field>
      <Field label="Plan"><Select value={b.plan_code} onChange={(e) => set('plan_code', e.target.value)}>{(plans.data?.data ?? []).map((p) => <option key={String(p.code)} value={String(p.code)}>{String(p.name)}</option>)}</Select></Field>
      <Field label="Vehicle quota"><Input type="number" value={b.vehicle_quota} onChange={(e) => set('vehicle_quota', e.target.value)} /></Field>
      <Field label="Trial days" hint="0 = invoice immediately"><Input type="number" min={0} max={90} value={b.trial_days} onChange={(e) => set('trial_days', e.target.value)} /></Field>
      <Field label="Legal name"><Input value={b.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} /></Field>
      <Field label="KRA PIN / TIN"><Input value={b.tax_id ?? ''} onChange={(e) => set('tax_id', e.target.value)} /></Field>
      <Field label="Company email"><Input type="email" value={b.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
      <Field label="Company phone"><Input value={b.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
      <p className="pt-2 text-sm font-semibold sm:col-span-2">Company administrator</p>
      <Field label="Full name" required><Input value={b.admin_name ?? ''} onChange={(e) => set('admin_name', e.target.value)} /></Field>
      <Field label="Email" required><Input type="email" value={b.admin_email ?? ''} onChange={(e) => set('admin_email', e.target.value)} /></Field>
      <Field label="Phone"><Input value={b.admin_phone ?? ''} onChange={(e) => set('admin_phone', e.target.value)} /></Field>
      <Field label="Language"><Select value={b.locale} onChange={(e) => set('locale', e.target.value)}><option value="en">English</option><option value="sw">Kiswahili</option></Select></Field>
      <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={() => onDone()}>Cancel</Button><Button loading={busy} disabled={!b.name || !b.slug || !b.admin_email || !b.admin_name} onClick={() => void save()}>Create &amp; invite</Button></div>
    </div>
  );
}

export function AdminTenantDetail(): ReactNode {
  const { id } = useParams();
  const { t } = useI18n();
  const { toast, confirm } = useToast();
  const q = useQuery({ queryKey: ['/admin/tenants', id], queryFn: () => api.get<Row & { admins: Row[]; invoices: Row[]; recent_activity: Row[] }>(`/admin/tenants/${id}`) });
  const [sub, setSub] = useState<Record<string, string> | null>(null);
  if (!q.data) return <div className="flex justify-center py-24"><Spinner /></div>;
  const tn = q.data;
  const patch = async (body: object, ok: string): Promise<void> => {
    try { await api.patch(`/admin/tenants/${id}`, body); toast(ok); void q.refetch(); } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <Link to="/admin/tenants" className="inline-flex items-center gap-1 text-sm text-ink/60 hover:text-ink"><ArrowLeft className="size-4" />{t('tenants')}</Link>
      <PageHeader title={<span className="flex items-center gap-3">{String(tn.name)} <StatusBadge value={tn.status} /></span>} subtitle={`${String(tn.slug)} · ${String(tn.country_code)} · ${String(tn.currency)} · since ${fmtDate(tn.created_at)}`}
        actions={
          <>
            {tn.status !== 'suspended' && tn.status !== 'cancelled' && <Button variant="secondary" onClick={async () => { if (await confirm(`Suspend ${String(tn.name)}? Only their administrator can sign in, to pay.`, { danger: true })) void patch({ status: 'suspended' }, 'Suspended'); }}>Suspend</Button>}
            {tn.status === 'suspended' && <Button onClick={() => void patch({ status: 'active' }, 'Reactivated')}>Reactivate</Button>}
            <Button variant="secondary" onClick={() => void api.post(`/admin/tenants/${id}/invoices`).then((r) => { toast(`Invoice ${String((r as Row).number)}`); void q.refetch(); }, (e: unknown) => toast(errorText(e), 'error'))}>Issue invoice now</Button>
          </>
        } />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Plan" value={String(tn.plan_name ?? '—')} sub={`${fmtMoney(tn.price_per_vehicle, String(tn.currency))} / vehicle`} />
        <Stat label={t('vehicles')} value={`${fmtNum(tn.vehicles)} / ${fmtNum(tn.vehicle_quota)}`} />
        <Stat label="Trackers online" value={`${fmtNum(tn.online_devices)} / ${fmtNum(tn.devices)}`} />
        <Stat label={t('balance_due')} value={fmtMoney(tn.balance, String(tn.currency))} tone={Number(tn.balance) > 0 ? 'bad' : 'flat'} />
      </div>
      <Card title="Subscription" actions={<Button size="sm" variant="secondary" onClick={() => setSub({ plan_code: String(tn.plan_code ?? ''), price_per_vehicle: String(tn.price_per_vehicle ?? ''), vehicle_quota: String(tn.vehicle_quota ?? '') })}>{t('edit')}</Button>}>
        <p className="text-sm"><StatusBadge value={tn.subscription_status} /> · period ends {fmtDate(tn.current_period_end)}{tn.trial_ends_at ? ` · trial ends ${fmtDate(tn.trial_ends_at)}` : ''}</p>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Administrators" pad={false}><Table rows={tn.admins} columns={[{ key: 'full_name' }, { key: 'email' }, { key: 'status', type: 'status' }, { key: 'last_login_at', label: 'Last sign-in', render: (r) => fmtAgo(r.last_login_at) }]} /></Card>
        <Card title={t('invoices')} pad={false}><Table rows={tn.invoices} columns={[{ key: 'number' }, { key: 'period_start', type: 'date' }, { key: 'invoice_total', label: 'Total', render: (r) => fmtMoney(r.invoice_total, String(r.currency)), align: 'right' }, { key: 'status', type: 'status' }]} /></Card>
      </div>
      <Card title="Recent activity" pad={false}><Table rows={tn.recent_activity} columns={[{ key: 'created_at', type: 'datetime' }, { key: 'action', render: (r) => <span className="font-mono text-xs">{String(r.action)}</span> }, { key: 'entity_type' }]} /></Card>
      <Modal open={Boolean(sub)} onClose={() => setSub(null)} title="Edit subscription">
        {sub && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan code"><Input value={sub.plan_code} onChange={(e) => setSub({ ...sub, plan_code: e.target.value })} /></Field>
            <Field label="Price per vehicle"><Input type="number" value={sub.price_per_vehicle} onChange={(e) => setSub({ ...sub, price_per_vehicle: e.target.value })} /></Field>
            <Field label="Vehicle quota"><Input type="number" value={sub.vehicle_quota} onChange={(e) => setSub({ ...sub, vehicle_quota: e.target.value })} /></Field>
            <Field label="Extend period to"><Input type="date" value={sub.current_period_end ?? ''} onChange={(e) => setSub({ ...sub, current_period_end: e.target.value })} /></Field>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button variant="secondary" onClick={() => setSub(null)}>{t('cancel')}</Button>
              <Button onClick={() => { void patch({ subscription: { plan_code: sub.plan_code || undefined, price_per_vehicle: sub.price_per_vehicle ? Number(sub.price_per_vehicle) : undefined, vehicle_quota: sub.vehicle_quota ? Number(sub.vehicle_quota) : undefined, current_period_end: sub.current_period_end ? new Date(`${sub.current_period_end}T23:59:00`).toISOString() : undefined } }, t('saved')); setSub(null); }}>{t('save')}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export function AdminPlans(): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get<{ data: Row[] }>('/admin/plans') });
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const save = async (): Promise<void> => {
    if (!edit) return;
    const prices = Object.fromEntries(['KES', 'TZS', 'UGX', 'RWF', 'USD'].filter((c) => edit[`price_${c}`] !== '' && edit[`price_${c}`] !== undefined).map((c) => [c, Number(edit[`price_${c}`])]));
    const body = { code: edit.code, name: edit.name, description: edit.description || null, trial_days: Number(edit.trial_days ?? 14), min_vehicles: Number(edit.min_vehicles ?? 1), is_public: Boolean(edit.is_public), is_active: Boolean(edit.is_active), features: String(edit.features ?? '').split(',').map((x) => x.trim()).filter(Boolean), prices };
    try {
      if (edit.id) await api.patch(`/admin/plans/${String(edit.id)}`, { ...body, code: undefined });
      else await api.post('/admin/plans', body);
      toast(t('saved'));
      setEdit(null);
      void q.refetch();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader title={t('plans')} actions={<Button icon={<Plus className="size-4" />} onClick={() => setEdit({ is_public: true, is_active: true, trial_days: 14, min_vehicles: 1 })}>{t('add')}</Button>} />
      <Card pad={false}>
        <Table rows={q.data?.data ?? []} loading={q.isPending} onRowClick={(r) => setEdit({ ...r, features: ((r.features as string[]) ?? []).join(', '), ...Object.fromEntries(Object.entries((r.prices as Record<string, number>) ?? {}).map(([c, v]) => [`price_${c}`, v])) })} columns={[
          { key: 'name', render: (r) => <div><p className="font-medium">{String(r.name)}</p><p className="font-mono text-xs text-ink/50">{String(r.code)}</p></div> },
          { key: 'prices', label: 'Price / vehicle / month', render: (r) => money(r.prices) },
          { key: 'min_vehicles', type: 'number' }, { key: 'trial_days', type: 'number' }, { key: 'subscribers', type: 'number' },
          { key: 'is_public', label: 'Public', type: 'bool' }, { key: 'is_active', label: t('active'), type: 'bool' },
        ]} />
      </Card>
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={edit?.id ? `${t('edit')} ${String(edit.name)}` : 'New plan'} size="lg">
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code"><Input disabled={Boolean(edit.id)} value={String(edit.code ?? '')} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label={t('name')}><Input value={String(edit.name ?? '')} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            {['KES', 'TZS', 'UGX', 'RWF', 'USD'].map((c) => <Field key={c} label={`Price ${c}`}><Input type="number" value={String(edit[`price_${c}`] ?? '')} onChange={(e) => setEdit({ ...edit, [`price_${c}`]: e.target.value })} /></Field>)}
            <Field label="Minimum vehicles"><Input type="number" value={String(edit.min_vehicles ?? 1)} onChange={(e) => setEdit({ ...edit, min_vehicles: e.target.value })} /></Field>
            <Field label="Trial days"><Input type="number" value={String(edit.trial_days ?? 14)} onChange={(e) => setEdit({ ...edit, trial_days: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Features" hint="Comma-separated feature keys"><Textarea rows={2} value={String(edit.features ?? '')} onChange={(e) => setEdit({ ...edit, features: e.target.value })} /></Field></div>
            <div className="sm:col-span-2"><Field label={t('description')}><Textarea rows={2} value={String(edit.description ?? '')} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
            <Checkbox label="Shown to customers" checked={Boolean(edit.is_public)} onChange={(e) => setEdit({ ...edit, is_public: e.target.checked })} />
            <Checkbox label={t('active')} checked={Boolean(edit.is_active)} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />
            <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={() => setEdit(null)}>{t('cancel')}</Button><Button onClick={() => void save()}>{t('save')}</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export function AdminInvoices(): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const [status, setStatus] = useState('');
  const list = usePaged('/admin/invoices', { status: status || undefined });
  const [pay, setPay] = useState<Row | null>(null);
  const [p, setP] = useState<Record<string, string>>({ method: 'bank_transfer' });
  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try { await fn(); toast(ok); void list.refetch(); } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('invoices')} />
      <Card pad={false}>
        <div className="border-b border-black/[0.06] px-4 py-3"><Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t('status')}><option value="">{t('all')}</option>{['open', 'overdue', 'paid', 'void'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select></div>
        <Table rows={list.rows} loading={list.isPending} columns={[
          { key: 'number', render: (r) => <span className="font-mono text-xs">{String(r.number)}</span> }, { key: 'tenant_name', label: 'Company' },
          { key: 'period_start', label: t('period'), render: (r) => `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}` }, { key: 'vehicle_count', label: t('vehicles'), type: 'number' },
          { key: 'total', label: 'Total', render: (r) => fmtMoney(r.total, String(r.currency)), align: 'right' }, { key: 'amount_paid', label: 'Paid', render: (r) => fmtMoney(r.amount_paid, String(r.currency)), align: 'right' },
          { key: 'due_date', type: 'date' }, { key: 'status', type: 'status' },
        ]} rowActions={(r) => (['open', 'overdue'].includes(String(r.status)) ? (
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => { setPay(r); setP({ method: 'bank_transfer', amount: String(Number(r.total) - Number(r.amount_paid)) }); }}>Record payment</Button>
            {Number(r.amount_paid) === 0 && <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt('Reason for voiding?'); if (reason) void act(() => api.post(`/admin/invoices/${String(r.id)}/void`, { reason }), 'Voided'); }}>Void</Button>}
          </div>
        ) : null)} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={Boolean(pay)} onClose={() => setPay(null)} title={`Record payment · ${String(pay?.number ?? '')}`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Method"><Select value={p.method} onChange={(e) => setP({ ...p, method: e.target.value })}>{['bank_transfer', 'mpesa_ke', 'mpesa_tz', 'airtel_money', 'mixx_tz', 'mtn_momo', 'card', 'manual'].map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</Select></Field>
          <Field label="Amount"><Input type="number" value={p.amount ?? ''} onChange={(e) => setP({ ...p, amount: e.target.value })} /></Field>
          <Field label="Reference" required><Input value={p.reference ?? ''} onChange={(e) => setP({ ...p, reference: e.target.value })} /></Field>
          <Field label="Paid on"><Input type="date" value={p.paid_on ?? ''} onChange={(e) => setP({ ...p, paid_on: e.target.value })} /></Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="secondary" onClick={() => setPay(null)}>{t('cancel')}</Button>
            <Button disabled={!p.reference || !p.amount} onClick={() => { void act(() => api.post(`/admin/invoices/${String(pay!.id)}/payments`, { method: p.method, amount: Number(p.amount), reference: p.reference, paid_at: p.paid_on ? new Date(`${p.paid_on}T12:00:00`).toISOString() : undefined }), 'Payment recorded'); setPay(null); }}>{t('save')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function AdminDevices(): ReactNode {
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const list = usePaged('/admin/devices', { q: search || undefined, status: status || undefined });
  const tenants = useQuery({ queryKey: ['admin-tenants-all'], queryFn: () => api.get<{ data: Row[] }>('/admin/tenants', { page_size: 200 }) });
  const [bulk, setBulk] = useState(false);
  const [text, setText] = useState('');
  const [tenant, setTenant] = useState('');
  const [protocol, setProtocol] = useState('teltonika');
  const [model, setModel] = useState('FMC130');
  const [move, setMove] = useState<Row | null>(null);
  const provision = async (): Promise<void> => {
    const devices = text.split(/\n/).map((l) => l.split(/[,;\t]/).map((x) => x.trim())).filter((x) => x[0]).map(([identifier, msisdn, iccid]) => ({ identifier: identifier!, protocol, model, sim_msisdn: msisdn || undefined, sim_iccid: iccid || undefined }));
    try {
      const r = await api.post<{ created: number; skipped: string[] }>('/admin/devices', { tenant_id: tenant || null, devices });
      toast(`${r.created} provisioned${r.skipped.length ? `, ${r.skipped.length} already existed` : ''}`);
      setBulk(false);
      setText('');
      void list.refetch();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title="Tracker stock" actions={<Button icon={<Upload className="size-4" />} onClick={() => setBulk(true)}>Provision trackers</Button>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-black/[0.06] px-4 py-3">
          <SearchBox value={search} onChange={setSearch} placeholder="IMEI or SIM" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t('status')}><option value="">{t('all')}</option>{['in_stock', 'active', 'suspended', 'retired'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select>
        </div>
        <Table rows={list.rows} loading={list.isPending} columns={[
          { key: 'identifier', label: 'IMEI', render: (r) => <span className="font-mono text-xs">{String(r.identifier)}</span> }, { key: 'model', render: (r) => `${String(r.model ?? '—')} · ${String(r.protocol)}` },
          { key: 'tenant_name', label: 'Company', render: (r) => String(r.tenant_name ?? 'Jatelo stock') }, { key: 'sim_msisdn', label: 'SIM' },
          { key: 'last_seen_at', label: t('last_seen'), render: (r) => fmtAgo(r.last_seen_at, lang) }, { key: 'status', type: 'status' },
        ]} rowActions={(r) => <Button size="sm" variant="ghost" onClick={() => setMove(r)}>Transfer</Button>} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={bulk} onClose={() => setBulk(false)} title="Provision trackers" size="lg">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Protocol"><Select value={protocol} onChange={(e) => setProtocol(e.target.value)}><option value="teltonika">Teltonika</option><option value="gt06">GT06 / Concox</option><option value="queclink">Queclink</option></Select></Field>
            <Field label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} /></Field>
            <Field label="Assign to company"><Select value={tenant} onChange={(e) => setTenant(e.target.value)}><option value="">Jatelo stock</option>{(tenants.data?.data ?? []).map((x) => <option key={String(x.id)} value={String(x.id)}>{String(x.name)}</option>)}</Select></Field>
          </div>
          <Field label="One tracker per line: IMEI, SIM number, ICCID" hint="SIM and ICCID are optional"><Textarea rows={8} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'356307042441013, +254712000001\n356307042441021'} /></Field>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setBulk(false)}>{t('cancel')}</Button><Button disabled={!text.trim()} onClick={() => void provision()}>Provision</Button></div>
        </div>
      </Modal>
      <Modal open={Boolean(move)} onClose={() => setMove(null)} title={`Transfer ${String(move?.identifier ?? '')}`} size="sm">
        {move && (
          <div className="space-y-4">
            <p className="text-sm text-ink/60">The tracker is unassigned from any vehicle first.</p>
            <Select value={tenant} onChange={(e) => setTenant(e.target.value)}><option value="">Back to Jatelo stock</option>{(tenants.data?.data ?? []).map((x) => <option key={String(x.id)} value={String(x.id)}>{String(x.name)}</option>)}</Select>
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setMove(null)}>{t('cancel')}</Button>
              <Button onClick={() => void api.post(`/admin/devices/${String(move.id)}/transfer`, { tenant_id: tenant || null }).then(() => { toast(t('saved')); setMove(null); void list.refetch(); }, (e: unknown) => toast(errorText(e), 'error'))}>{t('save')}</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export function AdminAudit(): ReactNode {
  const { t } = useI18n();
  const [action, setAction] = useState('');
  const list = usePaged('/admin/audit-logs', { action: action || undefined });
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('audit_log')} />
      <Card pad={false}>
        <div className="border-b border-black/[0.06] px-4 py-3"><Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action, e.g. tenant.* or payment.received" className="max-w-sm" /></div>
        <Table rows={list.rows} loading={list.isPending} columns={[
          { key: 'created_at', render: (r) => fmtDateTime(r.created_at) }, { key: 'tenant_name', label: 'Company', render: (r) => String(r.tenant_name ?? 'Platform') },
          { key: 'actor_email', label: 'Who', render: (r) => String(r.actor_email ?? r.actor_type) }, { key: 'action', render: (r) => <span className="font-mono text-xs">{String(r.action)}</span> },
          { key: 'entity_type' }, { key: 'metadata', label: 'Details', render: (r) => <span className="line-clamp-1 max-w-xs font-mono text-[11px] text-ink/55">{r.metadata ? JSON.stringify(r.metadata) : ''}</span> },
        ]} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
    </div>
  );
}

