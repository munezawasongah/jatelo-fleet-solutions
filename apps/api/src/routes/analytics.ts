import type { Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { buildReport, DEFS, nextRunAt, renderReport, REPORT_TYPES, type ReportType } from '@jfs/reports';
import { z } from 'zod';
import { guard, requireAuth, tenantDb, type AuthContext } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { paged, PageQuery } from '../http/crud.js';
import { AppError, unprocessable } from '../http/errors.js';
import { AnyRow, ListOf, listRows, resource, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';

const BASE = '/api/v1';
const TAG = 'Analytics & reports';
const isoDate = z.iso.date();
const FORMATS = ['json', 'pdf', 'xlsx', 'csv'] as const;

const ReportQuery = z.object({
  from: isoDate.describe('First day (tenant-local), inclusive'),
  to: isoDate.describe('Last day (tenant-local), inclusive; at most 366 days after from'),
  format: z.enum(FORMATS).default('json'),
  locale: z.enum(['en', 'sw']).optional(),
  vehicle_ids: z.string().optional().describe('Comma-separated vehicle ids'),
  driver_ids: z.string().optional().describe('Comma-separated driver ids'),
  group_id: z.uuid().optional(),
});
const ids = (s?: string): string[] | null => {
  if (!s) return null;
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const x of list) if (!/^[0-9a-f-]{36}$/i.test(x)) throw unprocessable('Invalid id in list', { id: x });
  return list.length ? list : null;
};

/** Restricts the requested vehicles to the user's vehicle-group scope (if any). */
async function scopedVehicles(c: PoolClient, auth: AuthContext, requested: string[] | null): Promise<string[] | null> {
  const scope = await groupScope(c, auth.userId);
  if (!scope) return requested;
  const allowed = (await c.query<{ id: string }>('SELECT id FROM vehicles WHERE group_id = ANY($1) AND deleted_at IS NULL', [scope])).rows.map((r) => r.id);
  const out = requested ? requested.filter((id) => allowed.includes(id)) : allowed;
  return out.length ? out : ['00000000-0000-0000-0000-000000000000'];
}

const DRIVER_REPORTS: ReportType[] = ['driver_scores'];
const FINANCE_REPORTS: ReportType[] = ['fuel', 'maintenance', 'executive_summary'];

function canRun(auth: AuthContext, type: ReportType): boolean {
  if (auth.permissions.has('reports:read')) return true;
  if (DRIVER_REPORTS.includes(type)) return auth.permissions.has('driver_scores:read');
  return false;
}

async function tenantLocale(c: PoolClient): Promise<{ locale: 'en' | 'sw'; timezone: string }> {
  const r = (await c.query<{ locale: 'en' | 'sw'; timezone: string }>('SELECT locale, timezone FROM tenants WHERE id = app.current_tenant_id()')).rows[0];
  return r ?? { locale: 'en', timezone: 'Africa/Nairobi' };
}

export function registerAnalyticsRoutes(v1: Router): void {
  // ---------------------------------------------------------------- dashboard
  route(v1, BASE, {
    method: 'get',
    path: '/analytics/dashboard',
    tags: [TAG],
    summary: 'Executive dashboard: live fleet status, KPIs vs previous period, daily trends, leaders and laggards',
    auth: true,
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), group_id: z.uuid().optional() }),
    middleware: guard('analytics:read'),
    responses: { 200: { description: 'Dashboard', schema: AnyRow } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const { locale, timezone } = await tenantLocale(c);
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
        const to = query.to ?? today;
        const from = query.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
        const vehicles = await scopedVehicles(c, auth, null);
        const params = { from, to, vehicle_ids: vehicles, group_id: query.group_id ?? null };
        const exec = await buildReport(c, auth.tenantId!, 'executive_summary', params, locale);
        const kpis = Object.fromEntries(exec.rows.map((r) => [String(r.key), { label: r.metric, value: r.raw, display: r.value, previous: r.previous, change: r.change, trend: r.trend }]));
        const VEH = `($1::uuid[] IS NULL OR v.id = ANY($1)) AND ($2::uuid IS NULL OR v.group_id = $2)`;
        const live = (
          await c.query<Row>(
            `SELECT count(*) AS total,
               count(*) FILTER (WHERE ds.state = 'moving' AND ds.last_seen_at > now() - interval '15 minutes') AS moving,
               count(*) FILTER (WHERE ds.state = 'idle' AND ds.last_seen_at > now() - interval '15 minutes') AS idle,
               count(*) FILTER (WHERE ds.state = 'stopped' AND ds.last_seen_at > now() - interval '15 minutes') AS stopped,
               count(*) FILTER (WHERE ds.device_id IS NOT NULL AND (ds.last_seen_at IS NULL OR ds.last_seen_at <= now() - interval '15 minutes')) AS offline,
               count(*) FILTER (WHERE da.device_id IS NULL) AS no_device
             FROM vehicles v LEFT JOIN device_assignments da ON da.vehicle_id = v.id AND da.unassigned_at IS NULL
             LEFT JOIN device_status ds ON ds.device_id = da.device_id
             WHERE v.deleted_at IS NULL AND v.status NOT IN ('sold', 'written_off') AND ${VEH}`,
            [vehicles, query.group_id ?? null],
          )
        ).rows[0]!;
        const series = await listRows(
          c,
          `SELECT d::date::text AS day, coalesce(sum(s.distance_km), 0) AS distance_km, round(coalesce(sum(s.driving_s), 0) / 3600.0, 1) AS driving_h,
             round(coalesce(sum(s.idle_s), 0) / 3600.0, 1) AS idle_h, coalesce(sum(s.fuel_cost), 0) AS fuel_cost, coalesce(sum(s.harsh_events), 0) AS harsh,
             coalesce(sum(s.overspeed_events), 0) AS overspeed, count(DISTINCT s.vehicle_id) FILTER (WHERE s.distance_km > 0) AS active_vehicles
           FROM generate_series($3::date, $4::date, interval '1 day') d
           LEFT JOIN (vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id AND ${VEH}) ON s.day = d::date
           GROUP BY d ORDER BY d`,
          [vehicles, query.group_id ?? null, from, to],
        );
        const topVehicles = await listRows(
          c,
          `SELECT v.id, v.plate_number, sum(s.distance_km) AS distance_km, round(avg(s.utilisation_pct), 1) AS utilisation_pct, sum(s.fuel_cost) AS fuel_cost
           FROM vehicle_daily_stats s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.day BETWEEN $3 AND $4 AND ${VEH}
           GROUP BY v.id ORDER BY distance_km DESC LIMIT 5`,
          [vehicles, query.group_id ?? null, from, to],
        );
        const drivers = await listRows(
          c,
          `SELECT d.id, d.full_name, round(sum(s.score * greatest(s.distance_km, 1)) / sum(greatest(s.distance_km, 1)), 1) AS score, sum(s.distance_km) AS distance_km,
             sum(s.harsh_brake + s.harsh_accel + s.harsh_corner) AS harsh, sum(s.overspeed_count) AS overspeed
           FROM driver_daily_scores s JOIN drivers d ON d.id = s.driver_id WHERE s.day BETWEEN $1 AND $2 AND d.deleted_at IS NULL
           GROUP BY d.id HAVING sum(s.distance_km) > 0 ORDER BY score DESC`,
          [from, to],
        );
        const ops = (
          await c.query<Row>(
            `SELECT (SELECT count(*) FROM alerts WHERE status = 'open') AS open_alerts,
               (SELECT count(*) FROM alerts WHERE status = 'open' AND severity = 'critical') AS critical_alerts,
               (SELECT count(*) FROM service_schedules WHERE deleted_at IS NULL AND is_active AND status IN ('due', 'overdue')) AS services_due,
               (SELECT count(*) FROM service_schedules WHERE deleted_at IS NULL AND is_active AND status = 'overdue') AS services_overdue,
               (SELECT count(*) FROM work_orders WHERE deleted_at IS NULL AND status IN ('open', 'scheduled', 'in_progress', 'on_hold')) AS open_work_orders,
               (SELECT count(*) FROM defects WHERE status IN ('open', 'in_progress') AND severity = 'critical') AS critical_defects,
               (SELECT count(*) FROM jobs WHERE deleted_at IS NULL AND status IN ('dispatched', 'in_progress')) AS active_jobs,
               (SELECT count(*) FROM jobs WHERE deleted_at IS NULL AND off_route_since IS NOT NULL AND status IN ('dispatched', 'in_progress')) AS off_route_jobs,
               (SELECT count(*) FROM fuel_events WHERE event_type = 'drain' AND status = 'open') AS open_fuel_drains`,
          )
        ).rows[0]!;
        return {
          period: { from, to },
          currency: exec.tenant.currency,
          live: Object.fromEntries(Object.entries(live).map(([k, v]) => [k, Number(v)])),
          kpis,
          operations: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, Number(v)])),
          series,
          top_vehicles: topVehicles,
          best_drivers: drivers.slice(0, 5),
          drivers_needing_coaching: drivers.slice(-5).reverse().filter((d) => Number(d.score) < 80),
        };
      });
    },
  });

  // ---------------------------------------------------------------- reports
  route(v1, BASE, {
    method: 'get',
    path: '/reports/types',
    tags: [TAG],
    summary: 'Available report types with their columns',
    auth: true,
    middleware: guard(),
    responses: { 200: { description: 'Types', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: ({ req }) => {
      const auth = requireAuth(req);
      return {
        data: REPORT_TYPES.filter((t) => canRun(auth, t)).map((t) => ({
          type: t,
          title: DEFS[t].title,
          columns: DEFS[t].columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
          formats: FORMATS,
        })),
      };
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/reports/:type',
    tags: [TAG],
    summary: 'Run a report: JSON for on-screen tables, or download as PDF / Excel / CSV',
    description: 'Durations are seconds in JSON, minutes in Excel/CSV. Date-times are shown in the company time zone.',
    auth: true,
    params: z.object({ type: z.enum(REPORT_TYPES) }),
    query: ReportQuery,
    middleware: guard(),
    responses: { 200: { description: 'Report (JSON) or file' } },
    handler: async ({ req, res, params, query }) => {
      const auth = requireAuth(req);
      if (!canRun(auth, params.type)) throw new AppError(403, 'forbidden', 'You do not have access to this report');
      if (FINANCE_REPORTS.includes(params.type) && !auth.permissions.has('reports:read')) throw new AppError(403, 'forbidden', 'You do not have access to this report');
      const out = await tenantDb(req, async (c) => {
        const { locale } = await tenantLocale(c);
        const vehicleIds = await scopedVehicles(c, auth, ids(query.vehicle_ids));
        const report = await buildReport(c, auth.tenantId!, params.type, {
          from: query.from, to: query.to, vehicle_ids: vehicleIds, driver_ids: ids(query.driver_ids), group_id: query.group_id ?? null,
        }, query.locale ?? locale).catch((err: Error & { status?: number }) => {
          if (err.status === 422) throw unprocessable(err.message);
          throw err;
        });
        await c.query(
          `INSERT INTO report_runs (tenant_id, report_type, params, format, status, row_count, requested_by, started_at, completed_at)
           VALUES ($1,$2,$3,$4,'completed',$5,$6, now(), now())`,
          [auth.tenantId, params.type, JSON.stringify({ ...query, format: undefined }), query.format === 'json' ? 'csv' : query.format, report.rows.length, auth.userId],
        );
        return report;
      });
      if (query.format === 'json') return out;
      const file = await renderReport(out, query.format);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).end(file.buffer);
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/report-runs',
    tags: [TAG],
    summary: 'Report history (on-demand and scheduled)',
    auth: true,
    query: z.object({ ...PageQuery, schedule_id: z.uuid().optional() }),
    middleware: guard('reports:read'),
    responses: { 200: { description: 'Runs', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT r.id, r.schedule_id, s.name AS schedule_name, r.report_type, r.params, r.format, r.status, r.row_count, r.error, u.full_name AS requested_by_name,
             r.created_at, r.completed_at, count(*) OVER () AS total
           FROM report_runs r LEFT JOIN report_schedules s ON s.id = r.schedule_id LEFT JOIN users u ON u.id = r.requested_by
           WHERE ($1::uuid IS NULL OR r.schedule_id = $1) ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
          [query.schedule_id ?? null, query.page_size, (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  // ---------------------------------------------------------------- scheduled reports
  resource(v1, {
    path: 'report-schedules',
    table: 'report_schedules',
    tag: TAG,
    noun: 'Report schedule',
    read: ['reports:read'],
    write: ['reports:schedule'],
    input: z.object({
      name: z.string().trim().min(2).max(120),
      report_type: z.enum(REPORT_TYPES),
      filters: z.object({ vehicle_ids: z.array(z.uuid()).max(500).optional(), group_id: z.uuid().optional(), driver_ids: z.array(z.uuid()).max(500).optional() }).optional(),
      format: z.enum(['pdf', 'xlsx', 'csv']).optional(),
      frequency: z.enum(['daily', 'weekly', 'monthly']),
      send_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      day_of_week: z.number().int().min(1).max(7).nullable().optional().describe('1 = Monday (weekly)'),
      day_of_month: z.number().int().min(1).max(28).nullable().optional().describe('monthly'),
      locale: z.enum(['en', 'sw']).optional(),
      recipients: z.array(z.email()).min(1).max(20),
      is_active: z.boolean().optional(),
    }),
    select: `SELECT x.id, x.name, x.report_type, x.filters, x.format, x.frequency, x.send_time::text, x.day_of_week, x.day_of_month, x.locale, x.recipients,
      x.is_active, x.last_run_at, x.next_run_at, x.created_at, x.updated_at FROM report_schedules x`,
    sorts: { name: 'x.name', next_run_at: 'x.next_run_at' },
    defaultSort: 'x.name ASC',
    search: ['x.name'],
    softDelete: true,
    toColumns: (b) => ({ ...b, ...(b.filters ? { filters: JSON.stringify(b.filters) } : {}) }),
    extraCreate: (auth) => ({ created_by: auth.userId }),
    validate: async (_c, b, _auth, existing) => {
      const freq = b.frequency ?? existing?.frequency;
      if (freq === 'weekly' && !(b.day_of_week ?? existing?.day_of_week)) throw unprocessable('Weekly schedules need day_of_week (1 = Monday)');
      if (freq === 'monthly' && !(b.day_of_month ?? existing?.day_of_month)) throw unprocessable('Monthly schedules need day_of_month (1-28)');
    },
    afterWrite: async (c, id) => {
      const s = (
        await c.query<{ frequency: 'daily' | 'weekly' | 'monthly'; send_time: string; day_of_week: number | null; day_of_month: number | null; timezone: string }>(
          `SELECT s.frequency, s.send_time::text, s.day_of_week, s.day_of_month, t.timezone FROM report_schedules s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = $1`,
          [id],
        )
      ).rows[0];
      if (s) await c.query('UPDATE report_schedules SET next_run_at = $2 WHERE id = $1', [id, nextRunAt({ ...s, send_time: s.send_time.slice(0, 5) }, s.timezone)]);
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/report-schedules/:id/run-now',
    tags: [TAG],
    summary: 'Send a scheduled report now (for the last full period)',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('reports:schedule'),
    responses: { 202: { description: 'Queued', schema: z.object({ queued: z.boolean() }) } },
    status: 202,
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => {
        const r = await c.query(`UPDATE report_schedules SET next_run_at = now() WHERE id = $1 AND deleted_at IS NULL AND is_active`, [params.id]);
        if (!r.rowCount) throw unprocessable('Schedule not found or paused');
        return { queued: true };
      }),
  });
}
