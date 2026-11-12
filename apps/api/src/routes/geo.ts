import type { Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { requireAuth, guard, tenantDb } from '../auth/middleware.js';
import { notFound, unprocessable } from '../http/errors.js';
import { AnyRow, resource, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';

const LngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const pointWkt = (lat: number, lng: number): string => `SRID=4326;POINT(${lng} ${lat})`;
const lineWkt = (c: [number, number][]): string =>
  `SRID=4326;LINESTRING(${c.map(([x, y]) => `${x} ${y}`).join(', ')})`;
function polyWkt(c: [number, number][]): string {
  const ring = [...c];
  const [f, l] = [ring[0]!, ring[ring.length - 1]!];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push(f);
  return `SRID=4326;POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(', ')}))`;
}
const POI_CATEGORIES = [
  'depot',
  'customer',
  'supplier',
  'fuel_station',
  'workshop',
  'parking',
  'border_post',
  'weighbridge',
  'police_checkpoint',
  'other',
] as const;

export function registerGeoRoutes(v1: Router): void {
  // ---------------------------------------------------------------- points of interest
  route(v1, '/api/v1', {
    method: 'get',
    path: '/pois/nearby',
    tags: ['Geofencing'],
    summary: 'Places near a point (nearest first)',
    auth: true,
    query: z.object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      radius_m: z.coerce.number().int().min(10).max(100000).default(2000),
    }),
    middleware: guard('geofences:read'),
    responses: { 200: { description: 'Places', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => ({
        data: rowsOf(
          await c.query<Row>(
            `SELECT id, name, category, ST_Y(geom) AS lat, ST_X(geom) AS lng, radius_m,
             round(ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)) AS distance_m
           FROM pois WHERE deleted_at IS NULL AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
           ORDER BY distance_m LIMIT 50`,
            [query.lat, query.lng, query.radius_m],
          ),
        ),
      })),
  });

  resource(v1, {
    path: 'pois',
    table: 'pois',
    tag: 'Geofencing',
    noun: 'Place',
    read: ['geofences:read'],
    write: ['geofences:write'],
    input: z.object({
      name: z.string().trim().min(1).max(120),
      category: z.enum(POI_CATEGORIES).optional(),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radius_m: z.number().int().min(10).max(5000).optional(),
      address: z.string().trim().max(300).nullable().optional(),
      contact_name: z.string().trim().max(120).nullable().optional(),
      contact_phone: z.string().trim().max(30).nullable().optional(),
      external_ref: z.string().trim().max(80).nullable().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }),
    select: `SELECT x.id, x.name, x.category, ST_Y(x.geom) AS lat, ST_X(x.geom) AS lng, x.radius_m, x.address, x.contact_name,
      x.contact_phone, x.external_ref, x.notes, x.created_at, x.updated_at FROM pois x`,
    sorts: { name: 'x.name', category: 'x.category', created_at: 'x.created_at' },
    defaultSort: 'x.name ASC',
    search: ['x.name', 'x.address', 'x.external_ref'],
    filters: { category: { column: 'x.category', schema: z.enum(POI_CATEGORIES) } },
    toColumns: async (b, c, _auth) => {
      const { lat, lng, ...rest } = b;
      const out: Row = { ...rest };
      if (lat !== undefined || lng !== undefined) {
        if (lat === undefined || lng === undefined) throw unprocessable('Send both lat and lng');
        out.geom = pointWkt(lat, lng);
      }
      void c;
      return out;
    },
    extraCreate: (auth) => ({ created_by: auth.userId }),
  });

  // ---------------------------------------------------------------- geofences
  const GeofenceInput = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    shape: z.enum(['circle', 'polygon', 'corridor']),
    center: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .optional(),
    radius_m: z.number().int().min(20).max(100000).optional(),
    polygon: z
      .array(LngLat)
      .min(3)
      .max(2000)
      .optional()
      .describe('[[lng, lat], ...] - closed automatically'),
    path: z
      .array(LngLat)
      .min(2)
      .max(5000)
      .optional()
      .describe('Corridor centre line [[lng, lat], ...]'),
    width_m: z.number().int().min(20).max(5000).optional(),
    speed_limit_kph: z.number().int().min(5).max(200).nullable().optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    applies_to_all: z.boolean().optional(),
    is_active: z.boolean().optional(),
    poi_id: z.uuid().nullable().optional(),
  });

  resource(v1, {
    path: 'geofences',
    table: 'geofences',
    tag: 'Geofencing',
    noun: 'Geofence',
    read: ['geofences:read'],
    write: ['geofences:write'],
    input: GeofenceInput,
    select: `SELECT x.id, x.name, x.description, x.shape, ST_Y(x.center) AS center_lat, ST_X(x.center) AS center_lng, x.radius_m, x.width_m,
      x.speed_limit_kph, x.color, x.applies_to_all, x.is_active, x.poi_id, ST_AsGeoJSON(x.geom, 6)::json AS geometry,
      ST_AsGeoJSON(x.path, 6)::json AS path, round(ST_Area(x.geom::geography)) AS area_m2,
      (SELECT count(*) FROM geofence_assignments ga WHERE ga.geofence_id = x.id) AS assignment_count,
      (SELECT count(*) FROM geofence_presence gp WHERE gp.geofence_id = x.id) AS vehicles_inside,
      x.created_at, x.updated_at FROM geofences x`,
    sorts: { name: 'x.name', created_at: 'x.created_at', area_m2: 'x.area_m2' },
    defaultSort: 'x.name ASC',
    search: ['x.name'],
    filters: {
      shape: { column: 'x.shape', schema: z.enum(['circle', 'polygon', 'corridor']) },
      is_active: {
        column: 'x.is_active',
        schema: z.enum(['true', 'false']).transform((v) => v === 'true'),
      },
    },
    validate: async (_c, b, _a, existing) => {
      const shape = b.shape ?? (existing?.shape as string | undefined);
      if (b.shape && !existing) {
        if (shape === 'circle' && (!b.center || !b.radius_m))
          throw unprocessable('A circle needs center and radius_m');
        if (shape === 'polygon' && !b.polygon)
          throw unprocessable('A polygon needs polygon coordinates');
        if (shape === 'corridor' && (!b.path || !b.width_m))
          throw unprocessable('A corridor needs path and width_m');
      }
    },
    toColumns: (b) => {
      const { center, polygon, path, ...rest } = b;
      const out: Row = { ...rest };
      if (center) out.center = pointWkt(center.lat, center.lng);
      if (polygon) out.geom = polyWkt(polygon);
      if (path) out.path = lineWkt(path);
      // the trigger recomputes geom for circle/corridor; a placeholder keeps NOT NULL satisfied on insert
      if (!out.geom && b.shape && b.shape !== 'polygon')
        out.geom = 'SRID=4326;MULTIPOLYGON(((0 0,0 0.0001,0.0001 0,0 0)))';
      return out;
    },
    extraCreate: (auth) => ({ created_by: auth.userId }),
  });

  route(v1, '/api/v1', {
    method: 'put',
    path: '/geofences/:id/assignments',
    tags: ['Geofencing'],
    summary: 'Replace which vehicles/groups a geofence alerts for',
    description: 'An empty list with applies_to_all=true means every vehicle.',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({
      applies_to_all: z.boolean(),
      assignments: z
        .array(
          z
            .object({
              vehicle_id: z.uuid().optional(),
              group_id: z.uuid().optional(),
              alert_on_entry: z.boolean().default(true),
              alert_on_exit: z.boolean().default(true),
              dwell_minutes: z.number().int().min(1).max(10080).nullable().optional(),
              schedule: z
                .object({
                  days: z.array(z.number().int().min(1).max(7)).min(1),
                  start: z.string().regex(/^\d{2}:\d{2}$/),
                  end: z.string().regex(/^\d{2}:\d{2}$/),
                })
                .nullable()
                .optional(),
            })
            .refine(
              (a) => Boolean(a.vehicle_id) !== Boolean(a.group_id),
              'Each assignment needs exactly one of vehicle_id or group_id',
            ),
        )
        .max(500),
    }),
    middleware: guard('geofences:write'),
    responses: { 200: { description: 'Assignments', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        if (
          !(
            await c.query(
              'UPDATE geofences SET applies_to_all = $2 WHERE id = $1 AND deleted_at IS NULL',
              [params.id, body.applies_to_all],
            )
          ).rowCount
        )
          throw notFound('Geofence');
        await c.query('DELETE FROM geofence_assignments WHERE geofence_id = $1', [params.id]);
        for (const a of body.assignments) {
          await c.query(
            `INSERT INTO geofence_assignments (tenant_id, geofence_id, vehicle_id, group_id, alert_on_entry, alert_on_exit, dwell_minutes, schedule)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              auth.tenantId,
              params.id,
              a.vehicle_id ?? null,
              a.group_id ?? null,
              a.alert_on_entry,
              a.alert_on_exit,
              a.dwell_minutes ?? null,
              a.schedule ? JSON.stringify(a.schedule) : null,
            ],
          );
        }
        return { data: await assignments(c, params.id) };
      });
    },
  });

  route(v1, '/api/v1', {
    method: 'get',
    path: '/geofences/:id/assignments',
    tags: ['Geofencing'],
    summary: 'Vehicles/groups a geofence applies to',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('geofences:read'),
    responses: { 200: { description: 'Assignments', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => ({ data: await assignments(c, params.id) })),
  });

  route(v1, '/api/v1', {
    method: 'get',
    path: '/geofence-events',
    tags: ['Geofencing'],
    summary: 'Entry/exit/dwell history',
    auth: true,
    query: z.object({
      geofence_id: z.uuid().optional(),
      vehicle_id: z.uuid().optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }),
    middleware: guard('geofences:read'),
    responses: { 200: { description: 'Events', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => ({
        data: rowsOf(
          await c.query<Row>(
            `SELECT e.id, e.event_type, e.occurred_at, e.lat, e.lng, e.speed_kph, e.dwell_s, e.geofence_id, g.name AS geofence_name,
             e.vehicle_id, v.plate_number, e.driver_id, d.full_name AS driver_name
           FROM geofence_events e JOIN geofences g ON g.id = e.geofence_id JOIN vehicles v ON v.id = e.vehicle_id LEFT JOIN drivers d ON d.id = e.driver_id
           WHERE ($1::uuid IS NULL OR e.geofence_id = $1) AND ($2::uuid IS NULL OR e.vehicle_id = $2)
             AND e.occurred_at >= coalesce($3::timestamptz, now() - interval '7 days') AND e.occurred_at < coalesce($4::timestamptz, now() + interval '1 minute')
           ORDER BY e.occurred_at DESC LIMIT $5`,
            [
              query.geofence_id ?? null,
              query.vehicle_id ?? null,
              query.from ?? null,
              query.to ?? null,
              query.limit,
            ],
          ),
        ),
      })),
  });
}

async function assignments(c: PoolClient, geofenceId: string): Promise<Row[]> {
  return rowsOf(
    await c.query<Row>(
      `SELECT a.id, a.vehicle_id, v.plate_number, a.group_id, g.name AS group_name, a.alert_on_entry, a.alert_on_exit, a.dwell_minutes, a.schedule
     FROM geofence_assignments a LEFT JOIN vehicles v ON v.id = a.vehicle_id LEFT JOIN vehicle_groups g ON g.id = a.group_id
     WHERE a.geofence_id = $1 ORDER BY v.plate_number NULLS LAST, g.name`,
      [geofenceId],
    ),
  );
}
