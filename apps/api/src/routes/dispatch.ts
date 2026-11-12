import type { Request, Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb, type AuthContext } from '../auth/middleware.js';
import { assertFile, orderBy, paged, PageQuery } from '../http/crud.js';
import { AppError, forbidden, notFound, unprocessable } from '../http/errors.js';
import { AnyRow, ListOf, listRows, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { pushToUser } from '../infra/push.js';
import { redis } from '../infra/redis.js';
import { planRoute, type Stop } from '../infra/routing.js';

const BASE = '/api/v1';
const TAG = 'Dispatch';
const dt = z.iso.datetime({ offset: true });
const PROFILES = ['car', 'truck', 'motorcycle'] as const;
const JOB_STATUSES = ['draft', 'scheduled', 'dispatched', 'in_progress', 'completed', 'cancelled', 'failed'] as const;
const STOP_TYPES = ['pickup', 'delivery', 'service', 'waypoint'] as const;
const ACTIVE = ['dispatched', 'in_progress'];
const CLOSED = ['completed', 'cancelled', 'failed'];

/** Allowed manual status transitions. */
const NEXT: Record<string, string[]> = {
  draft: ['scheduled', 'dispatched', 'cancelled'],
  scheduled: ['draft', 'dispatched', 'cancelled'],
  dispatched: ['scheduled', 'in_progress', 'cancelled', 'failed', 'completed'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  cancelled: ['draft'],
  failed: ['draft'],
};

// ---------------------------------------------------------------- schemas
const Point = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };
const RouteStopIn = z.object({
  name: z.string().trim().min(1).max(160),
  ...Point,
  poi_id: z.uuid().nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  service_minutes: z.number().int().min(0).max(1440).optional(),
  time_window_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  time_window_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});
const RouteIn = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  profile: z.enum(PROFILES).optional(),
  optimize_order: z.boolean().optional(),
  return_to_start: z.boolean().optional(),
  deviation_threshold_m: z.number().int().min(50).max(20000).optional(),
  stops: z.array(RouteStopIn).min(2).max(100).optional(),
});

const JobStopIn = z.object({
  stop_type: z.enum(STOP_TYPES).optional(),
  name: z.string().trim().min(1).max(160),
  ...Point,
  poi_id: z.uuid().nullable().optional(),
  arrival_radius_m: z.number().int().min(20).max(5000).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  contact_name: z.string().trim().max(120).nullable().optional(),
  contact_phone: z.string().trim().max(20).nullable().optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
  items: z.array(z.object({ description: z.string().max(200), quantity: z.number().min(0).optional(), sku: z.string().max(60).optional() })).max(200).optional(),
  time_window_start: dt.nullable().optional(),
  time_window_end: dt.nullable().optional(),
  service_minutes: z.number().int().min(0).max(1440).optional(),
});
const JobIn = z.object({
  reference: z.string().trim().min(1).max(40).optional(),
  title: z.string().trim().min(1).max(160),
  customer_name: z.string().trim().max(160).nullable().optional(),
  customer_phone: z.string().trim().max(20).nullable().optional(),
  vehicle_id: z.uuid().nullable().optional(),
  driver_id: z.uuid().nullable().optional(),
  route_id: z.uuid().nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  scheduled_start: dt.nullable().optional(),
  scheduled_end: dt.nullable().optional(),
  deviation_threshold_m: z.number().int().min(50).max(20000).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  stops: z.array(JobStopIn).max(100).optional(),
  optimize: z.boolean().optional().describe('Re-order stops for the shortest drive when planning'),
  dispatch: z.boolean().optional().describe('Dispatch immediately to the assigned driver'),
});
const JobPatch = JobIn.omit({ stops: true, optimize: true, dispatch: true }).partial();
const Pod = z.object({
  recipient_name: z.string().trim().min(1).max(160),
  recipient_phone: z.string().trim().max(20).nullable().optional(),
  signature_file_id: z.uuid().nullable().optional(),
  photo_file_ids: z.array(z.uuid()).max(10).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  captured_at: dt.optional(),
});
const IdParam = z.object({ id: z.uuid() });
const StopParam = z.object({ id: z.uuid(), stopId: z.uuid() });

// ---------------------------------------------------------------- helpers
const JOB_SELECT = `SELECT j.id, j.reference, j.title, j.customer_name, j.customer_phone, j.vehicle_id, v.plate_number, j.driver_id,
  d.full_name AS driver_name, j.route_id, j.status, j.priority, j.scheduled_start, j.scheduled_end, j.actual_start, j.actual_end,
  j.planned_distance_km, j.planned_duration_s, j.actual_distance_km, j.deviation_threshold_m, j.off_route_since, j.last_deviation_m,
  j.progress_pct, j.notes, j.created_at, j.updated_at,
  (SELECT count(*) FROM job_stops s WHERE s.job_id = j.id) AS stop_count,
  (SELECT count(*) FROM job_stops s WHERE s.job_id = j.id AND s.status IN ('completed', 'failed', 'skipped')) AS stops_done,
  (SELECT min(s.eta) FROM job_stops s WHERE s.job_id = j.id AND s.status IN ('pending', 'en_route')) AS next_eta
  FROM jobs j LEFT JOIN vehicles v ON v.id = j.vehicle_id LEFT JOIN drivers d ON d.id = j.driver_id`;

const STOP_SELECT = `SELECT s.id, s.seq, s.stop_type, s.poi_id, s.name, ST_Y(s.geom) AS lat, ST_X(s.geom) AS lng, s.arrival_radius_m, s.address,
  s.contact_name, s.contact_phone, s.instructions, s.items, s.time_window_start, s.time_window_end, s.planned_arrival, s.eta, s.arrived_at,
  s.departed_at, s.status, s.failure_reason, (p.id IS NOT NULL) AS has_pod FROM job_stops s LEFT JOIN proof_of_delivery p ON p.job_stop_id = s.id`;

/** The driver record linked to the signed-in user (driver app), if any. */
async function myDriverId(c: PoolClient, auth: AuthContext): Promise<string | null> {
  const r = await c.query<{ id: string }>('SELECT id FROM drivers WHERE user_id = $1 AND deleted_at IS NULL', [auth.userId]);
  return r.rows[0]?.id ?? null;
}

/** Loads a job the caller may act on. Dispatch staff see all; drivers only their own active/assigned jobs. */
async function loadJob(c: PoolClient, auth: AuthContext, id: string, write: boolean): Promise<Row> {
  const j = rowsOf(await c.query<Row>(`${JOB_SELECT} WHERE j.id = $1 AND j.deleted_at IS NULL`, [id]))[0];
  if (!j) throw notFound('Job');
  const staff = auth.permissions.has(write ? 'jobs:write' : 'jobs:read') && !auth.permissions.has('driver_app:use');
  if (staff || auth.role === 'super_admin') return j;
  const me = await myDriverId(c, auth);
  if (!me || j.driver_id !== me) throw notFound('Job');
  return j;
}

