import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { DEFS, REPORT_TYPES, type ColType, type Column, type Locale, type Queryable, type ReportParams, type ReportType } from './definitions.js';

export { DEFS, REPORT_TYPES };
export type { ColType, Column, Locale, Queryable, ReportParams, ReportType };
export type ReportFormat = 'pdf' | 'xlsx' | 'csv';

export interface Report {
  type: ReportType;
  title: string;
  tenant: { name: string; currency: string; timezone: string };
  period: { from: string; to: string };
  columns: Column[];
  rows: Record<string, unknown>[];
  summary: { label: string; value: number | string; type: ColType }[];
  generated_at: string;
  locale: Locale;
}

const MAX_DAYS = 366;

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
function shiftDate(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

async function bounds(c: Queryable, tz: string, from: string, to: string): Promise<{ start: Date; stop: Date }> {
  const r = await c.query<{ start: Date; stop: Date }>(
    `SELECT ($2::date)::timestamp AT TIME ZONE $1 AS start, ($3::date + 1)::timestamp AT TIME ZONE $1 AS stop`,
    [tz, from, to],
  );
  return r.rows[0]!;
}

const numberish = (v: unknown): unknown => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);

async function kpis(c: Queryable, tenantId: string, p: ReportParams, tz: string): Promise<Record<string, number>> {
  const { start, stop } = await bounds(c, tz, p.from, p.to);
  const args = [tenantId, start, stop, p.vehicle_ids ?? null, p.group_id ?? null, p.driver_ids ?? null, p.from, p.to];
  const VEH = `($4::uuid[] IS NULL OR v.id = ANY($4)) AND ($5::uuid IS NULL OR v.group_id = $5)`;
  const r = await c.query<Record<string, string | null>>(
    `SELECT
       (SELECT count(*) FROM vehicles v WHERE v.tenant_id = $1 AND v.deleted_at IS NULL AND v.status NOT IN ('sold', 'written_off') AND ${VEH}) AS fleet,
       (SELECT count(DISTINCT s.vehicle_id) FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND s.distance_km > 0 AND ${VEH}) AS active,
       (SELECT coalesce(sum(s.distance_km), 0) FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND ${VEH}) AS km,
       (SELECT coalesce(sum(s.trips), 0) FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND ${VEH}) AS trips,
       (SELECT coalesce(sum(s.driving_s), 0) / 3600.0 FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND ${VEH}) AS driving_h,
       (SELECT coalesce(sum(s.idle_s), 0) / 3600.0 FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND ${VEH}) AS idle_h,
       (SELECT coalesce(avg(s.utilisation_pct), 0) FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND ${VEH}) AS util,
       (SELECT coalesce(sum(f.litres), 0) FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id WHERE f.tenant_id = $1 AND f.deleted_at IS NULL AND f.filled_at >= $2 AND f.filled_at < $3 AND ${VEH}) AS litres,
       (SELECT coalesce(sum(f.total_cost), 0) FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id WHERE f.tenant_id = $1 AND f.deleted_at IS NULL AND f.filled_at >= $2 AND f.filled_at < $3 AND ${VEH}) AS fuel_cost,
       (SELECT coalesce(sum(w.total_cost), 0) FROM work_orders w JOIN vehicles v ON v.id = w.vehicle_id WHERE w.tenant_id = $1 AND w.deleted_at IS NULL AND w.status = 'completed' AND w.completed_at >= $2 AND w.completed_at < $3 AND ${VEH}) AS maint_cost,
       (SELECT round(sum(s.score * greatest(s.distance_km, 1)) / nullif(sum(greatest(s.distance_km, 1)), 0), 1) FROM driver_daily_scores s WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND ($6::uuid[] IS NULL OR s.driver_id = ANY($6))) AS score,
       (SELECT count(*) FROM driving_events e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.tenant_id = $1 AND e.event_type LIKE 'harsh_%' AND e.occurred_at >= $2 AND e.occurred_at < $3 AND ${VEH}) AS harsh,
       (SELECT count(*) FROM driving_events e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.tenant_id = $1 AND e.event_type = 'overspeed' AND e.occurred_at >= $2 AND e.occurred_at < $3 AND ${VEH}) AS overspeed,
       (SELECT count(*) FROM alerts a WHERE a.tenant_id = $1 AND a.severity = 'critical' AND a.occurred_at >= $2 AND a.occurred_at < $3) AS critical_alerts,
       (SELECT count(*) FROM fuel_events fe JOIN vehicles v ON v.id = fe.vehicle_id WHERE fe.tenant_id = $1 AND fe.event_type = 'drain' AND fe.status <> 'dismissed' AND fe.started_at >= $2 AND fe.started_at < $3 AND ${VEH}) AS drains,
       (SELECT count(*) FROM jobs j WHERE j.tenant_id = $1 AND j.deleted_at IS NULL AND j.status = 'completed' AND j.actual_end >= $2 AND j.actual_end < $3) AS jobs_done,
       (SELECT round(100.0 * count(*) FILTER (WHERE s.time_window_end IS NULL OR s.arrived_at <= s.time_window_end) / nullif(count(*), 0), 1)
          FROM job_stops s WHERE s.tenant_id = $1 AND s.status = 'completed' AND s.arrived_at >= $2 AND s.arrived_at < $3) AS on_time`,
    args,
  );
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.rows[0] ?? {})) out[k] = v === null ? NaN : Number(v);
  return out;
}

