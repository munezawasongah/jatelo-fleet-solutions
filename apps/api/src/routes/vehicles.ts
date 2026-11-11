import type { Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import {
  assertFile,
  diff,
  insertSql,
  num,
  orderBy,
  paged,
  PageQuery,
  Pagination,
  updateSql,
} from '../http/crud.js';
import { AppError, forbidden, notFound, unprocessable } from '../http/errors.js';
import { route } from '../http/route.js';

const BASE = '/api/v1';
const TAGS = ['Vehicles'];

const BODY_TYPES = [
  'saloon',
  'hatchback',
  'suv',
  'pickup',
  'van',
  'minibus',
  'bus',
  'truck',
  'prime_mover',
  'trailer',
  'tanker',
  'motorcycle',
  'tuk_tuk',
  'other',
] as const;
const USAGE = ['private', 'commercial', 'psv', 'government', 'ngo'] as const;
const FUELS = ['petrol', 'diesel', 'electric', 'hybrid', 'lpg', 'cng'] as const;
const STATUSES = ['active', 'in_maintenance', 'inactive', 'sold', 'written_off'] as const;
const ICONS = ['car', 'pickup', 'van', 'truck', 'bus', 'motorcycle', 'tuk_tuk', 'trailer'] as const;
const DOC_TYPES = [
  'insurance',
  'ntsa_inspection',
  'tra_inspection',
  'road_licence',
  'psv_licence',
  'logbook',
  'speed_governor_cert',
  'tracking_cert',
  'transit_permit',
  'comesa_card',
  'other',
] as const;

const isoDate = z.iso.date();
const VehicleInput = z.object({
  plate_number: z.string().trim().min(2).max(20),
  group_id: z.uuid().nullable().optional(),
  fleet_number: z.string().trim().max(40).nullable().optional(),
  label: z.string().trim().max(80).nullable().optional(),
  vin: z
    .string()
    .trim()
    .regex(/^[A-HJ-NPR-Za-hj-npr-z0-9]{11,17}$/, 'VIN must be 11-17 letters/digits (no I, O or Q)')
    .nullable()
    .optional(),
  make: z.string().trim().max(60).nullable().optional(),
  model: z.string().trim().max(60).nullable().optional(),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  color: z.string().trim().max(40).nullable().optional(),
  body_type: z.enum(BODY_TYPES).optional(),
  usage_type: z.enum(USAGE).optional(),
  fuel_type: z.enum(FUELS).optional(),
  tank_capacity_l: z.number().positive().max(5000).nullable().optional(),
  expected_l_per_100km: z.number().positive().max(200).nullable().optional(),
  seating_capacity: z.number().int().min(1).max(120).nullable().optional(),
  payload_kg: z.number().int().positive().max(100000).nullable().optional(),
  speed_limit_kph: z.number().int().min(20).max(200).nullable().optional(),
  speed_governor_fitted: z.boolean().optional(),
  odometer_km: z.number().min(0).max(5_000_000).optional(),
  engine_hours: z.number().min(0).max(500_000).optional(),
  odometer_source: z.enum(['manual', 'gps', 'can']).optional(),
  status: z.enum(STATUSES).optional(),
  purchase_date: isoDate.nullable().optional(),
  purchase_price: z.number().min(0).nullable().optional(),
  photo_file_id: z.uuid().nullable().optional(),
  icon: z.enum(ICONS).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  custom_fields: z
    .record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .refine((o) => Object.keys(o).length <= 50, 'At most 50 custom fields')
    .optional(),
});
const VehiclePatch = VehicleInput.partial().refine(
  (b) => Object.keys(b).length > 0,
  'Provide at least one field',
);

const DocInput = z.object({
  doc_type: z.enum(DOC_TYPES),
  document_number: z.string().trim().max(80).nullable().optional(),
  provider: z.string().trim().max(120).nullable().optional(),
  issued_on: isoDate.nullable().optional(),
  expires_on: isoDate.nullable().optional(),
  reminder_days: z.array(z.number().int().min(0).max(365)).max(10).optional(),
  file_id: z.uuid().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const DocPatch = DocInput.partial().refine(
  (b) => Object.keys(b).length > 0,
  'Provide at least one field',
);

// ---------------------------------------------------------------- response shapes
const VehicleSchema = z.object({
  id: z.string(),
  plate_number: z.string(),
  fleet_number: z.string().nullable(),
  label: z.string().nullable(),
  vin: z.string().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().nullable(),
  color: z.string().nullable(),
  body_type: z.string(),
  usage_type: z.string(),
  fuel_type: z.string(),
  tank_capacity_l: z.number().nullable(),
  expected_l_per_100km: z.number().nullable(),
  seating_capacity: z.number().nullable(),
  payload_kg: z.number().nullable(),
  speed_limit_kph: z.number().nullable(),
  speed_governor_fitted: z.boolean(),
  odometer_km: z.number(),
  engine_hours: z.number(),
  odometer_source: z.string(),
  status: z.string(),
  purchase_date: z.string().nullable(),
  purchase_price: z.number().nullable(),
  photo_file_id: z.string().nullable(),
  icon: z.string(),
  notes: z.string().nullable(),
  custom_fields: z.record(z.string(), z.unknown()),
  group: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).nullable(),
  device: z
    .object({
      id: z.string(),
      identifier: z.string(),
      protocol: z.string(),
      model: z.string().nullable(),
    })
    .nullable(),
  driver: z.object({ id: z.string(), name: z.string(), phone: z.string().nullable() }).nullable(),
  live: z.object({
    state: z.string(),
    since: z.string().nullable(),
    last_seen_at: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    speed_kph: z.number().nullable(),
    heading: z.number().nullable(),
    ignition: z.boolean().nullable(),
  }),
  compliance: z.object({ expired_documents: z.number(), next_expiry: z.string().nullable() }),
  created_at: z.string(),
  updated_at: z.string(),
});
const DocSchema = z.object({
  id: z.string(),
  vehicle_id: z.string(),
  doc_type: z.string(),
  document_number: z.string().nullable(),
  provider: z.string().nullable(),
  issued_on: z.string().nullable(),
  expires_on: z.string().nullable(),
  reminder_days: z.array(z.number()),
  file_id: z.string().nullable(),
  notes: z.string().nullable(),
  expiry_status: z.enum(['valid', 'expiring_soon', 'expired', 'no_expiry']),
  days_to_expiry: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

function toVehicle(r: Row): z.infer<typeof VehicleSchema> {
  return {
    id: String(r.id),
    plate_number: String(r.plate_number),
    fleet_number: str(r.fleet_number),
    label: str(r.label),
    vin: str(r.vin),
    make: str(r.make),
    model: str(r.model),
    year: num(r.year),
    color: str(r.color),
    body_type: String(r.body_type),
    usage_type: String(r.usage_type),
    fuel_type: String(r.fuel_type),
    tank_capacity_l: num(r.tank_capacity_l),
    expected_l_per_100km: num(r.expected_l_per_100km),
    seating_capacity: num(r.seating_capacity),
    payload_kg: num(r.payload_kg),
    speed_limit_kph: num(r.speed_limit_kph),
    speed_governor_fitted: Boolean(r.speed_governor_fitted),
    odometer_km: Number(r.odometer_km),
    engine_hours: Number(r.engine_hours),
    odometer_source: String(r.odometer_source),
    status: String(r.status),
    purchase_date: str(r.purchase_date),
    purchase_price: num(r.purchase_price),
    photo_file_id: str(r.photo_file_id),
    icon: String(r.icon),
    notes: str(r.notes),
    custom_fields: (r.custom_fields as Record<string, unknown>) ?? {},
    group:
      r.group_id && r.group_name
        ? { id: String(r.group_id), name: String(r.group_name), color: str(r.group_color) }
        : null,
    device: r.device_id
      ? {
          id: String(r.device_id),
          identifier: String(r.device_identifier),
          protocol: String(r.device_protocol),
          model: str(r.device_model),
        }
      : null,
    driver: r.driver_id
      ? { id: String(r.driver_id), name: String(r.driver_name), phone: str(r.driver_phone) }
      : null,
    live: {
      state: r.device_id ? String(r.live_state ?? 'never') : 'no_device',
      since: iso(r.state_since),
      last_seen_at: iso(r.last_seen_at),
      lat: num(r.lat),
      lng: num(r.lng),
      speed_kph: num(r.speed_kph),
      heading: num(r.heading),
      ignition: r.ignition === null || r.ignition === undefined ? null : Boolean(r.ignition),
    },
    compliance: {
      expired_documents: Number(r.expired_count ?? 0),
      next_expiry: str(r.next_expiry),
    },
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

function expiry(expires: string | null): {
  expiry_status: 'valid' | 'expiring_soon' | 'expired' | 'no_expiry';
  days_to_expiry: number | null;
} {
  if (!expires) return { expiry_status: 'no_expiry', days_to_expiry: null };
  const days = Math.round(
    (Date.parse(expires) - Date.parse(new Date().toISOString().slice(0, 10))) / 86_400_000,
  );
  return {
    expiry_status: days < 0 ? 'expired' : days <= 30 ? 'expiring_soon' : 'valid',
    days_to_expiry: days,
  };
}
function toDoc(r: Row): z.infer<typeof DocSchema> {
  return {
    id: String(r.id),
    vehicle_id: String(r.vehicle_id),
    doc_type: String(r.doc_type),
    document_number: str(r.document_number),
    provider: str(r.provider),
    issued_on: str(r.issued_on),
    expires_on: str(r.expires_on),
    reminder_days: (r.reminder_days as number[]) ?? [],
    file_id: str(r.file_id),
    notes: str(r.notes),
    ...expiry(str(r.expires_on)),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

const VEHICLE_SELECT = `
SELECT v.*, g.name AS group_name, g.color AS group_color,
  d.id AS device_id, d.identifier AS device_identifier, d.protocol AS device_protocol, d.model AS device_model,
  dr.id AS driver_id, dr.full_name AS driver_name, dr.phone AS driver_phone,
  ds.state AS live_state, ds.state_since, ds.last_seen_at, ds.lat, ds.lng, ds.speed_kph, ds.heading, ds.ignition,
  docs.expired_count, docs.next_expiry
FROM vehicles v
LEFT JOIN vehicle_groups g ON g.id = v.group_id AND g.deleted_at IS NULL
LEFT JOIN device_assignments da ON da.vehicle_id = v.id AND da.unassigned_at IS NULL
LEFT JOIN devices d ON d.id = da.device_id
LEFT JOIN driver_vehicle_assignments dva ON dva.vehicle_id = v.id AND dva.ends_at IS NULL AND dva.starts_at <= now()
LEFT JOIN drivers dr ON dr.id = dva.driver_id
LEFT JOIN device_status ds ON ds.device_id = d.id
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE vd.expires_on < current_date) AS expired_count,
         min(vd.expires_on) FILTER (WHERE vd.expires_on >= current_date) AS next_expiry
  FROM vehicle_documents vd WHERE vd.vehicle_id = v.id AND vd.deleted_at IS NULL
) docs ON true
WHERE v.deleted_at IS NULL`;

const SORTS: Record<string, string> = {
  plate_number: 'x.plate_normalized',
  fleet_number: 'x.fleet_number',
  created_at: 'x.created_at',
  updated_at: 'x.updated_at',
  odometer_km: 'x.odometer_km',
  year: 'x.year',
  make: 'x.make',
  status: 'x.status',
};

/** Loads a visible (not deleted, within the user's group scope) vehicle or throws 404. */
export async function visibleVehicle(
  c: PoolClient,
  id: string,
  scope: string[] | null,
): Promise<Row> {
  const r = (
    await c.query<Row>('SELECT * FROM vehicles WHERE id = $1 AND deleted_at IS NULL', [id])
  ).rows[0];
  if (!r || (scope && !scope.includes(String(r.group_id)))) throw notFound('Vehicle');
  return r;
}

async function vehicleDetail(c: PoolClient, id: string): Promise<z.infer<typeof VehicleSchema>> {
  return toVehicle((await c.query<Row>(`${VEHICLE_SELECT} AND v.id = $1`, [id])).rows[0]!);
}

async function assertGroup(
  c: PoolClient,
  groupId: string | null | undefined,
  scope: string[] | null,
): Promise<void> {
  if (groupId === undefined) return;
  if (groupId === null) {
    if (scope) throw forbidden('You can only place vehicles in your own groups');
    return;
  }
  if (
    !(await c.query('SELECT 1 FROM vehicle_groups WHERE id = $1 AND deleted_at IS NULL', [groupId]))
      .rowCount
  ) {
    throw unprocessable('Vehicle group not found');
  }
  if (scope && !scope.includes(groupId))
    throw forbidden('You can only place vehicles in your own groups');
}

function vehicleColumns(b: Partial<z.infer<typeof VehicleInput>>): Record<string, unknown> {
  const { custom_fields, ...rest } = b;
  return {
    ...rest,
    ...(custom_fields !== undefined ? { custom_fields: JSON.stringify(custom_fields) } : {}),
  };
}

export function registerVehicleRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/vehicles',
    tags: TAGS,
    summary: 'List vehicles',
    auth: true,
    query: z.object({
      ...PageQuery,
      search: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe('Plate, label or fleet number - spaces and case ignored'),
      group_id: z.uuid().optional(),
      status: z.enum(STATUSES).optional(),
      body_type: z.enum(BODY_TYPES).optional(),
      usage_type: z.enum(USAGE).optional(),
      sort: z
        .string()
        .max(40)
        .optional()
        .describe(`One of ${Object.keys(SORTS).join(', ')}; prefix with - for descending`),
    }),
    middleware: guard('vehicles:read'),
    responses: {
      200: {
        description: 'Page of vehicles',
        schema: z.object({ data: z.array(VehicleSchema), pagination: Pagination }),
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
          where.push(sql.replace('?', `$${params.length}`));
        };
        if (scope) add('v.group_id = ANY(?::uuid[])', scope);
        if (query.group_id) add('v.group_id = ?', query.group_id);
        if (query.status) add('v.status = ?', query.status);
        if (query.body_type) add('v.body_type = ?', query.body_type);
        if (query.usage_type) add('v.usage_type = ?', query.usage_type);
        if (query.search) {
          params.push(query.search);
          const n = params.length;
          where.push(`(v.plate_normalized LIKE '%' || upper(regexp_replace($${n}, '[^A-Za-z0-9]', '', 'g')) || '%'
            OR v.label ILIKE '%' || $${n} || '%' OR v.fleet_number ILIKE '%' || $${n} || '%')`);
        }
        const order = orderBy(query.sort, SORTS, 'x.plate_normalized ASC');
        params.push(query.page_size, (query.page - 1) * query.page_size);
        const { rows } = await c.query<Row>(
          `SELECT x.*, count(*) OVER() AS total FROM (${VEHICLE_SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''}) x
           ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return paged(rows.map(toVehicle), Number(rows[0]?.total ?? 0), query.page, query.page_size);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/vehicles/:id',
    tags: TAGS,
    summary: 'Vehicle details with documents',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('vehicles:read'),
    responses: {
      200: {
        description: 'Vehicle',
        schema: VehicleSchema.extend({ documents: z.array(DocSchema) }),
      },
    },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await visibleVehicle(c, params.id, await groupScope(c, auth.userId));
        const docs = await c.query<Row>(
          'SELECT * FROM vehicle_documents WHERE vehicle_id = $1 AND deleted_at IS NULL ORDER BY expires_on NULLS LAST, doc_type',
          [params.id],
        );
        return { ...(await vehicleDetail(c, params.id)), documents: docs.rows.map(toDoc) };
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/vehicles',
    tags: TAGS,
    summary: 'Add a vehicle',
    auth: true,
    description:
      'Blocked with 409 vehicle_quota_reached when the subscription vehicle limit is reached.',
    body: VehicleInput,
    status: 201,
    middleware: guard('vehicles:write'),
    responses: { 201: { description: 'Created', schema: VehicleSchema } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        await assertGroup(c, body.group_id ?? (scope ? null : undefined), scope);
        await assertFile(c, body.photo_file_id, ['vehicle_photo']);
        const q = (
          await c.query<{ vehicle_quota: number | null; used: string }>(
            `SELECT (SELECT vehicle_quota FROM subscriptions WHERE status IN ('trialing', 'active', 'past_due') LIMIT 1) AS vehicle_quota,
                  (SELECT count(*) FROM vehicles WHERE deleted_at IS NULL) AS used`,
          )
        ).rows[0]!;
        if (q.vehicle_quota === null)
          throw new AppError(
            402,
            'no_active_subscription',
            'Your company has no active subscription',
          );
        if (Number(q.used) >= q.vehicle_quota) {
          throw new AppError(
            409,
            'vehicle_quota_reached',
            `Your plan allows ${q.vehicle_quota} vehicles. Upgrade the plan to add more.`,
            { quota: q.vehicle_quota, used: Number(q.used) },
          );
        }
        const ins = insertSql('vehicles', { ...vehicleColumns(body), tenant_id: auth.tenantId });
        const id = (await c.query<{ id: string }>(ins.text, ins.values)).rows[0]!.id;
        const created = await vehicleDetail(c, id);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle.created',
          entityType: 'vehicle',
          entityId: id,
          metadata: { plate_number: created.plate_number },
          req,
        });
        return created;
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/vehicles/:id',
    tags: TAGS,
    summary: 'Update a vehicle',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: VehiclePatch,
    middleware: guard('vehicles:write'),
    responses: { 200: { description: 'Updated', schema: VehicleSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const before = await visibleVehicle(c, params.id, scope);
        await assertGroup(c, body.group_id, scope);
        await assertFile(c, body.photo_file_id, ['vehicle_photo']);
        const cols = vehicleColumns(body);
        const q = updateSql('vehicles', params.id, cols);
        await c.query(q.text, q.values);
        const changes = diff(before, { ...body, custom_fields: body.custom_fields });
        if (Object.keys(changes).length) {
          await audit({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            action: 'vehicle.updated',
            entityType: 'vehicle',
            entityId: params.id,
            changes,
            req,
          });
        }
        return vehicleDetail(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/vehicles/:id',
    tags: TAGS,
    summary: 'Remove a vehicle',
    description:
      'Soft delete: history is kept, the tracker and driver assignments end now, and the plate can be reused.',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('vehicles:write'),
    responses: { 204: { description: 'Removed' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      await tenantDb(req, async (c) => {
        const v = await visibleVehicle(c, params.id, await groupScope(c, auth.userId));
        await c.query(
          'UPDATE device_assignments SET unassigned_at = now() WHERE vehicle_id = $1 AND unassigned_at IS NULL',
          [params.id],
        );
        await c.query(
          `UPDATE driver_vehicle_assignments SET ends_at = greatest(now(), starts_at + interval '1 second')
           WHERE vehicle_id = $1 AND ends_at IS NULL`,
          [params.id],
        );
        await c.query('UPDATE vehicles SET deleted_at = now() WHERE id = $1', [params.id]);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle.deleted',
          entityType: 'vehicle',
          entityId: params.id,
          metadata: { plate_number: v.plate_number },
          req,
        });
      });
      return undefined;
    },
  });

  // ---------------------------------------------------------------- documents
  route(v1, BASE, {
    method: 'get',
    path: '/vehicles/:id/documents',
    tags: TAGS,
    summary: "List a vehicle's documents",
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('vehicles:read'),
    responses: {
      200: { description: 'Documents', schema: z.object({ data: z.array(DocSchema) }) },
    },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await visibleVehicle(c, params.id, await groupScope(c, auth.userId));
        const { rows } = await c.query<Row>(
          'SELECT * FROM vehicle_documents WHERE vehicle_id = $1 AND deleted_at IS NULL ORDER BY expires_on NULLS LAST, doc_type',
          [params.id],
        );
        return { data: rows.map(toDoc) };
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/vehicles/:id/documents',
    tags: TAGS,
    summary: 'Add a document to a vehicle',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: DocInput,
    status: 201,
    middleware: guard('vehicles:write'),
    responses: { 201: { description: 'Created', schema: DocSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await visibleVehicle(c, params.id, await groupScope(c, auth.userId));
        await assertFile(c, body.file_id, ['vehicle_document']);
        if (body.issued_on && body.expires_on && body.expires_on < body.issued_on)
          throw unprocessable('Expiry date is before the issue date');
        const q = insertSql('vehicle_documents', {
          ...body,
          vehicle_id: params.id,
          tenant_id: auth.tenantId,
          created_by: auth.userId,
        });
        const id = (await c.query<{ id: string }>(q.text, q.values)).rows[0]!.id;
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle_document.created',
          entityType: 'vehicle_document',
          entityId: id,
          metadata: { vehicle_id: params.id, doc_type: body.doc_type },
          req,
        });
        return toDoc(
          (await c.query<Row>('SELECT * FROM vehicle_documents WHERE id = $1', [id])).rows[0]!,
        );
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/vehicle-documents/:id',
    tags: TAGS,
    summary: 'Update a vehicle document',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: DocPatch,
    middleware: guard('vehicles:write'),
    responses: { 200: { description: 'Updated', schema: DocSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const before = (
          await c.query<Row>(
            'SELECT * FROM vehicle_documents WHERE id = $1 AND deleted_at IS NULL',
            [params.id],
          )
        ).rows[0];
        if (!before) throw notFound('Document');
        await visibleVehicle(c, String(before.vehicle_id), await groupScope(c, auth.userId));
        await assertFile(c, body.file_id, ['vehicle_document']);
        const issued = body.issued_on !== undefined ? body.issued_on : str(before.issued_on);
        const expires = body.expires_on !== undefined ? body.expires_on : str(before.expires_on);
        if (issued && expires && expires < issued)
          throw unprocessable('Expiry date is before the issue date');
        const q = updateSql('vehicle_documents', params.id, body);
        await c.query(q.text, q.values);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle_document.updated',
          entityType: 'vehicle_document',
          entityId: params.id,
          changes: diff(before, body),
          req,
        });
        return toDoc(
          (await c.query<Row>('SELECT * FROM vehicle_documents WHERE id = $1', [params.id]))
            .rows[0]!,
        );
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/vehicle-documents/:id',
    tags: TAGS,
    summary: 'Delete a vehicle document',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('vehicles:write'),
    responses: { 204: { description: 'Deleted' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      await tenantDb(req, async (c) => {
        const d = (
          await c.query<Row>(
            'SELECT * FROM vehicle_documents WHERE id = $1 AND deleted_at IS NULL',
            [params.id],
          )
        ).rows[0];
        if (!d) throw notFound('Document');
        await visibleVehicle(c, String(d.vehicle_id), await groupScope(c, auth.userId));
        await c.query('UPDATE vehicle_documents SET deleted_at = now() WHERE id = $1', [params.id]);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle_document.deleted',
          entityType: 'vehicle_document',
          entityId: params.id,
          metadata: { vehicle_id: d.vehicle_id, doc_type: d.doc_type },
          req,
        });
      });
      return undefined;
    },
  });
}
