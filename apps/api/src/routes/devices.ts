import type { Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { num, orderBy, paged, PageQuery, Pagination } from '../http/crud.js';
import { AppError, notFound, unprocessable } from '../http/errors.js';
import { route } from '../http/route.js';
import { visibleVehicle } from './vehicles.js';

const BASE = '/api/v1';
const TAGS = ['Devices'];
const PROTOCOLS = ['teltonika', 'gt06', 'queclink', 'http_json'] as const;
const STATUSES = ['in_stock', 'active', 'suspended', 'retired'] as const;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

const DeviceSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  protocol: z.string(),
  model: z.string().nullable(),
  firmware: z.string().nullable(),
  sim: z.object({
    iccid: z.string().nullable(),
    msisdn: z.string().nullable(),
    provider: z.string().nullable(),
  }),
  status: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  installed_at: z.string().nullable(),
  notes: z.string().nullable(),
  vehicle: z
    .object({ id: z.string(), plate_number: z.string(), assigned_at: z.string() })
    .nullable(),
  health: z.object({
    online: z.boolean(),
    state: z.string(),
    last_seen_at: z.string().nullable(),
    last_fix_at: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    speed_kph: z.number().nullable(),
    ignition: z.boolean().nullable(),
    satellites: z.number().nullable(),
    gsm_signal: z.number().nullable(),
    ext_voltage_mv: z.number().nullable(),
    battery_voltage_mv: z.number().nullable(),
  }),
});
const AssignmentSchema = z.object({
  id: z.string(),
  vehicle_id: z.string(),
  plate_number: z.string(),
  assigned_at: z.string(),
  unassigned_at: z.string().nullable(),
  assigned_by: z.string().nullable(),
  notes: z.string().nullable(),
});

const DEVICE_SELECT = `
SELECT d.id, d.identifier, d.protocol, d.model, d.firmware, d.sim_iccid, d.sim_msisdn, d.sim_provider, d.status,
  d.capabilities, d.installed_at, d.notes,
  v.id AS vehicle_id, v.plate_number, v.group_id, da.assigned_at,
  ds.state, ds.last_seen_at, ds.last_fix_at, ds.lat, ds.lng, ds.speed_kph, ds.ignition, ds.satellites, ds.gsm_signal,
  ds.ext_voltage_mv, ds.battery_voltage_mv,
  coalesce(ds.last_seen_at > now() - make_interval(mins => ts.offline_threshold_minutes), false) AS online
FROM devices d
LEFT JOIN device_assignments da ON da.device_id = d.id AND da.unassigned_at IS NULL
LEFT JOIN vehicles v ON v.id = da.vehicle_id AND v.deleted_at IS NULL
LEFT JOIN device_status ds ON ds.device_id = d.id
LEFT JOIN tenant_settings ts ON ts.tenant_id = d.tenant_id
WHERE d.deleted_at IS NULL`;

function toDevice(r: Row): z.infer<typeof DeviceSchema> {
  return {
    id: String(r.id),
    identifier: String(r.identifier),
    protocol: String(r.protocol),
    model: str(r.model),
    firmware: str(r.firmware),
    sim: { iccid: str(r.sim_iccid), msisdn: str(r.sim_msisdn), provider: str(r.sim_provider) },
    status: String(r.status),
    capabilities: (r.capabilities as Record<string, unknown>) ?? {},
    installed_at: iso(r.installed_at),
    notes: str(r.notes),
    vehicle: r.vehicle_id
      ? {
          id: String(r.vehicle_id),
          plate_number: String(r.plate_number),
          assigned_at: iso(r.assigned_at)!,
        }
      : null,
    health: {
      online: Boolean(r.online),
      state: r.last_seen_at ? String(r.state ?? 'never') : 'never',
      last_seen_at: iso(r.last_seen_at),
      last_fix_at: iso(r.last_fix_at),
      lat: num(r.lat),
      lng: num(r.lng),
      speed_kph: num(r.speed_kph),
      ignition: r.ignition === null || r.ignition === undefined ? null : Boolean(r.ignition),
      satellites: num(r.satellites),
      gsm_signal: num(r.gsm_signal),
      ext_voltage_mv: num(r.ext_voltage_mv),
      battery_voltage_mv: num(r.battery_voltage_mv),
    },
  };
}

/** Loads a device visible to the caller: in the tenant and, for group-restricted users, on one of their vehicles. */
async function visibleDevice(c: PoolClient, id: string, scope: string[] | null): Promise<Row> {
  const r = (await c.query<Row>(`${DEVICE_SELECT} AND d.id = $1`, [id])).rows[0];
  if (!r || (scope && !scope.includes(String(r.group_id)))) throw notFound('Device');
  return r;
}

