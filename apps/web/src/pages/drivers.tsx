import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EntityForm } from '../components/forms';
import { CrudPage, Table } from '../components/table';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Stat, StatusBadge, Tabs, cx, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtNum, isoDay } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { TripList } from './vehicles';

const DRIVER_FORM = { order: ['full_name', 'employee_number', 'phone', 'email', 'national_id', 'hire_date', 'status'], hide: ['photo_file_id'] };

export const scoreTone = (s: unknown): string => (Number(s) >= 85 ? 'green' : Number(s) >= 70 ? 'amber' : 'red');

export function DriversPage(): ReactNode {
  const { t } = useI18n();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <CrudPage
        path="/drivers"
        title={t('drivers')}
        noun={t('driver').toLowerCase()}
        write="drivers:write"
        params={{ status: status || undefined }}
        formOpts={DRIVER_FORM}
        onRowClick={(r) => nav(`/drivers/${String(r.id)}`)}
        filters={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label={t('status')}>
            <option value="">{t('all')}</option>
            {['active', 'suspended', 'inactive', 'terminated'].map((s) => <option key={s} value={s}>{t(s)}</option>)}
          </Select>
        }
        columns={[
          { key: 'full_name', render: (r) => <span className="font-medium">{String(r.full_name)}</span> },
          { key: 'employee_number' },
          { key: 'phone' },
          { key: 'vehicle', label: t('vehicle'), render: (r) => String((r.vehicle as Row | null)?.plate_number ?? '—') },
          { key: 'licence', label: 'Licence', render: (r) => { const l = r.licence as Row | null; return l ? <span className="inline-flex items-center gap-1.5">{fmtDate(l.expires_on)} {l.expiry_status !== 'valid' && <StatusBadge value={l.expiry_status} />}</span> : <Badge tone="red">Missing</Badge>; } },
          { key: 'score_30d', label: t('driver_score'), render: (r) => (r.score_30d === null || r.score_30d === undefined ? '—' : <Badge tone={scoreTone(r.score_30d)}>{fmtNum(r.score_30d, 1)}</Badge>) },
          { key: 'app_access', label: 'App', render: (r) => ((r.app_access as Row | null) ? <StatusBadge value={(r.app_access as Row).status} /> : '—') },
          { key: 'status', type: 'status' },
        ]}
      />
    </div>
  );
}

