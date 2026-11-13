import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MailPlus, RotateCcw, ShieldOff, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { EntityForm, MultiRefSelect } from '../components/forms';
import { CrudPage, Pager, Table, usePaged, SearchBox } from '../components/table';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Tabs, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

type Tab = 'company' | 'operations' | 'users' | 'groups' | 'webhooks' | 'audit';
const ROLES = ['company_admin', 'fleet_manager', 'dispatcher', 'mechanic', 'accountant'];

export default function SettingsPage(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const items: { value: Tab; label: string }[] = [
    ...(can('tenant:settings') ? [{ value: 'company' as const, label: t('company') }, { value: 'operations' as const, label: 'Operations' }] : []),
    ...(can('users:read') ? [{ value: 'users' as const, label: t('users') }] : []),
    ...(can('vehicles:write') ? [{ value: 'groups' as const, label: t('vehicle_groups') }] : []),
    ...(can('tenant:settings') ? [{ value: 'webhooks' as const, label: t('webhooks') }] : []),
    ...(can('audit:read') ? [{ value: 'audit' as const, label: t('audit_log') }] : []),
  ];
  const [tab, setTab] = useState<Tab>(items[0]?.value ?? 'users');
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader title={t('settings')} />
      <Tabs value={tab} onChange={setTab} items={items} />
      {tab === 'company' && <Company />}
      {tab === 'operations' && <Operations />}
      {tab === 'users' && <Users />}
      {tab === 'groups' && (
        <CrudPage embedded path="/vehicle-groups" title={t('vehicle_groups')} write="vehicles:write" noun="group" searchable={false}
          columns={[{ key: 'name', render: (r) => <span className="inline-flex items-center gap-2 font-medium"><span className="size-3 rounded" style={{ background: String(r.color ?? '#999') }} />{String(r.name)}</span> }, { key: 'description' }, { key: 'vehicle_count', label: t('vehicles'), type: 'number' }]} />
      )}
      {tab === 'webhooks' && (
        <CrudPage embedded path="/webhooks" title={t('webhooks')} write="tenant:settings" noun="webhook" searchable={false}
          headerActions={<span className="hidden text-xs text-ink/50 md:inline">Signed with HMAC-SHA256 (X-JFS-Signature). Leave events empty to receive everything.</span>}
          columns={[{ key: 'name' }, { key: 'url', render: (r) => <span className="font-mono text-xs">{String(r.url)}</span> }, { key: 'events', render: (r) => ((r.events as string[]) ?? []).join(', ') || 'All' }, { key: 'is_active', label: t('status'), render: (r) => <StatusBadge value={r.is_active === false ? 'inactive' : 'active'} /> }, { key: 'last_status', label: 'Last delivery', render: (r) => String(r.last_status ?? '—') }]} />
      )}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function Company(): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const { reload } = useAuth();
  const q = useQuery({ queryKey: ['/tenant'], queryFn: () => api.get<Row>('/tenant') });
  if (!q.data) return <Spinner />;
  return (
    <Card title={t('company')}>
      <p className="mb-4 text-sm text-ink/60">Country <b>{String(q.data.country_code)}</b> and currency <b>{String(q.data.currency)}</b> are fixed at signup - contact Jatelo support to change them.</p>
      <EntityForm path="/tenant" row={q.data} submit={{ method: 'patch', url: '/tenant' }} opts={{ hide: ['logo_url'] }} onSaved={() => { toast(t('saved')); void q.refetch(); void reload(); }} />
    </Card>
  );
}

function Operations(): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['/tenant'], queryFn: () => api.get<Row & { settings: Row }>('/tenant') });
  if (!q.data) return <Spinner />;
  const time = (v: unknown, set: (x: unknown) => void): ReactNode => <Input type="time" value={String(v ?? '').slice(0, 5)} onChange={(e) => set(e.target.value)} />;
  return (
    <Card title="Operating thresholds" >
      <p className="mb-4 text-sm text-ink/60">These drive trip detection, speeding, idling, offline alerts, driver scoring and data retention for the whole company.</p>
      <EntityForm
        path="/tenant/settings"
        row={{ ...q.data.settings, id: 'settings' }}
        submit={{ method: 'patch', url: '/tenant/settings' }}
        opts={{ custom: { night_start: time, night_end: time } }}
        onSaved={() => { toast(t('saved')); void q.refetch(); }}
      />
    </Card>
  );
}

