import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText, Play, Send } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { MultiRefSelect, useOptions } from '../components/forms';
import { Pager, Table, usePaged } from '../components/table';
import { Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Stat, StatusBadge, Tabs, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtDuration, fmtMoney, fmtNum, isoDay } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface ReportType { type: string; title: { en: string; sw: string }; columns: { key: string; label: { en: string; sw: string }; type: string }[] }
interface Report { title: string; columns: ReportType['columns']; rows: Row[]; summary: { label: string; value: number | string; type: string }[]; period: { from: string; to: string } }

const PRESETS: Record<string, () => [string, string]> = {
  yesterday: () => [isoDay(new Date(), -1), isoDay(new Date(), -1)],
  last_7_days: () => [isoDay(new Date(), -6), isoDay()],
  last_30_days: () => [isoDay(new Date(), -29), isoDay()],
  this_month: () => [`${isoDay().slice(0, 8)}01`, isoDay()],
};

function cellValue(v: unknown, type: string, currency?: string): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-ink/30">—</span>;
  switch (type) {
    case 'datetime': return fmtDateTime(v);
    case 'date': return fmtDate(v);
    case 'duration': return fmtDuration(v);
    case 'money': return fmtMoney(v, currency);
    case 'decimal': return fmtNum(v, 2);
    case 'number': return fmtNum(v);
    case 'percent': return `${fmtNum(v, 1)}%`;
    case 'bool': return v ? '✓' : '—';
    default: return String(v);
  }
}

export default function ReportsPage(): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const [tab, setTab] = useState<'run' | 'scheduled' | 'history'>('run');
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('reports')} subtitle="Run any report on screen, download it as PDF, Excel or CSV, or have it emailed on a schedule." />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'run', label: t('run_report') }, ...(can('reports:read') ? [{ value: 'scheduled' as const, label: t('scheduled_reports') }, { value: 'history' as const, label: t('history') }] : [])]} />
      {tab === 'run' && <Runner />}
      {tab === 'scheduled' && <Schedules />}
      {tab === 'history' && <History />}
    </div>
  );
}