export function DriverDetail(): ReactNode {
  const { id } = useParams();
  const { t, f } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  const [tab, setTab] = useState<'overview' | 'score' | 'trips' | 'incidents'>('overview');
  const [edit, setEdit] = useState(false);
  const [lic, setLic] = useState<Row | null | undefined>(undefined);
  const [tag, setTag] = useState(false);
  const d = useQuery({ queryKey: ['/drivers', id], queryFn: () => api.get<Row>(`/drivers/${id}`) });
  if (!d.data) return <div className="flex justify-center py-24">{d.error ? <p className="text-sm text-red-600">{errorText(d.error)}</p> : <Spinner />}</div>;
  const r = d.data;
  const write = can('drivers:write');
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['/drivers'] });
  const run = async (fn: () => Promise<unknown>, ok = t('saved')): Promise<void> => {
    try {
      const res = (await fn()) as Row | undefined;
      toast(res && typeof res === 'object' && 'dev_invite_url' in res ? `${ok} · ${String(res.dev_invite_url)}` : ok);
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const app = r.app_access as Row | null;
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <Link to="/drivers" className="mb-3 inline-flex items-center gap-1 text-sm text-ink/60 hover:text-ink"><ArrowLeft className="size-4" />{t('drivers')}</Link>
      <PageHeader
        title={<span className="flex items-center gap-3">{String(r.full_name)} <StatusBadge value={r.status} /></span>}
        subtitle={[r.employee_number, r.phone, (r.vehicle as Row | null)?.plate_number].filter(Boolean).join(' · ')}
        actions={write && <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>{t('edit')}</Button>}
      />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'overview', label: t('details') }, { value: 'score', label: t('driver_score') }, { value: 'trips', label: t('trips') }, { value: 'incidents', label: 'Incidents' },
      ]} />
      {tab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title={t('details')}>
            <dl className="space-y-2.5 text-sm">
              {[['national_id', r.national_id], ['email', r.email], ['hire_date', fmtDate(r.hire_date)], ['address', r.address],
                ['Emergency contact', [(r.emergency_contact as Row | null)?.name, (r.emergency_contact as Row | null)?.phone].filter(Boolean).join(' · ')]].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-3"><dt className="text-ink/55">{f(String(k))}</dt><dd className="text-right font-medium">{String(v || '—')}</dd></div>
              ))}
            </dl>
          </Card>
          <Card title="Licences & permits" actions={write && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setLic(null)}>{t('add')}</Button>} pad={false}>
            <ul className="divide-y divide-black/[0.05]">
              {((r.licences as Row[]) ?? []).map((l) => (
                <li key={String(l.id)} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <div>
                    <p className="font-medium">{t(String(l.licence_type))} · {String(l.licence_number)}</p>
                    <p className="text-xs text-ink/55">{((l.classes as string[]) ?? []).join(', ')} · expires {fmtDate(l.expires_on)}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <StatusBadge value={l.expiry_status} />
                    {write && <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} aria-label={t('edit')} onClick={() => setLic(l)} />}
                    {write && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-red-600" />} aria-label={t('delete')} onClick={async () => { if (await confirm('Delete this licence?', { danger: true })) void run(() => api.del(`/driver-licences/${String(l.id)}`), t('deleted')); }} />}
                  </div>
                </li>
              ))}
              {!((r.licences as Row[]) ?? []).length && <li><Empty title="No licence on file" /></li>}
            </ul>
          </Card>
          <Card title="Driver app & ID tags">
            <div className="space-y-4 text-sm">
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink/45"><Smartphone className="size-3.5" />Driver app login</p>
                {app ? (
                  <div className="flex items-center justify-between gap-2">
                    <span>{String(app.email)} <StatusBadge value={app.status} /></span>
                    {write && <Button size="sm" variant="ghost" onClick={async () => { if (await confirm('Revoke this driver\'s app login?', { danger: true })) void run(() => api.del(`/drivers/${String(r.id)}/app-access`)); }}>Revoke</Button>}
                  </div>
                ) : write ? <AppAccess driver={r} onDone={(x) => void run(async () => x, 'Invitation sent')} /> : '—'}
              </div>
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink/45"><KeyRound className="size-3.5" />RFID / iButton</p>
                <ul className="space-y-1">
                  {((r.identifiers as Row[]) ?? []).map((i) => (
                    <li key={String(i.id)} className="flex items-center justify-between">
                      <span className="font-mono">{String(i.value)} <span className="font-sans text-xs text-ink/50">{String(i.kind)}</span></span>
                      {write && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4 text-red-600" />} aria-label={t('delete')} onClick={() => void run(() => api.del(`/driver-identifiers/${String(i.id)}`), t('deleted'))} />}
                    </li>
                  ))}
                </ul>
                {write && <Button size="sm" variant="secondary" className="mt-2" icon={<Plus className="size-4" />} onClick={() => setTag(true)}>{t('add')}</Button>}
              </div>
            </div>
          </Card>
        </div>
      )}
      {tab === 'score' && <Scorecard driverId={String(r.id)} />}
      {tab === 'trips' && <TripList params={{ driver_id: String(r.id) }} />}
      {tab === 'incidents' && <Incidents driverId={String(r.id)} />}
      <Modal open={edit} onClose={() => setEdit(false)} title={`${t('edit')} ${String(r.full_name)}`} size="lg">
        {edit && <EntityForm path="/drivers" row={r} opts={DRIVER_FORM} onCancel={() => setEdit(false)} onSaved={() => { setEdit(false); refresh(); }} />}
      </Modal>
      <Modal open={lic !== undefined} onClose={() => setLic(undefined)} title="Licence">
        {lic !== undefined && (lic ? (
          <EntityForm path="/driver-licences" row={lic} opts={{ hide: ['file_id'] }} onCancel={() => setLic(undefined)} onSaved={() => { setLic(undefined); refresh(); }} />
        ) : (
          <EntityForm path={`/drivers/${String(r.id)}/licences`} schemaPath="/drivers/{id}/licences" opts={{ hide: ['file_id'] }} onCancel={() => setLic(undefined)} onSaved={() => { setLic(undefined); refresh(); }} />
        ))}
      </Modal>
      <Modal open={tag} onClose={() => setTag(false)} title="ID tag">
        {tag && <EntityForm path={`/drivers/${String(r.id)}/identifiers`} schemaPath="/drivers/{id}/identifiers" onCancel={() => setTag(false)} onSaved={() => { setTag(false); refresh(); }} />}
      </Modal>
    </div>
  );
}

