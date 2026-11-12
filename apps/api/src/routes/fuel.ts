import type { Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { assertFile, paged, PageQuery } from '../http/crud.js';
import { AppError, forbidden, notFound, unprocessable } from '../http/errors.js';
import { AnyRow, ListOf, listRows, resource, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { headerIndex, parseCsv, parseDate, parseNumber, parseXlsx } from '../http/tabular.js';
import { getObjectBuffer } from '../infra/storage.js';
import { visibleVehicle } from './vehicles.js';

const BASE = '/api/v1';
const TAG = 'Fuel';
const CURRENCIES = ['KES', 'TZS', 'UGX', 'RWF', 'USD'] as const;
const FUEL_TYPES = ['petrol', 'diesel', 'lpg', 'cng', 'adblue'] as const;
const dt = z.iso.datetime({ offset: true });

/**
 * Recomputes full-tank-to-full-tank consumption for a vehicle's logs and flags anomalies:
 * over_tank_capacity, odometer_rollback, high_consumption (> 1.5x expected), low_consumption (< 0.5x expected).
 */
export async function recomputeConsumption(c: PoolClient, vehicleId: string): Promise<void> {
  const v = (
    await c.query<{ tank_capacity_l: string | null; expected_l_per_100km: string | null }>(
      'SELECT tank_capacity_l, expected_l_per_100km FROM vehicles WHERE id = $1',
      [vehicleId],
    )
  ).rows[0];
  const tank = v?.tank_capacity_l ? Number(v.tank_capacity_l) : null;
  const expected = v?.expected_l_per_100km ? Number(v.expected_l_per_100km) : null;
  const logs = (
    await c.query<{
      id: string;
      litres: string;
      odometer_km: string | null;
      is_full_tank: boolean;
      flags: string[];
    }>(
      `SELECT id, litres, odometer_km, is_full_tank, flags FROM fuel_logs WHERE vehicle_id = $1 AND deleted_at IS NULL AND fuel_type <> 'adblue'
     ORDER BY filled_at, created_at`,
      [vehicleId],
    )
  ).rows;
  let lastFullOdo: number | null = null;
  let litresSince = 0;
  let prevOdo: number | null = null;
  for (const l of logs) {
    const litres = Number(l.litres);
    const odo = l.odometer_km === null ? null : Number(l.odometer_km);
    const flags = new Set(
      l.flags.filter(
        (f) =>
          ![
            'over_tank_capacity',
            'odometer_rollback',
            'high_consumption',
            'low_consumption',
          ].includes(f),
      ),
    );
    if (tank && litres > tank * 1.05) flags.add('over_tank_capacity');
    if (odo !== null && prevOdo !== null && odo < prevOdo) flags.add('odometer_rollback');
    litresSince += litres;
    let distance: number | null = null;
    let consumption: number | null = null;
    if (l.is_full_tank && odo !== null) {
      if (lastFullOdo !== null && odo > lastFullOdo) {
        distance = odo - lastFullOdo;
        consumption = Math.round((litresSince / distance) * 100 * 100) / 100;
        if (expected && consumption > expected * 1.5) flags.add('high_consumption');
        if (expected && consumption < expected * 0.5) flags.add('low_consumption');
      }
      lastFullOdo = odo;
      litresSince = 0;
    }
    if (odo !== null) prevOdo = odo;
    await c.query(
      'UPDATE fuel_logs SET distance_since_last_km = $2, consumption_l_per_100km = $3, flags = $4 WHERE id = $1',
      [l.id, distance === null ? null : distance.toFixed(1), consumption, [...flags]],
    );
  }
}

const LOG_SELECT = `SELECT x.id, x.vehicle_id, v.plate_number, x.driver_id, d.full_name AS driver_name, x.fuel_card_id, fc.card_last4, x.filled_at, x.litres,
  x.unit_price, x.total_cost, x.currency, x.odometer_km, x.is_full_tank, x.fuel_type, x.station_name, x.poi_id, x.lat, x.lng, x.receipt_number,
  x.receipt_file_id, x.source, x.external_ref, x.distance_since_last_km, x.consumption_l_per_100km, x.flags, x.verified, x.notes, x.created_at, x.updated_at
  FROM fuel_logs x JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN drivers d ON d.id = x.driver_id LEFT JOIN fuel_cards fc ON fc.id = x.fuel_card_id`;

const LogInput = z.object({
  vehicle_id: z.uuid(),
  driver_id: z.uuid().nullable().optional(),
  fuel_card_id: z.uuid().nullable().optional(),
  filled_at: dt,
  litres: z.number().positive().max(2000),
  unit_price: z.number().positive().nullable().optional(),
  total_cost: z.number().min(0).optional(),
  currency: z.enum(CURRENCIES).optional(),
  odometer_km: z.number().min(0).nullable().optional(),
  is_full_tank: z.boolean().optional(),
  fuel_type: z.enum(FUEL_TYPES).optional(),
  station_name: z.string().trim().max(120).nullable().optional(),
  poi_id: z.uuid().nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  receipt_number: z.string().trim().max(60).nullable().optional(),
  receipt_file_id: z.uuid().nullable().optional(),
  verified: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

async function tenantCurrency(c: PoolClient): Promise<string> {
  return (
    await c.query<{ currency: string }>('SELECT currency FROM tenants LIMIT 1')
  ).rows[0]!.currency.trim();
}

export function registerFuelRoutes(v1: Router): void {
  resource(v1, {
    path: 'fuel-cards',
    table: 'fuel_cards',
    tag: TAG,
    noun: 'Fuel card',
    read: ['fuel:read'],
    write: ['fuel:write'],
    input: z.object({
      provider: z.enum([
        'totalenergies',
        'rubis',
        'shell',
        'vivo',
        'ola',
        'puma',
        'oryx',
        'gulf',
        'other',
      ]),
      card_last4: z
        .string()
        .regex(/^\d{4}$/, 'Only the last 4 digits - never store full card numbers'),
      label: z.string().trim().max(80).nullable().optional(),
      vehicle_id: z.uuid().nullable().optional(),
      driver_id: z.uuid().nullable().optional(),
      monthly_limit: z.number().positive().nullable().optional(),
      currency: z.enum(CURRENCIES),
      status: z.enum(['active', 'blocked', 'expired', 'lost']).optional(),
      expires_on: z.iso.date().nullable().optional(),
    }),
    select: `SELECT x.id, x.provider, x.card_last4, x.label, x.vehicle_id, v.plate_number, x.driver_id, d.full_name AS driver_name, x.monthly_limit, x.currency,
      x.status, x.expires_on, (SELECT coalesce(sum(total_cost), 0) FROM fuel_logs l WHERE l.fuel_card_id = x.id AND l.deleted_at IS NULL
        AND l.filled_at >= date_trunc('month', now())) AS spent_this_month, x.created_at, x.updated_at
      FROM fuel_cards x LEFT JOIN vehicles v ON v.id = x.vehicle_id LEFT JOIN drivers d ON d.id = x.driver_id`,
    sorts: { provider: 'x.provider', created_at: 'x.created_at' },
    defaultSort: 'x.created_at DESC',
    search: ['x.card_last4', 'x.label'],
  });

  resource(v1, {
    path: 'fuel-prices',
    table: 'fuel_prices',
    tag: TAG,
    noun: 'Fuel price',
    read: ['fuel:read'],
    write: ['fuel:write'],
    softDelete: false,
    input: z.object({
      fuel_type: z.enum(['petrol', 'diesel', 'lpg', 'cng']),
      price_per_litre: z.number().positive(),
      currency: z.enum(CURRENCIES),
      effective_from: z.iso.date(),
    }),
    select:
      'SELECT x.id, x.fuel_type, x.price_per_litre, x.currency, x.effective_from, x.created_at FROM fuel_prices x',
    sorts: { effective_from: 'x.effective_from' },
    defaultSort: 'x.effective_from DESC',
    filters: {
      fuel_type: { column: 'x.fuel_type', schema: z.enum(['petrol', 'diesel', 'lpg', 'cng']) },
    },
  });

  // ---------------------------------------------------------------- fuel logs
  resource(v1, {
    path: 'fuel-logs',
    table: 'fuel_logs',
    tag: TAG,
    noun: 'Fuel log',
    read: ['fuel:read'],
    write: ['fuel:write'],
    input: LogInput,
    select: LOG_SELECT,
    sorts: {
      filled_at: 'x.filled_at',
      litres: 'x.litres',
      total_cost: 'x.total_cost',
      consumption: 'x.consumption_l_per_100km',
    },
    defaultSort: 'x.filled_at DESC',
    search: ['v.plate_number', 'x.station_name', 'x.receipt_number'],
    filters: {
      vehicle_id: { column: 'x.vehicle_id', schema: z.uuid() },
      driver_id: { column: 'x.driver_id', schema: z.uuid() },
      source: { column: 'x.source', schema: z.enum(['manual', 'app', 'card_import', 'sensor']) },
      flagged: {
        column: 'cardinality(x.flags) > 0',
        schema: z.enum(['true', 'false']).transform((v) => v === 'true'),
      },
    },
    validate: async (c, b, auth) => {
      if (b.vehicle_id) await visibleVehicle(c, b.vehicle_id, await groupScope(c, auth.userId));
      await assertFile(c, b.receipt_file_id, ['fuel_receipt']);
    },
    toColumns: async (b, c) => {
      const out: Row = { ...b };
      if (b.litres !== undefined && b.total_cost === undefined && b.unit_price)
        out.total_cost = Math.round(b.litres * b.unit_price * 100) / 100;
      if (b.litres !== undefined && b.unit_price === undefined && b.total_cost)
        out.unit_price = Math.round((b.total_cost / b.litres) * 1000) / 1000;
      if (b.vehicle_id && !b.currency) out.currency = await tenantCurrency(c);
      if (b.vehicle_id && out.total_cost === undefined)
        throw unprocessable('Provide total_cost or unit_price');
      return out;
    },
    extraCreate: (auth) => ({ created_by: auth.userId, source: 'manual' }),
    afterWrite: async (c, id) => {
      const v = (
        await c.query<{ vehicle_id: string }>('SELECT vehicle_id FROM fuel_logs WHERE id = $1', [
          id,
        ])
      ).rows[0];
      if (v) await recomputeConsumption(c, v.vehicle_id);
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/fuel-logs/submit',
    tags: [TAG],
    summary: 'Driver app: log a fill-up for my assigned vehicle',
    description:
      "Vehicle and driver are taken from the driver's current assignment unless vehicle_id is given. Photo of the receipt is recommended.",
    auth: true,
    body: z.object({
      vehicle_id: z.uuid().optional(),
      filled_at: dt.optional(),
      litres: z.number().positive().max(2000),
      total_cost: z.number().min(0),
      odometer_km: z.number().min(0).optional(),
      is_full_tank: z.boolean().default(true),
      station_name: z.string().trim().max(120).optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      receipt_number: z.string().trim().max(60).optional(),
      receipt_file_id: z.uuid().optional(),
      client_ref: z.string().max(80).optional().describe('Idempotency key from the offline app'),
    }),
    status: 201,
    middleware: guard('fuel:submit'),
    responses: { 201: { description: 'Fuel log', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const d = (
          await c.query<{ id: string; vehicle_id: string | null }>(
            `SELECT dr.id, dva.vehicle_id FROM drivers dr LEFT JOIN driver_vehicle_assignments dva ON dva.driver_id = dr.id AND dva.ends_at IS NULL
           WHERE dr.user_id = $1 AND dr.deleted_at IS NULL`,
            [auth.userId],
          )
        ).rows[0];
        if (!d) throw forbidden('Your login is not linked to a driver profile');
        const vehicleId = body.vehicle_id ?? d.vehicle_id;
        if (!vehicleId) throw unprocessable('You are not assigned to a vehicle - choose one');
        await assertFile(c, body.receipt_file_id, ['fuel_receipt']);
        if (body.client_ref) {
          const dup = (
            await c.query<{ id: string }>(
              `SELECT id FROM fuel_logs WHERE source = 'app' AND external_ref = $1`,
              [body.client_ref],
            )
          ).rows[0];
          if (dup) return rowsOf(await c.query<Row>(`${LOG_SELECT} WHERE x.id = $1`, [dup.id]))[0];
        }
        const v = (
          await c.query<{ fuel_type: string }>(
            'SELECT fuel_type FROM vehicles WHERE id = $1 AND deleted_at IS NULL',
            [vehicleId],
          )
        ).rows[0];
        if (!v) throw notFound('Vehicle');
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO fuel_logs (tenant_id, vehicle_id, driver_id, filled_at, litres, unit_price, total_cost, currency, odometer_km, is_full_tank, fuel_type,
             station_name, lat, lng, receipt_number, receipt_file_id, source, external_ref, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'app',$17,$18) RETURNING id`,
            [
              auth.tenantId,
              vehicleId,
              d.id,
              body.filled_at ?? new Date().toISOString(),
              body.litres,
              Math.round((body.total_cost / body.litres) * 1000) / 1000,
              body.total_cost,
              await tenantCurrency(c),
              body.odometer_km ?? null,
              body.is_full_tank,
              ['petrol', 'diesel', 'lpg', 'cng'].includes(v.fuel_type) ? v.fuel_type : 'diesel',
              body.station_name ?? null,
              body.lat ?? null,
              body.lng ?? null,
              body.receipt_number ?? null,
              body.receipt_file_id ?? null,
              body.client_ref ?? null,
              auth.userId,
            ],
          )
        ).rows[0]!.id;
        await recomputeConsumption(c, vehicleId);
        return rowsOf(await c.query<Row>(`${LOG_SELECT} WHERE x.id = $1`, [id]))[0];
      });
    },
  });

  // ---------------------------------------------------------------- card statement import
  route(v1, BASE, {
    method: 'post',
    path: '/fuel-imports',
    tags: [TAG],
    summary: 'Import a fuel card statement (CSV or Excel)',
    description:
      'Upload the file with purpose "import" first. Recognised columns (any order, names flexible): date, plate/registration, litres/quantity, ' +
      'amount/total, unit price, odometer/mileage, station/site, receipt/transaction id, card (last 4). Rows already imported are skipped.',
    auth: true,
    body: z.object({ file_id: z.uuid(), provider: z.string().trim().min(2).max(40) }),
    status: 201,
    middleware: guard('fuel:import'),
    responses: { 201: { description: 'Import result', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const f = (
          await c.query<{
            storage_key: string;
            content_type: string;
            purpose: string;
            status: string;
          }>('SELECT storage_key, content_type, purpose, status FROM files WHERE id = $1', [
            body.file_id,
          ])
        ).rows[0];
        if (!f || f.status !== 'ready' || f.purpose !== 'import')
          throw unprocessable('Upload the statement with purpose "import" first');
        const buf = await getObjectBuffer(f.storage_key);
        const rows =
          f.content_type === 'text/csv' ? parseCsv(buf.toString('utf8')) : await parseXlsx(buf);
        if (rows.length < 2) throw unprocessable('The file has no data rows');
        const idx = headerIndex(rows[0]!, {
          date: ['date', 'transaction date', 'trans date', 'datetime', 'date time', 'tarehe'],
          plate: ['plate', 'registration', 'reg no', 'vehicle', 'vehicle reg', 'reg'],
          litres: ['litres', 'liters', 'quantity', 'qty', 'volume', 'lita'],
          amount: ['amount', 'total', 'value', 'total amount', 'kiasi'],
          price: ['unit price', 'price', 'price per litre', 'rate'],
          odometer: ['odometer', 'mileage', 'km', 'odo'],
          station: ['station', 'site', 'merchant', 'location'],
          ref: ['receipt', 'receipt no', 'transaction id', 'reference', 'ref', 'invoice'],
          card: ['card', 'card no', 'card number', 'pan'],
        });
        for (const req of ['date', 'plate', 'litres'] as const)
          if (idx[req] === undefined)
            throw unprocessable(`Could not find a "${req}" column`, { headers: rows[0] });
        const tz = (await c.query<{ timezone: string }>('SELECT timezone FROM tenants LIMIT 1'))
          .rows[0]!.timezone;
        const offset = tz === 'Africa/Kigali' ? 120 : 180;
        const currency = await tenantCurrency(c);
        const vehicles = new Map(
          (
            await c.query<{ id: string; plate_normalized: string; fuel_type: string }>(
              'SELECT id, plate_normalized, fuel_type FROM vehicles WHERE deleted_at IS NULL',
            )
          ).rows.map((v) => [v.plate_normalized, v]),
        );
        const cards = new Map(
          (
            await c.query<{ id: string; card_last4: string }>(
              'SELECT id, card_last4 FROM fuel_cards WHERE deleted_at IS NULL',
            )
          ).rows.map((x) => [x.card_last4, x.id]),
        );
        const batch = (
          await c.query<{ id: string }>(
            `INSERT INTO fuel_import_batches (tenant_id, provider, file_id, rows_total, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [auth.tenantId, body.provider, body.file_id, rows.length - 1, auth.userId],
          )
        ).rows[0]!.id;
        const errors: { row: number; message: string }[] = [];
        const touched = new Set<string>();
        let imported = 0;
        let skipped = 0;
        for (const [n, r] of rows.slice(1).entries()) {
          const rowNo = n + 2;
          const get = (k: string): string | undefined =>
            idx[k] === undefined ? undefined : r[idx[k]!];
          const plate = (get('plate') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const v = vehicles.get(plate);
          const at = parseDate(get('date') ?? '', offset);
          const litres = parseNumber(get('litres'));
          let amount = parseNumber(get('amount'));
          const price = parseNumber(get('price'));
          if (!v) {
            errors.push({ row: rowNo, message: `Unknown vehicle "${get('plate') ?? ''}"` });
            continue;
          }
          if (!at) {
            errors.push({ row: rowNo, message: `Unreadable date "${get('date') ?? ''}"` });
            continue;
          }
          if (!litres || litres <= 0) {
            errors.push({ row: rowNo, message: 'Missing litres' });
            continue;
          }
          if (amount === null && price !== null) amount = Math.round(litres * price * 100) / 100;
          if (amount === null) {
            errors.push({ row: rowNo, message: 'Missing amount' });
            continue;
          }
          const ref = get('ref')?.trim() || `${plate}-${at.toISOString()}-${litres}`;
          const card = (get('card') ?? '').replace(/\D/g, '').slice(-4);
          const res = await c.query(
            `INSERT INTO fuel_logs (tenant_id, vehicle_id, fuel_card_id, filled_at, litres, unit_price, total_cost, currency, odometer_km, is_full_tank, fuel_type,
               station_name, receipt_number, source, external_ref, import_batch_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,'card_import',$13,$14,$15)
             ON CONFLICT (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL AND deleted_at IS NULL DO NOTHING`,
            [
              auth.tenantId,
              v.id,
              cards.get(card) ?? null,
              at,
              litres,
              price ?? Math.round((amount / litres) * 1000) / 1000,
              amount,
              currency,
              parseNumber(get('odometer')),
              ['petrol', 'diesel', 'lpg', 'cng'].includes(v.fuel_type) ? v.fuel_type : 'diesel',
              get('station')?.trim() || null,
              get('ref')?.trim() || null,
              ref,
              batch,
              auth.userId,
            ],
          );
          if (res.rowCount) {
            imported++;
            touched.add(v.id);
          } else skipped++;
        }
        for (const vid of touched) await recomputeConsumption(c, vid);
        await c.query(
          `UPDATE fuel_import_batches SET status = 'completed', rows_imported = $2, rows_skipped = $3, errors = $4, completed_at = now() WHERE id = $1`,
          [batch, imported, skipped + errors.length, JSON.stringify(errors.slice(0, 500))],
        );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'fuel.imported',
          entityType: 'fuel_import',
          entityId: batch,
          metadata: { imported, skipped, errors: errors.length },
          req,
        });
        return { batch_id: batch, rows: rows.length - 1, imported, duplicates: skipped, errors };
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/fuel-imports',
    tags: [TAG],
    summary: 'Import history',
    auth: true,
    middleware: guard('fuel:import'),
    responses: { 200: { description: 'Batches', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req }) =>
      tenantDb(req, async (c) => ({
        data: await listRows(
          c,
          'SELECT id, provider, status, rows_total, rows_imported, rows_skipped, errors, created_at, completed_at FROM fuel_import_batches ORDER BY created_at DESC LIMIT 100',
          [],
        ),
      })),
  });

  // ---------------------------------------------------------------- sensor events (refuel / drain)
  route(v1, BASE, {
    method: 'get',
    path: '/fuel-events',
    tags: [TAG],
    summary: 'Sensor-detected refuels and possible theft/drains',
    auth: true,
    query: z.object({
      ...PageQuery,
      vehicle_id: z.uuid().optional(),
      event_type: z.enum(['refuel', 'drain', 'sensor_fault']).optional(),
      status: z.enum(['open', 'confirmed', 'dismissed']).optional(),
    }),
    middleware: guard('fuel:read'),
    responses: { 200: { description: 'Events', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT e.*, v.plate_number, d.full_name AS driver_name, count(*) OVER() AS total FROM fuel_events e JOIN vehicles v ON v.id = e.vehicle_id
            LEFT JOIN drivers d ON d.id = e.driver_id WHERE ($1::uuid IS NULL OR e.vehicle_id = $1) AND ($2::text IS NULL OR e.event_type = $2) AND ($3::text IS NULL OR e.status = $3)
            ORDER BY e.started_at DESC LIMIT $4 OFFSET $5`,
          [
            query.vehicle_id ?? null,
            query.event_type ?? null,
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
    path: '/fuel-events/:id/review',
    tags: [TAG],
    summary: 'Confirm or dismiss a refuel/drain event, optionally matching a fuel log',
    auth: true,
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      status: z.enum(['confirmed', 'dismissed']),
      note: z.string().trim().max(1000).optional(),
      matched_fuel_log_id: z.uuid().optional(),
    }),
    middleware: guard('fuel:write'),
    responses: { 200: { description: 'Reviewed', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `UPDATE fuel_events SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(),
            matched_fuel_log_id = coalesce($5, matched_fuel_log_id) WHERE id = $1 RETURNING id, status, review_note, matched_fuel_log_id`,
          [
            params.id,
            body.status,
            body.note ?? null,
            auth.userId,
            body.matched_fuel_log_id ?? null,
          ],
        );
        if (!r.rowCount) throw notFound('Fuel event');
        return rowsOf(r)[0];
      });
    },
  });

  // ---------------------------------------------------------------- analytics
  route(v1, BASE, {
    method: 'get',
    path: '/fuel/summary',
    tags: [TAG],
    summary: 'Fuel use and cost per vehicle, with idle waste and recommendations',
    auth: true,
    query: z.object({ from: dt, to: dt, group_id: z.uuid().optional() }),
    middleware: guard('fuel:read'),
    responses: { 200: { description: 'Summary', schema: AnyRow } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      if (new Date(query.to) <= new Date(query.from))
        throw unprocessable('"to" must be after "from"');
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const vehicles = await listRows(
          c,
          `
          WITH logs AS (SELECT vehicle_id, sum(litres) AS litres, sum(total_cost) AS cost, count(*) AS fills,
                 avg(consumption_l_per_100km) FILTER (WHERE consumption_l_per_100km IS NOT NULL) AS avg_l100, count(*) FILTER (WHERE cardinality(flags) > 0) AS flagged,
                 max(odometer_km) - min(odometer_km) AS odo_km
               FROM fuel_logs WHERE deleted_at IS NULL AND filled_at >= $1 AND filled_at < $2 GROUP BY vehicle_id),
           dist AS (SELECT vehicle_id, sum(distance_km) AS km, sum(idle_s) AS idle_s FROM vehicle_daily_stats WHERE day >= $1::date AND day < $2::date GROUP BY vehicle_id),
           trips AS (SELECT vehicle_id, sum(distance_km) AS km, sum(idle_s) AS idle_s FROM trips WHERE started_at >= $1 AND started_at < $2 GROUP BY vehicle_id),
           drains AS (SELECT vehicle_id, count(*) AS n, sum(abs(change_l)) AS litres FROM fuel_events WHERE event_type = 'drain' AND status <> 'dismissed'
               AND started_at >= $1 AND started_at < $2 GROUP BY vehicle_id)
          SELECT v.id AS vehicle_id, v.plate_number, v.fuel_type, v.expected_l_per_100km, coalesce(l.litres, 0) AS litres, coalesce(l.cost, 0) AS cost,
            coalesce(l.fills, 0) AS fills, round(l.avg_l100::numeric, 2) AS avg_l_per_100km, coalesce(l.flagged, 0) AS flagged_logs,
            round(greatest(coalesce(dist.km, t.km, 0), coalesce(l.odo_km, 0))::numeric, 1) AS distance_km, round(coalesce(dist.idle_s, t.idle_s, 0) / 3600.0, 2) AS idle_hours,
            CASE WHEN greatest(coalesce(dist.km, t.km, 0), coalesce(l.odo_km, 0)) > 0 THEN round((coalesce(l.litres, 0) / greatest(coalesce(dist.km, t.km, 0), coalesce(l.odo_km, 0)) * 100)::numeric, 2) END AS litres_per_100km_period,
            CASE WHEN greatest(coalesce(dist.km, t.km, 0), coalesce(l.odo_km, 0)) > 0 THEN round((coalesce(l.cost, 0) / greatest(coalesce(dist.km, t.km, 0), coalesce(l.odo_km, 0)))::numeric, 2) END AS cost_per_km,
            -- idle burn: ~0.8 L/h for light vehicles, ~2.5 L/h for trucks/buses
            round((coalesce(dist.idle_s, t.idle_s, 0) / 3600.0 * CASE WHEN v.body_type IN ('truck','prime_mover','bus','tanker') THEN 2.5 WHEN v.body_type = 'motorcycle' THEN 0.2 ELSE 0.8 END)::numeric, 1) AS idle_fuel_l,
            coalesce(dr.n, 0) AS drain_events, round(coalesce(dr.litres, 0)::numeric, 1) AS drained_litres
          FROM vehicles v LEFT JOIN logs l ON l.vehicle_id = v.id LEFT JOIN dist ON dist.vehicle_id = v.id LEFT JOIN trips t ON t.vehicle_id = v.id
          LEFT JOIN drains dr ON dr.vehicle_id = v.id
          WHERE v.deleted_at IS NULL AND ($3::uuid[] IS NULL OR v.group_id = ANY($3)) AND ($4::uuid IS NULL OR v.group_id = $4)
          ORDER BY cost DESC`,
          [query.from, query.to, scope, query.group_id ?? null],
        );
        const price = Number(
          (
            await c.query<{
              p: string | null;
            }>(`SELECT price_per_litre AS p FROM fuel_prices WHERE fuel_type = 'diesel' AND effective_from <= now()
          ORDER BY effective_from DESC LIMIT 1`)
          ).rows[0]?.p ?? 0,
        );
        const recommendations: {
          vehicle_id: string;
          plate_number: string;
          type: string;
          message: string;
        }[] = [];
        for (const v of vehicles) {
          const idleCost = Number(v.idle_fuel_l) * price;
          if (Number(v.idle_hours) >= 5)
            recommendations.push({
              vehicle_id: String(v.vehicle_id),
              plate_number: String(v.plate_number),
              type: 'idle',
              message: `${v.plate_number} idled ${v.idle_hours} h (~${v.idle_fuel_l} L${price ? `, about ${Math.round(idleCost).toLocaleString()} in fuel` : ''}). Coach drivers to switch off when parked over 5 minutes.`,
            });
          if (
            v.expected_l_per_100km &&
            v.litres_per_100km_period &&
            Number(v.litres_per_100km_period) > Number(v.expected_l_per_100km) * 1.25
          )
            recommendations.push({
              vehicle_id: String(v.vehicle_id),
              plate_number: String(v.plate_number),
              type: 'consumption',
              message: `${v.plate_number} used ${v.litres_per_100km_period} L/100 km vs ${v.expected_l_per_100km} expected. Check tyre pressure, air filter and injectors, and review harsh driving.`,
            });
          if (Number(v.drain_events) > 0)
            recommendations.push({
              vehicle_id: String(v.vehicle_id),
              plate_number: String(v.plate_number),
              type: 'theft',
              message: `${v.plate_number} had ${v.drain_events} suspected drain(s) totalling ${v.drained_litres} L. Review the fuel events and where the vehicle was parked.`,
            });
          if (Number(v.flagged_logs) > 0)
            recommendations.push({
              vehicle_id: String(v.vehicle_id),
              plate_number: String(v.plate_number),
              type: 'logs',
              message: `${v.plate_number} has ${v.flagged_logs} fuel log(s) flagged (over tank capacity, odometer rollback or unusual consumption).`,
            });
        }
        const totals = vehicles.reduce<Record<string, number>>((a, v) => {
          for (const k of ['litres', 'cost', 'distance_km', 'idle_fuel_l', 'drained_litres'])
            a[k] = (a[k] ?? 0) + Number(v[k] ?? 0);
          return a;
        }, {});
        totals.cost_per_km = totals.distance_km
          ? Math.round(((totals.cost ?? 0) / totals.distance_km) * 100) / 100
          : 0;
        totals.litres_per_100km = totals.distance_km
          ? Math.round(((totals.litres ?? 0) / totals.distance_km) * 10000) / 100
          : 0;
        return { from: query.from, to: query.to, totals, vehicles, recommendations };
      });
    },
  });

  void AppError;
}
