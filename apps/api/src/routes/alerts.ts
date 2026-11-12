import { randomBytes } from 'node:crypto';
import type { Router } from 'express';
import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { encrypt } from '../auth/crypto.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { paged, PageQuery } from '../http/crud.js';
import { notFound, unprocessable } from '../http/errors.js';
import { normalizePhone } from '../http/phone.js';
import { AnyRow, ListOf, resource, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';

const BASE = '/api/v1';
export const RULE_TYPES = [
  'overspeed',
  'harsh_event',
  'geofence_enter',
  'geofence_exit',
  'geofence_dwell',
  'ignition_on',
  'ignition_off',
  'idle',
  'device_offline',
  'low_battery',
  'power_cut',
  'sos',
  'tamper',
  'towing',
  'crash',
  'fuel_drain',
  'refuel',
  'fuel_level_low',
  'service_due',
  'document_expiry',
  'licence_expiry',
  'dtc',
  'route_deviation',
  'job_late',
  'unauthorized_driver',
  'after_hours_use',
  'inspection_failed',
  'defect_critical',
] as const;
const CHANNELS = ['in_app', 'sms', 'email', 'push', 'webhook'] as const;
const Schedule = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

const Target = z
  .object({
    vehicle_id: z.uuid().optional(),
    group_id: z.uuid().optional(),
    driver_id: z.uuid().optional(),
    geofence_id: z.uuid().optional(),
  })
  .refine((t) => Object.values(t).filter(Boolean).length === 1, 'Each target needs exactly one id');
const Recipient = z
  .object({
    user_id: z.uuid().optional(),
    role: z
      .enum(['company_admin', 'fleet_manager', 'dispatcher', 'mechanic', 'accountant', 'driver'])
      .optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  })
  .refine(
    (r) => Object.values(r).filter(Boolean).length === 1,
    'Each recipient needs exactly one of user_id, role, phone or email',
  );

const RuleInput = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  rule_type: z.enum(RULE_TYPES),
  conditions: z.record(z.string(), z.unknown()).optional(),
  applies_to_all: z.boolean().optional(),
  schedule: Schedule.nullable().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  cooldown_minutes: z.number().int().min(0).max(10080).optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).optional(),
  is_active: z.boolean().optional(),
  targets: z.array(Target).max(500).optional(),
  recipients: z.array(Recipient).min(1).max(100).optional(),
});

async function writeChildren(
  c: PoolClient,
  tenantId: string,
  tenantCountry: string,
  ruleId: string,
  b: Partial<z.infer<typeof RuleInput>>,
): Promise<void> {
  if (b.targets) {
    await c.query('DELETE FROM alert_rule_targets WHERE rule_id = $1', [ruleId]);
    for (const t of b.targets) {
      await c.query(
        'INSERT INTO alert_rule_targets (tenant_id, rule_id, vehicle_id, group_id, driver_id, geofence_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          tenantId,
          ruleId,
          t.vehicle_id ?? null,
          t.group_id ?? null,
          t.driver_id ?? null,
          t.geofence_id ?? null,
        ],
      );
    }
  }
  if (b.recipients) {
    await c.query('DELETE FROM alert_rule_recipients WHERE rule_id = $1', [ruleId]);
    for (const r of b.recipients) {
      await c.query(
        'INSERT INTO alert_rule_recipients (tenant_id, rule_id, user_id, role, phone, email) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          tenantId,
          ruleId,
          r.user_id ?? null,
          r.role ?? null,
          r.phone ? normalizePhone(r.phone, tenantCountry) : null,
          r.email ?? null,
        ],
      );
    }
  }
}

const country = async (c: PoolClient): Promise<string> =>
  (
    await c.query<{ country_code: string }>('SELECT country_code FROM tenants LIMIT 1')
  ).rows[0]?.country_code.trim() ?? 'KE';

