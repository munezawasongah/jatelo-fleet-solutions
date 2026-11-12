import type { Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb, type AuthContext } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { assertFile, paged, PageQuery } from '../http/crud.js';
import { AppError, forbidden, notFound, unprocessable } from '../http/errors.js';
import { AnyRow, ListOf, listRows, resource, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { redis } from '../infra/redis.js';
import { visibleVehicle } from './vehicles.js';

const BASE = '/api/v1';
const TAG = 'Maintenance';
const isoDate = z.iso.date();
const CATEGORIES = [
  'engine',
  'oil_service',
  'brakes',
  'tyres',
  'electrical',
  'body',
  'transmission',
  'suspension',
  'cooling',
  'air_conditioning',
  'inspection',
  'other',
] as const;
const WO_STATUSES = [
  'open',
  'scheduled',
  'in_progress',
  'on_hold',
  'completed',
  'cancelled',
] as const;

/** Publishes an event for the alert engine (worker). */
export async function publishEvent(e: Record<string, unknown>): Promise<void> {
  await redis.xadd(
    'vehicle_events',
    'MAXLEN',
    '~',
    '500000',
    '*',
    'data',
    JSON.stringify({ at: new Date().toISOString(), ...e }),
  );
}

async function nextNumber(c: PoolClient, table: string, prefix: string): Promise<string> {
  const r = await c.query<{ n: number }>(
    `SELECT coalesce(max(substring(number FROM '${prefix}-(\\d+)$')::int), 0) + 1 AS n FROM ${table} WHERE number ~ '^${prefix}-\\d+$'`,
  );
  return `${prefix}-${String(r.rows[0]!.n).padStart(4, '0')}`;
}

/** Recomputes a schedule's status from the vehicle's current odometer/engine hours and today's date. */
export async function refreshScheduleStatus(c: PoolClient, scheduleIds?: string[]): Promise<void> {
  await c.query(
    `UPDATE service_schedules s SET status = CASE
        WHEN (s.next_due_km IS NOT NULL AND v.odometer_km >= s.next_due_km + greatest(s.remind_before_km, 500))
          OR (s.next_due_hours IS NOT NULL AND v.engine_hours >= s.next_due_hours + greatest(s.remind_before_hours, 10))
          OR (s.next_due_at IS NOT NULL AND now() >= s.next_due_at + interval '7 days') THEN 'overdue'
        WHEN (s.next_due_km IS NOT NULL AND v.odometer_km >= s.next_due_km)
          OR (s.next_due_hours IS NOT NULL AND v.engine_hours >= s.next_due_hours)
          OR (s.next_due_at IS NOT NULL AND now() >= s.next_due_at) THEN 'due'
        WHEN (s.next_due_km IS NOT NULL AND v.odometer_km >= s.next_due_km - s.remind_before_km)
          OR (s.next_due_hours IS NOT NULL AND v.engine_hours >= s.next_due_hours - s.remind_before_hours)
          OR (s.next_due_at IS NOT NULL AND now() >= s.next_due_at - make_interval(days => s.remind_before_days)) THEN 'due_soon'
        ELSE 'ok' END
     FROM vehicles v WHERE v.id = s.vehicle_id AND s.deleted_at IS NULL AND ($1::uuid[] IS NULL OR s.id = ANY($1))`,
    [scheduleIds ?? null],
  );
}

const SCHEDULE_SELECT = `SELECT x.id, x.vehicle_id, v.plate_number, x.service_task_id, t.name AS task_name, x.name, x.interval_km, x.interval_hours,
  x.interval_days, x.remind_before_km, x.remind_before_hours, x.remind_before_days, x.last_done_at, x.last_done_km, x.last_done_hours,
  x.next_due_at, x.next_due_km, x.next_due_hours, x.status, x.cycle, x.is_active, x.notes, v.odometer_km AS current_km, v.engine_hours AS current_hours,
  CASE WHEN x.next_due_km IS NOT NULL THEN x.next_due_km - v.odometer_km END AS km_remaining,
  CASE WHEN x.next_due_at IS NOT NULL THEN (x.next_due_at::date - current_date) END AS days_remaining, x.created_at, x.updated_at
  FROM service_schedules x JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN service_tasks t ON t.id = x.service_task_id`;

const WO_SELECT = `SELECT x.id, x.number, x.vehicle_id, v.plate_number, x.title, x.description, x.wo_type, x.priority, x.status, x.assigned_to,
  u.full_name AS assigned_to_name, x.vendor_name, x.scheduled_for, x.started_at, x.completed_at, x.odometer_km, x.engine_hours, x.labour_cost,
  x.parts_cost, x.other_cost, x.total_cost, x.currency, x.invoice_number, x.invoice_file_id, x.notes, x.created_at, x.updated_at,
  CASE WHEN x.completed_at IS NOT NULL AND x.started_at IS NOT NULL THEN round(extract(epoch FROM x.completed_at - x.started_at) / 3600, 1) END AS downtime_hours
  FROM work_orders x JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN users u ON u.id = x.assigned_to`;

const Item = z.object({
  item_type: z.enum(['labour', 'part', 'service', 'other']),
  description: z.string().trim().min(1).max(200),
  quantity: z.number().positive().max(100000).default(1),
  unit_cost: z.number().min(0).max(1e9).default(0),
  part_id: z.uuid().nullable().optional(),
  service_task_id: z.uuid().nullable().optional(),
  schedule_id: z.uuid().nullable().optional(),
  mechanic_id: z.uuid().nullable().optional(),
});

async function addItem(
  c: PoolClient,
  tenantId: string,
  woId: string,
  it: z.infer<typeof Item>,
): Promise<void> {
  let unit = it.unit_cost;
  if (it.item_type === 'part' && it.part_id && unit === 0) {
    unit = Number(
      (
        await c.query<{ unit_cost: string }>(
          'SELECT unit_cost FROM parts WHERE id = $1 AND deleted_at IS NULL',
          [it.part_id],
        )
      ).rows[0]?.unit_cost ?? 0,
    );
  }
  await c.query(
    `INSERT INTO work_order_items (tenant_id, work_order_id, item_type, service_task_id, schedule_id, part_id, mechanic_id, description, quantity, unit_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      tenantId,
      woId,
      it.item_type,
      it.service_task_id ?? null,
      it.schedule_id ?? null,
      it.part_id ?? null,
      it.mechanic_id ?? null,
      it.description,
      it.quantity,
      unit,
    ],
  );
}

async function workOrder(c: PoolClient, id: string): Promise<Row> {
  const wo = rowsOf(
    await c.query<Row>(`${WO_SELECT} WHERE x.id = $1 AND x.deleted_at IS NULL`, [id]),
  )[0];
  if (!wo) throw notFound('Work order');
  const items = await listRows(
    c,
    `SELECT i.id, i.item_type, i.description, i.quantity, i.unit_cost, i.total, i.part_id, p.part_number, i.service_task_id,
      i.schedule_id, i.mechanic_id, u.full_name AS mechanic_name FROM work_order_items i LEFT JOIN parts p ON p.id = i.part_id
      LEFT JOIN users u ON u.id = i.mechanic_id WHERE i.work_order_id = $1 ORDER BY i.created_at`,
    [id],
  );
  const defects = await listRows(
    c,
    'SELECT id, title, severity, status FROM defects WHERE work_order_id = $1',
    [id],
  );
  const dtcs = await listRows(
    c,
    'SELECT id, code, description, status FROM dtc_codes WHERE work_order_id = $1',
    [id],
  );
  return { ...wo, items, defects, dtc_codes: dtcs };
}

export function registerMaintenanceRoutes(v1: Router): void {
  // ---------------------------------------------------------------- service catalogue & schedules
  resource(v1, {
    path: 'service-tasks',
    table: 'service_tasks',
    tag: TAG,
    noun: 'Service task',
    read: ['maintenance:read'],
    write: ['maintenance:write'],
    input: z.object({
      name: z.string().trim().min(2).max(120),
      category: z.enum(CATEGORIES),
      description: z.string().trim().max(1000).nullable().optional(),
      est_labour_hours: z.number().min(0).max(1000).nullable().optional(),
      est_cost: z.number().min(0).nullable().optional(),
      is_active: z.boolean().optional(),
    }),
    select:
      'SELECT x.id, x.name, x.category, x.description, x.est_labour_hours, x.est_cost, x.is_active, x.created_at, x.updated_at FROM service_tasks x',
    sorts: { name: 'x.name', category: 'x.category' },
    defaultSort: 'x.name ASC',
    search: ['x.name'],
    filters: { category: { column: 'x.category', schema: z.enum(CATEGORIES) } },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/service-schedules/due',
    tags: [TAG],
    summary: 'Services due soon, due or overdue across the fleet',
    auth: true,
    middleware: guard('maintenance:read'),
    responses: { 200: { description: 'Schedules', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await refreshScheduleStatus(c);
        const scope = await groupScope(c, auth.userId);
        return {
          data: await listRows(
            c,
            `${SCHEDULE_SELECT} WHERE x.deleted_at IS NULL AND x.is_active AND x.status <> 'ok'
          AND ($1::uuid[] IS NULL OR v.group_id = ANY($1)) ORDER BY array_position(ARRAY['overdue','due','due_soon'], x.status), km_remaining NULLS LAST`,
            [scope],
          ),
        };
      });
    },
  });

  resource(v1, {
    path: 'service-schedules',
    table: 'service_schedules',
    tag: TAG,
    noun: 'Service schedule',
    read: ['maintenance:read'],
    write: ['maintenance:write'],
    input: z.object({
      vehicle_id: z.uuid(),
      service_task_id: z.uuid().nullable().optional(),
      name: z.string().trim().min(2).max(120),
      interval_km: z.number().positive().nullable().optional(),
      interval_hours: z.number().positive().nullable().optional(),
      interval_days: z.number().int().positive().nullable().optional(),
      remind_before_km: z.number().min(0).optional(),
      remind_before_hours: z.number().min(0).optional(),
      remind_before_days: z.number().int().min(0).optional(),
      last_done_at: z.iso.datetime({ offset: true }).nullable().optional(),
      last_done_km: z.number().min(0).nullable().optional(),
      last_done_hours: z.number().min(0).nullable().optional(),
      is_active: z.boolean().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }),
    select: SCHEDULE_SELECT,
    sorts: {
      name: 'x.name',
      status: 'x.status',
      next_due_km: 'x.next_due_km',
      next_due_at: 'x.next_due_at',
      plate_number: 'x.plate_number',
    },
    defaultSort: 'x.plate_number ASC',
    search: ['x.name', 'v.plate_number'],
    filters: {
      vehicle_id: { column: 'x.vehicle_id', schema: z.uuid() },
      status: { column: 'x.status', schema: z.enum(['ok', 'due_soon', 'due', 'overdue']) },
    },
    validate: async (c, b, auth, existing) => {
      if (b.vehicle_id) await visibleVehicle(c, b.vehicle_id, await groupScope(c, auth.userId));
      if (!existing && !b.interval_km && !b.interval_hours && !b.interval_days)
        throw unprocessable('Set at least one of interval_km, interval_hours or interval_days');
    },
    toColumns: async (b, c) => {
      const out: Row = { ...b };
      // a new schedule with no history starts counting from the vehicle's current reading
      if (b.vehicle_id && b.last_done_km === undefined && b.last_done_at === undefined) {
        const v = (
          await c.query<{ odometer_km: string; engine_hours: string }>(
            'SELECT odometer_km, engine_hours FROM vehicles WHERE id = $1',
            [b.vehicle_id],
          )
        ).rows[0];
        out.last_done_km = Number(v?.odometer_km ?? 0);
        out.last_done_hours = Number(v?.engine_hours ?? 0);
        out.last_done_at = new Date().toISOString();
      }
      return out;
    },
    extraCreate: (auth) => ({ created_by: auth.userId }),
    afterWrite: async (c, id) => refreshScheduleStatus(c, [id]),
  });

  // ---------------------------------------------------------------- parts & stock
  resource(v1, {
    path: 'parts',
    table: 'parts',
    tag: TAG,
    noun: 'Part',
    read: ['parts:read'],
    write: ['parts:write'],
    input: z.object({
      part_number: z.string().trim().max(60).nullable().optional(),
      name: z.string().trim().min(2).max(160),
      category: z.string().trim().max(60).nullable().optional(),
      unit: z.enum(['pcs', 'litre', 'set', 'pair', 'metre', 'kg']).optional(),
      unit_cost: z.number().min(0).optional(),
      currency: z.enum(['KES', 'TZS', 'UGX', 'RWF', 'USD']),
      reorder_level: z.number().min(0).optional(),
      reorder_qty: z.number().min(0).optional(),
      location: z.string().trim().max(80).nullable().optional(),
      supplier_name: z.string().trim().max(120).nullable().optional(),
      supplier_contact: z.string().trim().max(120).nullable().optional(),
      compatible_models: z.string().trim().max(500).nullable().optional(),
      is_active: z.boolean().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }),
    select: `SELECT x.id, x.part_number, x.name, x.category, x.unit, x.unit_cost, x.currency, x.quantity_on_hand, x.reorder_level, x.reorder_qty,
      (x.quantity_on_hand <= x.reorder_level) AS low_stock, round(x.quantity_on_hand * x.unit_cost, 2) AS stock_value, x.location, x.supplier_name,
      x.supplier_contact, x.compatible_models, x.is_active, x.notes, x.created_at, x.updated_at FROM parts x`,
    sorts: {
      name: 'x.name',
      part_number: 'x.part_number',
      quantity_on_hand: 'x.quantity_on_hand',
      stock_value: 'x.stock_value',
    },
    defaultSort: 'x.name ASC',
    search: ['x.name', 'x.part_number', 'x.supplier_name'],
    filters: {
      low_stock: {
        column: '(x.quantity_on_hand <= x.reorder_level)',
        schema: z.enum(['true', 'false']).transform((v) => v === 'true'),
      },
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/parts/:id/movements',
    tags: [TAG],
    summary: 'Record stock in/out (purchase, issue, return, adjustment, transfer)',
    auth: true,
    description:
      "Stock can never go negative. Purchases update the part's unit cost to the weighted average.",
    params: z.object({ id: z.uuid() }),
    body: z.object({
      movement_type: z.enum([
        'purchase',
        'issue',
        'return',
        'adjustment',
        'transfer_in',
        'transfer_out',
      ]),
      quantity: z.number().refine((n) => n !== 0),
      unit_cost: z.number().min(0).optional(),
      reference: z.string().trim().max(80).optional(),
      work_order_id: z.uuid().optional(),
      notes: z.string().trim().max(500).optional(),
    }),
    status: 201,
    middleware: guard('parts:write'),
    responses: { 201: { description: 'Part after the movement', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      if (body.movement_type !== 'adjustment' && body.quantity < 0)
        throw unprocessable('Quantity must be positive (use adjustment for corrections)');
      return tenantDb(req, async (c) => {
        const p = (
          await c.query<{ quantity_on_hand: string; unit_cost: string }>(
            'SELECT quantity_on_hand, unit_cost FROM parts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
            [params.id],
          )
        ).rows[0];
        if (!p) throw notFound('Part');
        await c
          .query(
            `INSERT INTO part_stock_movements (tenant_id, part_id, movement_type, quantity, unit_cost, reference, work_order_id, notes, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              auth.tenantId,
              params.id,
              body.movement_type,
              body.quantity,
              body.unit_cost ?? null,
              body.reference ?? null,
              body.work_order_id ?? null,
              body.notes ?? null,
              auth.userId,
            ],
          )
          .catch((e: { code?: string }) => {
            if (e.code === '23514')
              throw new AppError(
                409,
                'insufficient_stock',
                `Only ${Number(p.quantity_on_hand)} in stock`,
              );
            throw e;
          });
        if (body.movement_type === 'purchase' && body.unit_cost !== undefined) {
          const q0 = Number(p.quantity_on_hand);
          const avg =
            (q0 * Number(p.unit_cost) + body.quantity * body.unit_cost) / (q0 + body.quantity);
          await c.query('UPDATE parts SET unit_cost = $2 WHERE id = $1', [
            params.id,
            avg.toFixed(2),
          ]);
        }
        return rowsOf(
          await c.query<Row>(
            'SELECT id, name, quantity_on_hand, unit_cost, (quantity_on_hand <= reorder_level) AS low_stock FROM parts WHERE id = $1',
            [params.id],
          ),
        )[0];
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/parts/:id/movements',
    tags: [TAG],
    summary: 'Stock ledger for a part',
    auth: true,
    params: z.object({ id: z.uuid() }),
    query: z.object(PageQuery),
    middleware: guard('parts:read'),
    responses: { 200: { description: 'Movements', schema: ListOf } },
    handler: async ({ req, params, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT m.id, m.movement_type, m.quantity, m.unit_cost, m.reference, m.work_order_id, w.number AS work_order_number,
            m.notes, u.full_name AS created_by, m.created_at, count(*) OVER() AS total
          FROM part_stock_movements m LEFT JOIN work_orders w ON w.id = m.work_order_id LEFT JOIN users u ON u.id = m.created_by
          WHERE m.part_id = $1 ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
          [params.id, query.page_size, (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  // ---------------------------------------------------------------- work orders
  route(v1, BASE, {
    method: 'post',
    path: '/work-orders',
    tags: [TAG],
    summary: 'Open a work order (number assigned automatically)',
    auth: true,
    body: z.object({
      vehicle_id: z.uuid(),
      title: z.string().trim().min(2).max(160),
      description: z.string().trim().max(4000).optional(),
      wo_type: z
        .enum(['preventive', 'corrective', 'inspection', 'accident', 'recall', 'tyre'])
        .default('corrective'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
      assigned_to: z.uuid().optional(),
      vendor_name: z.string().trim().max(120).optional(),
      scheduled_for: z.iso.datetime({ offset: true }).optional(),
      items: z.array(Item).max(200).default([]),
      defect_ids: z.array(z.uuid()).max(50).default([]),
      dtc_ids: z.array(z.uuid()).max(50).default([]),
    }),
    status: 201,
    middleware: guard('maintenance:write'),
    responses: { 201: { description: 'Work order', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const v = await visibleVehicle(c, body.vehicle_id, await groupScope(c, auth.userId));
        const cur = (
          await c.query<{ currency: string }>('SELECT currency FROM tenants LIMIT 1')
        ).rows[0]!.currency.trim();
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO work_orders (tenant_id, number, vehicle_id, title, description, wo_type, priority, status, assigned_to, vendor_name, scheduled_for,
             odometer_km, engine_hours, currency, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
            [
              auth.tenantId,
              await nextNumber(c, 'work_orders', 'WO'),
              body.vehicle_id,
              body.title,
              body.description ?? null,
              body.wo_type,
              body.priority,
              body.scheduled_for ? 'scheduled' : 'open',
              body.assigned_to ?? null,
              body.vendor_name ?? null,
              body.scheduled_for ?? null,
              v.odometer_km,
              v.engine_hours,
              cur,
              auth.userId,
            ],
          )
        ).rows[0]!.id;
        for (const it of body.items) await addItem(c, auth.tenantId!, id, it);
        if (body.defect_ids.length)
          await c.query(
            `UPDATE defects SET work_order_id = $1, status = 'in_progress' WHERE id = ANY($2) AND vehicle_id = $3`,
            [id, body.defect_ids, body.vehicle_id],
          );
        if (body.dtc_ids.length)
          await c.query(
            'UPDATE dtc_codes SET work_order_id = $1 WHERE id = ANY($2) AND vehicle_id = $3',
            [id, body.dtc_ids, body.vehicle_id],
          );
        if (body.wo_type === 'preventive' || body.wo_type === 'corrective')
          await c.query(
            `UPDATE vehicles SET status = 'in_maintenance' WHERE id = $1 AND status = 'active' AND $2`,
            [body.vehicle_id, body.priority === 'urgent'],
          );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'work_order.created',
          entityType: 'work_order',
          entityId: id,
          req,
        });
        return workOrder(c, id);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/work-orders',
    tags: [TAG],
    summary: 'List work orders',
    auth: true,
    query: z.object({
      ...PageQuery,
      status: z.enum(WO_STATUSES).optional(),
      vehicle_id: z.uuid().optional(),
      assigned_to: z.uuid().optional(),
      open_only: z.enum(['true', 'false']).optional(),
      search: z.string().trim().max(60).optional(),
    }),
    middleware: guard('maintenance:read'),
    responses: { 200: { description: 'Work orders', schema: ListOf } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const mine = auth.role === 'mechanic' ? auth.userId : null;
        const r = await c.query<Row>(
          `SELECT y.*, count(*) OVER() AS total FROM (${WO_SELECT} WHERE x.deleted_at IS NULL
            AND ($1::text IS NULL OR x.status = $1) AND ($2::uuid IS NULL OR x.vehicle_id = $2) AND ($3::uuid IS NULL OR x.assigned_to = $3)
            AND ($4::bool IS NULL OR NOT $4 OR x.status NOT IN ('completed','cancelled')) AND ($5::uuid[] IS NULL OR v.group_id = ANY($5))
            AND ($6::text IS NULL OR x.number ILIKE '%'||$6||'%' OR x.title ILIKE '%'||$6||'%' OR v.plate_number ILIKE '%'||$6||'%')) y
          ORDER BY array_position(ARRAY['urgent','high','normal','low'], y.priority), y.created_at DESC LIMIT $7 OFFSET $8`,
          [
            query.status ?? null,
            query.vehicle_id ?? null,
            query.assigned_to ?? mine,
            query.open_only ? query.open_only === 'true' : null,
            scope,
            query.search ?? null,
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
    path: '/work-orders/:id',
    tags: [TAG],
    summary: 'Work order with lines, defects and fault codes',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('maintenance:read'),
    responses: { 200: { description: 'Work order', schema: AnyRow } },
    handler: async ({ req, params }) => tenantDb(req, (c) => workOrder(c, params.id)),
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/work-orders/:id',
    tags: [TAG],
    summary: 'Edit work order details',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({
      title: z.string().trim().min(2).max(160).optional(),
      description: z.string().trim().max(4000).nullable().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      assigned_to: z.uuid().nullable().optional(),
      vendor_name: z.string().trim().max(120).nullable().optional(),
      scheduled_for: z.iso.datetime({ offset: true }).nullable().optional(),
      invoice_number: z.string().trim().max(60).nullable().optional(),
      invoice_file_id: z.uuid().nullable().optional(),
      notes: z.string().trim().max(4000).nullable().optional(),
    }),
    middleware: guard('maintenance:write'),
    responses: { 200: { description: 'Work order', schema: AnyRow } },
    handler: async ({ req, params, body }) =>
      tenantDb(req, async (c) => {
        await assertFile(c, body.invoice_file_id, ['work_order']);
        const cols = Object.entries(body).filter(([, v]) => v !== undefined);
        if (cols.length) {
          const r = await c.query(
            `UPDATE work_orders SET ${cols.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
            [params.id, ...cols.map(([, v]) => v)],
          );
          if (!r.rowCount) throw notFound('Work order');
        }
        return workOrder(c, params.id);
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/work-orders/:id/items',
    tags: [TAG],
    summary: 'Add labour/part/service lines',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({ items: z.array(Item).min(1).max(100) }),
    middleware: guard('maintenance:write'),
    responses: { 200: { description: 'Work order', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const wo = await workOrder(c, params.id);
        if (wo.status === 'completed' || wo.status === 'cancelled')
          throw new AppError(409, 'work_order_closed', 'This work order is closed');
        for (const it of body.items) await addItem(c, auth.tenantId!, params.id, it);
        return workOrder(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/work-orders/:id/items/:itemId',
    tags: [TAG],
    summary: 'Remove a line',
    auth: true,
    params: z.object({ id: z.uuid(), itemId: z.uuid() }),
    middleware: guard('maintenance:write'),
    responses: { 200: { description: 'Work order', schema: AnyRow } },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => {
        const wo = await workOrder(c, params.id);
        if (wo.status === 'completed')
          throw new AppError(409, 'work_order_closed', 'This work order is closed');
        if (
          !(
            await c.query('DELETE FROM work_order_items WHERE id = $1 AND work_order_id = $2', [
              params.itemId,
              params.id,
            ])
          ).rowCount
        )
          throw notFound('Line');
        return workOrder(c, params.id);
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/work-orders/:id/status',
    tags: [TAG],
    summary: 'Move a work order through its lifecycle',
    description:
      'Completing issues all part lines from stock, completes linked service schedules (resetting their next due), resolves linked defects and clears linked fault codes.',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({
      status: z.enum(['scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled']),
      odometer_km: z.number().min(0).optional(),
      engine_hours: z.number().min(0).optional(),
      note: z.string().trim().max(1000).optional(),
    }),
    middleware: guard('maintenance:write'),
    responses: { 200: { description: 'Work order', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const wo = await workOrder(c, params.id);
        if (wo.status === 'completed' || wo.status === 'cancelled')
          throw new AppError(409, 'work_order_closed', 'This work order is already closed');
        if (auth.role === 'mechanic' && wo.assigned_to && wo.assigned_to !== auth.userId)
          throw forbidden('This work order is assigned to another mechanic');
        await c.query(
          `UPDATE work_orders SET status = $2, started_at = CASE WHEN $2 = 'in_progress' THEN coalesce(started_at, now()) ELSE started_at END,
            completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END, odometer_km = coalesce($3, odometer_km), engine_hours = coalesce($4, engine_hours),
            notes = CASE WHEN $5::text IS NULL THEN notes ELSE concat_ws(E'\\n', notes, $5) END WHERE id = $1`,
          [
            params.id,
            body.status,
            body.odometer_km ?? null,
            body.engine_hours ?? null,
            body.note ?? null,
          ],
        );
        if (body.status === 'completed')
          await completeWorkOrder(c, auth, params.id, String(wo.vehicle_id), String(wo.number));
        if (body.status === 'completed' || body.status === 'cancelled') {
          await c.query(
            `UPDATE vehicles SET status = 'active' WHERE id = $1 AND status = 'in_maintenance'
              AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.vehicle_id = $1 AND w.id <> $2 AND w.status IN ('in_progress') AND w.deleted_at IS NULL)`,
            [wo.vehicle_id, params.id],
          );
        }
        if (body.status === 'in_progress')
          await c.query(
            `UPDATE vehicles SET status = 'in_maintenance' WHERE id = $1 AND status = 'active'`,
            [wo.vehicle_id],
          );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: `work_order.${body.status}`,
          entityType: 'work_order',
          entityId: params.id,
          req,
        });
        return workOrder(c, params.id);
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/vehicles/:id/service-history',
    tags: [TAG],
    summary: 'Completed work orders and costs for a vehicle',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('maintenance:read'),
    responses: { 200: { description: 'History', schema: AnyRow } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await visibleVehicle(c, params.id, await groupScope(c, auth.userId));
        const data = await listRows(
          c,
          `${WO_SELECT} WHERE x.vehicle_id = $1 AND x.deleted_at IS NULL ORDER BY coalesce(x.completed_at, x.created_at) DESC`,
          [params.id],
        );
        const totals = rowsOf(
          await c.query<Row>(
            `SELECT count(*) FILTER (WHERE status = 'completed') AS completed, coalesce(sum(total_cost) FILTER (WHERE status = 'completed'), 0) AS total_cost,
            coalesce(sum(total_cost) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '365 days'), 0) AS cost_12m FROM work_orders WHERE vehicle_id = $1 AND deleted_at IS NULL`,
            [params.id],
          ),
        )[0];
        return { totals, data };
      });
    },
  });

  // ---------------------------------------------------------------- inspections
  resource(v1, {
    path: 'inspection-templates',
    table: 'inspection_templates',
    tag: TAG,
    noun: 'Inspection template',
    read: ['inspections:read'],
    write: ['inspections:templates'],
    input: z.object({
      name: z.string().trim().min(2).max(120),
      inspection_type: z.enum(['pre_trip', 'post_trip', 'periodic']),
      body_types: z.array(z.string()).nullable().optional(),
      is_default: z.boolean().optional(),
      is_active: z.boolean().optional(),
      items: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(160),
            label_sw: z.string().trim().max(160).nullable().optional(),
            category: z.string().trim().max(40).default('general'),
            is_critical: z.boolean().default(false),
            requires_photo_on_fail: z.boolean().default(true),
          }),
        )
        .min(1)
        .max(100)
        .optional(),
    }),
    select: `SELECT x.id, x.name, x.inspection_type, x.body_types, x.is_default, x.is_active, x.created_at, x.updated_at,
      coalesce((SELECT json_agg(json_build_object('id', i.id, 'seq', i.seq, 'label', i.label, 'label_sw', i.label_sw, 'category', i.category,
        'is_critical', i.is_critical, 'requires_photo_on_fail', i.requires_photo_on_fail) ORDER BY i.seq) FROM inspection_template_items i WHERE i.template_id = x.id), '[]') AS items
      FROM inspection_templates x`,
    sorts: { name: 'x.name' },
    defaultSort: 'x.name ASC',
    toColumns: (b) => {
      const { items: _i, ...rest } = b;
      return rest;
    },
    afterWrite: async (c, id, auth, req) => {
      const items = (
        req.body as {
          items?: {
            label: string;
            label_sw?: string | null;
            category?: string;
            is_critical?: boolean;
            requires_photo_on_fail?: boolean;
          }[];
        }
      ).items;
      if (!items) return;
      await c.query('DELETE FROM inspection_template_items WHERE template_id = $1', [id]);
      for (const [i, it] of items.entries()) {
        await c.query(
          `INSERT INTO inspection_template_items (tenant_id, template_id, seq, label, label_sw, category, is_critical, requires_photo_on_fail)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            auth.tenantId,
            id,
            i + 1,
            it.label,
            it.label_sw ?? null,
            it.category ?? 'general',
            it.is_critical ?? false,
            it.requires_photo_on_fail ?? true,
          ],
        );
      }
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/inspections',
    tags: [TAG],
    summary: 'Submit a pre/post-trip inspection (driver app)',
    description:
      'Each "defect" result creates a defect; a critical defect fails the inspection, takes the vehicle out of service and alerts the fleet manager.',
    auth: true,
    body: z.object({
      vehicle_id: z.uuid(),
      template_id: z.uuid().optional(),
      inspection_type: z.enum(['pre_trip', 'post_trip', 'periodic']),
      started_at: z.iso.datetime({ offset: true }),
      odometer_km: z.number().min(0).optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      signature_file_id: z.uuid().optional(),
      notes: z.string().trim().max(2000).optional(),
      results: z
        .array(
          z.object({
            template_item_id: z.uuid().optional(),
            label: z.string().trim().min(1).max(160),
            category: z.string().max(40).default('general'),
            status: z.enum(['ok', 'defect', 'na']),
            is_critical: z.boolean().default(false),
            note: z.string().trim().max(1000).optional(),
            photo_file_ids: z.array(z.uuid()).max(10).default([]),
          }),
        )
        .min(1)
        .max(150),
    }),
    status: 201,
    middleware: guard(),
    responses: { 201: { description: 'Inspection', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      if (!auth.permissions.has('inspections:submit') && !auth.permissions.has('maintenance:write'))
        throw forbidden();
      return tenantDb(req, async (c) => {
        await visibleVehicle(c, body.vehicle_id, await groupScope(c, auth.userId));
        await assertFile(c, body.signature_file_id, ['inspection', 'proof_of_delivery']);
        for (const r of body.results)
          for (const f of r.photo_file_ids) await assertFile(c, f, ['inspection']);
        const driverId =
          (
            await c.query<{ id: string }>(
              'SELECT id FROM drivers WHERE user_id = $1 AND deleted_at IS NULL',
              [auth.userId],
            )
          ).rows[0]?.id ?? null;
        const defects = body.results.filter((r) => r.status === 'defect');
        const critical = defects.some((r) => r.is_critical);
        const result = critical ? 'fail' : defects.length ? 'pass_with_defects' : 'pass';
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO inspections (tenant_id, vehicle_id, driver_id, template_id, inspection_type, started_at, odometer_km, lat, lng, result, signature_file_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [
              auth.tenantId,
              body.vehicle_id,
              driverId,
              body.template_id ?? null,
              body.inspection_type,
              body.started_at,
              body.odometer_km ?? null,
              body.lat ?? null,
              body.lng ?? null,
              result,
              body.signature_file_id ?? null,
              body.notes ?? null,
            ],
          )
        ).rows[0]!.id;
        for (const r of body.results) {
          const rid = (
            await c.query<{ id: string }>(
              `INSERT INTO inspection_results (tenant_id, inspection_id, template_item_id, label, category, status, is_critical, note, photo_file_ids)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
              [
                auth.tenantId,
                id,
                r.template_item_id ?? null,
                r.label,
                r.category,
                r.status,
                r.is_critical,
                r.note ?? null,
                r.photo_file_ids,
              ],
            )
          ).rows[0]!.id;
          if (r.status === 'defect') {
            await c.query(
              `INSERT INTO defects (tenant_id, vehicle_id, inspection_result_id, reported_by_driver_id, reported_by_user_id, title, description, severity, photo_file_ids)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                auth.tenantId,
                body.vehicle_id,
                rid,
                driverId,
                auth.userId,
                r.label,
                r.note ?? null,
                r.is_critical ? 'critical' : 'minor',
                r.photo_file_ids,
              ],
            );
          }
        }
        if (critical)
          await c.query(
            `UPDATE vehicles SET status = 'in_maintenance' WHERE id = $1 AND status = 'active'`,
            [body.vehicle_id],
          );
        if (result === 'fail') {
          await publishEvent({
            type: 'inspection_failed',
            tenant_id: auth.tenantId,
            vehicle_id: body.vehicle_id,
            driver_id: driverId,
            lat: body.lat ?? null,
            lng: body.lng ?? null,
            extra: body.inspection_type.replace('_', '-'),
            source_type: 'inspections',
            source_id: id,
            dedupe: `inspection:${id}`,
          });
          for (const dft of defects.filter((x) => x.is_critical)) {
            await publishEvent({
              type: 'defect_critical',
              tenant_id: auth.tenantId,
              vehicle_id: body.vehicle_id,
              driver_id: driverId,
              extra: dft.label,
              dedupe: `defect:${id}:${dft.label}`,
            });
          }
        }
        return rowsOf(
          await c.query<Row>(
            'SELECT id, vehicle_id, inspection_type, result, submitted_at FROM inspections WHERE id = $1',
            [id],
          ),
        )[0];
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/inspections',
    tags: [TAG],
    summary: 'List inspections',
    auth: true,
    query: z.object({
      ...PageQuery,
      vehicle_id: z.uuid().optional(),
      result: z.enum(['pass', 'pass_with_defects', 'fail']).optional(),
    }),
    middleware: guard('inspections:read'),
    responses: { 200: { description: 'Inspections', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT i.id, i.vehicle_id, v.plate_number, i.driver_id, d.full_name AS driver_name, i.inspection_type, i.result, i.odometer_km,
            i.started_at, i.submitted_at, (SELECT count(*) FROM inspection_results r WHERE r.inspection_id = i.id AND r.status = 'defect') AS defects, count(*) OVER() AS total
          FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id LEFT JOIN drivers d ON d.id = i.driver_id
          WHERE ($1::uuid IS NULL OR i.vehicle_id = $1) AND ($2::text IS NULL OR i.result = $2) ORDER BY i.submitted_at DESC LIMIT $3 OFFSET $4`,
          [
            query.vehicle_id ?? null,
            query.result ?? null,
            query.page_size,
            (query.page - 1) * query.page_size,
          ],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  route(v1, BASE, {
    method: 'get',
    path: '/inspections/:id',
    tags: [TAG],
    summary: 'Inspection with every checklist result',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('inspections:read'),
    responses: { 200: { description: 'Inspection', schema: AnyRow } },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => {
        const i = rowsOf(
          await c.query<Row>(
            `SELECT i.*, v.plate_number, d.full_name AS driver_name FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id
          LEFT JOIN drivers d ON d.id = i.driver_id WHERE i.id = $1`,
            [params.id],
          ),
        )[0];
        if (!i) throw notFound('Inspection');
        return {
          ...i,
          results: await listRows(
            c,
            'SELECT id, label, category, status, is_critical, note, photo_file_ids FROM inspection_results WHERE inspection_id = $1',
            [params.id],
          ),
        };
      }),
  });

  // ---------------------------------------------------------------- defects
  resource(v1, {
    path: 'defects',
    table: 'defects',
    tag: TAG,
    noun: 'Defect',
    read: ['maintenance:read'],
    write: ['maintenance:write'],
    softDelete: false,
    input: z.object({
      vehicle_id: z.uuid(),
      title: z.string().trim().min(2).max(160),
      description: z.string().trim().max(2000).nullable().optional(),
      severity: z.enum(['minor', 'major', 'critical']).optional(),
      status: z.enum(['open', 'in_progress', 'resolved', 'deferred', 'rejected']).optional(),
      resolution_note: z.string().trim().max(1000).nullable().optional(),
      photo_file_ids: z.array(z.uuid()).max(10).optional(),
    }),
    select: `SELECT x.id, x.vehicle_id, v.plate_number, x.title, x.description, x.severity, x.status, x.work_order_id, w.number AS work_order_number,
      x.photo_file_ids, x.reported_at, d.full_name AS reported_by_driver, x.resolved_at, x.resolution_note, x.created_at, x.updated_at
      FROM defects x JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN work_orders w ON w.id = x.work_order_id LEFT JOIN drivers d ON d.id = x.reported_by_driver_id`,
    sorts: { reported_at: 'x.reported_at', severity: 'x.severity', status: 'x.status' },
    defaultSort: 'x.reported_at DESC',
    search: ['x.title', 'v.plate_number'],
    filters: {
      vehicle_id: { column: 'x.vehicle_id', schema: z.uuid() },
      status: {
        column: 'x.status',
        schema: z.enum(['open', 'in_progress', 'resolved', 'deferred', 'rejected']),
      },
      severity: { column: 'x.severity', schema: z.enum(['minor', 'major', 'critical']) },
    },
    toColumns: (b) => ({
      ...b,
      ...(b.status === 'resolved' ? { resolved_at: new Date().toISOString() } : {}),
    }),
    extraCreate: (auth) => ({ reported_by_user_id: auth.userId }),
    ops: ['list', 'get', 'create', 'update'],
  });

  // ---------------------------------------------------------------- fault codes
  route(v1, BASE, {
    method: 'get',
    path: '/dtc-codes',
    tags: [TAG],
    summary: 'Engine fault codes captured from CAN/OBD trackers',
    auth: true,
    query: z.object({
      ...PageQuery,
      vehicle_id: z.uuid().optional(),
      status: z.enum(['active', 'pending', 'cleared']).optional(),
    }),
    middleware: guard('maintenance:read'),
    responses: { 200: { description: 'Codes', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT d.id, d.vehicle_id, v.plate_number, d.code, coalesce(d.description, k.description) AS description, k.system, d.status,
            d.first_seen_at, d.last_seen_at, d.occurrences, d.work_order_id, d.cleared_at, count(*) OVER() AS total
          FROM dtc_codes d JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN dtc_catalog k ON k.code = d.code
          WHERE ($1::uuid IS NULL OR d.vehicle_id = $1) AND ($2::text IS NULL OR d.status = $2) ORDER BY d.last_seen_at DESC LIMIT $3 OFFSET $4`,
          [
            query.vehicle_id ?? null,
            query.status ?? null,
            query.page_size,
            (query.page - 1) * query.page_size,
          ],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/dtc-codes/:id/clear',
    tags: [TAG],
    summary: 'Mark a fault code as cleared',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('maintenance:write'),
    responses: { 200: { description: 'Cleared', schema: AnyRow } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `UPDATE dtc_codes SET status = 'cleared', cleared_at = now(), cleared_by = $2 WHERE id = $1 AND status <> 'cleared' RETURNING id, code, status, cleared_at`,
          [params.id, auth.userId],
        );
        if (!r.rowCount) throw notFound('Active fault code');
        return rowsOf(r)[0];
      });
    },
  });
}

async function completeWorkOrder(
  c: PoolClient,
  auth: AuthContext,
  id: string,
  vehicleId: string,
  number: string,
): Promise<void> {
  // issue part lines from stock once
  const parts = (
    await c.query<{ part_id: string; quantity: string; unit_cost: string }>(
      `SELECT part_id, sum(quantity) AS quantity, max(unit_cost) AS unit_cost FROM work_order_items WHERE work_order_id = $1 AND item_type = 'part' AND part_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM part_stock_movements m WHERE m.work_order_id = $1 AND m.part_id = work_order_items.part_id AND m.movement_type = 'issue')
     GROUP BY part_id`,
      [id],
    )
  ).rows;
  for (const p of parts) {
    await c
      .query(
        `INSERT INTO part_stock_movements (tenant_id, part_id, movement_type, quantity, unit_cost, reference, work_order_id, created_by)
      VALUES ($1,$2,'issue',$3,$4,$5,$6,$7)`,
        [auth.tenantId, p.part_id, p.quantity, p.unit_cost, number, id, auth.userId],
      )
      .catch((e: { code?: string }) => {
        if (e.code === '23514')
          throw new AppError(
            409,
            'insufficient_stock',
            'Not enough stock for one of the parts on this work order',
            { part_id: p.part_id },
          );
        throw e;
      });
  }
  const wo = (
    await c.query<{ odometer_km: string | null; engine_hours: string | null; completed_at: Date }>(
      'SELECT odometer_km, engine_hours, completed_at FROM work_orders WHERE id = $1',
      [id],
    )
  ).rows[0]!;
  const schedules = (
    await c.query<{ schedule_id: string }>(
      'SELECT DISTINCT schedule_id FROM work_order_items WHERE work_order_id = $1 AND schedule_id IS NOT NULL',
      [id],
    )
  ).rows;
  for (const s of schedules) {
    await c.query(
      `UPDATE service_schedules SET last_done_at = $2, last_done_km = coalesce($3, (SELECT odometer_km FROM vehicles WHERE id = $5)),
        last_done_hours = coalesce($4, (SELECT engine_hours FROM vehicles WHERE id = $5)), cycle = cycle + 1, status = 'ok' WHERE id = $1`,
      [s.schedule_id, wo.completed_at, wo.odometer_km, wo.engine_hours, vehicleId],
    );
  }
  await c.query(
    `UPDATE defects SET status = 'resolved', resolved_at = now(), resolution_note = coalesce(resolution_note, $2) WHERE work_order_id = $1 AND status <> 'resolved'`,
    [id, `Fixed in ${number}`],
  );
  await c.query(
    `UPDATE dtc_codes SET status = 'cleared', cleared_at = now(), cleared_by = $2 WHERE work_order_id = $1 AND status <> 'cleared'`,
    [id, auth.userId],
  );
}