const SORTS: Record<string, string> = {
  identifier: 'x.identifier',
  protocol: 'x.protocol',
  last_seen_at: 'x.last_seen_at',
  plate_number: 'x.plate_number',
  status: 'x.status',
};

export function registerDeviceRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/devices',
    tags: TAGS,
    summary: 'List trackers',
    auth: true,
    query: z.object({
      ...PageQuery,
      search: z.string().trim().max(40).optional().describe('IMEI/identifier, model or SIM number'),
      protocol: z.enum(PROTOCOLS).optional(),
      status: z.enum(STATUSES).optional(),
      assigned: z.enum(['true', 'false']).optional(),
      online: z.enum(['true', 'false']).optional(),
      sort: z
        .string()
        .max(40)
        .optional()
        .describe(`One of ${Object.keys(SORTS).join(', ')}; prefix - for descending`),
    }),
    middleware: guard('devices:read'),
    responses: {
      200: {
        description: 'Page of trackers',
        schema: z.object({ data: z.array(DeviceSchema), pagination: Pagination }),
      },
    },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const where: string[] = [];
        const params: unknown[] = [];
        const add = (sql: string, v: unknown): void => {
          params.push(v);
          where.push(sql.replaceAll('?', `$${params.length}`));
        };
        if (scope) add('v.group_id = ANY(?::uuid[])', scope);
        if (query.protocol) add('d.protocol = ?', query.protocol);
        if (query.status) add('d.status = ?', query.status);
        if (query.assigned)
          where.push(query.assigned === 'true' ? 'v.id IS NOT NULL' : 'v.id IS NULL');
        if (query.search)
          add(
            `(d.identifier ILIKE '%' || ? || '%' OR d.model ILIKE '%' || ? || '%' OR d.sim_msisdn ILIKE '%' || ? || '%')`,
            query.search,
          );
        const outer = query.online ? `WHERE x.online = ${query.online === 'true'}` : '';
        const order = orderBy(query.sort, SORTS, 'x.identifier ASC');
        params.push(query.page_size, (query.page - 1) * query.page_size);
        const { rows } = await c.query<Row>(
          `SELECT x.*, count(*) OVER() AS total FROM (${DEVICE_SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''}) x
           ${outer} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return paged(rows.map(toDevice), Number(rows[0]?.total ?? 0), query.page, query.page_size);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/devices/:id',
    tags: TAGS,
    summary: 'Tracker details with assignment history',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('devices:read'),
    responses: {
      200: {
        description: 'Tracker',
        schema: DeviceSchema.extend({ assignments: z.array(AssignmentSchema) }),
      },
    },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const d = await visibleDevice(c, params.id, await groupScope(c, auth.userId));
        const hist = await c.query<Row>(
          `SELECT da.id, da.vehicle_id, v.plate_number, da.assigned_at, da.unassigned_at, u.full_name AS assigned_by, da.notes
           FROM device_assignments da JOIN vehicles v ON v.id = da.vehicle_id LEFT JOIN users u ON u.id = da.assigned_by
           WHERE da.device_id = $1 ORDER BY da.assigned_at DESC LIMIT 20`,
          [params.id],
        );
        return {
          ...toDevice(d),
          assignments: hist.rows.map((h) => ({
            id: String(h.id),
            vehicle_id: String(h.vehicle_id),
            plate_number: String(h.plate_number),
            assigned_at: iso(h.assigned_at)!,
            unassigned_at: iso(h.unassigned_at),
            assigned_by: str(h.assigned_by),
            notes: str(h.notes),
          })),
        };
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/devices/:id',
    tags: TAGS,
    summary: 'Update tracker notes',
    auth: true,
    description:
      'Hardware details (IMEI, protocol, SIM) are managed by Jatelo; companies can keep their own notes.',
    params: z.object({ id: z.uuid() }),
    body: z.object({ notes: z.string().trim().max(1000).nullable() }),
    middleware: guard('devices:assign'),
    responses: { 200: { description: 'Updated', schema: DeviceSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await visibleDevice(c, params.id, await groupScope(c, auth.userId));
        await c.query('UPDATE devices SET notes = $2 WHERE id = $1', [params.id, body.notes]);
        return toDevice(
          (await c.query<Row>(`${DEVICE_SELECT} AND d.id = $1`, [params.id])).rows[0]!,
        );
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/devices/:id/assign',
    tags: TAGS,
    summary: 'Install a tracker on a vehicle',
    auth: true,
    description:
      'If the tracker is on another vehicle, or the vehicle already has a tracker, the request fails with 409 assignment_conflict ' +
      'unless replace=true, in which case the old assignments end at the same moment the new one starts.',
    params: z.object({ id: z.uuid() }),
    body: z.object({
      vehicle_id: z.uuid(),
      assigned_at: z.iso
        .datetime({ offset: true })
        .optional()
        .describe('Installation time; defaults to now; cannot be in the future'),
      replace: z.boolean().default(false),
      notes: z.string().trim().max(500).optional(),
    }),
    middleware: guard('devices:assign'),
    responses: { 200: { description: 'Assigned', schema: DeviceSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      const at = body.assigned_at ? new Date(body.assigned_at) : new Date();
      if (at.getTime() > Date.now() + 60_000)
        throw unprocessable('Installation time cannot be in the future');
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const device = await visibleDevice(c, params.id, scope);
        if (device.status !== 'active')
          throw new AppError(409, 'device_not_active', 'Only active trackers can be installed');
        const vehicle = await visibleVehicle(c, body.vehicle_id, scope);

        const onDevice = (
          await c.query<{
            id: string;
            vehicle_id: string;
            plate_number: string;
            assigned_at: Date;
          }>(
            `SELECT da.id, da.vehicle_id, v.plate_number, da.assigned_at FROM device_assignments da JOIN vehicles v ON v.id = da.vehicle_id
           WHERE da.device_id = $1 AND da.unassigned_at IS NULL`,
            [params.id],
          )
        ).rows[0];
        if (onDevice?.vehicle_id === body.vehicle_id) return toDevice(device);
        const onVehicle = (
          await c.query<{ id: string; identifier: string; assigned_at: Date }>(
            `SELECT da.id, d.identifier, da.assigned_at FROM device_assignments da JOIN devices d ON d.id = da.device_id
           WHERE da.vehicle_id = $1 AND da.unassigned_at IS NULL`,
            [body.vehicle_id],
          )
        ).rows[0];

        const conflicts = [
          ...(onDevice
            ? [
                {
                  type: 'device_in_use',
                  message: `This tracker is installed on ${onDevice.plate_number}`,
                  vehicle_id: onDevice.vehicle_id,
                },
              ]
            : []),
          ...(onVehicle
            ? [
                {
                  type: 'vehicle_has_device',
                  message: `${String(vehicle.plate_number)} already has tracker ${onVehicle.identifier}`,
                  device_identifier: onVehicle.identifier,
                },
              ]
            : []),
        ];
        if (conflicts.length && !body.replace) {
          throw new AppError(
            409,
            'assignment_conflict',
            'This change would replace an existing installation. Send replace=true to confirm.',
            conflicts,
          );
        }
        for (const cur of [onDevice, onVehicle]) {
          if (!cur) continue;
          if (at <= cur.assigned_at)
            throw unprocessable('The new installation time must be after the current one started');
          await c.query('UPDATE device_assignments SET unassigned_at = $2 WHERE id = $1', [
            cur.id,
            at,
          ]);
        }
        await c.query(
          `INSERT INTO device_assignments (tenant_id, device_id, vehicle_id, assigned_at, assigned_by, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
          [auth.tenantId, params.id, body.vehicle_id, at, auth.userId, body.notes ?? null],
        );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'device.assigned',
          entityType: 'device',
          entityId: params.id,
          metadata: {
            identifier: device.identifier,
            vehicle_id: body.vehicle_id,
            plate_number: vehicle.plate_number,
            replaced: conflicts.map((x) => x.type),
          },
          req,
        });
        return toDevice(
          (await c.query<Row>(`${DEVICE_SELECT} AND d.id = $1`, [params.id])).rows[0]!,
        );
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/devices/:id/unassign',
    tags: TAGS,
    summary: 'Remove a tracker from its vehicle',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('devices:assign'),
    responses: { 200: { description: 'Unassigned', schema: DeviceSchema } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const device = await visibleDevice(c, params.id, await groupScope(c, auth.userId));
        const ended = (
          await c.query<{ vehicle_id: string }>(
            `UPDATE device_assignments SET unassigned_at = greatest(now(), assigned_at + interval '1 second')
           WHERE device_id = $1 AND unassigned_at IS NULL RETURNING vehicle_id`,
            [params.id],
          )
        ).rows[0];
        if (!ended)
          throw new AppError(409, 'not_assigned', 'This tracker is not installed on any vehicle');
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'device.unassigned',
          entityType: 'device',
          entityId: params.id,
          metadata: {
            identifier: device.identifier,
            vehicle_id: ended.vehicle_id,
            plate_number: device.plate_number,
          },
          req,
        });
        return toDevice(
          (await c.query<Row>(`${DEVICE_SELECT} AND d.id = $1`, [params.id])).rows[0]!,
        );
      });
    },
  });
}
