import type { Router } from 'express';
import { withTransaction, type PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { INVITABLE_ROLES, issueInvite, sendInvite } from '../auth/invites.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { revokeSessions } from '../auth/tokens.js';
import { config } from '../config.js';
import { paged, PageQuery } from '../http/crud.js';
import { conflict, forbidden, notFound, unprocessable } from '../http/errors.js';
import { normalizePhone } from '../http/phone.js';
import { AnyRow, ListOf, listRows, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { systemPool } from '../infra/db.js';
import { redis } from '../infra/redis.js';

const BASE = '/api/v1';
const IdParam = z.object({ id: z.uuid() });

const USER_SELECT = `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.locale, u.status, u.last_login_at, u.created_at, u.updated_at,
  (m.enabled_at IS NOT NULL) AS mfa_enabled, dr.id AS driver_id,
  coalesce((SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name) FROM user_group_access a JOIN vehicle_groups g ON g.id = a.group_id
    WHERE a.user_id = u.id), '[]'::json) AS groups
  FROM users u LEFT JOIN user_mfa m ON m.user_id = u.id LEFT JOIN drivers dr ON dr.user_id = u.id AND dr.deleted_at IS NULL`;

async function countryOf(c: PoolClient): Promise<{ country: string; name: string; locale: 'en' | 'sw' }> {
  const t = (await c.query<{ country_code: string; name: string; locale: 'en' | 'sw' }>('SELECT country_code, name, locale FROM tenants WHERE id = app.current_tenant_id()')).rows[0]!;
  return { country: t.country_code, name: t.name, locale: t.locale };
}

async function setGroups(c: PoolClient, tenantId: string, userId: string, groupIds: string[]): Promise<void> {
  if (groupIds.length) {
    const ok = await c.query('SELECT id FROM vehicle_groups WHERE id = ANY($1) AND deleted_at IS NULL', [groupIds]);
    if (ok.rowCount !== new Set(groupIds).size) throw unprocessable('One or more vehicle groups were not found');
  }
  await c.query('DELETE FROM user_group_access WHERE user_id = $1', [userId]);
  for (const g of new Set(groupIds)) await c.query('INSERT INTO user_group_access (tenant_id, user_id, group_id) VALUES ($1,$2,$3)', [tenantId, userId, g]);
}

/** Device command text per protocol. */
function commandText(protocol: string, type: string, payload?: string): string {
  if (type === 'custom') {
    if (!payload) throw unprocessable('Custom commands need a payload');
    return payload;
  }
  const table: Record<string, Record<string, string>> = {
    teltonika: { immobilize: 'setdigout 1', restore: 'setdigout 0', get_info: 'getinfo', reboot: 'cpureset' },
    gt06: { immobilize: 'RELAY,1#', restore: 'RELAY,0#', get_info: 'STATUS#', reboot: 'RESET#' },
    queclink: { immobilize: 'AT+GTOUT=gv300,1,,,,,,,,,,,,,,,,FFFF$', restore: 'AT+GTOUT=gv300,0,,,,,,,,,,,,,,,,FFFF$', get_info: 'AT+GTRTO=gv300,0,,,,,,FFFF$', reboot: 'AT+GTRTO=gv300,3,,,,,,FFFF$' },
  };
  const text = table[protocol]?.[type];
  if (!text) throw unprocessable(`"${type}" is not supported for ${protocol} devices`);
  return text;
}

export function registerAdminRoutes(v1: Router): void {
  // ---------------------------------------------------------------- users
  route(v1, BASE, {
    method: 'get',
    path: '/users',
    tags: ['Users'],
    summary: 'Company users',
    auth: true,
    query: z.object({ ...PageQuery, q: z.string().max(100).optional(), role: z.string().optional(), status: z.enum(['invited', 'active', 'disabled']).optional() }),
    middleware: guard('users:read'),
    responses: { 200: { description: 'Users', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT x.*, count(*) OVER () AS total FROM (${USER_SELECT} WHERE u.deleted_at IS NULL
             AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR u.role = $2)
             AND ($3::text IS NULL OR u.status = $3)) x ORDER BY x.full_name LIMIT $4 OFFSET $5`,
          [query.q ?? null, query.role ?? null, query.status ?? null, query.page_size, (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/users',
    tags: ['Users'],
    summary: 'Invite a user (drivers are invited from their driver profile)',
    auth: true,
    body: z.object({
      email: z.email(),
      full_name: z.string().trim().min(2).max(120),
      phone: z.string().max(20).nullable().optional(),
      role: z.enum(INVITABLE_ROLES as ['company_admin']),
      locale: z.enum(['en', 'sw']).optional(),
      group_ids: z.array(z.uuid()).max(100).optional().describe('Limit the user to these vehicle groups (empty = all)'),
    }),
    status: 201,
    middleware: guard('users:manage'),
    responses: { 201: { description: 'User', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const { user, token, t } = await tenantDb(req, async (c) => {
        const t = await countryOf(c);
        const dup = await systemPool.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL', [body.email]);
        if (dup.rowCount) throw conflict('A user with this email already exists');
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO users (tenant_id, email, full_name, phone, role, locale, status) VALUES ($1,$2,$3,$4,$5,$6,'invited') RETURNING id`,
            [auth.tenantId, body.email, body.full_name, normalizePhone(body.phone ?? null, t.country), body.role, body.locale ?? t.locale],
          )
        ).rows[0]!.id;
        if (body.group_ids) await setGroups(c, auth.tenantId!, id, body.group_ids);
        const { token } = await issueInvite(c, id, auth.tenantId);
        return { user: rowsOf(await c.query<Row>(`${USER_SELECT} WHERE u.id = $1`, [id]))[0]!, token, t };
      });
      await sendInvite({ email: body.email, name: body.full_name, company: t.name, locale: body.locale ?? t.locale, token });
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'user.invited', entityType: 'user', entityId: String(user.id), metadata: { role: body.role }, req });
      return { ...user, ...(config.NODE_ENV !== 'production' ? { dev_invite_url: `${config.WEB_APP_URL}/accept-invite?token=${token}` } : {}) };
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/users/:id',
    tags: ['Users'],
    summary: 'Change a user\'s details, role, status or vehicle-group access',
    auth: true,
    params: IdParam,
    body: z.object({
      full_name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().max(20).nullable().optional(),
      role: z.enum(INVITABLE_ROLES as ['company_admin']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      locale: z.enum(['en', 'sw']).optional(),
      group_ids: z.array(z.uuid()).max(100).optional(),
    }),
    middleware: guard('users:manage'),
    responses: { 200: { description: 'User', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      const self = params.id === auth.userId;
      if (self && (body.role || body.status)) throw forbidden('You cannot change your own role or status');
      const out = await tenantDb(req, async (c) => {
        const u = (await c.query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1 AND deleted_at IS NULL', [params.id])).rows[0];
        if (!u) throw notFound('User');
        if (u.role === 'driver' && body.role) throw unprocessable('Driver logins are managed from the driver profile');
        if (body.status === 'active' && u.status === 'invited') throw unprocessable('The user must accept the invitation first');
        if (u.role === 'company_admin' && ((body.role && body.role !== 'company_admin') || body.status === 'disabled')) {
          const admins = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'company_admin' AND status = 'active' AND deleted_at IS NULL`)).rows[0]!.n;
          if (admins <= 1) throw unprocessable('The company needs at least one active administrator');
        }
        const t = await countryOf(c);
        await c.query(
          `UPDATE users SET full_name = coalesce($2, full_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END, role = coalesce($5, role),
             status = coalesce($6, status), locale = coalesce($7, locale) WHERE id = $1`,
          [params.id, body.full_name ?? null, body.phone !== undefined, normalizePhone(body.phone ?? null, t.country), body.role ?? null, body.status ?? null, body.locale ?? null],
        );
        if (body.group_ids) await setGroups(c, auth.tenantId!, params.id, body.group_ids);
        return rowsOf(await c.query<Row>(`${USER_SELECT} WHERE u.id = $1`, [params.id]))[0]!;
      });
      if (body.role || body.status === 'disabled' || body.group_ids)
        await withTransaction(systemPool, (c) => revokeSessions(c, { userId: params.id }, body.status === 'disabled' ? 'user_disabled' : 'permissions_changed'));
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'user.updated', entityType: 'user', entityId: params.id, changes: body, req });
      return out;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/users/:id/resend-invite',
    tags: ['Users'],
    summary: 'Send a new invitation link',
    auth: true,
    params: IdParam,
    middleware: guard('users:manage'),
    responses: { 200: { description: 'Sent', schema: AnyRow } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      const r = await tenantDb(req, async (c) => {
        const u = (await c.query<{ email: string; full_name: string; status: string; locale: 'en' | 'sw' }>('SELECT email, full_name, status, locale FROM users WHERE id = $1 AND deleted_at IS NULL', [params.id])).rows[0];
        if (!u) throw notFound('User');
        if (u.status !== 'invited') throw unprocessable('This user has already accepted the invitation');
        const { token, expiresAt } = await issueInvite(c, params.id, auth.tenantId);
        return { u, token, expiresAt, company: (await countryOf(c)).name };
      });
      await sendInvite({ email: r.u.email, name: r.u.full_name, company: r.company, locale: r.u.locale, token: r.token });
      return { sent: true, expires_at: r.expiresAt };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/users/:id/reset-mfa',
    tags: ['Users'],
    summary: 'Remove a user\'s two-factor authentication (they must set it up again) and sign them out everywhere',
    auth: true,
    params: IdParam,
    middleware: guard('users:manage'),
    responses: { 200: { description: 'Reset', schema: AnyRow } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      if (params.id === auth.userId) throw forbidden('Use your own security settings to change your 2FA');
      await tenantDb(req, async (c) => {
        const u = await c.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [params.id]);
        if (!u.rowCount) throw notFound('User');
      });
      await withTransaction(systemPool, async (c) => {
        await c.query('DELETE FROM user_mfa WHERE user_id = $1', [params.id]);
        await revokeSessions(c, { userId: params.id }, 'mfa_reset');
      });
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'user.mfa_reset', entityType: 'user', entityId: params.id, req });
      return { reset: true };
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/users/:id',
    tags: ['Users'],
    summary: 'Remove a user',
    auth: true,
    params: IdParam,
    middleware: guard('users:manage'),
    responses: { 204: { description: 'Removed' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      if (params.id === auth.userId) throw forbidden('You cannot remove yourself');
      await tenantDb(req, async (c) => {
        const u = (await c.query<{ role: string }>('SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL', [params.id])).rows[0];
        if (!u) throw notFound('User');
        if (u.role === 'driver') throw unprocessable('Remove driver logins from the driver profile');
        if (u.role === 'company_admin') {
          const admins = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'company_admin' AND status = 'active' AND deleted_at IS NULL AND id <> $1`, [params.id])).rows[0]!.n;
          if (admins < 1) throw unprocessable('The company needs at least one active administrator');
        }
        await c.query(`UPDATE users SET deleted_at = now(), status = 'disabled' WHERE id = $1`, [params.id]);
        await c.query('DELETE FROM user_group_access WHERE user_id = $1', [params.id]);
      });
      await withTransaction(systemPool, (c) => revokeSessions(c, { userId: params.id }, 'user_removed'));
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'user.removed', entityType: 'user', entityId: params.id, req });
      return undefined;
    },
  });

  // ---------------------------------------------------------------- company profile & settings
  route(v1, BASE, {
    method: 'get',
    path: '/tenant',
    tags: ['Company'],
    summary: 'Company profile and operating settings',
    auth: true,
    middleware: guard(),
    responses: { 200: { description: 'Company', schema: AnyRow } },
    handler: async ({ req }) =>
      tenantDb(req, async (c) => {
        const t = rowsOf(
          await c.query<Row>(
            `SELECT id, name, slug, legal_name, tax_id, country_code, currency, timezone, locale, email, phone, address, logo_url, status, trial_ends_at, created_at
             FROM tenants WHERE id = app.current_tenant_id()`,
          ),
        )[0]!;
        const s = rowsOf(await c.query<Row>('SELECT * FROM tenant_settings WHERE tenant_id = app.current_tenant_id()'))[0] ?? {};
        return { ...t, settings: s };
      }),
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/tenant',
    tags: ['Company'],
    summary: 'Update company profile',
    auth: true,
    body: z.object({
      name: z.string().trim().min(2).max(160).optional(),
      legal_name: z.string().trim().max(200).nullable().optional(),
      tax_id: z.string().trim().max(40).nullable().optional(),
      timezone: z.enum(['Africa/Nairobi', 'Africa/Dar_es_Salaam', 'Africa/Kampala', 'Africa/Kigali']).optional(),
      locale: z.enum(['en', 'sw']).optional(),
      email: z.email().nullable().optional(),
      phone: z.string().max(20).nullable().optional(),
      address: z.string().trim().max(400).nullable().optional(),
      logo_url: z.string().url().max(500).nullable().optional(),
    }),
    middleware: guard('tenant:settings'),
    responses: { 200: { description: 'Company', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const out = await tenantDb(req, async (c) => {
        const t = await countryOf(c);
        const vals: Record<string, unknown> = { ...body, ...(body.phone !== undefined ? { phone: normalizePhone(body.phone, t.country) } : {}) };
        const keys = Object.keys(vals).filter((k) => vals[k] !== undefined);
        if (keys.length)
          await c.query(`UPDATE tenants SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = app.current_tenant_id()`, keys.map((k) => vals[k]));
        return rowsOf(await c.query<Row>('SELECT id, name, legal_name, tax_id, timezone, locale, email, phone, address, logo_url FROM tenants WHERE id = app.current_tenant_id()'))[0]!;
      });
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'tenant.updated', entityType: 'tenant', entityId: auth.tenantId!, changes: body, req });
      return out;
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/tenant/settings',
    tags: ['Company'],
    summary: 'Update operating settings (units, speed limits, idle/offline thresholds, night hours, retention)',
    auth: true,
    body: z.object({
      distance_unit: z.enum(['km', 'mi']).optional(),
      volume_unit: z.enum(['l', 'gal']).optional(),
      speed_limit_kph: z.number().int().min(20).max(200).optional(),
      overspeed_tolerance_kph: z.number().int().min(0).max(30).optional(),
      overspeed_min_seconds: z.number().int().min(0).max(600).optional(),
      harsh_thresholds: z.object({ brake_g: z.number().min(0.1).max(1.5), accel_g: z.number().min(0.1).max(1.5), corner_g: z.number().min(0.1).max(1.5) }).optional(),
      idle_threshold_seconds: z.number().int().min(30).max(7200).optional(),
      offline_threshold_minutes: z.number().int().min(5).max(10080).optional(),
      night_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      night_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      gps_retention_days: z.number().int().min(30).max(1825).optional(),
      raw_packet_retention_days: z.number().int().min(1).max(90).optional(),
      audit_retention_days: z.number().int().min(90).max(3650).optional(),
    }),
    middleware: guard('tenant:settings'),
    responses: { 200: { description: 'Settings', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const out = await tenantDb(req, async (c) => {
        const vals: Record<string, unknown> = { ...body, ...(body.harsh_thresholds ? { harsh_thresholds: JSON.stringify(body.harsh_thresholds) } : {}) };
        const keys = Object.keys(vals).filter((k) => vals[k] !== undefined);
        if (keys.length)
          await c.query(`UPDATE tenant_settings SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE tenant_id = app.current_tenant_id()`, keys.map((k) => vals[k]));
        return rowsOf(await c.query<Row>('SELECT * FROM tenant_settings WHERE tenant_id = app.current_tenant_id()'))[0]!;
      });
      await redis.publish('config:tenant', JSON.stringify({ tenant_id: auth.tenantId })); // workers drop cached settings
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'tenant.settings_updated', entityType: 'tenant', entityId: auth.tenantId!, changes: body, req });
      return out;
    },
  });

  // ---------------------------------------------------------------- audit log
  route(v1, BASE, {
    method: 'get',
    path: '/audit-logs',
    tags: ['Company'],
    summary: 'Audit trail of sign-ins and changes in the company',
    auth: true,
    query: z.object({
      ...PageQuery,
      action: z.string().max(80).optional().describe('Exact action or prefix ending in * (e.g. "user.*")'),
      entity_type: z.string().max(40).optional(),
      entity_id: z.string().max(80).optional(),
      actor_id: z.uuid().optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    }),
    middleware: guard('audit:read'),
    responses: { 200: { description: 'Entries', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const action = query.action?.endsWith('*') ? `${query.action.slice(0, -1)}%` : (query.action ?? null);
        const r = await c.query<Row>(
          `SELECT a.id, a.created_at, a.actor_type, a.actor_id, u.full_name AS actor_name, u.email AS actor_email, a.action, a.entity_type, a.entity_id, a.changes,
             a.metadata, host(a.ip) AS ip, a.user_agent, count(*) OVER () AS total
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
           WHERE ($1::text IS NULL OR a.action LIKE $1) AND ($2::text IS NULL OR a.entity_type = $2) AND ($3::text IS NULL OR a.entity_id = $3)
             AND ($4::uuid IS NULL OR a.actor_id = $4) AND ($5::timestamptz IS NULL OR a.created_at >= $5) AND ($6::timestamptz IS NULL OR a.created_at < $6)
           ORDER BY a.created_at DESC, a.id DESC LIMIT $7 OFFSET $8`,
          [action, query.entity_type ?? null, query.entity_id ?? null, query.actor_id ?? null, query.from ?? null, query.to ?? null, query.page_size,
            (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  // ---------------------------------------------------------------- remote device commands
  route(v1, BASE, {
    method: 'post',
    path: '/devices/:id/commands',
    tags: ['Devices'],
    summary: 'Send a remote command (engine immobilise/restore, info, reboot, or raw text)',
    description: 'Delivered through the ingest gateway holding the tracker\'s live connection. Immobilising only engages when the vehicle is slow/stopped (device-side logic).',
    auth: true,
    params: IdParam,
    body: z.object({ command_type: z.enum(['immobilize', 'restore', 'get_info', 'reboot', 'custom']), payload: z.string().max(500).optional(), confirm: z.boolean().optional() }),
    status: 202,
    middleware: guard('devices:assign'),
    responses: { 202: { description: 'Command queued / sent', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      if (body.command_type === 'immobilize' && !body.confirm) throw unprocessable('Immobilising cuts the engine - resend with "confirm": true');
      if (body.command_type === 'custom' && auth.role !== 'company_admin' && auth.role !== 'super_admin') throw forbidden('Only administrators can send raw commands');
      const cmd = await tenantDb(req, async (c) => {
        const d = (await c.query<{ protocol: string; status: string }>('SELECT protocol, status FROM devices WHERE id = $1 AND deleted_at IS NULL', [params.id])).rows[0];
        if (!d) throw notFound('Device');
        if (d.protocol === 'http_json') throw unprocessable('Phone trackers do not accept remote commands');
        const text = commandText(d.protocol, body.command_type, body.payload);
        const r = await c.query<{ id: string }>(
          `INSERT INTO device_commands (tenant_id, device_id, command_type, payload, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [auth.tenantId, params.id, body.command_type, text, auth.userId],
        );
        return { id: r.rows[0]!.id, text };
      });
      const conn = await redis.get(`conn:${params.id}`);
      let delivered = false;
      if (conn) {
        const instance = conn.slice(0, conn.lastIndexOf(':'));
        delivered = (await redis.publish(`${config.INGEST_CONTROL_CHANNEL}:${instance}`, JSON.stringify({ command_id: cmd.id, device_id: params.id, text: cmd.text }))) > 0;
      }
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: `device.command.${body.command_type}`, entityType: 'device', entityId: params.id, metadata: { command_id: cmd.id }, req });
      return {
        id: cmd.id,
        status: delivered ? 'sent' : 'queued',
        message: delivered ? 'Command sent to the tracker' : 'The tracker is offline - the command will be sent when it reconnects (expires after 24 h)',
      };
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/devices/:id/commands',
    tags: ['Devices'],
    summary: 'Command history for a tracker',
    auth: true,
    params: IdParam,
    middleware: guard('devices:read'),
    responses: { 200: { description: 'Commands', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => ({
        data: await listRows(
          c,
          `SELECT dc.id, dc.command_type, dc.payload, dc.status, dc.response, u.full_name AS requested_by_name, dc.created_at, dc.sent_at, dc.responded_at
           FROM device_commands dc LEFT JOIN users u ON u.id = dc.requested_by WHERE dc.device_id = $1 ORDER BY dc.created_at DESC LIMIT 100`,
          [params.id],
        ),
      })),
  });
}

