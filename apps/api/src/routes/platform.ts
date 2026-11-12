import type { Router } from 'express';
import { applyPayment, issueInvoice, withTransaction, type PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { issueInvite, sendInvite } from '../auth/invites.js';
import { forgetTenantStatus, guard, requireAuth } from '../auth/middleware.js';
import { revokeSessions } from '../auth/tokens.js';
import { config } from '../config.js';
import { paged, PageQuery } from '../http/crud.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { normalizePhone } from '../http/phone.js';
import { AnyRow, ListOf, listRows, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { systemPool } from '../infra/db.js';

/**
 * Jatelo super-admin console: tenants, plans & prices, subscriptions, invoices & manual payments, tracker stock provisioning,
 * platform health. Uses the system connection (RLS bypass) - every route requires platform:admin.
 */
const BASE = '/api/v1';
const TAG = 'Super admin';
const IdParam = z.object({ id: z.uuid() });
const PA = (): ReturnType<typeof guard> => guard('platform:admin');
const CURRENCY: Record<string, string> = { KE: 'KES', TZ: 'TZS', UG: 'UGX', RW: 'RWF' };
const TZ: Record<string, string> = { KE: 'Africa/Nairobi', TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala', RW: 'Africa/Kigali' };

const sys = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTransaction(systemPool, fn);

const TENANT_SELECT = `SELECT t.id, t.name, t.slug, t.legal_name, t.tax_id, t.country_code, t.currency, t.timezone, t.locale, t.email, t.phone, t.address, t.status,
  t.trial_ends_at, t.created_at, t.updated_at, s.id AS subscription_id, s.status AS subscription_status, p.code AS plan_code, p.name AS plan_name,
  s.price_per_vehicle, s.vehicle_quota, s.current_period_end,
  (SELECT count(*) FROM vehicles v WHERE v.tenant_id = t.id AND v.deleted_at IS NULL AND v.status NOT IN ('sold', 'written_off')) AS vehicles,
  (SELECT count(*) FROM devices d WHERE d.tenant_id = t.id AND d.deleted_at IS NULL AND d.status = 'active') AS devices,
  (SELECT count(*) FROM device_status ds WHERE ds.tenant_id = t.id AND ds.last_seen_at > now() - interval '15 minutes') AS online_devices,
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL AND u.status = 'active') AS active_users,
  (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM invoices i WHERE i.tenant_id = t.id AND i.status IN ('open', 'overdue')) AS balance
  FROM tenants t
  LEFT JOIN LATERAL (SELECT * FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.created_at DESC LIMIT 1) s ON true
  LEFT JOIN plans p ON p.id = s.plan_id`;

export function registerPlatformRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/admin/stats',
    tags: [TAG],
    summary: 'Platform overview: tenants, fleet size, MRR, arrears, ingest throughput',
    auth: true,
    middleware: PA(),
    responses: { 200: { description: 'Stats', schema: AnyRow } },
    handler: async () => {
      const r = (
        await systemPool.query<Row>(
          `SELECT
             (SELECT json_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM tenants WHERE deleted_at IS NULL GROUP BY status) x) AS tenants,
             (SELECT count(*) FROM vehicles WHERE deleted_at IS NULL) AS vehicles,
             (SELECT count(*) FROM devices WHERE deleted_at IS NULL AND status = 'active') AS active_devices,
             (SELECT count(*) FROM devices WHERE deleted_at IS NULL AND status = 'in_stock') AS devices_in_stock,
             (SELECT count(*) FROM device_status WHERE last_seen_at > now() - interval '15 minutes') AS online_devices,
             (SELECT json_object_agg(currency, mrr) FROM (
                SELECT s.currency, sum(s.price_per_vehicle * greatest(p.min_vehicles, (SELECT count(*) FROM vehicles v WHERE v.tenant_id = s.tenant_id AND v.deleted_at IS NULL
                  AND v.status NOT IN ('sold', 'written_off')))) AS mrr
                FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active', 'past_due') GROUP BY s.currency) m) AS mrr,
             (SELECT json_object_agg(currency, owed) FROM (SELECT currency, sum(total - amount_paid) AS owed FROM invoices WHERE status = 'overdue' GROUP BY currency) o) AS overdue,
             (SELECT json_object_agg(currency, paid) FROM (SELECT currency, sum(amount) AS paid FROM payments WHERE status = 'succeeded' AND paid_at > date_trunc('month', now()) GROUP BY currency) p) AS collected_this_month,
             (SELECT count(*) FROM trips WHERE started_at > now() - interval '24 hours') AS trips_24h,
             (SELECT count(*) FROM alerts WHERE occurred_at > now() - interval '24 hours') AS alerts_24h`,
        )
      ).rows[0]!;
      return r;
    },
  });

  // ---------------------------------------------------------------- tenants
  route(v1, BASE, {
    method: 'get',
    path: '/admin/tenants',
    tags: [TAG],
    summary: 'All companies with plan, usage and balance',
    auth: true,
    query: z.object({ ...PageQuery, q: z.string().max(100).optional(), status: z.enum(['trial', 'active', 'suspended', 'cancelled']).optional(), country: z.enum(['KE', 'TZ', 'UG', 'RW']).optional() }),
    middleware: PA(),
    responses: { 200: { description: 'Tenants', schema: ListOf } },
    handler: async ({ query }) => {
      const r = await systemPool.query<Row>(
        `SELECT x.*, count(*) OVER () AS total FROM (${TENANT_SELECT} WHERE t.deleted_at IS NULL
           AND ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR t.status = $2)
           AND ($3::text IS NULL OR t.country_code = $3)) x ORDER BY x.name LIMIT $4 OFFSET $5`,
        [query.q ?? null, query.status ?? null, query.country ?? null, query.page_size, (query.page - 1) * query.page_size],
      );
      return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/admin/tenants/:id',
    tags: [TAG],
    summary: 'Company detail with admins, invoices and recent activity',
    auth: true,
    params: IdParam,
    middleware: PA(),
    responses: { 200: { description: 'Tenant', schema: AnyRow } },
    handler: async ({ params }) =>
      sys(async (c) => {
        const t = rowsOf(await c.query<Row>(`${TENANT_SELECT} WHERE t.id = $1`, [params.id]))[0];
        if (!t) throw notFound('Tenant');
        const admins = await listRows(c, `SELECT id, email, full_name, phone, status, last_login_at FROM users WHERE tenant_id = $1 AND role = 'company_admin' AND deleted_at IS NULL`, [params.id]);
        const invoices = await listRows(c, `SELECT id, number, period_start::text, total AS invoice_total, amount_paid, currency, status, due_date::text FROM invoices WHERE tenant_id = $1 ORDER BY period_start DESC LIMIT 12`, [params.id]);
        const activity = await listRows(c, `SELECT action, entity_type, created_at FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`, [params.id]);
        return { ...t, admins, invoices, recent_activity: activity };
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/admin/tenants',
    tags: [TAG],
    summary: 'Onboard a company: tenant, trial subscription and an invited company administrator',
    auth: true,
    body: z.object({
      name: z.string().trim().min(2).max(160),
      slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/),
      country_code: z.enum(['KE', 'TZ', 'UG', 'RW']),
      currency: z.enum(['KES', 'TZS', 'UGX', 'RWF', 'USD']).optional(),
      legal_name: z.string().max(200).optional(),
      tax_id: z.string().max(40).optional(),
      email: z.email().optional(),
      phone: z.string().max(20).optional(),
      locale: z.enum(['en', 'sw']).optional(),
      plan_code: z.string().min(2).max(40),
      vehicle_quota: z.number().int().min(1).max(100000).default(25),
      trial_days: z.number().int().min(0).max(90).optional(),
      admin: z.object({ email: z.email(), full_name: z.string().trim().min(2).max(120), phone: z.string().max(20).optional() }),
    }),
    status: 201,
    middleware: PA(),
    responses: { 201: { description: 'Tenant', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const currency = body.currency ?? CURRENCY[body.country_code]!;
      const out = await sys(async (c) => {
        if ((await c.query('SELECT 1 FROM tenants WHERE slug = $1', [body.slug])).rowCount) throw conflict('That short name (slug) is taken');
        if ((await c.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL', [body.admin.email])).rowCount)
          throw conflict('A user with the administrator email already exists');
        const plan = (
          await c.query<{ id: string; trial_days: number; price: string | null }>(
            `SELECT p.id, p.trial_days, pp.price_per_vehicle AS price FROM plans p LEFT JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = $2 WHERE p.code = $1 AND p.is_active`,
            [body.plan_code, currency],
          )
        ).rows[0];
        if (!plan) throw unprocessable('Unknown or inactive plan');
        if (plan.price === null) throw unprocessable(`The plan has no ${currency} price - add one first`);
        const trial = body.trial_days ?? plan.trial_days;
        const t = (
          await c.query<{ id: string }>(
            `INSERT INTO tenants (name, slug, legal_name, tax_id, country_code, currency, timezone, locale, email, phone, status, trial_ends_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11::int > 0 THEN 'trial' ELSE 'active' END, CASE WHEN $11::int > 0 THEN now() + make_interval(days => $11) END)
             RETURNING id`,
            [body.name, body.slug, body.legal_name ?? null, body.tax_id ?? null, body.country_code, currency, TZ[body.country_code], body.locale ?? 'en',
              body.email ?? null, normalizePhone(body.phone ?? null, body.country_code), trial],
          )
        ).rows[0]!.id;
        await c.query(
          `INSERT INTO subscriptions (tenant_id, plan_id, status, vehicle_quota, price_per_vehicle, currency, current_period_start, current_period_end)
           VALUES ($1,$2, CASE WHEN $6::int > 0 THEN 'trialing' ELSE 'active' END, $3,$4,$5, now(), now() + CASE WHEN $6::int > 0 THEN make_interval(days => $6) ELSE interval '1 month' END)`,
          [t, plan.id, body.vehicle_quota, plan.price, currency, trial],
        );
        const u = (
          await c.query<{ id: string }>(
            `INSERT INTO users (tenant_id, email, full_name, phone, role, locale, status) VALUES ($1,$2,$3,$4,'company_admin',$5,'invited') RETURNING id`,
            [t, body.admin.email, body.admin.full_name, normalizePhone(body.admin.phone ?? null, body.country_code), body.locale ?? 'en'],
          )
        ).rows[0]!.id;
        const { token } = await issueInvite(c, u, t);
        if (trial === 0) await issueInvoice(c, t);
        return { id: t, token };
      });
      await sendInvite({ email: body.admin.email, name: body.admin.full_name, company: body.name, locale: body.locale ?? 'en', token: out.token });
      await audit({ tenantId: out.id, actorId: auth.userId, action: 'tenant.created', entityType: 'tenant', entityId: out.id, metadata: { plan: body.plan_code }, req });
      const t = rowsOf(await systemPool.query<Row>(`${TENANT_SELECT} WHERE t.id = $1`, [out.id]))[0]!;
      return { ...t, ...(config.NODE_ENV !== 'production' ? { dev_invite_url: `${config.WEB_APP_URL}/accept-invite?token=${out.token}` } : {}) };
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/admin/tenants/:id',
    tags: [TAG],
    summary: 'Edit a company, change status (suspend/reactivate/cancel) or its subscription',
    auth: true,
    params: IdParam,
    body: z.object({
      name: z.string().trim().min(2).max(160).optional(),
      legal_name: z.string().max(200).nullable().optional(),
      tax_id: z.string().max(40).nullable().optional(),
      email: z.email().nullable().optional(),
      status: z.enum(['trial', 'active', 'suspended', 'cancelled']).optional(),
      trial_ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
      subscription: z
        .object({
          plan_code: z.string().optional(),
          price_per_vehicle: z.number().min(0).optional(),
          vehicle_quota: z.number().int().min(1).max(100000).optional(),
          status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']).optional(),
          current_period_end: z.iso.datetime({ offset: true }).optional(),
          cancel_at_period_end: z.boolean().optional(),
        })
        .optional(),
      reason: z.string().max(500).optional(),
    }),
    middleware: PA(),
    responses: { 200: { description: 'Tenant', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      await sys(async (c) => {
        const t = (await c.query<{ status: string; currency: string }>('SELECT status, currency FROM tenants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [params.id])).rows[0];
        if (!t) throw notFound('Tenant');
        const { subscription: s, reason: _r, ...fields } = body;
        const keys = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);
        if (keys.length)
          await c.query(`UPDATE tenants SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [params.id, ...keys.map((k) => (fields as Record<string, unknown>)[k])]);
        if (s) {
          let planId: string | null = null;
          let price = s.price_per_vehicle ?? null;
          if (s.plan_code) {
            const p = (
              await c.query<{ id: string; price: string | null }>(
                `SELECT p.id, pp.price_per_vehicle AS price FROM plans p LEFT JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = $2 WHERE p.code = $1`,
                [s.plan_code, t.currency],
              )
            ).rows[0];
            if (!p) throw unprocessable('Unknown plan');
            planId = p.id;
            price ??= p.price === null ? null : Number(p.price);
          }
          const sub = await c.query(
            `UPDATE subscriptions SET plan_id = coalesce($2, plan_id), price_per_vehicle = coalesce($3, price_per_vehicle), vehicle_quota = coalesce($4, vehicle_quota),
               status = coalesce($5, status), current_period_end = coalesce($6, current_period_end), cancel_at_period_end = coalesce($7, cancel_at_period_end),
               cancelled_at = CASE WHEN $5 = 'cancelled' THEN now() ELSE cancelled_at END
             WHERE id = (SELECT id FROM subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1)`,
            [params.id, planId, price, s.vehicle_quota ?? null, s.status ?? null, s.current_period_end ?? null, s.cancel_at_period_end ?? null],
          );
          if (!sub.rowCount) throw unprocessable('This company has no subscription');
        }
        if (body.status === 'cancelled') {
          const users = (await c.query<{ id: string }>('SELECT id FROM users WHERE tenant_id = $1', [params.id])).rows;
          for (const u of users) await revokeSessions(c, { userId: u.id }, 'tenant_cancelled');
        }
      });
      forgetTenantStatus(params.id);
      await audit({ tenantId: params.id, actorId: auth.userId, action: body.status ? `tenant.status.${body.status}` : 'tenant.updated', entityType: 'tenant', entityId: params.id, changes: body, req });
      return rowsOf(await systemPool.query<Row>(`${TENANT_SELECT} WHERE t.id = $1`, [params.id]))[0]!;
    },
  });

  // ---------------------------------------------------------------- plans
  route(v1, BASE, {
    method: 'get',
    path: '/admin/plans',
    tags: [TAG],
    summary: 'Plans with prices per currency and subscriber counts',
    auth: true,
    middleware: PA(),
    responses: { 200: { description: 'Plans', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async () => ({
      data: rowsOf(
        await systemPool.query<Row>(
          `SELECT p.*, coalesce((SELECT json_object_agg(currency, price_per_vehicle) FROM plan_prices WHERE plan_id = p.id), '{}'::json) AS prices,
             (SELECT count(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status IN ('trialing', 'active', 'past_due')) AS subscribers
           FROM plans p ORDER BY p.sort_order, p.name`,
        ),
      ),
    }),
  });

  const PlanIn = z.object({
    code: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: z.string().trim().min(2).max(80),
    description: z.string().max(1000).nullable().optional(),
    billing_interval: z.enum(['month', 'year']).optional(),
    trial_days: z.number().int().min(0).max(90).optional(),
    min_vehicles: z.number().int().min(1).optional(),
    features: z.array(z.string().max(80)).max(50).optional(),
    limits: z.record(z.string(), z.number()).optional(),
    is_public: z.boolean().optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().optional(),
    prices: z.record(z.enum(['KES', 'TZS', 'UGX', 'RWF', 'USD']), z.number().min(0)).optional().describe('Price per vehicle per interval, by currency'),
  });

  async function savePlan(c: PoolClient, id: string | null, b: Partial<z.infer<typeof PlanIn>>): Promise<string> {
    const { prices, ...f } = b;
    const vals: Record<string, unknown> = { ...f, ...(f.features ? { features: JSON.stringify(f.features) } : {}), ...(f.limits ? { limits: JSON.stringify(f.limits) } : {}) };
    const keys = Object.keys(vals).filter((k) => vals[k] !== undefined);
    let planId = id;
    if (!planId) {
      planId = (
        await c.query<{ id: string }>(`INSERT INTO plans (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => vals[k]))
      ).rows[0]!.id;
    } else if (keys.length) {
      const r = await c.query(`UPDATE plans SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [planId, ...keys.map((k) => vals[k])]);
      if (!r.rowCount) throw notFound('Plan');
    }
    for (const [cur, price] of Object.entries(prices ?? {}))
      await c.query(
        `INSERT INTO plan_prices (plan_id, currency, price_per_vehicle) VALUES ($1,$2,$3) ON CONFLICT (plan_id, currency) DO UPDATE SET price_per_vehicle = EXCLUDED.price_per_vehicle`,
        [planId, cur, price],
      );
    return planId;
  }

  route(v1, BASE, {
    method: 'post',
    path: '/admin/plans',
    tags: [TAG],
    summary: 'Create a plan',
    auth: true,
    body: PlanIn,
    status: 201,
    middleware: PA(),
    responses: { 201: { description: 'Plan', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const id = await sys(async (c) => {
        if ((await c.query('SELECT 1 FROM plans WHERE code = $1', [body.code])).rowCount) throw conflict('A plan with this code exists');
        return savePlan(c, null, body);
      });
      await audit({ tenantId: null, actorId: auth.userId, action: 'plan.created', entityType: 'plan', entityId: id, changes: body, req });
      return rowsOf(await systemPool.query<Row>('SELECT * FROM plans WHERE id = $1', [id]))[0]!;
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/admin/plans/:id',
    tags: [TAG],
    summary: 'Edit a plan or its prices (existing subscriptions keep their price until changed)',
    auth: true,
    params: IdParam,
    body: PlanIn.partial(),
    middleware: PA(),
    responses: { 200: { description: 'Plan', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      await sys((c) => savePlan(c, params.id, body));
      await audit({ tenantId: null, actorId: auth.userId, action: 'plan.updated', entityType: 'plan', entityId: params.id, changes: body, req });
      return rowsOf(await systemPool.query<Row>('SELECT * FROM plans WHERE id = $1', [params.id]))[0]!;
    },
  });

  // ---------------------------------------------------------------- invoices & payments
  route(v1, BASE, {
    method: 'get',
    path: '/admin/invoices',
    tags: [TAG],
    summary: 'All invoices',
    auth: true,
    query: z.object({ ...PageQuery, status: z.enum(['draft', 'open', 'paid', 'overdue', 'void']).optional(), tenant_id: z.uuid().optional() }),
    middleware: PA(),
    responses: { 200: { description: 'Invoices', schema: ListOf } },
    handler: async ({ query }) => {
      const r = await systemPool.query<Row>(
        `SELECT i.id, i.number, i.tenant_id, t.name AS tenant_name, i.period_start::text, i.period_end::text, i.vehicle_count, i.total, i.amount_paid, i.currency,
           i.status, i.due_date::text, i.issued_at, i.paid_at, count(*) OVER () AS total_rows
         FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE ($1::text IS NULL OR i.status = $1) AND ($2::uuid IS NULL OR i.tenant_id = $2)
         ORDER BY i.created_at DESC LIMIT $3 OFFSET $4`,
        [query.status ?? null, query.tenant_id ?? null, query.page_size, (query.page - 1) * query.page_size],
      );
      return paged(rowsOf(r, { keep: ['total', 'tenant_id'] }).map(({ total_rows: _t, ...x }) => x), Number(r.rows[0]?.total_rows ?? 0), query.page, query.page_size);
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/admin/tenants/:id/invoices',
    tags: [TAG],
    summary: 'Issue the invoice for the current subscription period now',
    auth: true,
    params: IdParam,
    status: 201,
    middleware: PA(),
    responses: { 201: { description: 'Invoice', schema: AnyRow } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      const r = await sys((c) => issueInvoice(c, params.id));
      if (!r) throw unprocessable('This company has no active subscription');
      if (r.created) await audit({ tenantId: params.id, actorId: auth.userId, action: 'invoice.issued', entityType: 'invoice', entityId: r.id, req });
      return r;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/admin/invoices/:id/void',
    tags: [TAG],
    summary: 'Void an unpaid invoice',
    auth: true,
    params: IdParam,
    body: z.object({ reason: z.string().trim().min(3).max(500) }),
    middleware: PA(),
    responses: { 200: { description: 'Voided', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      const r = await systemPool.query<{ tenant_id: string }>(
        `UPDATE invoices SET status = 'void', notes = concat_ws(E'\\n', notes, 'Voided: ' || $2) WHERE id = $1 AND status IN ('draft', 'open', 'overdue') AND amount_paid = 0 RETURNING tenant_id`,
        [params.id, body.reason],
      );
      if (!r.rowCount) throw unprocessable('Only unpaid invoices can be voided');
      await audit({ tenantId: r.rows[0]!.tenant_id, actorId: auth.userId, action: 'invoice.voided', entityType: 'invoice', entityId: params.id, metadata: body, req });
      return { voided: true };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/admin/invoices/:id/payments',
    tags: [TAG],
    summary: 'Record a payment received outside the app (bank transfer, cheque, Airtel/MTN mobile money...)',
    auth: true,
    params: IdParam,
    body: z.object({
      method: z.enum(['mpesa_ke', 'mpesa_tz', 'airtel_money', 'mixx_tz', 'mtn_momo', 'bank_transfer', 'card', 'manual']),
      amount: z.number().positive(),
      reference: z.string().trim().min(3).max(80),
      paid_at: z.iso.datetime({ offset: true }).optional(),
      payer_phone: z.string().max(20).optional(),
      note: z.string().max(500).optional(),
    }),
    status: 201,
    middleware: PA(),
    responses: { 201: { description: 'Payment', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      const out = await sys(async (c) => {
        const inv = (await c.query<{ tenant_id: string; currency: string; status: string }>('SELECT tenant_id, currency, status FROM invoices WHERE id = $1 FOR UPDATE', [params.id])).rows[0];
        if (!inv) throw notFound('Invoice');
        if (inv.status === 'void') throw unprocessable('This invoice is void');
        let p;
        try {
          p = await c.query<{ id: string }>(
            `INSERT INTO payments (tenant_id, invoice_id, method, amount, currency, status, provider_reference, payer_phone, paid_at, metadata)
             VALUES ($1,$2,$3,$4,$5,'succeeded',$6,$7,coalesce($8, now()),$9) RETURNING id`,
            [inv.tenant_id, params.id, body.method, body.amount, inv.currency, body.reference, body.payer_phone ?? null, body.paid_at ?? null,
              JSON.stringify({ recorded_by: auth.userId, note: body.note ?? null })],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw conflict('A payment with this reference was already recorded');
          throw err;
        }
        await applyPayment(c, p.rows[0]!.id);
        return { id: p.rows[0]!.id, tenant_id: inv.tenant_id };
      });
      forgetTenantStatus(out.tenant_id);
      await audit({ tenantId: out.tenant_id, actorId: auth.userId, action: 'payment.recorded', entityType: 'payment', entityId: out.id, metadata: body, req });
      return rowsOf(await systemPool.query<Row>('SELECT * FROM payments WHERE id = $1', [out.id]))[0]!;
    },
  });

  // ---------------------------------------------------------------- tracker stock
  route(v1, BASE, {
    method: 'get',
    path: '/admin/devices',
    tags: [TAG],
    summary: 'All trackers (stock and deployed) with last contact',
    auth: true,
    query: z.object({ ...PageQuery, q: z.string().max(40).optional(), status: z.enum(['in_stock', 'active', 'suspended', 'retired']).optional(), tenant_id: z.uuid().optional() }),
    middleware: PA(),
    responses: { 200: { description: 'Devices', schema: ListOf } },
    handler: async ({ query }) => {
      const r = await systemPool.query<Row>(
        `SELECT d.id, d.identifier, d.protocol, d.model, d.firmware, d.sim_iccid, d.sim_msisdn, d.sim_provider, d.status, d.tenant_id, t.name AS tenant_name,
           ds.last_seen_at, ds.state, count(*) OVER () AS total
         FROM devices d LEFT JOIN tenants t ON t.id = d.tenant_id LEFT JOIN device_status ds ON ds.device_id = d.id
         WHERE d.deleted_at IS NULL AND ($1::text IS NULL OR d.identifier ILIKE '%' || $1 || '%' OR d.sim_msisdn ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR d.status = $2) AND ($3::uuid IS NULL OR d.tenant_id = $3)
         ORDER BY d.created_at DESC LIMIT $4 OFFSET $5`,
        [query.q ?? null, query.status ?? null, query.tenant_id ?? null, query.page_size, (query.page - 1) * query.page_size],
      );
      return paged(rowsOf(r).map((x, i) => ({ ...x, tenant_id: r.rows[i]!.tenant_id })), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/admin/devices',
    tags: [TAG],
    summary: 'Provision trackers in bulk into Jatelo stock or straight to a company',
    auth: true,
    body: z.object({
      tenant_id: z.uuid().nullable().optional(),
      devices: z
        .array(
          z.object({
            identifier: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/),
            protocol: z.enum(['teltonika', 'gt06', 'queclink']),
            model: z.string().max(60).optional(),
            firmware: z.string().max(60).optional(),
            sim_iccid: z.string().max(30).optional(),
            sim_msisdn: z.string().max(20).optional(),
            sim_provider: z.string().max(40).optional(),
          }),
        )
        .min(1)
        .max(1000),
    }),
    status: 201,
    middleware: PA(),
    responses: { 201: { description: 'Result', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const r = await sys(async (c) => {
        if (body.tenant_id && !(await c.query('SELECT 1 FROM tenants WHERE id = $1', [body.tenant_id])).rowCount) throw notFound('Tenant');
        let created = 0;
        const skipped: string[] = [];
        for (const d of body.devices) {
          const ins = await c.query(
            `INSERT INTO devices (tenant_id, identifier, protocol, model, firmware, sim_iccid, sim_msisdn, sim_provider, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $1::uuid IS NULL THEN 'in_stock' ELSE 'active' END) ON CONFLICT (identifier) DO NOTHING`,
            [body.tenant_id ?? null, d.identifier, d.protocol, d.model ?? null, d.firmware ?? null, d.sim_iccid ?? null, d.sim_msisdn ?? null, d.sim_provider ?? null],
          );
          if (ins.rowCount) created++;
          else skipped.push(d.identifier);
        }
        return { created, skipped };
      });
      await audit({ tenantId: body.tenant_id ?? null, actorId: auth.userId, action: 'devices.provisioned', entityType: 'device', metadata: { count: r.created, tenant_id: body.tenant_id ?? null }, req });
      return r;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/admin/devices/:id/transfer',
    tags: [TAG],
    summary: 'Move a tracker to another company, or back to stock (unassigns it from any vehicle)',
    auth: true,
    params: IdParam,
    body: z.object({ tenant_id: z.uuid().nullable() }),
    middleware: PA(),
    responses: { 200: { description: 'Device', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      await sys(async (c) => {
        const d = (await c.query<{ tenant_id: string | null }>('SELECT tenant_id FROM devices WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [params.id])).rows[0];
        if (!d) throw notFound('Device');
        await c.query(`UPDATE device_assignments SET unassigned_at = now() WHERE device_id = $1 AND unassigned_at IS NULL`, [params.id]);
        await c.query(`DELETE FROM device_status WHERE device_id = $1`, [params.id]);
        await c.query(`UPDATE devices SET tenant_id = $2, status = CASE WHEN $2::uuid IS NULL THEN 'in_stock' ELSE 'active' END WHERE id = $1`, [params.id, body.tenant_id]);
      });
      await audit({ tenantId: body.tenant_id, actorId: auth.userId, action: 'device.transferred', entityType: 'device', entityId: params.id, metadata: body, req });
      return rowsOf(await systemPool.query<Row>('SELECT id, identifier, protocol, status, tenant_id FROM devices WHERE id = $1', [params.id]))[0]!;
    },
  });

  // ---------------------------------------------------------------- platform audit
  route(v1, BASE, {
    method: 'get',
    path: '/admin/audit-logs',
    tags: [TAG],
    summary: 'Audit trail across all companies',
    auth: true,
    query: z.object({ ...PageQuery, tenant_id: z.uuid().optional(), action: z.string().max(80).optional() }),
    middleware: PA(),
    responses: { 200: { description: 'Entries', schema: ListOf } },
    handler: async ({ query }) => {
      const action = query.action?.endsWith('*') ? `${query.action.slice(0, -1)}%` : (query.action ?? null);
      const r = await systemPool.query<Row>(
        `SELECT a.id, a.created_at, a.tenant_id, t.name AS tenant_name, a.actor_type, a.actor_id, u.email AS actor_email, a.action, a.entity_type, a.entity_id,
           a.metadata, host(a.ip) AS ip, count(*) OVER () AS total
         FROM audit_logs a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN users u ON u.id = a.actor_id
         WHERE ($1::uuid IS NULL OR a.tenant_id = $1) AND ($2::text IS NULL OR a.action LIKE $2) ORDER BY a.created_at DESC, a.id DESC LIMIT $3 OFFSET $4`,
        [query.tenant_id ?? null, action, query.page_size, (query.page - 1) * query.page_size],
      );
      return paged(rowsOf(r).map((x, i) => ({ ...x, tenant_id: r.rows[i]!.tenant_id })), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
    },
  });
}