async function jobEvent(
  c: PoolClient,
  tenantId: string,
  jobId: string,
  type: string,
  details: Record<string, unknown>,
  actor: { type: 'user' | 'driver' | 'system'; id?: string | null },
  stopId?: string | null,
  at?: { lat?: number | null; lng?: number | null },
): Promise<void> {
  await c.query(
    `INSERT INTO job_events (tenant_id, job_id, job_stop_id, event_type, details, actor_type, actor_id, lat, lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, jobId, stopId ?? null, type, JSON.stringify(details), actor.type, actor.id ?? null, at?.lat ?? null, at?.lng ?? null],
  );
}

const actorOf = (auth: AuthContext): { type: 'user' | 'driver'; id: string } => ({
  type: auth.permissions.has('driver_app:use') ? 'driver' : 'user',
  id: auth.userId,
});

/** Pushes a job update to dispatchers (tenant room) and to the assigned driver's devices. */
async function broadcast(c: PoolClient, tenantId: string, jobId: string, kind: string): Promise<void> {
  const j = (
    await c.query<{ status: string; driver_user: string | null; vehicle_id: string | null; reference: string; title: string }>(
      `SELECT j.status, d.user_id AS driver_user, j.vehicle_id, j.reference, j.title FROM jobs j LEFT JOIN drivers d ON d.id = j.driver_id WHERE j.id = $1`,
      [jobId],
    )
  ).rows[0];
  if (!j) return;
  const payload = JSON.stringify({ type: 'job', kind, job_id: jobId, status: j.status, reference: j.reference, title: j.title, vehicle_id: j.vehicle_id });
  await redis.publish(`rt:tenant:${tenantId}`, payload);
  if (j.driver_user) {
    await redis.publish(`rt:user:${j.driver_user}`, payload);
    if (ACTIVE.includes(j.status) && ['dispatched', 'created', 'stops', 'updated'].includes(kind))
      await pushToUser(j.driver_user, kind === 'dispatched' || kind === 'created' ? `New job ${j.reference}` : `Job ${j.reference} updated`, j.title, {
        type: 'job', job_id: jobId,
      });
  }
}

async function nextReference(c: PoolClient): Promise<string> {
  const y = new Date().getUTCFullYear();
  const r = await c.query<{ n: number }>(
    `SELECT coalesce(max(substring(reference FROM '^JOB-${y}-(\\d+)$')::int), 0) + 1 AS n FROM jobs WHERE reference ~ '^JOB-${y}-\\d+$'`,
  );
  return `JOB-${y}-${String(r.rows[0]!.n).padStart(5, '0')}`;
}

async function insertStops(c: PoolClient, tenantId: string, jobId: string, stops: z.infer<typeof JobStopIn>[], startSeq = 1): Promise<void> {
  let seq = startSeq;
  for (const s of stops) {
    await c.query(
      `INSERT INTO job_stops (tenant_id, job_id, seq, stop_type, poi_id, name, geom, arrival_radius_m, address, contact_name, contact_phone,
         instructions, items, time_window_start, time_window_end)
       VALUES ($1,$2,$3,$4,$5,$6, ST_SetSRID(ST_MakePoint($8, $7), 4326), $9,$10,$11,$12,$13,$14,$15,$16)`,
      [tenantId, jobId, seq++, s.stop_type ?? 'delivery', s.poi_id ?? null, s.name, s.lat, s.lng, s.arrival_radius_m ?? 150, s.address ?? null,
        s.contact_name ?? null, s.contact_phone ?? null, s.instructions ?? null, JSON.stringify(s.items ?? []),
        s.time_window_start ?? null, s.time_window_end ?? null],
    );
  }
}

/** Current position of a vehicle, if it has a live device. */
async function vehiclePosition(c: PoolClient, vehicleId: string | null): Promise<{ lat: number; lng: number; profile: string } | null> {
  if (!vehicleId) return null;
  const r = (
    await c.query<{ lat: number | null; lng: number | null; body_type: string | null }>(
      `SELECT ds.lat, ds.lng, v.body_type FROM vehicles v LEFT JOIN device_assignments da ON da.vehicle_id = v.id AND da.unassigned_at IS NULL
       LEFT JOIN device_status ds ON ds.device_id = da.device_id WHERE v.id = $1`,
      [vehicleId],
    )
  ).rows[0];
  if (!r) return null;
  const profile = ['truck', 'prime_mover', 'tanker', 'bus'].includes(r.body_type ?? '') ? 'truck' : r.body_type === 'motorcycle' ? 'motorcycle' : 'car';
  return r.lat === null || r.lng === null ? { lat: NaN, lng: NaN, profile } : { lat: r.lat, lng: r.lng, profile };
}

/**
 * Plans (and optionally optimises) a job: computes geometry, distance, duration and per-stop planned arrival / ETA.
 * Starts from the vehicle's live position when known, otherwise from the first stop (which then stays first).
 */
export async function planJob(c: PoolClient, jobId: string, optimize: boolean): Promise<Row> {
  const job = (
    await c.query<{ vehicle_id: string | null; scheduled_start: Date | null; status: string }>(
      'SELECT vehicle_id, scheduled_start, status FROM jobs WHERE id = $1',
      [jobId],
    )
  ).rows[0]!;
  const stops = (
    await c.query<{ id: string; lat: number; lng: number; status: string; time_window_start: Date | null; time_window_end: Date | null; service_minutes: number | null }>(
      `SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lng, status, time_window_start, time_window_end, 10 AS service_minutes
       FROM job_stops WHERE job_id = $1 ORDER BY seq`,
      [jobId],
    )
  ).rows;
  const open = stops.filter((s) => s.status === 'pending' || s.status === 'en_route');
  const done = stops.filter((s) => !open.includes(s));
  if (!open.length) return { planned: false, reason: 'no_open_stops' };
  const pos = await vehiclePosition(c, job.vehicle_id);
  const live = pos && Number.isFinite(pos.lat) && ACTIVE.includes(job.status);
  const fromVehicle = live || (pos && Number.isFinite(pos.lat) && open.length === 1);
  const asStop = (s: (typeof stops)[number]): Stop => ({
    lat: s.lat, lng: s.lng, service_minutes: s.service_minutes ?? 10,
    window_start: s.time_window_start?.toISOString() ?? null, window_end: s.time_window_end?.toISOString() ?? null,
  });
  const points: Stop[] = fromVehicle ? [{ lat: pos!.lat, lng: pos!.lng }, ...open.map(asStop)] : open.map(asStop);
  if (points.length < 2) return { planned: false, reason: 'need_two_points' };
  const departAt = live ? new Date() : (job.scheduled_start ?? new Date());
  const plan = await planRoute(points, { optimize, profile: pos?.profile ?? 'car', departAt });
  // ordered list of open stops (first stop fixed when we started from it)
  const ordered = fromVehicle ? plan.order.map((i) => open[i]!) : [open[0]!, ...plan.order.map((i) => open[i + 1]!)];
  const etas = fromVehicle ? plan.etas : [departAt.toISOString(), ...plan.etas];
  // re-sequence: completed stops keep their place first, then the planned order
  const seqOrder = [...done, ...ordered];
  for (let i = 0; i < seqOrder.length; i++) {
    const s = seqOrder[i]!;
    const k = ordered.indexOf(s);
    await c.query(
      `UPDATE job_stops SET seq = $2, eta = CASE WHEN $3::timestamptz IS NULL THEN eta ELSE $3 END,
         planned_arrival = CASE WHEN $4 AND $3::timestamptz IS NOT NULL THEN $3 ELSE planned_arrival END WHERE id = $1`,
      [s.id, i + 1, k >= 0 ? etas[k] : null, !ACTIVE.includes(job.status)],
    );
  }
  const line = plan.geometry.length >= 2 ? plan.geometry : [plan.geometry[0]!, plan.geometry[0]!];
  await c.query(
    `UPDATE jobs SET planned_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), planned_distance_km = $3, planned_duration_s = $4 WHERE id = $1`,
    [jobId, JSON.stringify({ type: 'LineString', coordinates: line }), plan.distance_km, plan.duration_s],
  );
  return { planned: true, engine: plan.engine, distance_km: plan.distance_km, duration_s: plan.duration_s, from_vehicle: Boolean(fromVehicle) };
}

async function jobDetail(c: PoolClient, id: string, job?: Row): Promise<Row> {
  const j = job ?? rowsOf(await c.query<Row>(`${JOB_SELECT} WHERE j.id = $1 AND j.deleted_at IS NULL`, [id]))[0];
  if (!j) throw notFound('Job');
  const stops = await listRows(c, `${STOP_SELECT} WHERE s.job_id = $1 ORDER BY s.seq`, [id]);
  const geom = (await c.query<{ g: string | null }>('SELECT ST_AsGeoJSON(planned_geometry, 6) AS g FROM jobs WHERE id = $1', [id])).rows[0]?.g;
  const pods = await listRows(
    c,
    `SELECT p.id, p.job_stop_id, p.recipient_name, p.recipient_phone, p.signature_file_id, p.photo_file_ids, p.notes, p.lat, p.lng, p.captured_at
     FROM proof_of_delivery p JOIN job_stops s ON s.id = p.job_stop_id WHERE s.job_id = $1`,
    [id],
  );
  return { ...j, planned_geometry: geom ? JSON.parse(geom) : null, stops, proof_of_delivery: pods };
}

async function setStatus(c: PoolClient, auth: AuthContext, job: Row, status: string, reason?: string | null): Promise<void> {
  const from = String(job.status);
  if (from === status) return;
  if (!NEXT[from]?.includes(status)) throw unprocessable(`A ${from} job cannot be moved to ${status}`, { allowed: NEXT[from] });
  if ((status === 'dispatched' || status === 'in_progress') && !job.driver_id)
    throw unprocessable('Assign a driver before dispatching the job');
  if (status === 'dispatched' && Number(job.stop_count) === 0) throw unprocessable('Add at least one stop before dispatching');
  await c.query(
    `UPDATE jobs SET status = $2,
       actual_start = CASE WHEN $2 = 'in_progress' AND actual_start IS NULL THEN now() ELSE actual_start END,
       actual_end = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() WHEN $2 = 'draft' THEN NULL ELSE actual_end END,
       off_route_since = CASE WHEN $2 IN ('completed', 'failed', 'cancelled', 'draft') THEN NULL ELSE off_route_since END
     WHERE id = $1`,
    [job.id, status],
  );
  if (status === 'draft') await c.query(`UPDATE job_stops SET status = 'pending', arrived_at = NULL, departed_at = NULL, failure_reason = NULL WHERE job_id = $1`, [job.id]);
  if (status === 'completed' || status === 'cancelled')
    await c.query(`UPDATE job_stops SET status = 'skipped' WHERE job_id = $1 AND status IN ('pending', 'en_route', 'arrived')`, [job.id]);
  await jobEvent(c, auth.tenantId!, String(job.id), 'status_change', { from, to: status, reason: reason ?? null }, actorOf(auth));
}

/** Completes the job automatically once every stop is done. */
async function autoComplete(c: PoolClient, auth: AuthContext, jobId: string): Promise<void> {
  const r = (
    await c.query<{ open: number; failed: number; status: string }>(
      `SELECT count(*) FILTER (WHERE s.status IN ('pending', 'en_route', 'arrived'))::int AS open,
         count(*) FILTER (WHERE s.status = 'failed')::int AS failed, j.status
       FROM jobs j LEFT JOIN job_stops s ON s.job_id = j.id WHERE j.id = $1 GROUP BY j.status`,
      [jobId],
    )
  ).rows[0];
  if (!r || r.open > 0 || !ACTIVE.includes(r.status)) return;
  const status = 'completed';
  await c.query(
    `UPDATE jobs SET status = $2, actual_end = now(), off_route_since = NULL, progress_pct = 100,
       actual_start = coalesce(actual_start, now()) WHERE id = $1`,
    [jobId, status],
  );
  await jobEvent(c, auth.tenantId!, jobId, 'status_change', { from: r.status, to: status, auto: true, failed_stops: r.failed }, { type: 'system' });
}

async function assertAssignable(c: PoolClient, vehicleId?: string | null, driverId?: string | null): Promise<void> {
  if (vehicleId) {
    const v = await c.query('SELECT 1 FROM vehicles WHERE id = $1 AND deleted_at IS NULL', [vehicleId]);
    if (!v.rowCount) throw unprocessable('Vehicle not found', { vehicle_id: vehicleId });
  }
  if (driverId) {
    const d = await c.query<{ status: string }>('SELECT status FROM drivers WHERE id = $1 AND deleted_at IS NULL', [driverId]);
    if (!d.rows[0]) throw unprocessable('Driver not found', { driver_id: driverId });
    if (d.rows[0].status !== 'active') throw unprocessable('This driver is not active', { driver_id: driverId });
  }
}

const isDriver = (auth: AuthContext): boolean => auth.permissions.has('driver_app:use');
function staffOnly(req: Request): AuthContext {
  const auth = requireAuth(req);
  if (isDriver(auth)) throw forbidden();
  return auth;
}

// ---------------------------------------------------------------- routes
export function registerDispatchRoutes(v1: Router): void {
  // ---------- route templates
  route(v1, BASE, {
    method: 'get',
    path: '/routes',
    tags: [TAG],
    summary: 'List planned route templates',
    auth: true,
    query: z.object({ ...PageQuery, q: z.string().max(100).optional() }),
    middleware: guard('routes:read'),
    responses: { 200: { description: 'Routes', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT r.id, r.name, r.description, r.profile, r.optimize_order, r.return_to_start, r.distance_km, r.duration_s, r.deviation_threshold_m,
             (SELECT count(*) FROM route_stops s WHERE s.route_id = r.id) AS stop_count, r.created_at, r.updated_at, count(*) OVER () AS total
           FROM routes r WHERE r.deleted_at IS NULL AND ($1::text IS NULL OR r.name ILIKE '%' || $1 || '%')
           ORDER BY r.name LIMIT $2 OFFSET $3`,
          [query.q ?? null, query.page_size, (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  async function saveRouteStops(c: PoolClient, tenantId: string, routeId: string, body: z.infer<typeof RouteIn>): Promise<void> {
    const stops = body.stops!;
    await c.query('DELETE FROM route_stops WHERE route_id = $1', [routeId]);
    const plan = await planRoute(
      stops.map((s) => ({ lat: s.lat, lng: s.lng, service_minutes: s.service_minutes ?? 0 })),
      { optimize: body.optimize_order ?? false, profile: body.profile ?? 'car', returnToStart: body.return_to_start ?? false },
    );
    const ordered = [stops[0]!, ...plan.order.map((i) => stops[i + 1]!)];
    let seq = 1;
    for (const s of ordered) {
      await c.query(
        `INSERT INTO route_stops (tenant_id, route_id, seq, poi_id, name, geom, address, service_minutes, time_window_start, time_window_end)
         VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($7, $6), 4326), $8,$9,$10,$11)`,
        [tenantId, routeId, seq++, s.poi_id ?? null, s.name, s.lat, s.lng, s.address ?? null, s.service_minutes ?? 0, s.time_window_start ?? null, s.time_window_end ?? null],
      );
    }
    await c.query(
      `UPDATE routes SET geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), distance_km = $3, duration_s = $4 WHERE id = $1`,
      [routeId, JSON.stringify({ type: 'LineString', coordinates: plan.geometry }), plan.distance_km, plan.duration_s],
    );
  }

  async function routeDetail(c: PoolClient, id: string): Promise<Row> {
    const r = rowsOf(
      await c.query<Row>(
        `SELECT id, name, description, profile, optimize_order, return_to_start, distance_km, duration_s, deviation_threshold_m,
           ST_AsGeoJSON(geometry, 6) AS geometry, created_at, updated_at FROM routes WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    )[0];
    if (!r) throw notFound('Route');
    const stops = await listRows(
      c,
      `SELECT id, seq, poi_id, name, ST_Y(geom) AS lat, ST_X(geom) AS lng, address, service_minutes, time_window_start::text, time_window_end::text
       FROM route_stops WHERE route_id = $1 ORDER BY seq`,
      [id],
    );
    return { ...r, geometry: r.geometry ? JSON.parse(String(r.geometry)) : null, stops };
  }

  route(v1, BASE, {
    method: 'post',
    path: '/routes',
    tags: [TAG],
    summary: 'Create a route template (stops are planned/optimised on save)',
    auth: true,
    body: RouteIn.required({ stops: true }),
    status: 201,
    middleware: guard('routes:write'),
    responses: { 201: { description: 'Route', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO routes (tenant_id, name, description, profile, optimize_order, return_to_start, deviation_threshold_m, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [auth.tenantId, body.name, body.description ?? null, body.profile ?? 'car', body.optimize_order ?? false, body.return_to_start ?? false,
            body.deviation_threshold_m ?? 500, auth.userId],
        );
        await saveRouteStops(c, auth.tenantId!, r.rows[0]!.id, body);
        return routeDetail(c, r.rows[0]!.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/routes/:id',
    tags: [TAG],
    summary: 'Route template with stops and geometry',
    auth: true,
    params: IdParam,
    middleware: guard('routes:read'),
    responses: { 200: { description: 'Route', schema: AnyRow } },
    handler: async ({ req, params }) => tenantDb(req, (c) => routeDetail(c, params.id)),
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/routes/:id',
    tags: [TAG],
    summary: 'Update a route template (sending stops replaces them and re-plans)',
    auth: true,
    params: IdParam,
    body: RouteIn.partial(),
    middleware: guard('routes:write'),
    responses: { 200: { description: 'Route', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const cur = (await c.query<Row>('SELECT * FROM routes WHERE id = $1 AND deleted_at IS NULL', [params.id])).rows[0];
        if (!cur) throw notFound('Route');
        await c.query(
          `UPDATE routes SET name = coalesce($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END, profile = coalesce($5, profile),
             optimize_order = coalesce($6, optimize_order), return_to_start = coalesce($7, return_to_start),
             deviation_threshold_m = coalesce($8, deviation_threshold_m) WHERE id = $1`,
          [params.id, body.name ?? null, body.description !== undefined, body.description ?? null, body.profile ?? null, body.optimize_order ?? null,
            body.return_to_start ?? null, body.deviation_threshold_m ?? null],
        );
        if (body.stops)
          await saveRouteStops(c, auth.tenantId!, params.id, {
            name: String(cur.name), profile: body.profile ?? (cur.profile as 'car'), optimize_order: body.optimize_order ?? Boolean(cur.optimize_order),
            return_to_start: body.return_to_start ?? Boolean(cur.return_to_start), stops: body.stops,
          });
        return routeDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/routes/:id',
    tags: [TAG],
    summary: 'Delete a route template',
    auth: true,
    params: IdParam,
    middleware: guard('routes:write'),
    responses: { 204: { description: 'Deleted' } },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => {
        const r = await c.query('UPDATE routes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [params.id]);
        if (!r.rowCount) throw notFound('Route');
        return undefined;
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/routes/plan',
    tags: [TAG],
    summary: 'Preview a route: optimised order, road geometry, distance, duration and ETAs (nothing is saved)',
    auth: true,
    body: z.object({
      stops: z.array(z.object({ ...Point, service_minutes: z.number().int().min(0).max(1440).optional() })).min(2).max(100),
      optimize: z.boolean().optional(),
      profile: z.enum(PROFILES).optional(),
      return_to_start: z.boolean().optional(),
      depart_at: dt.optional(),
    }),
    middleware: guard('routes:read'),
    responses: { 200: { description: 'Plan', schema: AnyRow } },
    handler: async ({ body }) => {
      const plan = await planRoute(body.stops, {
        optimize: body.optimize ?? true, profile: body.profile, returnToStart: body.return_to_start,
        departAt: body.depart_at ? new Date(body.depart_at) : undefined,
      });
      return plan as unknown as Row;
    },
  });

  // ---------- jobs
  route(v1, BASE, {
    method: 'get',
    path: '/jobs',
    tags: [TAG],
    summary: 'List jobs (drivers see only their own)',
    auth: true,
    query: z.object({
      ...PageQuery,
      status: z.string().optional().describe('Comma-separated statuses, or "active" / "open"'),
      driver_id: z.uuid().optional(),
      vehicle_id: z.uuid().optional(),
      from: dt.optional(),
      to: dt.optional(),
      q: z.string().max(100).optional(),
      sort: z.string().optional(),
    }),
    middleware: guard('jobs:read'),
    responses: { 200: { description: 'Jobs', schema: ListOf } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const driverOnly = isDriver(auth) ? ((await myDriverId(c, auth)) ?? '00000000-0000-0000-0000-000000000000') : null;
        let statuses: string[] | null = null;
        if (query.status === 'active') statuses = ACTIVE;
        else if (query.status === 'open') statuses = ['draft', 'scheduled', ...ACTIVE];
        else if (query.status) statuses = query.status.split(',').filter((s) => (JOB_STATUSES as readonly string[]).includes(s));
        const sort = orderBy(query.sort, { scheduled_start: 'j.scheduled_start', created_at: 'j.created_at', priority: 'j.priority', reference: 'j.reference' },
          'j.scheduled_start DESC NULLS LAST, j.created_at DESC');
        const r = await c.query<Row>(
          `${JOB_SELECT.replace('FROM jobs j', ', count(*) OVER () AS total FROM jobs j')}
           WHERE j.deleted_at IS NULL AND ($1::text[] IS NULL OR j.status = ANY($1)) AND ($2::uuid IS NULL OR j.driver_id = $2)
             AND ($3::uuid IS NULL OR j.vehicle_id = $3) AND ($4::timestamptz IS NULL OR coalesce(j.scheduled_start, j.created_at) >= $4)
             AND ($5::timestamptz IS NULL OR coalesce(j.scheduled_start, j.created_at) < $5)
             AND ($6::text IS NULL OR j.reference ILIKE '%' || $6 || '%' OR j.title ILIKE '%' || $6 || '%' OR j.customer_name ILIKE '%' || $6 || '%')
           ORDER BY ${sort} LIMIT $7 OFFSET $8`,
          [statuses, driverOnly ?? query.driver_id ?? null, query.vehicle_id ?? null, query.from ?? null, query.to ?? null, query.q ?? null,
            query.page_size, (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/jobs/board',
    tags: [TAG],
    summary: 'Dispatch board: today\'s jobs grouped by status with live progress',
    auth: true,
    query: z.object({ date: z.iso.date().optional() }),
    middleware: guard('jobs:read', 'jobs:dispatch'),
    responses: { 200: { description: 'Board', schema: AnyRow } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const tz = (await c.query<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = app.current_tenant_id()')).rows[0]?.timezone ?? 'Africa/Nairobi';
        const rows = rowsOf(
          await c.query<Row>(
            `${JOB_SELECT} WHERE j.deleted_at IS NULL AND (j.status IN ('dispatched', 'in_progress')
               OR (coalesce(j.scheduled_start, j.created_at) AT TIME ZONE $1)::date = coalesce($2::date, (now() AT TIME ZONE $1)::date))
             ORDER BY j.priority = 'urgent' DESC, j.priority = 'high' DESC, j.scheduled_start NULLS LAST`,
            [tz, query.date ?? null],
          ),
        );
        const columns: Record<string, Row[]> = {};
        for (const s of JOB_STATUSES) columns[s] = [];
        for (const r of rows) columns[String(r.status)]!.push(r);
        const late = rows.filter((r) => r.scheduled_end && r.next_eta && new Date(String(r.next_eta)) > new Date(String(r.scheduled_end))).length;
        return { date: query.date ?? null, totals: { jobs: rows.length, late, off_route: rows.filter((r) => r.off_route_since).length }, columns };
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/jobs',
    tags: [TAG],
    summary: 'Create a job with stops (optionally from a route template), plan it and optionally dispatch it',
    auth: true,
    body: JobIn,
    status: 201,
    middleware: guard('jobs:write'),
    responses: { 201: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        await assertAssignable(c, body.vehicle_id, body.driver_id);
        const reference = body.reference ?? (await nextReference(c));
        let threshold = body.deviation_threshold_m;
        let stops = body.stops ?? [];
        if (body.route_id && !stops.length) {
          const rt = (await c.query<{ deviation_threshold_m: number }>('SELECT deviation_threshold_m FROM routes WHERE id = $1 AND deleted_at IS NULL', [body.route_id])).rows[0];
          if (!rt) throw unprocessable('Route not found', { route_id: body.route_id });
          threshold ??= rt.deviation_threshold_m;
          const day = body.scheduled_start ? body.scheduled_start.slice(0, 10) : new Date().toISOString().slice(0, 10);
          stops = (
            await c.query<{ name: string; lat: number; lng: number; poi_id: string | null; address: string | null; ws: string | null; we: string | null }>(
              `SELECT s.name, ST_Y(s.geom) AS lat, ST_X(s.geom) AS lng, s.poi_id, s.address,
                 CASE WHEN s.time_window_start IS NOT NULL THEN to_char((($2::date + s.time_window_start) AT TIME ZONE t.timezone), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS ws,
                 CASE WHEN s.time_window_end IS NOT NULL THEN to_char((($2::date + s.time_window_end) AT TIME ZONE t.timezone), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS we
               FROM route_stops s JOIN tenants t ON t.id = s.tenant_id WHERE s.route_id = $1 ORDER BY s.seq`,
              [body.route_id, day],
            )
          ).rows.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng, poi_id: s.poi_id, address: s.address, time_window_start: s.ws, time_window_end: s.we }));
        }
        let j;
        try {
          j = await c.query<{ id: string }>(
            `INSERT INTO jobs (tenant_id, reference, title, customer_name, customer_phone, vehicle_id, driver_id, route_id, priority, scheduled_start,
               scheduled_end, deviation_threshold_m, notes, created_by, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $10::timestamptz IS NOT NULL THEN 'scheduled' ELSE 'draft' END) RETURNING id`,
            [auth.tenantId, reference, body.title, body.customer_name ?? null, body.customer_phone ?? null, body.vehicle_id ?? null, body.driver_id ?? null,
              body.route_id ?? null, body.priority ?? 'normal', body.scheduled_start ?? null, body.scheduled_end ?? null, threshold ?? 500,
              body.notes ?? null, auth.userId],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw new AppError(409, 'duplicate_reference', `Job reference ${reference} already exists`);
          throw err;
        }
        const id = j.rows[0]!.id;
        await insertStops(c, auth.tenantId!, id, stops);
        await jobEvent(c, auth.tenantId!, id, 'created', { reference, stops: stops.length }, actorOf(auth));
        if (stops.length) await planJob(c, id, body.optimize ?? false);
        if (body.dispatch) {
          const job = rowsOf(await c.query<Row>(`${JOB_SELECT} WHERE j.id = $1`, [id]))[0]!;
          await setStatus(c, auth, job, 'dispatched');
          await jobEvent(c, auth.tenantId!, id, 'assigned', { driver_id: body.driver_id, vehicle_id: body.vehicle_id ?? null }, actorOf(auth));
        }
        await broadcast(c, auth.tenantId!, id, 'created');
        await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'job.created', entityType: 'job', entityId: id, req });
        return jobDetail(c, id);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/jobs/:id',
    tags: [TAG],
    summary: 'Job detail with stops, planned route and proof of delivery',
    auth: true,
    params: IdParam,
    middleware: guard('jobs:read'),
    responses: { 200: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => jobDetail(c, params.id, await loadJob(c, auth, params.id, false)));
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/jobs/:id',
    tags: [TAG],
    summary: 'Update job details / reassign driver or vehicle',
    auth: true,
    params: IdParam,
    body: JobPatch,
    middleware: guard('jobs:write'),
    responses: { 200: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        const job = await loadJob(c, auth, params.id, true);
        if (CLOSED.includes(String(job.status))) throw unprocessable(`A ${String(job.status)} job cannot be edited`);
        await assertAssignable(c, body.vehicle_id, body.driver_id);
        const sets: string[] = [];
        const vals: unknown[] = [params.id];
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined) continue;
          vals.push(v);
          sets.push(`${k} = $${vals.length}`);
        }
        if (sets.length) await c.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $1`, vals);
        const reassigned = (body.driver_id !== undefined && body.driver_id !== job.driver_id) || (body.vehicle_id !== undefined && body.vehicle_id !== job.vehicle_id);
        if (reassigned) {
          await jobEvent(c, auth.tenantId!, params.id, 'assigned', { driver_id: body.driver_id ?? job.driver_id, vehicle_id: body.vehicle_id ?? job.vehicle_id, previous_driver_id: job.driver_id }, actorOf(auth));
          if (job.driver_id && body.driver_id !== undefined && body.driver_id !== job.driver_id) {
            const prev = (await c.query<{ user_id: string | null }>('SELECT user_id FROM drivers WHERE id = $1', [job.driver_id])).rows[0];
            if (prev?.user_id) await redis.publish(`rt:user:${prev.user_id}`, JSON.stringify({ type: 'job', kind: 'unassigned', job_id: params.id }));
          }
        }
        if (body.vehicle_id !== undefined || body.scheduled_start !== undefined) await planJob(c, params.id, false);
        await broadcast(c, auth.tenantId!, params.id, 'updated');
        return jobDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/jobs/:id',
    tags: [TAG],
    summary: 'Delete a draft, cancelled or failed job',
    auth: true,
    params: IdParam,
    middleware: guard('jobs:write'),
    responses: { 204: { description: 'Deleted' } },
    handler: async ({ req, params }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        const job = await loadJob(c, auth, params.id, true);
        if (!['draft', 'cancelled', 'failed'].includes(String(job.status))) throw unprocessable('Cancel the job before deleting it');
        await c.query('UPDATE jobs SET deleted_at = now() WHERE id = $1', [params.id]);
        await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'job.deleted', entityType: 'job', entityId: params.id, req });
        return undefined;
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/jobs/:id/plan',
    tags: [TAG],
    summary: 'Re-plan the job route and ETAs (optionally optimising stop order)',
    auth: true,
    params: IdParam,
    body: z.object({ optimize: z.boolean().optional() }),
    middleware: guard('jobs:write'),
    responses: { 200: { description: 'Job with plan', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        await loadJob(c, auth, params.id, true);
        const plan = await planJob(c, params.id, body.optimize ?? true);
        await broadcast(c, auth.tenantId!, params.id, 'planned');
        return { ...(await jobDetail(c, params.id)), plan };
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/jobs/:id/dispatch',
    tags: [TAG],
    summary: 'Dispatch the job to its driver (optionally assigning driver/vehicle first)',
    auth: true,
    params: IdParam,
    body: z.object({ driver_id: z.uuid().optional(), vehicle_id: z.uuid().optional() }),
    middleware: guard('jobs:dispatch'),
    responses: { 200: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        await loadJob(c, auth, params.id, true);
        await assertAssignable(c, body.vehicle_id, body.driver_id);
        if (body.driver_id || body.vehicle_id)
          await c.query('UPDATE jobs SET driver_id = coalesce($2, driver_id), vehicle_id = coalesce($3, vehicle_id) WHERE id = $1', [params.id, body.driver_id ?? null, body.vehicle_id ?? null]);
        const job = rowsOf(await c.query<Row>(`${JOB_SELECT} WHERE j.id = $1`, [params.id]))[0]!;
        await setStatus(c, auth, job, 'dispatched');
        await jobEvent(c, auth.tenantId!, params.id, 'assigned', { driver_id: job.driver_id, vehicle_id: job.vehicle_id }, actorOf(auth));
        await planJob(c, params.id, false);
        await broadcast(c, auth.tenantId!, params.id, 'dispatched');
        return jobDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/jobs/:id/status',
    tags: [TAG],
    summary: 'Change job status (drivers may start, complete or fail their own jobs)',
    auth: true,
    params: IdParam,
    body: z.object({ status: z.enum(JOB_STATUSES), reason: z.string().trim().max(500).nullable().optional() }),
    middleware: guard('jobs:read'),
    responses: { 200: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      if (isDriver(auth) && !['in_progress', 'completed', 'failed'].includes(body.status)) throw forbidden('Drivers can only start, complete or fail a job');
      if (!isDriver(auth) && !auth.permissions.has('jobs:write')) throw forbidden();
      return tenantDb(req, async (c) => {
        const job = await loadJob(c, auth, params.id, true);
        if (body.status === 'failed' && !body.reason) throw unprocessable('Give a reason when marking a job as failed');
        await setStatus(c, auth, job, body.status, body.reason);
        await broadcast(c, auth.tenantId!, params.id, 'status');
        return jobDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/jobs/:id/events',
    tags: [TAG],
    summary: 'Job timeline (status changes, arrivals, deviations, ETA updates, POD)',
    auth: true,
    params: IdParam,
    middleware: guard('jobs:read'),
    responses: { 200: { description: 'Events', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await loadJob(c, auth, params.id, false);
        return {
          data: await listRows(
            c,
            `SELECT e.id, e.event_type, e.job_stop_id, s.name AS stop_name, e.occurred_at, e.lat, e.lng, e.details, e.actor_type, e.actor_id, u.full_name AS actor_name
             FROM job_events e LEFT JOIN job_stops s ON s.id = e.job_stop_id LEFT JOIN users u ON u.id = e.actor_id
             WHERE e.job_id = $1 ORDER BY e.occurred_at, e.id`,
            [params.id],
          ),
        };
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/jobs/:id/notes',
    tags: [TAG],
    summary: 'Add a note to the job timeline',
    auth: true,
    params: IdParam,
    body: z.object({ note: z.string().trim().min(1).max(2000), lat: z.number().optional(), lng: z.number().optional() }),
    status: 201,
    middleware: guard('jobs:read'),
    responses: { 201: { description: 'Added', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await loadJob(c, auth, params.id, true);
        await jobEvent(c, auth.tenantId!, params.id, 'note', { note: body.note }, actorOf(auth), null, body);
        return { ok: true };
      });
    },
  });

  // ---------- stops
  route(v1, BASE, {
    method: 'post',
    path: '/jobs/:id/stops',
    tags: [TAG],
    summary: 'Append stops to a job (re-plans ETAs)',
    auth: true,
    params: IdParam,
    body: z.object({ stops: z.array(JobStopIn).min(1).max(100), optimize: z.boolean().optional() }),
    status: 201,
    middleware: guard('jobs:write'),
    responses: { 201: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        const job = await loadJob(c, auth, params.id, true);
        if (CLOSED.includes(String(job.status))) throw unprocessable('Stops cannot be added to a closed job');
        const max = (await c.query<{ m: number }>('SELECT coalesce(max(seq), 0)::int AS m FROM job_stops WHERE job_id = $1', [params.id])).rows[0]!.m;
        await insertStops(c, auth.tenantId!, params.id, body.stops, max + 1);
        await planJob(c, params.id, body.optimize ?? false);
        await broadcast(c, auth.tenantId!, params.id, 'stops');
        return jobDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/jobs/:id/stops/:stopId',
    tags: [TAG],
    summary: 'Edit a stop',
    auth: true,
    params: StopParam,
    body: JobStopIn.partial().extend({ seq: z.number().int().min(1).optional() }),
    middleware: guard('jobs:write'),
    responses: { 200: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        await loadJob(c, auth, params.id, true);
        const s = (await c.query<{ seq: number; status: string }>('SELECT seq, status FROM job_stops WHERE id = $1 AND job_id = $2', [params.stopId, params.id])).rows[0];
        if (!s) throw notFound('Stop');
        if (body.seq && body.seq !== s.seq) {
          await c.query('SET CONSTRAINTS job_stops_seq_unique DEFERRED');
          await c.query(
            `UPDATE job_stops SET seq = CASE WHEN id = $2 THEN $3 WHEN $3 < $4 AND seq >= $3 AND seq < $4 THEN seq + 1
               WHEN $3 > $4 AND seq <= $3 AND seq > $4 THEN seq - 1 ELSE seq END WHERE job_id = $1`,
            [params.id, params.stopId, body.seq, s.seq],
          );
        }
        const sets: string[] = [];
        const vals: unknown[] = [params.stopId];
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined || ['seq', 'lat', 'lng', 'service_minutes'].includes(k)) continue;
          vals.push(k === 'items' ? JSON.stringify(v) : v);
          sets.push(`${k} = $${vals.length}`);
        }
        if (body.lat !== undefined && body.lng !== undefined) {
          vals.push(body.lng, body.lat);
          sets.push(`geom = ST_SetSRID(ST_MakePoint($${vals.length - 1}, $${vals.length}), 4326)`);
        }
        if (sets.length) await c.query(`UPDATE job_stops SET ${sets.join(', ')} WHERE id = $1`, vals);
        await planJob(c, params.id, false);
        await broadcast(c, auth.tenantId!, params.id, 'stops');
        return jobDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/jobs/:id/stops/:stopId',
    tags: [TAG],
    summary: 'Remove a pending stop',
    auth: true,
    params: StopParam,
    middleware: guard('jobs:write'),
    responses: { 204: { description: 'Removed' } },
    handler: async ({ req, params }) => {
      const auth = staffOnly(req);
      return tenantDb(req, async (c) => {
        await loadJob(c, auth, params.id, true);
        const r = await c.query<{ seq: number }>(`DELETE FROM job_stops WHERE id = $1 AND job_id = $2 AND status = 'pending' RETURNING seq`, [params.stopId, params.id]);
        if (!r.rowCount) throw unprocessable('Only pending stops can be removed');
        await c.query('SET CONSTRAINTS job_stops_seq_unique DEFERRED');
        await c.query('UPDATE job_stops SET seq = seq - 1 WHERE job_id = $1 AND seq > $2', [params.id, r.rows[0]!.seq]);
        await planJob(c, params.id, false);
        await broadcast(c, auth.tenantId!, params.id, 'stops');
        return undefined;
      });
    },
  });

  const StopAction = z.object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    at: dt.optional(),
    reason: z.string().trim().max(500).optional(),
    pod: Pod.optional(),
  });
  const STOP_NEXT: Record<string, string[]> = {
    arrive: ['pending', 'en_route'],
    complete: ['pending', 'en_route', 'arrived'],
    fail: ['pending', 'en_route', 'arrived'],
    skip: ['pending', 'en_route'],
    reopen: ['completed', 'failed', 'skipped'],
  };

  async function savePod(c: PoolClient, auth: AuthContext, jobId: string, stopId: string, pod: z.infer<typeof Pod>, driverId: string | null): Promise<void> {
    await assertFile(c, pod.signature_file_id, ['proof_of_delivery']);
    for (const f of pod.photo_file_ids ?? []) await assertFile(c, f, ['proof_of_delivery']);
    await c.query(
      `INSERT INTO proof_of_delivery (tenant_id, job_stop_id, recipient_name, recipient_phone, signature_file_id, photo_file_ids, notes, lat, lng, captured_at, driver_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (job_stop_id) DO UPDATE SET recipient_name = EXCLUDED.recipient_name, recipient_phone = EXCLUDED.recipient_phone,
         signature_file_id = EXCLUDED.signature_file_id, photo_file_ids = EXCLUDED.photo_file_ids, notes = EXCLUDED.notes, lat = EXCLUDED.lat,
         lng = EXCLUDED.lng, captured_at = EXCLUDED.captured_at, driver_id = EXCLUDED.driver_id`,
      [auth.tenantId, stopId, pod.recipient_name, pod.recipient_phone ?? null, pod.signature_file_id ?? null, pod.photo_file_ids ?? [], pod.notes ?? null,
        pod.lat ?? null, pod.lng ?? null, pod.captured_at ?? new Date().toISOString(), driverId],
    );
    await jobEvent(c, auth.tenantId!, jobId, 'pod_captured', { recipient: pod.recipient_name, photos: pod.photo_file_ids?.length ?? 0, signed: Boolean(pod.signature_file_id) },
      actorOf(auth), stopId, pod);
  }

  route(v1, BASE, {
    method: 'post',
    path: '/jobs/:id/stops/:stopId/:action',
    tags: [TAG],
    summary: 'Stop workflow: arrive, complete (with optional POD), fail (with reason), skip or reopen',
    description: 'Available to dispatch staff and to the assigned driver. Completing the last open stop completes the job.',
    auth: true,
    params: StopParam.extend({ action: z.enum(['arrive', 'complete', 'fail', 'skip', 'reopen']) }),
    body: StopAction,
    middleware: guard('jobs:read'),
    responses: { 200: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      if (!isDriver(auth) && !auth.permissions.has('jobs:write')) throw forbidden();
      if (isDriver(auth) && params.action === 'reopen') throw forbidden('Ask your dispatcher to reopen a stop');
      return tenantDb(req, async (c) => {
        const job = await loadJob(c, auth, params.id, true);
        if (!ACTIVE.includes(String(job.status)) && params.action !== 'reopen')
          throw unprocessable('The job must be dispatched before its stops can be updated');
        const s = (await c.query<{ status: string }>('SELECT status FROM job_stops WHERE id = $1 AND job_id = $2', [params.stopId, params.id])).rows[0];
        if (!s) throw notFound('Stop');
        if (!STOP_NEXT[params.action]!.includes(s.status)) throw unprocessable(`Cannot ${params.action} a ${s.status} stop`);
        if (params.action === 'fail' && !body.reason) throw unprocessable('Give a reason for the failed stop');
        const at = body.at ?? new Date().toISOString();
        if (job.status === 'dispatched' && params.action !== 'reopen') await setStatus(c, auth, job, 'in_progress');
        const statusMap = { arrive: 'arrived', complete: 'completed', fail: 'failed', skip: 'skipped', reopen: 'pending' } as const;
        await c.query(
          `UPDATE job_stops SET status = $2,
             arrived_at = CASE WHEN $2 = 'arrived' THEN $3 WHEN $2 = 'completed' THEN coalesce(arrived_at, $3) WHEN $2 = 'pending' THEN NULL ELSE arrived_at END,
             departed_at = CASE WHEN $2 IN ('completed', 'failed') THEN greatest($3, coalesce(arrived_at, $3)) WHEN $2 = 'pending' THEN NULL ELSE departed_at END,
             failure_reason = CASE WHEN $2 IN ('failed', 'skipped') THEN $4 WHEN $2 = 'pending' THEN NULL ELSE failure_reason END
           WHERE id = $1`,
          [params.stopId, statusMap[params.action], at, body.reason ?? null],
        );
        const evType = params.action === 'arrive' ? 'arrived' : params.action === 'complete' || params.action === 'fail' ? 'departed' : 'note';
        await jobEvent(c, auth.tenantId!, params.id, evType, { action: params.action, reason: body.reason ?? null }, actorOf(auth), params.stopId, body);
        if (body.pod) await savePod(c, auth, params.id, params.stopId, body.pod, (job.driver_id as string | null) ?? null);
        if (params.action === 'reopen' && CLOSED.includes(String(job.status))) {
          await c.query(`UPDATE jobs SET status = 'in_progress', actual_end = NULL WHERE id = $1`, [params.id]);
          await jobEvent(c, auth.tenantId!, params.id, 'status_change', { from: job.status, to: 'in_progress', reason: 'stop reopened' }, actorOf(auth));
        }
        await c.query(
          `UPDATE jobs SET progress_pct = (SELECT round(100.0 * count(*) FILTER (WHERE status IN ('completed', 'failed', 'skipped')) / greatest(count(*), 1), 2)
             FROM job_stops WHERE job_id = $1) WHERE id = $1`,
          [params.id],
        );
        await autoComplete(c, auth, params.id);
        if (params.action !== 'arrive') await planJob(c, params.id, false);
        await broadcast(c, auth.tenantId!, params.id, `stop_${params.action}`);
        return jobDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'put',
    path: '/jobs/:id/stops/:stopId/pod',
    tags: [TAG],
    summary: 'Capture or replace proof of delivery (recipient, signature, photos)',
    auth: true,
    params: StopParam,
    body: Pod,
    middleware: guard('jobs:read'),
    responses: { 200: { description: 'Job', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      if (!isDriver(auth) && !auth.permissions.has('jobs:write')) throw forbidden();
      return tenantDb(req, async (c) => {
        const job = await loadJob(c, auth, params.id, true);
        const s = await c.query('SELECT 1 FROM job_stops WHERE id = $1 AND job_id = $2', [params.stopId, params.id]);
        if (!s.rowCount) throw notFound('Stop');
        await savePod(c, auth, params.id, params.stopId, body, (job.driver_id as string | null) ?? null);
        await broadcast(c, auth.tenantId!, params.id, 'pod');
        return jobDetail(c, params.id);
      });
    },
  });

  // ---------- driver app
  route(v1, BASE, {
    method: 'get',
    path: '/jobs/my/current',
    tags: [TAG],
    summary: 'Driver app: my active and upcoming jobs with stops',
    auth: true,
    middleware: guard('driver_app:use'),
    responses: { 200: { description: 'Jobs', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const me = await myDriverId(c, auth);
        if (!me) return { data: [] };
        const jobs = rowsOf(
          await c.query<Row>(
            `${JOB_SELECT} WHERE j.deleted_at IS NULL AND j.driver_id = $1 AND (j.status IN ('dispatched', 'in_progress')
               OR (j.status = 'scheduled' AND j.scheduled_start < now() + interval '2 days')
               OR (j.status = 'completed' AND j.actual_end > now() - interval '12 hours'))
             ORDER BY j.status = 'in_progress' DESC, j.status = 'dispatched' DESC, j.scheduled_start NULLS LAST LIMIT 50`,
            [me],
          ),
        );
        const out: Row[] = [];
        for (const j of jobs) out.push(await jobDetail(c, String(j.id), j));
        return { data: out };
      });
    },
  });
}