export function registerAlertRoutes(v1: Router): void {
  resource(v1, {
    path: 'alert-rules',
    table: 'alert_rules',
    tag: 'Alerts',
    noun: 'Alert rule',
    read: ['alerts:read'],
    write: ['alert_rules:manage'],
    input: RuleInput,
    select: `SELECT x.id, x.name, x.description, x.rule_type, x.conditions, x.applies_to_all, x.schedule, x.severity, x.cooldown_minutes,
      x.channels, x.is_active, x.created_at, x.updated_at,
      coalesce((SELECT json_agg(json_build_object('vehicle_id', t.vehicle_id, 'group_id', t.group_id, 'driver_id', t.driver_id, 'geofence_id', t.geofence_id))
        FROM alert_rule_targets t WHERE t.rule_id = x.id), '[]') AS targets,
      coalesce((SELECT json_agg(json_build_object('user_id', r.user_id, 'role', r.role, 'phone', r.phone, 'email', r.email))
        FROM alert_rule_recipients r WHERE r.rule_id = x.id), '[]') AS recipients,
      (SELECT count(*) FROM alerts a WHERE a.rule_id = x.id AND a.occurred_at > now() - interval '30 days') AS alerts_30d
      FROM alert_rules x`,
    sorts: { name: 'x.name', rule_type: 'x.rule_type', created_at: 'x.created_at' },
    defaultSort: 'x.name ASC',
    search: ['x.name'],
    filters: { rule_type: { column: 'x.rule_type', schema: z.enum(RULE_TYPES) } },
    toColumns: (b) => {
      const { targets: _t, recipients: _r, conditions, schedule, ...rest } = b;
      return {
        ...rest,
        ...(b.targets !== undefined ? { applies_to_all: b.targets.length === 0 } : {}),
        ...(conditions !== undefined ? { conditions: JSON.stringify(conditions) } : {}),
        ...(schedule !== undefined ? { schedule: schedule ? JSON.stringify(schedule) : null } : {}),
      };
    },
    extraCreate: (auth) => ({ created_by: auth.userId }),
    afterWrite: async (c, id, auth, req) => {
      await writeChildren(
        c,
        auth.tenantId!,
        await country(c),
        id,
        req.body as Partial<z.infer<typeof RuleInput>>,
      );
    },
  });

  // ---------------------------------------------------------------- alerts
  route(v1, BASE, {
    method: 'get',
    path: '/alerts',
    tags: ['Alerts'],
    summary: 'Alert history',
    auth: true,
    query: z.object({
      ...PageQuery,
      status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      vehicle_id: z.uuid().optional(),
      alert_type: z.string().max(40).optional(),
      from: z.iso.datetime({ offset: true }).optional(),
    }),
    middleware: guard('alerts:read'),
    responses: { 200: { description: 'Alerts', schema: ListOf } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const r = await c.query<Row>(
          `SELECT a.id, a.rule_id, a.alert_type, a.severity, a.title, a.message, a.data, a.vehicle_id, v.plate_number, a.driver_id,
             d.full_name AS driver_name, a.geofence_id, a.job_id, a.occurred_at, a.lat, a.lng, a.status, a.acknowledged_at, ua.full_name AS acknowledged_by,
             a.resolved_at, a.note, count(*) OVER() AS total
           FROM alerts a LEFT JOIN vehicles v ON v.id = a.vehicle_id LEFT JOIN drivers d ON d.id = a.driver_id LEFT JOIN users ua ON ua.id = a.acknowledged_by
           WHERE ($1::text IS NULL OR a.status = $1) AND ($2::text IS NULL OR a.severity = $2) AND ($3::uuid IS NULL OR a.vehicle_id = $3)
             AND ($4::text IS NULL OR a.alert_type = $4) AND a.occurred_at >= coalesce($5::timestamptz, now() - interval '90 days')
             AND ($6::uuid[] IS NULL OR a.vehicle_id IS NULL OR v.group_id = ANY($6))
           ORDER BY a.occurred_at DESC LIMIT $7 OFFSET $8`,
          [
            query.status ?? null,
            query.severity ?? null,
            query.vehicle_id ?? null,
            query.alert_type ?? null,
            query.from ?? null,
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
    method: 'get',
    path: '/alerts/summary',
    tags: ['Alerts'],
    summary: 'Open alert counts by severity and type',
    auth: true,
    middleware: guard('alerts:read'),
    responses: { 200: { description: 'Summary', schema: AnyRow } },
    handler: async ({ req }) =>
      tenantDb(req, async (c) => {
        const r = rowsOf(
          await c.query<Row>(
            `SELECT severity, alert_type, count(*) AS n FROM alerts WHERE status = 'open' GROUP BY 1, 2`,
          ),
        );
        const by_severity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
        const by_type: Record<string, number> = {};
        for (const x of r) {
          by_severity[String(x.severity)] = (by_severity[String(x.severity)] ?? 0) + Number(x.n);
          by_type[String(x.alert_type)] = (by_type[String(x.alert_type)] ?? 0) + Number(x.n);
        }
        return {
          open: Object.values(by_severity).reduce((a, b) => a + b, 0),
          by_severity,
          by_type,
        };
      }),
  });

  for (const action of ['acknowledge', 'resolve'] as const) {
    route(v1, BASE, {
      method: 'post',
      path: `/alerts/:id/${action}`,
      tags: ['Alerts'],
      summary: `${action === 'acknowledge' ? 'Acknowledge' : 'Resolve'} an alert`,
      auth: true,
      params: z.object({ id: z.uuid() }),
      body: z.object({ note: z.string().trim().max(1000).optional() }),
      middleware: guard('alerts:acknowledge'),
      responses: { 200: { description: 'Updated', schema: AnyRow } },
      handler: async ({ req, params, body }) => {
        const auth = requireAuth(req);
        return tenantDb(req, async (c) => {
          const r =
            action === 'acknowledge'
              ? await c.query<Row>(
                  `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2, note = coalesce($3, note)
                WHERE id = $1 AND status = 'open' RETURNING id, status, acknowledged_at, note`,
                  [params.id, auth.userId, body.note ?? null],
                )
              : await c.query<Row>(
                  `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2, note = coalesce($3, note),
                acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $2)
                WHERE id = $1 AND status <> 'resolved' RETURNING id, status, resolved_at, note`,
                  [params.id, auth.userId, body.note ?? null],
                );
          if (!r.rowCount) throw notFound('Open alert');
          await c
            .query(
              'UPDATE notifications SET read_at = now() WHERE alert_id = $1 AND read_at IS NULL',
              [params.id],
            )
            .catch(() => undefined);
          return rowsOf(r)[0];
        });
      },
    });
  }

  route(v1, BASE, {
    method: 'post',
    path: '/alerts/acknowledge-all',
    tags: ['Alerts'],
    summary: 'Acknowledge all open alerts (optionally of one type)',
    auth: true,
    body: z.object({ alert_type: z.string().max(40).optional() }),
    middleware: guard('alerts:acknowledge'),
    responses: { 200: { description: 'Count', schema: z.object({ acknowledged: z.number() }) } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => ({
        acknowledged:
          (
            await c.query(
              `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $1
          WHERE status = 'open' AND ($2::text IS NULL OR alert_type = $2)`,
              [auth.userId, body.alert_type ?? null],
            )
          ).rowCount ?? 0,
      }));
    },
  });

  // ---------------------------------------------------------------- notifications (own)
  route(v1, BASE, {
    method: 'get',
    path: '/notifications',
    tags: ['Notifications'],
    summary: 'My in-app notifications',
    auth: true,
    query: z.object({
      unread: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.coerce.number().int().optional(),
    }),
    middleware: guard(),
    responses: { 200: { description: 'Notifications', schema: AnyRow } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const data = rowsOf(
          await c.query<Row>(
            `SELECT id, type, title, body, data, link, alert_id, read_at, created_at FROM notifications
           WHERE ($1::bool IS NULL OR (read_at IS NULL) = $1) AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
            [query.unread ? query.unread === 'true' : null, query.before ?? null, query.limit],
          ),
        );
        const unread = Number(
          (
            await c.query<{ n: string }>(
              'SELECT count(*) AS n FROM notifications WHERE read_at IS NULL',
            )
          ).rows[0]!.n,
        );
        return { data, unread };
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/notifications/read',
    tags: ['Notifications'],
    summary: 'Mark notifications as read (all when ids omitted)',
    auth: true,
    body: z.object({ ids: z.array(z.number().int()).max(500).optional() }),
    middleware: guard(),
    responses: { 200: { description: 'Count', schema: z.object({ updated: z.number() }) } },
    handler: async ({ req, body }) =>
      tenantDb(req, async (c) => ({
        updated:
          (
            await c.query(
              'UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND ($1::bigint[] IS NULL OR id = ANY($1))',
              [body.ids ?? null],
            )
          ).rowCount ?? 0,
      })),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/push-tokens',
    tags: ['Notifications'],
    summary: 'Register this device for push notifications (FCM)',
    auth: true,
    body: z.object({
      token: z.string().min(20).max(4096),
      platform: z.enum(['android', 'ios', 'web']),
      device_name: z.string().max(120).optional(),
      app_version: z.string().max(40).optional(),
    }),
    status: 201,
    middleware: guard(),
    responses: { 201: { description: 'Registered', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await c.query('DELETE FROM push_tokens WHERE token = $1', [body.token]);
        const r = await c.query<Row>(
          `INSERT INTO push_tokens (tenant_id, user_id, token, platform, device_name, app_version) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, platform, device_name, created_at`,
          [
            auth.tenantId,
            auth.userId,
            body.token,
            body.platform,
            body.device_name ?? null,
            body.app_version ?? null,
          ],
        );
        return rowsOf(r)[0];
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/push-tokens',
    tags: ['Notifications'],
    summary: 'Unregister a push token (on sign-out)',
    auth: true,
    body: z.object({ token: z.string().min(20).max(4096) }),
    middleware: guard(),
    responses: { 204: { description: 'Removed' } },
    handler: async ({ req, body }) => {
      await tenantDb(req, (c) => c.query('DELETE FROM push_tokens WHERE token = $1', [body.token]));
      return undefined;
    },
  });

  // ---------------------------------------------------------------- webhooks
  route(v1, BASE, {
    method: 'post',
    path: '/webhooks',
    tags: ['Integrations'],
    summary: 'Create a webhook endpoint (signing secret shown once)',
    auth: true,
    body: z.object({
      name: z.string().trim().min(2).max(80),
      url: z.url().refine((u) => u.startsWith('https://'), 'Must be https'),
      events: z.array(z.string().max(40)).max(50).default([]),
    }),
    status: 201,
    middleware: guard('tenant:settings'),
    responses: { 201: { description: 'Created', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const secret = `whsec_${randomBytes(24).toString('base64url')}`;
      return tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `INSERT INTO webhook_endpoints (tenant_id, name, url, secret_enc, events, created_by) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, name, url, events, is_active, created_at`,
          [auth.tenantId, body.name, body.url, encrypt(secret), body.events, auth.userId],
        );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'webhook.created',
          entityType: 'webhook',
          entityId: String(r.rows[0]!.id),
          req,
        });
        return { ...rowsOf(r)[0], secret };
      });
    },
  });
  resource(v1, {
    path: 'webhooks',
    table: 'webhook_endpoints',
    tag: 'Integrations',
    noun: 'Webhook',
    read: ['tenant:settings'],
    write: ['tenant:settings'],
    input: z.object({
      name: z.string().trim().min(2).max(80),
      url: z.url().refine((u) => u.startsWith('https://'), 'Must be https'),
      events: z.array(z.string().max(40)).max(50),
      is_active: z.boolean(),
    }),
    select:
      'SELECT x.id, x.name, x.url, x.events, x.is_active, x.last_status, x.failure_count, x.disabled_at, x.created_at, x.updated_at FROM webhook_endpoints x',
    softDelete: false,
    sorts: { name: 'x.name', created_at: 'x.created_at' },
    defaultSort: 'x.name ASC',
    toColumns: (b) => ({
      ...b,
      ...(b.is_active === true ? { failure_count: 0, disabled_at: null } : {}),
    }),
    ops: ['list', 'get', 'update', 'delete'],
  });

  void unprocessable;
}
