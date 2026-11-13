import type { Router } from 'express';
import { withTransaction } from '@jfs/db';
import { z } from 'zod';
import { randomToken, sha256 } from '../auth/crypto.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { config } from '../config.js';
import { forbidden } from '../http/errors.js';
import { AnyRow, listRows, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { systemPool } from '../infra/db.js';
import { redis } from '../infra/redis.js';

/** Endpoints the Jatelo Fleet Driver app needs beyond jobs/messages/shifts/fuel/inspections. */
const BASE = '/api/v1';
const TAG = 'Driver app';

export function registerDriverAppRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/driver-app/me',
    tags: [TAG],
    summary: 'Driver home: profile, current vehicle, today\'s shift, counts and app settings',
    auth: true,
    middleware: guard('driver_app:use'),
    responses: { 200: { description: 'Home', schema: AnyRow } },
    handler: async ({ req }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const d = rowsOf(
          await c.query<Row>(
            `SELECT d.id, d.full_name, d.employee_number, d.phone, d.photo_file_id, v.id AS vehicle_id, v.plate_number, v.label AS vehicle_label,
               v.odometer_km, v.fuel_type, v.tank_capacity_l,
               EXISTS (SELECT 1 FROM device_assignments da JOIN devices dv ON dv.id = da.device_id WHERE da.vehicle_id = v.id AND da.unassigned_at IS NULL AND dv.protocol <> 'http_json') AS has_hardware
             FROM drivers d LEFT JOIN driver_vehicle_assignments dva ON dva.driver_id = d.id AND dva.ends_at IS NULL AND dva.starts_at <= now()
             LEFT JOIN vehicles v ON v.id = dva.vehicle_id
             WHERE d.user_id = $1 AND d.deleted_at IS NULL`,
            [auth.userId],
          ),
        )[0];
        if (!d) throw forbidden('Your login is not linked to a driver profile - ask your fleet manager');
        const shift = rowsOf(
          await c.query<Row>(
            `SELECT s.id, s.vehicle_id, v.plate_number, s.starts_at, s.ends_at, s.status, s.actual_start, s.actual_end FROM shifts s LEFT JOIN vehicles v ON v.id = s.vehicle_id
             WHERE s.driver_id = $1 AND s.ends_at > now() - interval '2 hours' AND s.starts_at < now() + interval '18 hours' AND s.status <> 'cancelled'
             ORDER BY s.starts_at LIMIT 1`,
            [d.id],
          ),
        )[0] ?? null;
        const counts = (
          await c.query<{ jobs: number; unread: number; open_defects: number }>(
            `SELECT (SELECT count(*) FROM jobs WHERE driver_id = $1 AND deleted_at IS NULL AND status IN ('dispatched', 'in_progress'))::int AS jobs,
               (SELECT count(*) FROM messages WHERE driver_id = $1 AND sender_type <> 'driver' AND read_at IS NULL)::int AS unread,
               (SELECT count(*) FROM defects WHERE vehicle_id = $2 AND status IN ('open', 'in_progress'))::int AS open_defects`,
            [d.id, d.vehicle_id ?? null],
          )
        ).rows[0]!;
        const templates = await listRows(
          c,
          `SELECT t.id, t.name, t.inspection_type, t.is_default,
             coalesce((SELECT json_agg(json_build_object('id', i.id, 'label', i.label, 'label_sw', i.label_sw, 'category', i.category, 'is_critical', i.is_critical,
               'requires_photo_on_fail', i.requires_photo_on_fail) ORDER BY i.seq) FROM inspection_template_items i WHERE i.template_id = t.id), '[]'::json) AS items
           FROM inspection_templates t WHERE t.deleted_at IS NULL AND t.is_active ORDER BY t.is_default DESC, t.name`,
          [],
        );
        const tenant = (await c.query<{ name: string; currency: string; timezone: string; locale: string }>('SELECT name, currency, timezone, locale FROM tenants WHERE id = app.current_tenant_id()')).rows[0]!;
        return {
          driver: d,
          shift,
          counts,
          inspection_templates: templates,
          company: tenant,
          settings: { phone_tracking_interval_s: 15, phone_tracking_distance_m: 25, upload_batch: 50 },
        };
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/driver-app/phone-tracker',
    tags: [TAG],
    summary: 'Register this phone as a GPS tracker (for vehicles without hardware) and get ingest credentials',
    description:
      'Idempotent per install_id; every call rotates the upload token. The phone tracker is attached to the driver\'s current vehicle only when that vehicle has no hardware tracker.',
    auth: true,
    body: z.object({ install_id: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/), device_name: z.string().max(80).optional() }),
    middleware: guard('driver_app:use'),
    responses: { 200: { description: 'Credentials', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const ctx = await tenantDb(req, async (c) =>
        (
          await c.query<{ driver_id: string; vehicle_id: string | null; has_hardware: boolean }>(
            `SELECT d.id AS driver_id, dva.vehicle_id,
               EXISTS (SELECT 1 FROM device_assignments da JOIN devices dv ON dv.id = da.device_id WHERE da.vehicle_id = dva.vehicle_id AND da.unassigned_at IS NULL AND dv.protocol <> 'http_json') AS has_hardware
             FROM drivers d LEFT JOIN driver_vehicle_assignments dva ON dva.driver_id = d.id AND dva.ends_at IS NULL AND dva.starts_at <= now()
             WHERE d.user_id = $1 AND d.deleted_at IS NULL`,
            [auth.userId],
          )
        ).rows[0],
      );
      if (!ctx) throw forbidden('Your login is not linked to a driver profile');
      const identifier = `ph-${body.install_id}`.slice(0, 40);
      const token = randomToken(24);
      const out = await withTransaction(systemPool, async (c) => {
        const dev = (
          await c.query<{ id: string; tenant_id: string | null }>(
            `INSERT INTO devices (tenant_id, identifier, protocol, model, status, auth_token_hash, notes, installed_at)
             VALUES ($1, $2, 'http_json', $3, 'active', $4, $5, now())
             ON CONFLICT (identifier) DO UPDATE SET auth_token_hash = EXCLUDED.auth_token_hash, model = EXCLUDED.model, status = 'active', deleted_at = NULL
             WHERE devices.tenant_id = EXCLUDED.tenant_id
             RETURNING id, tenant_id`,
            [auth.tenantId, identifier, body.device_name ?? 'Driver phone', sha256(token), `Driver app (${auth.userId})`],
          )
        ).rows[0];
        if (!dev) throw forbidden('This phone is registered to another company');
        const current = (await c.query<{ vehicle_id: string }>('SELECT vehicle_id FROM device_assignments WHERE device_id = $1 AND unassigned_at IS NULL', [dev.id])).rows[0];
        const want = ctx.vehicle_id && !ctx.has_hardware ? ctx.vehicle_id : null;
        if (current && current.vehicle_id !== want) await c.query('UPDATE device_assignments SET unassigned_at = now() WHERE device_id = $1 AND unassigned_at IS NULL', [dev.id]);
        if (want && (!current || current.vehicle_id !== want)) {
          // only one phone per vehicle: detach other phones from it
          await c.query(
            `UPDATE device_assignments da SET unassigned_at = now() FROM devices dv WHERE dv.id = da.device_id AND dv.protocol = 'http_json' AND da.vehicle_id = $1 AND da.unassigned_at IS NULL`,
            [want],
          );
          await c.query(`INSERT INTO device_assignments (tenant_id, device_id, vehicle_id, assigned_at, notes) VALUES ($1,$2,$3, now(), 'Driver phone')`, [auth.tenantId, dev.id, want]);
        }
        return { id: dev.id, vehicleId: want };
      });
      await redis.del(`dev:${identifier}`); // ingest gateway device cache (token changed)
      return {
        device_id: out.id,
        identifier,
        token,
        ingest_url: `${config.INGEST_PUBLIC_URL.replace(/\/$/, '')}/v1/positions`,
        vehicle_id: out.vehicleId,
        tracking: out.vehicleId ? 'phone' : ctx.has_hardware ? 'hardware' : 'none',
      };
    },
  });
}
