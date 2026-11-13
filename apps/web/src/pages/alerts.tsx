import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { MultiRefSelect, useOptions } from '../components/forms';
import { Pager, Table, usePaged } from '../components/table';
import { Badge, Button, Card, Checkbox, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRealtime } from '../lib/realtime';

export default function AlertsPage(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const [tab, setTab] = useState<'alerts' | 'rules' | 'geofence' | 'events'>('alerts');
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('alerts')} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'alerts', label: t('alerts') },
        { value: 'rules' as const, label: t('alert_rules') },
        { value: 'events', label: 'Driving events' },
        { value: 'geofence', label: 'Geofence activity' },
      ]} />
      {tab === 'alerts' && <AlertList />}
      {tab === 'rules' && <Rules />}
      {tab === 'events' && <EventList path="/driving-events" />}
      {tab === 'geofence' && <EventList path="/geofence-events" />}
    </div>
  );
}

function AlertList(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState('');
  const list = usePaged('/alerts', { status: status || undefined, severity: severity || undefined });
  useRealtime('alert', () => void list.refetch());
  const act = async (path: string, body: object = {}): Promise<void> => {
    try {
      await api.post(path, body);
      await qc.invalidateQueries({ queryKey: ['/alerts'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const ack = can('alerts:acknowledge');
  return (
    <Card pad={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.06] px-4 py-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t('status')}>
          <option value="">{t('all')}</option>
          {['open', 'acknowledged', 'resolved'].map((s) => <option key={s} value={s}>{t(s)}</option>)}
        </Select>
        <Select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-40" aria-label="Severity">
          <option value="">{t('all')}</option>
          {['critical', 'warning', 'info'].map((s) => <option key={s} value={s}>{t(s)}</option>)}
        </Select>
        <div className="flex-1" />
        {ack && status === 'open' && list.total > 0 && <Button variant="secondary" icon={<CheckCheck className="size-4" />} onClick={() => void act('/alerts/acknowledge-all')}>Acknowledge all</Button>}
      </div>
      <Table
        rows={list.rows}
        loading={list.isPending}
        columns={[
          { key: 'occurred_at', type: 'datetime' },
          { key: 'severity', type: 'status' },
          { key: 'title', render: (r) => <div><p className="font-medium">{String(r.title)}</p><p className="text-xs text-ink/55">{String(r.message ?? '')}</p></div> },
          { key: 'plate_number', label: t('vehicle') },
          { key: 'driver_name', label: t('driver') },
          { key: 'status', type: 'status' },
        ]}
        rowActions={ack ? (r) => (
          <div className="flex gap-1">
            {r.status === 'open' && <Button size="sm" variant="secondary" icon={<Check className="size-4" />} onClick={() => void act(`/alerts/${String(r.id)}/acknowledge`)}>{t('acknowledge')}</Button>}
            {r.status !== 'resolved' && <Button size="sm" variant="ghost" onClick={() => void act(`/alerts/${String(r.id)}/resolve`)}>{t('resolve')}</Button>}
          </div>
        ) : undefined}
      />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

function EventList({ path }: { path: string }): ReactNode {
  const { t } = useI18n();
  const list = usePaged(path, {});
  return (
    <Card pad={false}>
      <Table rows={list.rows} loading={list.isPending} columns={[
        { key: 'occurred_at', type: 'datetime' },
        { key: 'event_type', render: (r) => t(String(r.event_type)) },
        ...(path === '/geofence-events' ? [{ key: 'geofence_name', label: 'Geofence' }, { key: 'dwell_s', label: 'Time inside', render: (r: Row) => (r.dwell_s ? `${Math.round(Number(r.dwell_s) / 60)} min` : '—') }] : [{ key: 'severity', type: 'status' as const }, { key: 'speed_kph', label: t('speed'), render: (r: Row) => (r.speed_kph ? `${String(r.speed_kph)}${r.speed_limit_kph ? ` / ${String(r.speed_limit_kph)}` : ''} km/h` : '—') }]),
        { key: 'plate_number', label: t('vehicle') },
        { key: 'driver_name', label: t('driver') },
      ]} />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </Card>
  );
}

// ---------------------------------------------------------------- rules
const RULE_TYPES = ['overspeed', 'harsh_event', 'geofence_enter', 'geofence_exit', 'geofence_dwell', 'ignition_on', 'ignition_off', 'idle', 'device_offline', 'low_battery', 'power_cut', 'sos', 'tamper', 'towing', 'crash', 'fuel_drain', 'refuel', 'fuel_level_low', 'service_due', 'document_expiry', 'licence_expiry', 'dtc', 'route_deviation', 'job_late', 'unauthorized_driver', 'after_hours_use', 'inspection_failed', 'defect_critical'];

/** Conditions each rule type understands (matches the alert engine). */
const CONDITIONS: Record<string, { key: string; label: string; type: 'number' | 'time' | 'days' | 'harsh'; def?: unknown }[]> = {
  overspeed: [{ key: 'speed_kph', label: 'Alert at or above (km/h)', type: 'number', def: 80 }],
  harsh_event: [{ key: 'types', label: 'Event types', type: 'harsh', def: ['harsh_brake', 'harsh_accel', 'harsh_corner'] }],
  idle: [{ key: 'minutes', label: 'Idling longer than (minutes)', type: 'number', def: 10 }],
  fuel_drain: [{ key: 'min_litres', label: 'Drop of at least (litres)', type: 'number', def: 15 }],
  refuel: [{ key: 'min_litres', label: 'Fill of at least (litres)', type: 'number', def: 20 }],
  fuel_level_low: [{ key: 'below_pct', label: 'Below (%)', type: 'number', def: 15 }],
  route_deviation: [{ key: 'meters', label: 'Off route by at least (m)', type: 'number', def: 500 }],
  after_hours_use: [{ key: 'start', label: 'After-hours from', type: 'time', def: '20:00' }, { key: 'end', label: 'until', type: 'time', def: '05:00' }],
  document_expiry: [{ key: 'days_before', label: 'Days before expiry', type: 'days', def: [30, 7, 1] }],
  licence_expiry: [{ key: 'days_before', label: 'Days before expiry', type: 'days', def: [30, 7, 1] }],
};

function Rules(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  const list = usePaged('/alert-rules', {}, { pageSize: 100 });
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const write = can('alert_rules:manage');
  return (
    <>
      <Card pad={false} title={t('alert_rules')} actions={write && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEdit(null)}>{t('add')}</Button>}>
        <Table rows={list.rows} loading={list.isPending} onRowClick={write ? setEdit : undefined} columns={[
          { key: 'name', render: (r) => <span className="font-medium">{String(r.name)}</span> },
          { key: 'rule_type', render: (r) => t(String(r.rule_type)) },
          { key: 'severity', type: 'status' },
          { key: 'channels', render: (r) => <div className="flex flex-wrap gap-1">{((r.channels as string[]) ?? []).map((c) => <Badge key={c}>{c}</Badge>)}</div> },
          { key: 'applies_to_all', label: 'Applies to', render: (r) => (r.applies_to_all ? t('all_vehicles') : `${((r.targets as Row[]) ?? []).length} selected`) },
          { key: 'is_active', label: t('status'), render: (r) => <StatusBadge value={r.is_active ? 'active' : 'inactive'} /> },
        ]} rowActions={write ? (r) => (
          <>
            <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} aria-label={t('edit')} onClick={() => setEdit(r)} />
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-red-600" />} aria-label={t('delete')} onClick={async () => {
              if (!(await confirm(`Delete rule "${String(r.name)}"?`, { danger: true }))) return;
              await api.del(`/alert-rules/${String(r.id)}`).then(() => qc.invalidateQueries({ queryKey: ['/alert-rules'] }), (e: unknown) => toast(errorText(e), 'error'));
            }} />
          </>
        ) : undefined} />
      </Card>
      <Modal open={edit !== undefined} onClose={() => setEdit(undefined)} title={edit ? `${t('edit')} ${String(edit.name)}` : `${t('new')} ${t('alert_rules').toLowerCase()}`} size="lg">
        {edit !== undefined && <RuleForm row={edit} onDone={() => { setEdit(undefined); void qc.invalidateQueries({ queryKey: ['/alert-rules'] }); }} />}
      </Modal>
    </>
  );
}

function RuleForm({ row, onDone }: { row: Row | null; onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState(String(row?.name ?? ''));
  const [description, setDescription] = useState(String(row?.description ?? ''));
  const [type, setType] = useState(String(row?.rule_type ?? 'overspeed'));
  const [conditions, setConditions] = useState<Record<string, unknown>>((row?.conditions as Record<string, unknown>) ?? { speed_kph: 80 });
  const [severity, setSeverity] = useState(String(row?.severity ?? 'warning'));
  const [cooldown, setCooldown] = useState(Number(row?.cooldown_minutes ?? 15));
  const [channels, setChannels] = useState<string[]>((row?.channels as string[]) ?? ['in_app']);
  const [all, setAll] = useState(row ? Boolean(row.applies_to_all) : true);
  const targets = (row?.targets as Row[] | undefined) ?? [];
  const [vehicles, setVehicles] = useState<string[]>(targets.filter((x) => x.vehicle_id).map((x) => String(x.vehicle_id)));
  const [groups, setGroups] = useState<string[]>(targets.filter((x) => x.group_id).map((x) => String(x.group_id)));
  const [geofences, setGeofences] = useState<string[]>(targets.filter((x) => x.geofence_id).map((x) => String(x.geofence_id)));
  const recips = (row?.recipients as Row[] | undefined) ?? [{ role: 'company_admin' }, { role: 'fleet_manager' }];
  const [roles, setRoles] = useState<string[]>(recips.filter((r) => r.role).map((r) => String(r.role)));
  const [users, setUsers] = useState<string[]>(recips.filter((r) => r.user_id).map((r) => String(r.user_id)));
  const [extra, setExtra] = useState(recips.filter((r) => r.phone || r.email).map((r) => String(r.phone ?? r.email)).join(', '));
  const sched = row?.schedule as { days: number[]; start: string; end: string } | null | undefined;
  const [useSched, setUseSched] = useState(Boolean(sched));
  const [days, setDays] = useState<number[]>(sched?.days ?? [1, 2, 3, 4, 5]);
  const [sStart, setSStart] = useState(sched?.start ?? '06:00');
  const [sEnd, setSEnd] = useState(sched?.end ?? '19:00');
  const [active, setActive] = useState(row ? Boolean(row.is_active) : true);
  const [busy, setBusy] = useState(false);
  const usersOpt = useOptions('/users');
  const geoRule = type.startsWith('geofence_');

  const changeType = (x: string): void => {
    setType(x);
    setConditions(Object.fromEntries((CONDITIONS[x] ?? []).map((c) => [c.key, c.def])));
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const body = {
        name, description: description || null, rule_type: type, conditions, severity, cooldown_minutes: cooldown, channels, is_active: active,
        applies_to_all: all && !geoRule,
        targets: [...(all && !geoRule ? [] : [...vehicles.map((v) => ({ vehicle_id: v })), ...groups.map((g) => ({ group_id: g }))]), ...geofences.map((g) => ({ geofence_id: g }))],
        recipients: [
          ...roles.map((r) => ({ role: r })),
          ...users.map((u) => ({ user_id: u })),
          ...extra.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.includes('@') ? { email: x } : { phone: x })),
        ],
        schedule: useSched ? { days, start: sStart, end: sEnd } : null,
      };
      if (row) await api.patch(`/alert-rules/${String(row.id)}`, body);
      else await api.post('/alert-rules', body);
      toast(t('saved'));
      onDone();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('name')} required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Trigger">
          <Select value={type} onChange={(e) => changeType(e.target.value)}>{RULE_TYPES.map((x) => <option key={x} value={x}>{t(x)}</option>)}</Select>
        </Field>
        {(CONDITIONS[type] ?? []).map((c) => (
          <Field key={c.key} label={c.label}>
            {c.type === 'number' && <Input type="number" value={String(conditions[c.key] ?? '')} onChange={(e) => setConditions({ ...conditions, [c.key]: e.target.value === '' ? undefined : Number(e.target.value) })} />}
            {c.type === 'time' && <Input type="time" value={String(conditions[c.key] ?? '')} onChange={(e) => setConditions({ ...conditions, [c.key]: e.target.value })} />}
            {c.type === 'days' && <Input value={((conditions[c.key] as number[]) ?? []).join(', ')} onChange={(e) => setConditions({ ...conditions, [c.key]: e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0) })} />}
            {c.type === 'harsh' && (
              <div className="flex flex-wrap gap-3 pt-1">
                {['harsh_brake', 'harsh_accel', 'harsh_corner'].map((h) => {
                  const arr = (conditions.types as string[]) ?? [];
                  return <Checkbox key={h} label={t(h)} checked={arr.includes(h)} onChange={(e) => setConditions({ types: e.target.checked ? [...arr, h] : arr.filter((x) => x !== h) })} />;
                })}
              </div>
            )}
          </Field>
        ))}
        <Field label="Severity"><Select value={severity} onChange={(e) => setSeverity(e.target.value)}>{['info', 'warning', 'critical'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</Select></Field>
        <Field label="Repeat at most every (minutes)"><Input type="number" min={0} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} /></Field>
        <div className="sm:col-span-2"><Field label={t('description')}><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
      </div>
      <Field label="Notify via">
        <div className="flex flex-wrap gap-4 pt-1">
          {['in_app', 'push', 'sms', 'email', 'webhook'].map((c) => <Checkbox key={c} label={c === 'in_app' ? 'In-app' : c.toUpperCase().replace('PUSH', 'Push').replace('WEBHOOK', 'Webhook').replace('EMAIL', 'Email')} checked={channels.includes(c)} onChange={(e) => setChannels(e.target.checked ? [...channels, c] : channels.filter((x) => x !== c))} />)}
        </div>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who gets it (roles)">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg p-2 ring-1 ring-black/10">
            {['company_admin', 'fleet_manager', 'dispatcher', 'mechanic', 'accountant', 'driver'].map((r) => <Checkbox key={r} label={t(r)} checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />)}
          </div>
        </Field>
        <Field label="Specific people">
          <MultiRefSelect path="/users" label={(u) => String(u.full_name)} value={users} onChange={setUsers} />
          {usersOpt.loading && null}
        </Field>
        <div className="sm:col-span-2"><Field label="Extra phone numbers / emails" hint="Comma separated, e.g. +254712345678, ops@company.co.ke"><Input value={extra} onChange={(e) => setExtra(e.target.value)} /></Field></div>
      </div>
      {geoRule ? (
        <Field label="Geofences" hint="Leave empty for every geofence"><MultiRefSelect path="/geofences" label={(g) => String(g.name)} value={geofences} onChange={setGeofences} /></Field>
      ) : (
        <div className="space-y-2">
          <Checkbox label={t('all_vehicles')} checked={all} onChange={(e) => setAll(e.target.checked)} />
          {!all && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('vehicles')}><MultiRefSelect path="/vehicles" label={(v) => String(v.plate_number)} value={vehicles} onChange={setVehicles} /></Field>
              <Field label={t('vehicle_groups')}><MultiRefSelect path="/vehicle-groups" label={(g) => String(g.name)} value={groups} onChange={setGroups} /></Field>
            </div>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Checkbox label="Only during certain hours" checked={useSched} onChange={(e) => setUseSched(e.target.checked)} />
        {useSched && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex gap-1">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <button key={i} type="button" onClick={() => setDays(days.includes(i + 1) ? days.filter((x) => x !== i + 1) : [...days, i + 1].sort())}
                  className={`size-8 rounded-full text-xs font-semibold ${days.includes(i + 1) ? 'bg-brand-600 text-white' : 'bg-black/5'}`} aria-pressed={days.includes(i + 1)}>{d}</button>
              ))}
            </div>
            <Input type="time" value={sStart} onChange={(e) => setSStart(e.target.value)} className="w-32" />
            <Input type="time" value={sEnd} onChange={(e) => setSEnd(e.target.value)} className="w-32" />
          </div>
        )}
      </div>
      <Checkbox label={t('active')} checked={active} onChange={(e) => setActive(e.target.checked)} />
      <div className="flex justify-end gap-2 border-t border-black/[0.06] pt-4">
        <Button variant="secondary" onClick={onDone}>{t('cancel')}</Button>
        <Button loading={busy} disabled={!name || !channels.length} onClick={() => void save()}>{t('save')}</Button>
      </div>
    </div>
  );
}