/** Builds a report as structured data (rows + summary). The caller enforces access; queries always filter by tenant. */
export async function buildReport(c: Queryable, tenantId: string, type: ReportType, params: ReportParams, locale: Locale = 'en'): Promise<Report> {
  const def = DEFS[type];
  if (!def) throw new Error(`Unknown report type ${type}`);
  const n = days(params.from, params.to);
  if (!(n >= 1 && n <= MAX_DAYS)) throw Object.assign(new Error('The report period must be between 1 and 366 days'), { status: 422 });
  const t = (
    await c.query<{ name: string; currency: string; timezone: string }>('SELECT name, currency, timezone FROM tenants WHERE id = $1', [tenantId])
  ).rows[0];
  if (!t) throw new Error('Tenant not found');
  const base = { type, title: def.title[locale], tenant: t, period: { from: params.from, to: params.to }, generated_at: new Date().toISOString(), locale };

  if (type === 'executive_summary') {
    const cur = await kpis(c, tenantId, params, t.timezone);
    const prevParams = { ...params, from: shiftDate(params.from, -n), to: shiftDate(params.from, -1) };
    const prev = await kpis(c, tenantId, prevParams, t.timezone);
    const derived = (k: Record<string, number>): Record<string, number> => ({
      ...k,
      cost_per_km: k.km! > 100 ? (k.fuel_cost! + k.maint_cost!) / k.km! : NaN,
      l_per_100: k.km! > 100 ? (k.litres! / k.km!) * 100 : NaN,
    });
    const a = derived(cur);
    const b = derived(prev);
    const money = (v: number): string => (Number.isFinite(v) ? `${t.currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '-');
    const num = (v: number, dp = 0): string => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: dp }) : '-');
    const lines: [string, string, string, (v: number) => string, boolean][] = [
      ['fleet', 'Fleet size', 'Idadi ya magari', (v) => num(v), true],
      ['active', 'Vehicles used', 'Magari yaliyotumika', (v) => num(v), true],
      ['km', 'Distance driven (km)', 'Umbali (km)', (v) => num(v), true],
      ['trips', 'Trips', 'Safari', (v) => num(v), true],
      ['driving_h', 'Driving hours', 'Saa za kuendesha', (v) => num(v, 1), true],
      ['idle_h', 'Idle hours', 'Saa za kusimama', (v) => num(v, 1), false],
      ['util', 'Average utilisation %', 'Wastani wa matumizi %', (v) => num(v, 1), true],
      ['litres', 'Fuel purchased (L)', 'Mafuta yaliyonunuliwa (L)', (v) => num(v), false],
      ['l_per_100', 'Fleet consumption (L/100 km)', 'Matumizi ya mafuta (L/100 km)', (v) => num(v, 1), false],
      ['fuel_cost', 'Fuel cost', 'Gharama ya mafuta', money, false],
      ['maint_cost', 'Maintenance cost', 'Gharama ya matengenezo', money, false],
      ['cost_per_km', 'Running cost per km', 'Gharama kwa km', (v) => (Number.isFinite(v) ? `${t.currency} ${v.toFixed(2)}` : '-'), false],
      ['score', 'Average driver score', 'Wastani wa alama za madereva', (v) => num(v, 1), true],
      ['harsh', 'Harsh driving events', 'Matukio ya uendeshaji mkali', (v) => num(v), false],
      ['overspeed', 'Overspeed events', 'Matukio ya mwendo kasi', (v) => num(v), false],
      ['drains', 'Suspected fuel drains', 'Wizi wa mafuta unaoshukiwa', (v) => num(v), false],
      ['critical_alerts', 'Critical alerts', 'Tahadhari hatari', (v) => num(v), false],
      ['jobs_done', 'Jobs completed', 'Kazi zilizokamilika', (v) => num(v), true],
      ['on_time', 'Stops on time %', 'Vituo kwa wakati %', (v) => num(v, 1), true],
    ];
    const rows = lines.map(([k, en, sw, f, upGood]) => {
      const x = a[k]!;
      const y = b[k]!;
      const ch = Number.isFinite(x) && Number.isFinite(y) && y !== 0 ? ((x - y) / Math.abs(y)) * 100 : NaN;
      return {
        key: k,
        metric: locale === 'sw' ? sw : en,
        value: f(x),
        previous: f(y),
        change: Number.isFinite(ch) ? `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%` : '-',
        trend: Number.isFinite(ch) && Math.abs(ch) >= 0.5 ? ((ch > 0) === upGood ? 'good' : 'bad') : 'flat',
        raw: Number.isFinite(x) ? x : null,
      };
    });
    return { ...base, columns: def.columns, rows, summary: [] };
  }

  const { start, stop } = await bounds(c, t.timezone, params.from, params.to);
  // every parameter must appear (with a type) even when a report does not use it
  const typed = 'SELECT $1::uuid, $2::timestamptz, $3::timestamptz, $4::uuid[], $5::uuid, $6::uuid[], $7::date, $8::date';
  const sql = /^WITH /i.test(def.sql) ? def.sql.replace(/^WITH /i, `WITH _params AS (${typed}), `) : `WITH _params AS (${typed}) ${def.sql}`;
  const res = await c.query<Record<string, unknown>>(sql, [
    tenantId, start, stop, params.vehicle_ids?.length ? params.vehicle_ids : null, params.group_id ?? null,
    params.driver_ids?.length ? params.driver_ids : null, params.from, params.to,
  ]);
  const rows = res.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, numberish(v)])));
  const summary = (def.summary?.(rows) ?? []).map((s) => ({ label: s.label[locale], value: s.value, type: s.type }));
  return { ...base, columns: def.columns, rows, summary };
}

// ---------------------------------------------------------------- formatting
function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function formatCell(v: unknown, type: ColType, r: Pick<Report, 'tenant' | 'locale'>): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'datetime':
    case 'date': {
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) return String(v);
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: r.tenant.timezone, year: '2-digit', month: '2-digit', day: '2-digit',
        ...(type === 'datetime' ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
      }).format(d);
    }
    case 'duration':
      return fmtDuration(Number(v));
    case 'money':
      return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'decimal':
      return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'number':
      return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
    case 'percent':
      return `${Number(v).toFixed(1)}%`;
    case 'bool':
      return v === true ? (r.locale === 'sw' ? 'Ndiyo' : 'Yes') : r.locale === 'sw' ? 'Hapana' : 'No';
    default:
      return String(v);
  }
}

const csvCell = (s: string): string => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function toCsv(r: Report): Buffer {
  const lines = [r.columns.map((c) => csvCell(c.label[r.locale])).join(',')];
  for (const row of r.rows)
    lines.push(
      r.columns
        .map((c) => {
          const v = row[c.key];
          if (v === null || v === undefined) return '';
          if (c.type === 'datetime' || c.type === 'date') {
            const d = v instanceof Date ? v : new Date(String(v));
            const f = new Intl.DateTimeFormat('sv-SE', { timeZone: r.tenant.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
              ...(c.type === 'datetime' ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(d);
            return f;
          }
          if (['number', 'decimal', 'money', 'percent'].includes(c.type)) return String(v);
          if (c.type === 'duration') return String(Math.round(Number(v) / 60)); // minutes
          return csvCell(formatCell(v, c.type, r));
        })
        .join(','),
    );
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

async function toXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jatelo Fleet Solutions';
  wb.created = new Date();
  const ws = wb.addWorksheet(r.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 5 }] });
  ws.addRow([r.title]).font = { bold: true, size: 14, color: { argb: 'FF0B3D2E' } };
  ws.addRow([`${r.tenant.name} · ${r.period.from} – ${r.period.to}`]).font = { color: { argb: 'FF555555' } };
  ws.addRow(r.summary.map((s) => `${s.label}: ${formatCell(s.value, s.type, r)}`));
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => (c.type === 'duration' ? `${c.label[r.locale]} (min)` : c.label[r.locale])));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F6B4F' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  for (const row of r.rows) {
    ws.addRow(
      r.columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined) return null;
        if (c.type === 'datetime' || c.type === 'date') {
          // Excel has no time zones: write the tenant-local wall-clock time
          const d = v instanceof Date ? v : new Date(String(v));
          const p = new Intl.DateTimeFormat('en-CA', { timeZone: r.tenant.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
            .formatToParts(d)
            .reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
          return new Date(Date.UTC(+p.year!, +p.month! - 1, +p.day!, +(p.hour === '24' ? 0 : p.hour!), +p.minute!));
        }
        if (c.type === 'duration') return Math.round(Number(v) / 60);
        if (['number', 'decimal', 'money', 'percent'].includes(c.type)) return Number(v);
        if (c.type === 'bool') return v === true;
        return String(v);
      }),
    );
  }
  r.columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1);
    column.width = Math.max(c.width ?? (c.type === 'datetime' ? 17 : 12), c.label[r.locale].length + 2);
    column.numFmt =
      c.type === 'datetime' ? 'dd/mm/yyyy hh:mm' : c.type === 'date' ? 'dd/mm/yyyy' : c.type === 'money' ? '#,##0.00' : c.type === 'decimal' ? '#,##0.0#'
        : c.type === 'number' || c.type === 'duration' ? '#,##0' : c.type === 'percent' ? '0.0"%"' : '@';
  });
  if (r.rows.length) ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: r.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPdf(r: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: r.columns.length > 7 ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: r.title, Author: 'Jatelo Fleet Solutions' } });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 72;
    const GREEN = '#0F6B4F';
    // header
    doc.fillColor(GREEN).fontSize(18).font('Helvetica-Bold').text(r.title, 36, 36);
    doc.fillColor('#444').fontSize(10).font('Helvetica').text(`${r.tenant.name}   ·   ${r.period.from} – ${r.period.to}   ·   ${r.locale === 'sw' ? 'Imetolewa' : 'Generated'} ${formatCell(r.generated_at, 'datetime', r)}`);
    doc.moveDown(0.8);
    // summary tiles
    if (r.summary.length) {
      const tw = Math.min(150, W / r.summary.length - 8);
      const y = doc.y;
      r.summary.forEach((s, i) => {
        const x = 36 + i * (tw + 8);
        doc.roundedRect(x, y, tw, 46, 4).fillAndStroke('#F1F7F4', '#D5E7DE');
        doc.fillColor('#555').fontSize(8).text(s.label, x + 8, y + 7, { width: tw - 16 });
        doc.fillColor('#111').fontSize(14).font('Helvetica-Bold').text(formatCell(s.value, s.type, r), x + 8, y + 22, { width: tw - 16 });
        doc.font('Helvetica');
      });
      doc.y = y + 60;
    }
    // table
    const weights = r.columns.map((c) => c.width ?? (c.type === 'datetime' ? 15 : c.type === 'text' ? 14 : 9));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * W);
    const fs = r.columns.length > 10 ? 7 : 8;
    const drawHeader = (): void => {
      const y = doc.y;
      doc.rect(36, y, W, 18).fill(GREEN);
      let x = 36;
      doc.fillColor('#FFF').font('Helvetica-Bold').fontSize(fs);
      r.columns.forEach((c, i) => {
        doc.text(c.label[r.locale], x + 3, y + 5, { width: widths[i]! - 6, height: 12, ellipsis: true, lineBreak: false });
        x += widths[i]!;
      });
      doc.font('Helvetica').fillColor('#111');
      doc.y = y + 20;
    };
    drawHeader();
    const limit = Math.min(r.rows.length, 5000);
    for (let n = 0; n < limit; n++) {
      const row = r.rows[n]!;
      if (doc.y > doc.page.height - 60) {
        doc.addPage();
        doc.y = 36;
        drawHeader();
      }
      const y = doc.y;
      if (n % 2 === 1) doc.rect(36, y - 2, W, 14).fill('#F7F9F8').fillColor('#111');
      let x = 36;
      doc.fontSize(fs);
      r.columns.forEach((c, i) => {
        const right = ['number', 'decimal', 'money', 'percent', 'duration'].includes(c.type);
        doc.fillColor('#111').text(formatCell(row[c.key], c.type, r), x + 3, y, { width: widths[i]! - 6, height: 11, ellipsis: true, lineBreak: false, align: right ? 'right' : 'left' });
        x += widths[i]!;
      });
      doc.y = y + 14;
    }
    if (!r.rows.length) doc.fillColor('#777').fontSize(10).text(r.locale === 'sw' ? 'Hakuna data kwa kipindi hiki.' : 'No data for this period.', 36, doc.y + 8);
    if (r.rows.length > limit)
      doc.fillColor('#B00').fontSize(9).text(`Showing first ${limit} of ${r.rows.length} rows - download Excel/CSV for the full data.`, 36, doc.y + 6);
    // footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc.fillColor('#999').fontSize(7).text(`Jatelo Fleet Solutions · ${r.title} · ${i + 1}/${range.count}`, 36, doc.page.height - 28, { width: W, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

export async function renderReport(r: Report, format: ReportFormat): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const slug = `${r.type}-${r.period.from}-to-${r.period.to}`;
  if (format === 'csv') return { buffer: toCsv(r), contentType: 'text/csv; charset=utf-8', filename: `${slug}.csv` };
  if (format === 'xlsx')
    return { buffer: await toXlsx(r), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${slug}.xlsx` };
  return { buffer: await toPdf(r), contentType: 'application/pdf', filename: `${slug}.pdf` };
}

/** Next run time for a schedule (tenant-local send_time on the next matching day). */
export function nextRunAt(
  s: { frequency: 'daily' | 'weekly' | 'monthly'; send_time: string; day_of_week?: number | null; day_of_month?: number | null },
  timezone: string,
  after = new Date(),
): Date {
  const [hh, mm] = s.send_time.split(':').map(Number) as [number, number];
  const offsetAt = (d: Date): number => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(p);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  };
  const off = offsetAt(after);
  const local = new Date(after.getTime() + off * 60_000);
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, hh, mm));
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (s.frequency === 'weekly' && dow !== s.day_of_week) continue;
    if (s.frequency === 'monthly' && d.getUTCDate() !== s.day_of_month) continue;
    const utc = new Date(d.getTime() - offsetAt(d) * 60_000);
    if (utc > after) return utc;
  }
  throw new Error('Could not compute next run');
}

/** Period covered by a scheduled run: yesterday (daily), last Mon-Sun (weekly) or last calendar month (monthly), tenant-local. */
export function periodFor(frequency: 'daily' | 'weekly' | 'monthly', timezone: string, at = new Date()): { from: string; to: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at); // YYYY-MM-DD
  if (frequency === 'daily') return { from: shiftDate(today, -1), to: shiftDate(today, -1) };
  if (frequency === 'weekly') {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    const lastSunday = shiftDate(today, -dow);
    return { from: shiftDate(lastSunday, -6), to: lastSunday };
  }
  const [y, m] = today.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return { from: first, to: last };
}
