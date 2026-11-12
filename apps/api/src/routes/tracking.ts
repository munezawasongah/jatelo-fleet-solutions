import type { Router } from 'express';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { randomToken, sha256 } from '../auth/crypto.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { config } from '../config.js';
import { paged, PageQuery, Pagination } from '../http/crud.js';
import { AppError, notFound, unprocessable } from '../http/errors.js';
import { rateLimit } from '../http/rate-limit.js';
import { AnyRow, ListOf, listRows, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { systemPool } from '../infra/db.js';
import { visibleVehicle } from './vehicles.js';

const BASE = '/api/v1';
const dt = z.iso.datetime({ offset: true });
const MAX_RANGE_MS = 7 * 86_400_000;

function range(from?: string, to?: string, maxMs = 31 * 86_400_000): [Date, Date] {
  const b = to ? new Date(to) : new Date();
  const a = from ? new Date(from) : new Date(b.getTime() - 86_400_000);
  if (b <= a) throw unprocessable('"to" must be after "from"');
  if (b.getTime() - a.getTime() > maxMs)
    throw unprocessable(`The period can be at most ${Math.round(maxMs / 86_400_000)} days`);
  return [a, b];
}

const LiveVehicle = z.object({
  vehicle_id: z.string(),
  plate_number: z.string(),
  label: z.string().nullable(),
  icon: z.string(),
  group_id: z.string().nullable(),
  group_name: z.string().nullable(),
  driver_name: z.string().nullable(),
  device_id: z.string().nullable(),
  state: z.string(),
  state_since: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  speed_kph: z.number().nullable(),
  heading: z.number().nullable(),
  ignition: z.boolean().nullable(),
  fuel_level_pct: z.number().nullable(),
  ext_voltage_mv: z.number().nullable(),
  gsm_signal: z.number().nullable(),
  odometer_km: z.number().nullable(),
  open_alerts: z.number(),
});

export function registerTrackingRoutes(v1: Router): void {
  // ---------------------------------------------------------------- live snapshot
  route(v1, BASE, {
    method: 'get',
    path: '/tracking/live',
    tags: ['Tracking'],
    summary: 'Latest position and status of every vehicle',
    description:
      'Initial map load; afterwards subscribe to the Socket.IO "position"/"status" events for updates.',
    auth: true,
    query: z.object({
      group_id: z.uuid().optional(),
      state: z.enum(['moving', 'idle', 'stopped', 'offline', 'never', 'no_device']).optional(),
    }),
    middleware: guard('tracking:read'),
    responses: {
      200: {
        description: 'Vehicles',
        schema: z.object({ data: z.array(LiveVehicle), counts: z.record(z.string(), z.number()) }),
      },
    },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const rows = await listRows(
          c,
          `SELECT v.id AS vehicle_id, v.plate_number, v.label, v.icon, v.group_id, g.name AS group_name, dr.full_name AS driver_name,
             d.id AS device_id, CASE WHEN d.id IS NULL THEN 'no_device' ELSE coalesce(ds.state, 'never') END AS state,
             ds.state_since, ds.last_seen_at, ds.lat, ds.lng, ds.speed_kph, ds.heading, ds.ignition, ds.fuel_level_pct,
             ds.ext_voltage_mv, ds.gsm_signal, coalesce(ds.odometer_km, v.odometer_km) AS odometer_km,
             (SELECT count(*) FROM alerts a WHERE a.vehicle_id = v.id AND a.status = 'open') AS open_alerts
           FROM vehicles v
           LEFT JOIN vehicle_groups g ON g.id = v.group_id
           LEFT JOIN device_assignments da ON da.vehicle_id = v.id AND da.unassigned_at IS NULL
           LEFT JOIN devices d ON d.id = da.device_id
           LEFT JOIN device_status ds ON ds.device_id = d.id
           LEFT JOIN driver_vehicle_assignments dva ON dva.vehicle_id = v.id AND dva.ends_at IS NULL AND dva.starts_at <= now()
           LEFT JOIN drivers dr ON dr.id = dva.driver_id
           WHERE v.deleted_at IS NULL AND v.status <> 'sold' AND v.status <> 'written_off'
             AND ($1::uuid[] IS NULL OR v.group_id = ANY($1)) AND ($2::uuid IS NULL OR v.group_id = $2)
           ORDER BY v.plate_number`,
          [scope, query.group_id ?? null],
        );
        const data = query.state ? rows.filter((r) => r.state === query.state) : rows;
        const counts: Record<string, number> = { total: rows.length };
        for (const r of rows) counts[String(r.state)] = (counts[String(r.state)] ?? 0) + 1;
        return { data, counts };
      });
    },
  });

  // ---------------------------------------------------------------- playback
  route(v1, BASE, {
    method: 'get',
    path: '/vehicles/:id/positions',
    tags: ['Tracking'],
    summary: 'Position history for playback (max 7 days)',
    description: 'Compact columnar arrays. Use with /trips and /stops for the timeline.',
    auth: true,
    params: z.object({ id: z.uuid() }),
    query: z.object({
      from: dt.optional(),
      to: dt.optional(),
      valid_only: z.enum(['true', 'false']).default('true'),
    }),
    middleware: guard('trips:read'),
    responses: { 200: { description: 'Positions', schema: AnyRow } },
    handler: async ({ req, params, query }) => {
      const auth = requireAuth(req);
      const [a, b] = range(query.from, query.to, MAX_RANGE_MS);
      return tenantDb(req, async (c) => {
        await visibleVehicle(c, params.id, await groupScope(c, auth.userId));
        const r = await c.query<{
          t: Date;
          lat: number;
          lng: number;
          s: number;
          h: number | null;
          i: boolean | null;
          o: string | null;
          f: number | null;
        }>(
          `SELECT recorded_at AS t, lat, lng, speed_kph AS s, heading AS h, ignition AS i, odometer_km AS o, fuel_level_pct AS f
           FROM gps_points WHERE vehicle_id = $1 AND recorded_at >= $2 AND recorded_at < $3 ${query.valid_only === 'true' ? 'AND is_valid' : ''}
           ORDER BY recorded_at LIMIT 100000`,
          [params.id, a, b],
        );
        const p = r.rows;
        return {
          vehicle_id: params.id,
          from: a.toISOString(),
          to: b.toISOString(),
          count: p.length,
          t: p.map((x) => x.t.getTime()),
          lat: p.map((x) => x.lat),
          lng: p.map((x) => x.lng),
          speed: p.map((x) => x.s),
          heading: p.map((x) => x.h),
          ignition: p.map((x) => x.i),
          odometer_km: p.map((x) => (x.o === null ? null : Number(x.o))),
          fuel_pct: p.map((x) => x.f),
        };
      });
    },
  });

  // ---------------------------------------------------------------- trips
  const TRIP_SELECT = `SELECT t.*, v.plate_number, dr.full_name AS driver_name,
      sp.name AS start_place, ep.name AS end_place
    FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN drivers dr ON dr.id = t.driver_id
    LEFT JOIN LATERAL (SELECT p.name FROM pois p WHERE p.deleted_at IS NULL AND ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint(t.start_lng, t.start_lat),4326)::geography, p.radius_m) LIMIT 1) sp ON true
    LEFT JOIN LATERAL (SELECT p.name FROM pois p WHERE p.deleted_at IS NULL AND t.end_lat IS NOT NULL AND ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint(t.end_lng, t.end_lat),4326)::geography, p.radius_m) LIMIT 1) ep ON true`;

  route(v1, BASE, {
    method: 'get',
    path: '/trips',
    tags: ['Tracking'],
    summary: 'List trips',
    auth: true,
    query: z.object({
      ...PageQuery,
      vehicle_id: z.uuid().optional(),
      driver_id: z.uuid().optional(),
      from: dt.optional(),
      to: dt.optional(),
      in_progress: z.enum(['true', 'false']).optional(),
    }),
    middleware: guard('trips:read'),
    responses: { 200: { description: 'Trips', schema: ListOf } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      const [a, b] = range(query.from, query.to);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const r = await c.query<Row>(
          `SELECT x.*, count(*) OVER() AS total FROM (${TRIP_SELECT}
             WHERE t.started_at >= $1 AND t.started_at < $2 AND ($3::uuid IS NULL OR t.vehicle_id = $3) AND ($4::uuid IS NULL OR t.driver_id = $4)
               AND ($5::uuid[] IS NULL OR v.group_id = ANY($5)) AND ($6::bool IS NULL OR (t.ended_at IS NULL) = $6)) x
           ORDER BY x.started_at DESC LIMIT $7 OFFSET $8`,
          [
            a,
            b,
            query.vehicle_id ?? null,
            query.driver_id ?? null,
            scope,
            query.in_progress ? query.in_progress === 'true' : null,
            query.page_size,
            (query.page - 1) * query.page_size,
          ],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/trips/:id',
    tags: ['Tracking'],
    summary: 'Trip with route, events and the stop it ended in',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('trips:read'),
    responses: { 200: { description: 'Trip', schema: AnyRow } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const trip = rowsOf(await c.query<Row>(`${TRIP_SELECT} WHERE t.id = $1`, [params.id]))[0];
        if (!trip) throw notFound('Trip');
        await visibleVehicle(c, String(trip.vehicle_id), await groupScope(c, auth.userId));
        const events = await listRows(
          c,
          'SELECT id, event_type, severity, occurred_at, ended_at, duration_s, lat, lng, speed_kph, speed_limit_kph, value FROM driving_events WHERE trip_id = $1 ORDER BY occurred_at',
          [params.id],
        );
        const end = trip.ended_at ? new Date(String(trip.ended_at)) : new Date();
        const pts = await c.query<{ t: Date; lat: number; lng: number; s: number }>(
          'SELECT recorded_at AS t, lat, lng, speed_kph AS s FROM gps_points WHERE vehicle_id = $1 AND recorded_at BETWEEN $2 AND $3 AND is_valid ORDER BY recorded_at LIMIT 50000',
          [trip.vehicle_id, trip.started_at, end],
        );
        return { ...trip, events, points: pts.rows.map((p) => [p.t.getTime(), p.lat, p.lng, p.s]) };
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/trips/:id',
    tags: ['Tracking'],
    summary: 'Classify a trip (business/private) or add notes',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({
      purpose: z.enum(['business', 'private', 'commute', 'unknown']).optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }),
    middleware: guard('trips:annotate'),
    responses: { 200: { description: 'Updated', schema: AnyRow } },
    handler: async ({ req, params, body }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          'UPDATE trips SET purpose = coalesce($2, purpose), notes = CASE WHEN $4 THEN $3 ELSE notes END WHERE id = $1 RETURNING id, purpose, notes',
          [params.id, body.purpose ?? null, body.notes ?? null, body.notes !== undefined],
        );
        if (!r.rowCount) throw notFound('Trip');
        return rowsOf(r)[0];
      }),
  });

  route(v1, BASE, {
    method: 'get',
    path: '/stops',
    tags: ['Tracking'],
    summary: 'List stops (parked / idling)',
    auth: true,
    query: z.object({
      ...PageQuery,
      vehicle_id: z.uuid().optional(),
      from: dt.optional(),
      to: dt.optional(),
      min_minutes: z.coerce.number().int().min(0).default(0),
    }),
    middleware: guard('trips:read'),
    responses: { 200: { description: 'Stops', schema: ListOf } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      const [a, b] = range(query.from, query.to);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const r = await c.query<Row>(
          `SELECT s.id, s.vehicle_id, v.plate_number, s.driver_id, s.trip_id, s.started_at, s.ended_at,
             coalesce(s.duration_s, extract(epoch FROM now() - s.started_at)::int) AS duration_s, s.lat, s.lng, s.ignition_on,
             p.id AS poi_id, p.name AS poi_name, p.category AS poi_category, count(*) OVER() AS total
           FROM stops s JOIN vehicles v ON v.id = s.vehicle_id LEFT JOIN pois p ON p.id = s.poi_id
           WHERE s.started_at >= $1 AND s.started_at < $2 AND ($3::uuid IS NULL OR s.vehicle_id = $3) AND ($4::uuid[] IS NULL OR v.group_id = ANY($4))
             AND coalesce(s.duration_s, extract(epoch FROM now() - s.started_at)) >= $5 * 60
           ORDER BY s.started_at DESC LIMIT $6 OFFSET $7`,
          [
            a,
            b,
            query.vehicle_id ?? null,
            scope,
            query.min_minutes,
            query.page_size,
            (query.page - 1) * query.page_size,
          ],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      });
    },
  });

  // ---------------------------------------------------------------- driving events
  route(v1, BASE, {
    method: 'get',
    path: '/driving-events',
    tags: ['Driver behaviour'],
    summary: 'List driving events',
    auth: true,
    query: z.object({
      ...PageQuery,
      vehicle_id: z.uuid().optional(),
      driver_id: z.uuid().optional(),
      event_type: z.string().max(40).optional(),
      severity: z.enum(['low', 'medium', 'high']).optional(),
      reviewed: z.enum(['true', 'false']).optional(),
      from: dt.optional(),
      to: dt.optional(),
    }),
    middleware: guard('trips:read'),
    responses: { 200: { description: 'Events', schema: ListOf } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      const [a, b] = range(query.from, query.to, 92 * 86_400_000);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const r = await c.query<Row>(
          `SELECT e.*, v.plate_number, dr.full_name AS driver_name, count(*) OVER() AS total
           FROM driving_events e LEFT JOIN vehicles v ON v.id = e.vehicle_id LEFT JOIN drivers dr ON dr.id = e.driver_id
           WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND ($3::uuid IS NULL OR e.vehicle_id = $3) AND ($4::uuid IS NULL OR e.driver_id = $4)
             AND ($5::text IS NULL OR e.event_type = $5) AND ($6::text IS NULL OR e.severity = $6) AND ($7::bool IS NULL OR (e.reviewed_at IS NOT NULL) = $7)
             AND ($8::uuid[] IS NULL OR v.group_id = ANY($8))
           ORDER BY e.occurred_at DESC LIMIT $9 OFFSET $10`,
          [
            a,
            b,
            query.vehicle_id ?? null,
            query.driver_id ?? null,
            query.event_type ?? null,
            query.severity ?? null,
            query.reviewed ? query.reviewed === 'true' : null,
            scope,
            query.page_size,
            (query.page - 1) * query.page_size,
          ],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/driving-events/:id/review',
    tags: ['Driver behaviour'],
    summary: 'Mark a driving event as reviewed (coaching note)',
    auth: true,
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ note: z.string().trim().max(1000).optional() }),
    middleware: guard('events:review'),
    responses: { 200: { description: 'Reviewed', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          'UPDATE driving_events SET reviewed_at = now(), reviewed_by = $2, review_note = $3 WHERE id = $1 RETURNING id, reviewed_at, review_note',
          [params.id, auth.userId, body.note ?? null],
        );
        if (!r.rowCount) throw notFound('Event');
        return rowsOf(r)[0];
      });
    },
  });

  // ---------------------------------------------------------------- share links
  route(v1, BASE, {
    method: 'post',
    path: '/share-links',
    tags: ['Tracking'],
    summary: 'Create a time-limited live tracking link for a customer',
    auth: true,
    body: z
      .object({
        vehicle_id: z.uuid().optional(),
        job_id: z.uuid().optional(),
        hours: z.number().min(0.25).max(720).default(4),
        label: z.string().trim().max(120).optional(),
      })
      .refine(
        (b) => Boolean(b.vehicle_id) !== Boolean(b.job_id),
        'Provide exactly one of vehicle_id or job_id',
      ),
    status: 201,
    middleware: guard('share_links:create'),
    responses: { 201: { description: 'Link (the token is shown only once)', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const token = randomToken(24);
      return tenantDb(req, async (c) => {
        if (body.vehicle_id)
          await visibleVehicle(c, body.vehicle_id, await groupScope(c, auth.userId));
        const r = await c.query<Row>(
          `INSERT INTO share_links (tenant_id, token_hash, vehicle_id, job_id, label, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7) RETURNING id, vehicle_id, job_id, label, expires_at, created_at`,
          [
            auth.tenantId,
            sha256(token),
            body.vehicle_id ?? null,
            body.job_id ?? null,
            body.label ?? null,
            Math.round(body.hours * 3600),
            auth.userId,
          ],
        );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'share_link.created',
          entityType: 'share_link',
          entityId: String(r.rows[0]!.id),
          req,
        });
        return { ...rowsOf(r)[0], token, url: `${config.WEB_APP_URL}/share/${token}` };
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/share-links',
    tags: ['Tracking'],
    summary: 'List share links',
    auth: true,
    query: z.object({ ...PageQuery, active: z.enum(['true', 'false']).optional() }),
    middleware: guard('share_links:create'),
    responses: { 200: { description: 'Links', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT s.id, s.vehicle_id, v.plate_number, s.job_id, j.reference AS job_reference, s.label, s.expires_at, s.revoked_at, s.view_count,
             s.last_viewed_at, s.created_at, (s.revoked_at IS NULL AND s.expires_at > now()) AS active, count(*) OVER() AS total
           FROM share_links s LEFT JOIN vehicles v ON v.id = s.vehicle_id LEFT JOIN jobs j ON j.id = s.job_id
           WHERE ($1::bool IS NULL OR (s.revoked_at IS NULL AND s.expires_at > now()) = $1)
           ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
          [
            query.active ? query.active === 'true' : null,
            query.page_size,
            (query.page - 1) * query.page_size,
          ],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/share-links/:id',
    tags: ['Tracking'],
    summary: 'Revoke a share link',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('share_links:create'),
    responses: { 204: { description: 'Revoked' } },
    handler: async ({ req, params }) => {
      await tenantDb(req, async (c) => {
        if (
          !(
            await c.query(
              'UPDATE share_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
              [params.id],
            )
          ).rowCount
        )
          throw notFound('Share link');
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/public/share/:token',
    tags: ['Public'],
    summary: 'Live location behind a share link (no login)',
    description:
      'Returns only the vehicle position (and job stops/ETAs for job links). Poll every 10-15 s or use Socket.IO with {share: token}.',
    params: z.object({ token: z.string().min(20).max(80) }),
    middleware: [rateLimit({ keyPrefix: 'share', points: 120, durationSec: 60 })],
    responses: { 200: { description: 'Shared location', schema: AnyRow } },
    handler: async ({ params }) => {
      const {
        tenant_id: _tenant,
        vehicle_id: _vehicle,
        ...view
      } = await resolveShare(params.token, true);
      return view;
    },
  });
}

/** Resolves a share token to the public view. Used by the REST endpoint and Socket.IO. */
export async function resolveShare(
  token: string,
  countView: boolean,
): Promise<Row & { tenant_id: string; vehicle_id: string | null }> {
  const s = (
    await systemPool.query<
      Row & { tenant_id: string; vehicle_id: string | null; job_id: string | null }
    >(
      `UPDATE share_links SET view_count = view_count + $2::int, last_viewed_at = CASE WHEN $2 = 1 THEN now() ELSE last_viewed_at END
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING id, tenant_id, vehicle_id, job_id, label, expires_at`,
      [sha256(token), countView ? 1 : 0],
    )
  ).rows[0];
  if (!s) throw new AppError(404, 'link_expired', 'This tracking link has expired or was revoked');
  let vehicleId = s.vehicle_id;
  let job: Row | null = null;
  if (s.job_id) {
    const j = (
      await systemPool.query<Row>(
        `SELECT id, reference, title, status, vehicle_id FROM jobs WHERE id = $1`,
        [s.job_id],
      )
    ).rows[0];
    if (j) {
      vehicleId = (j.vehicle_id as string | null) ?? null;
      const stops = rowsOf(
        await systemPool.query<Row>(
          `SELECT seq, stop_type, name, ST_Y(geom) AS lat, ST_X(geom) AS lng, status, eta, arrived_at, time_window_start, time_window_end
         FROM job_stops WHERE job_id = $1 ORDER BY seq`,
          [s.job_id],
        ),
      );
      job = { reference: j.reference, title: j.title, status: j.status, stops };
    }
  }
  const pos = vehicleId
    ? (rowsOf(
        await systemPool.query<Row>(
          `SELECT v.plate_number, v.icon, ds.state, ds.lat, ds.lng, ds.speed_kph, ds.heading, ds.last_seen_at
         FROM vehicles v LEFT JOIN device_assignments da ON da.vehicle_id = v.id AND da.unassigned_at IS NULL
         LEFT JOIN device_status ds ON ds.device_id = da.device_id WHERE v.id = $1`,
          [vehicleId],
        ),
      )[0] ?? null)
    : null;
  return {
    tenant_id: s.tenant_id,
    vehicle_id: vehicleId,
    label: s.label,
    expires_at: s.expires_at,
    vehicle: pos,
    job,
  };
}