function AppAccess({ driver, onDone }: { driver: Row; onDone: (r: unknown) => void }): ReactNode {
  const [email, setEmail] = useState(String(driver.email ?? ''));
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  return (
    <form className="flex gap-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try { onDone(await api.post(`/drivers/${String(driver.id)}/app-access`, email ? { email } : {})); } catch (x) { toast(errorText(x), 'error'); } finally { setBusy(false); }
    }}>
      <Input type="email" placeholder="driver@email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Button type="submit" size="sm" loading={busy}>Invite</Button>
    </form>
  );
}

function Scorecard({ driverId }: { driverId: string }): ReactNode {
  const { t } = useI18n();
  const [from, setFrom] = useState(isoDay(new Date(), -29));
  const [to, setTo] = useState(isoDay());
  const q = useQuery({ queryKey: ['scorecard', driverId, from, to], queryFn: () => api.get<Row & { daily: Row[]; events_by_type: Row[]; worst_events: Row[] }>(`/drivers/${driverId}/scorecard`, { from, to }) });
  const s = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Field label={t('from')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('to')}><Input type="date" value={to} max={isoDay()} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {!s ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Stat label={t('driver_score')} value={<span className={cx(Number(s.score) >= 85 ? 'text-emerald-700' : Number(s.score) >= 70 ? 'text-amber-700' : 'text-red-700')}>{fmtNum(s.score, 1)}</span>} sub={`Fleet ${fmtNum(s.fleet_score, 1)} · rank #${String(s.rank ?? '—')}`} />
            <Stat label={t('distance')} value={`${fmtNum(s.distance_km)} km`} sub={`${fmtNum(s.driving_hours, 1)} h driving`} />
            <Stat label="Harsh events" value={fmtNum(Number(s.harsh_brake) + Number(s.harsh_accel) + Number(s.harsh_corner))} sub={`${fmtNum(s.harsh_per_100km, 2)} / 100 km`} />
            <Stat label="Overspeed" value={fmtNum(s.overspeed_count)} sub={`${fmtNum(s.overspeed_minutes)} min over limit`} />
            <Stat label="Excess idling" value={`${fmtNum(s.idle_minutes)} min`} />
            <Stat label="Night driving" value={`${fmtNum(s.night_hours, 1)} h`} />
          </div>
          <Card title="Daily score">
            <div className="h-56">
              <ResponsiveContainer>
                <BarChart data={s.daily} margin={{ left: -20, right: 4, top: 8 }}>
                  <CartesianGrid stroke="#0001" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis domain={[0, 100]} fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar dataKey="score" fill="#0f6b4f" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Worst events" pad={false}>
            <Table rows={s.worst_events} columns={[
              { key: 'occurred_at', type: 'datetime' }, { key: 'event_type', render: (r) => t(String(r.event_type)) }, { key: 'severity', type: 'status' },
              { key: 'plate_number', label: t('vehicle') }, { key: 'speed_kph', label: t('speed'), render: (r) => (r.speed_kph ? `${String(r.speed_kph)} / ${String(r.speed_limit_kph ?? '—')}` : '—') },
              { key: 'reviewed_at', label: 'Coached', render: (r) => (r.reviewed_at ? <Badge tone="green">{fmtDateTime(r.reviewed_at)}</Badge> : <ReviewButton id={String(r.id)} onDone={() => void q.refetch()} />) },
            ]} />
          </Card>
        </>
      )}
    </div>
  );
}

function ReviewButton({ id, onDone }: { id: string; onDone: () => void }): ReactNode {
  const { can } = useAuth();
  const { toast } = useToast();
  if (!can('events:review')) return '—';
  return <Button size="sm" variant="secondary" onClick={() => void api.post(`/driving-events/${id}/review`, { note: 'Discussed with driver' }).then(onDone, (e: unknown) => toast(errorText(e), 'error'))}>Mark coached</Button>;
}

function Incidents({ driverId }: { driverId: string }): ReactNode {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['incidents', driverId], queryFn: () => api.get<{ data: Row[] }>(`/drivers/${driverId}/incidents`) });
  return (
    <Card pad={false}>
      <Table rows={q.data?.data ?? []} loading={q.isPending} columns={[
        { key: 'at', label: 'Time', type: 'datetime' }, { key: 'kind', render: (r) => t(String(r.kind)) }, { key: 'type', render: (r) => t(String(r.type)) },
        { key: 'severity', type: 'status' }, { key: 'plate_number', label: t('vehicle') }, { key: 'note' },
      ]} />
    </Card>
  );
}