function Users(): ReactNode {
  const { t, lang } = useI18n();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  const [search, setSearch] = useState('');
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<Row | null>(null);
  const list = usePaged('/users', { q: search || undefined });
  const manage = can('users:manage');
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try { await fn(); toast(ok); await qc.invalidateQueries({ queryKey: ['/users'] }); } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <>
      <Card pad={false} title={t('users')} actions={manage && <Button size="sm" icon={<MailPlus className="size-4" />} onClick={() => setInvite(true)}>{t('invite_user')}</Button>}>
        <div className="border-b border-black/[0.06] px-4 py-3"><SearchBox value={search} onChange={setSearch} /></div>
        <Table rows={list.rows} loading={list.isPending} onRowClick={manage ? (r) => (r.role === 'driver' || r.id === me?.user.id ? undefined : setEdit(r)) : undefined} columns={[
          { key: 'full_name', render: (r) => <div><p className="font-medium">{String(r.full_name)}</p><p className="text-xs text-ink/55">{String(r.email)}</p></div> },
          { key: 'role', render: (r) => <Badge tone={r.role === 'company_admin' ? 'violet' : 'gray'}>{t(String(r.role))}</Badge> },
          { key: 'groups', label: 'Access', render: (r) => (((r.groups as Row[]) ?? []).length ? ((r.groups as Row[]) ?? []).map((g) => String(g.name)).join(', ') : t('all_vehicles')) },
          { key: 'mfa_enabled', label: '2FA', render: (r) => (r.mfa_enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>) },
          { key: 'last_login_at', label: 'Last sign-in', render: (r) => fmtAgo(r.last_login_at, lang) },
          { key: 'status', type: 'status' },
        ]} rowActions={manage ? (r) => (r.role === 'driver' || r.id === me?.user.id ? null : (
          <div className="flex gap-0.5">
            {r.status === 'invited' && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => void run(() => api.post(`/users/${String(r.id)}/resend-invite`), 'Invitation sent')}>{t('resend_invite')}</Button>}
            {Boolean(r.mfa_enabled) && <Button size="sm" variant="ghost" icon={<ShieldOff className="size-4" />} aria-label={t('reset_2fa')} onClick={async () => { if (await confirm(`Reset 2FA for ${String(r.full_name)}? They will set it up again at next sign-in.`)) void run(() => api.post(`/users/${String(r.id)}/reset-mfa`), t('saved')); }} />}
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-red-600" />} aria-label={t('delete')} onClick={async () => { if (await confirm(`Remove ${String(r.full_name)}? They will be signed out everywhere.`, { danger: true })) void run(() => api.del(`/users/${String(r.id)}`), t('deleted')); }} />
          </div>
        )) : undefined} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={invite} onClose={() => setInvite(false)} title={t('invite_user')}>{invite && <UserForm onDone={() => { setInvite(false); void qc.invalidateQueries({ queryKey: ['/users'] }); }} />}</Modal>
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={`${t('edit')} ${String(edit?.full_name ?? '')}`}>{edit && <UserForm row={edit} onDone={() => { setEdit(null); void qc.invalidateQueries({ queryKey: ['/users'] }); }} />}</Modal>
    </>
  );
}

function UserForm({ row, onDone }: { row?: Row; onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const [b, setB] = useState<Record<string, unknown>>(row ? { full_name: row.full_name, phone: row.phone, role: row.role, status: row.status, locale: row.locale } : { role: 'dispatcher', locale: 'en' });
  const [groups, setGroups] = useState<string[]>(((row?.groups as Row[]) ?? []).map((g) => String(g.id)));
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown): void => setB({ ...b, [k]: v });
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      if (row) await api.patch(`/users/${String(row.id)}`, { ...b, status: b.status === 'invited' ? undefined : b.status, group_ids: groups });
      else {
        const r = await api.post<Row>('/users', { ...b, group_ids: groups });
        if (r.dev_invite_url) toast(`Invite link (dev): ${String(r.dev_invite_url)}`);
      }
      toast(row ? t('saved') : 'Invitation sent');
      onDone();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {!row && <Field label={t('email')} required><Input type="email" value={String(b.email ?? '')} onChange={(e) => set('email', e.target.value)} /></Field>}
      <Field label="Full name" required><Input value={String(b.full_name ?? '')} onChange={(e) => set('full_name', e.target.value)} /></Field>
      <Field label={t('phone')}><Input type="tel" value={String(b.phone ?? '')} onChange={(e) => set('phone', e.target.value || null)} /></Field>
      <Field label={t('role')}><Select value={String(b.role)} onChange={(e) => set('role', e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{t(r)}</option>)}</Select></Field>
      <Field label={t('language')}><Select value={String(b.locale ?? 'en')} onChange={(e) => set('locale', e.target.value)}><option value="en">English</option><option value="sw">Kiswahili</option></Select></Field>
      {row && row.status !== 'invited' && <Field label={t('status')}><Select value={String(b.status)} onChange={(e) => set('status', e.target.value)}><option value="active">{t('active')}</option><option value="disabled">Disabled</option></Select></Field>}
      <div className="sm:col-span-2"><Field label="Restrict to vehicle groups" hint="Leave empty to give access to the whole fleet"><MultiRefSelect path="/vehicle-groups" label={(g) => String(g.name)} value={groups} onChange={setGroups} /></Field></div>
      <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={onDone}>{t('cancel')}</Button><Button loading={busy} disabled={!b.full_name || (!row && !b.email)} onClick={() => void save()}>{row ? t('save') : t('invite_user')}</Button></div>
    </div>
  );
}

function Audit(): ReactNode {
  const { t } = useI18n();
  const [action, setAction] = useState('');
  const list = usePaged('/audit-logs', { action: action || undefined });
  return (
    <Card pad={false} title={t('audit_log')} actions={
      <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-48" aria-label="Action">
        <option value="">{t('all')}</option>
        {['auth.*', 'user.*', 'vehicle.*', 'driver.*', 'device.*', 'job.*', 'payment.*', 'tenant.*', 'subscription.*'].map((a) => <option key={a} value={a}>{a}</option>)}
      </Select>
    }>
      <Table rows={list.rows} loading={list.isPending} columns={[
        { key: 'created_at', render: (r) => fmtDateTime(r.created_at) }, { key: 'actor_name', label: 'Who', render: (r) => String(r.actor_name ?? r.actor_type) },
        { key: 'action', render: (r) => <span className="font-mono text-xs">{String(r.action)}</span> }, { key: 'entity_type', label: 'Item', render: (r) => `${String(r.entity_type ?? '')}` },
        { key: 'changes', label: 'Details', render: (r) => <span className="line-clamp-1 max-w-sm font-mono text-[11px] text-ink/60">{r.changes ? JSON.stringify(r.changes) : r.metadata ? JSON.stringify(r.metadata) : ''}</span> },
        { key: 'ip', label: 'IP', render: (r) => <span className="font-mono text-xs">{String(r.ip ?? '')}</span> },
      ]} />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </Card>
  );
}