function Runner(): ReactNode {
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const types = useQuery({ queryKey: ['report-types'], queryFn: () => api.get<{ data: ReportType[] }>('/reports/types') });
  const groups = useOptions('/vehicle-groups');
  const [type, setType] = useState('executive_summary');
  const [[from, to], setPeriod] = useState<[string, string]>(PRESETS.last_7_days!());
  const [vehicles, setVehicles] = useState<string[]>([]);
  const [group, setGroup] = useState('');
  const [params, setParams] = useState<Record<string, string> | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const q = { from, to, vehicle_ids: vehicles.length ? vehicles.join(',') : undefined, group_id: group || undefined, locale: lang };
  const report = useQuery({ queryKey: ['report', params], queryFn: () => api.get<Report>(`/reports/${params!.type}`, { ...params, type: undefined }), enabled: Boolean(params) });
  const download = async (format: string): Promise<void> => {
    setDownloading(format);
    try { await api.download(`/reports/${type}`, { ...q, format }); } catch (e) { toast(errorText(e), 'error'); } finally { setDownloading(null); }
  };
  const r = report.data;
  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
          <Field label={t('report_type')}>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {(types.data?.data ?? []).map((x) => <option key={x.type} value={x.type}>{x.title[lang]}</option>)}
            </Select>
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('from')}><Input type="date" value={from} max={to} onChange={(e) => setPeriod([e.target.value, to])} /></Field>
            <Field label={t('to')}><Input type="date" value={to} min={from} max={isoDay()} onChange={(e) => setPeriod([from, e.target.value])} /></Field>
            <div className="flex flex-wrap gap-1 pb-1">
              {Object.entries(PRESETS).map(([k, fn]) => <Button key={k} size="sm" variant="ghost" onClick={() => setPeriod(fn())}>{t(k)}</Button>)}
            </div>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label={t('vehicles')} hint="Leave empty for all vehicles"><MultiRefSelect path="/vehicles" label={(v) => String(v.plate_number)} value={vehicles} onChange={setVehicles} /></Field>
          <Field label={t('vehicle_groups')}>
            <Select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">{t('all')}</option>{groups.options.map((g) => <option key={String(g.id)} value={String(g.id)}>{String(g.name)}</option>)}</Select>
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-black/[0.06] pt-4">
          <Button icon={<Play className="size-4" />} loading={report.isFetching} onClick={() => setParams({ type, ...Object.fromEntries(Object.entries(q).filter(([, v]) => v)) as Record<string, string> })}>{t('run_report')}</Button>
          <Button variant="secondary" icon={<FileText className="size-4" />} loading={downloading === 'pdf'} onClick={() => void download('pdf')}>PDF</Button>
          <Button variant="secondary" icon={<FileSpreadsheet className="size-4" />} loading={downloading === 'xlsx'} onClick={() => void download('xlsx')}>Excel</Button>
          <Button variant="secondary" icon={<Download className="size-4" />} loading={downloading === 'csv'} onClick={() => void download('csv')}>CSV</Button>
        </div>
      </Card>
      {report.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errorText(report.error)}</p>}
      {report.isFetching && !r && <div className="flex justify-center py-16"><Spinner /></div>}
      {r && (
        <>
          {r.summary.length > 0 && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{r.summary.map((s) => <Stat key={s.label} label={s.label} value={cellValue(s.value, s.type)} />)}</div>}
          <Card title={`${r.title} · ${r.period.from} → ${r.period.to}`} pad={false}>
            {r.rows.length ? (
              <div className="max-h-[65vh] overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-black/[0.07] text-xs text-ink/55">{r.columns.map((c) => <th key={c.key} className="whitespace-nowrap px-3 py-2 font-medium">{c.label[lang]}</th>)}</tr>
                  </thead>
                  <tbody>
                    {r.rows.slice(0, 2000).map((row, i) => (
                      <tr key={i} className="border-b border-black/[0.04]">
                        {r.columns.map((c) => <td key={c.key} className={`whitespace-nowrap px-3 py-1.5 ${['number', 'decimal', 'money', 'percent', 'duration'].includes(c.type) ? 'text-right tabular' : ''}`}>{type === 'executive_summary' ? String(row[c.key] ?? '') : cellValue(row[c.key], c.type)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.rows.length > 2000 && <p className="p-3 text-xs text-ink/55">Showing 2,000 of {r.rows.length} rows - download Excel or CSV for everything.</p>}
              </div>
            ) : <Empty />}
          </Card>
        </>
      )}
    </div>
  );
}

function Schedules(): ReactNode {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  const types = useQuery({ queryKey: ['report-types'], queryFn: () => api.get<{ data: ReportType[] }>('/reports/types') });
  const list = usePaged('/report-schedules', {});
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const write = can('reports:schedule');
  const title = (k: unknown): string => types.data?.data.find((x) => x.type === k)?.title[lang] ?? String(k);
  return (
    <>
      <Card pad={false} title={t('scheduled_reports')} actions={write && <Button size="sm" onClick={() => setEdit(null)}>{t('add')}</Button>}>
        <Table rows={list.rows} loading={list.isPending} onRowClick={write ? setEdit : undefined} columns={[
          { key: 'name', render: (r) => <span className="font-medium">{String(r.name)}</span> }, { key: 'report_type', render: (r) => title(r.report_type) },
          { key: 'frequency', render: (r) => `${t(String(r.frequency))} ${String(r.send_time ?? '').slice(0, 5)}` }, { key: 'format', render: (r) => String(r.format).toUpperCase() },
          { key: 'recipients', render: (r) => ((r.recipients as string[]) ?? []).join(', ') }, { key: 'next_run_at', type: 'datetime' },
          { key: 'is_active', label: t('status'), render: (r) => <StatusBadge value={r.is_active ? 'active' : 'inactive'} /> },
        ]} rowActions={write ? (r) => (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" icon={<Send className="size-4" />} onClick={() => void api.post(`/report-schedules/${String(r.id)}/run-now`).then(() => toast('Queued - it will be emailed within a minute'), (e: unknown) => toast(errorText(e), 'error'))}>{t('send_now')}</Button>
            <Button size="sm" variant="ghost" onClick={async () => { if (await confirm(`Delete "${String(r.name)}"?`, { danger: true })) await api.del(`/report-schedules/${String(r.id)}`).then(() => qc.invalidateQueries({ queryKey: ['/report-schedules'] })); }}>{t('delete')}</Button>
          </div>
        ) : undefined} />
        <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
      </Card>
      <Modal open={edit !== undefined} onClose={() => setEdit(undefined)} title={t('scheduled_reports')}>
        {edit !== undefined && <ScheduleForm row={edit} types={types.data?.data ?? []} onDone={() => { setEdit(undefined); void qc.invalidateQueries({ queryKey: ['/report-schedules'] }); }} />}
      </Modal>
    </>
  );
}

function ScheduleForm({ row, types, onDone }: { row: Row | null; types: ReportType[]; onDone: () => void }): ReactNode {
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const [b, setB] = useState<Record<string, unknown>>(row ?? { report_type: 'executive_summary', frequency: 'weekly', day_of_week: 1, send_time: '07:00', format: 'pdf', locale: lang, recipients: [], is_active: true });
  const set = (k: string, v: unknown): void => setB({ ...b, [k]: v });
  const save = async (): Promise<void> => {
    const body = {
      name: b.name, report_type: b.report_type, frequency: b.frequency, send_time: String(b.send_time ?? '07:00').slice(0, 5), format: b.format, locale: b.locale,
      recipients: typeof b.recipients === 'string' ? (b.recipients as string).split(',').map((x) => x.trim()).filter(Boolean) : b.recipients,
      day_of_week: b.frequency === 'weekly' ? Number(b.day_of_week ?? 1) : null, day_of_month: b.frequency === 'monthly' ? Number(b.day_of_month ?? 1) : null, is_active: b.is_active,
    };
    try {
      if (row) await api.patch(`/report-schedules/${String(row.id)}`, body);
      else await api.post('/report-schedules', body);
      toast(t('saved'));
      onDone();
    } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('name')} required><Input value={String(b.name ?? '')} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label={t('report_type')}><Select value={String(b.report_type)} onChange={(e) => set('report_type', e.target.value)}>{types.map((x) => <option key={x.type} value={x.type}>{x.title[lang]}</option>)}</Select></Field>
      <Field label={t('frequency')}><Select value={String(b.frequency)} onChange={(e) => set('frequency', e.target.value)}>{['daily', 'weekly', 'monthly'].map((f) => <option key={f} value={f}>{t(f)}</option>)}</Select></Field>
      {b.frequency === 'weekly' && <Field label="Day"><Select value={String(b.day_of_week ?? 1)} onChange={(e) => set('day_of_week', Number(e.target.value))}>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</Select></Field>}
      {b.frequency === 'monthly' && <Field label="Day of month"><Input type="number" min={1} max={28} value={String(b.day_of_month ?? 1)} onChange={(e) => set('day_of_month', Number(e.target.value))} /></Field>}
      <Field label="Send at"><Input type="time" value={String(b.send_time ?? '07:00').slice(0, 5)} onChange={(e) => set('send_time', e.target.value)} /></Field>
      <Field label="Format"><Select value={String(b.format)} onChange={(e) => set('format', e.target.value)}><option value="pdf">PDF</option><option value="xlsx">Excel</option><option value="csv">CSV</option></Select></Field>
      <Field label={t('language')}><Select value={String(b.locale)} onChange={(e) => set('locale', e.target.value)}><option value="en">English</option><option value="sw">Kiswahili</option></Select></Field>
      <div className="sm:col-span-2"><Field label={t('recipients')} hint="Comma-separated email addresses"><Input value={Array.isArray(b.recipients) ? (b.recipients as string[]).join(', ') : String(b.recipients ?? '')} onChange={(e) => set('recipients', e.target.value)} /></Field></div>
      <Checkbox label={t('active')} checked={Boolean(b.is_active)} onChange={(e) => set('is_active', e.target.checked)} />
      <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="secondary" onClick={onDone}>{t('cancel')}</Button><Button disabled={!b.name} onClick={() => void save()}>{t('save')}</Button></div>
    </div>
  );
}

function History(): ReactNode {
  const { t } = useI18n();
  const list = usePaged('/report-runs', {});
  return (
    <Card pad={false}>
      <Table rows={list.rows} loading={list.isPending} columns={[
        { key: 'created_at', type: 'datetime' }, { key: 'report_type', render: (r) => t(String(r.report_type)) }, { key: 'schedule_name', label: 'Schedule' },
        { key: 'requested_by_name', label: 'By' }, { key: 'format', render: (r) => String(r.format).toUpperCase() }, { key: 'row_count', label: 'Rows', type: 'number' },
        { key: 'status', type: 'status' }, { key: 'error' },
      ]} />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </Card>
  );
}
