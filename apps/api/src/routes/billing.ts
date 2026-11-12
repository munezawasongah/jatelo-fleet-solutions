import type { Router } from 'express';
import { applyPayment, withTransaction, type PoolClient } from '@jfs/db';
import { renderInvoicePdf } from '@jfs/reports';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { safeEqual } from '../auth/crypto.js';
import { forgetTenantStatus, guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { config } from '../config.js';
import { paged, PageQuery } from '../http/crud.js';
import { AppError, notFound, unprocessable } from '../http/errors.js';
import { rateLimit } from '../http/rate-limit.js';
import { AnyRow, ListOf, listRows, rowsOf, type Row } from '../http/resource.js';
import { route } from '../http/route.js';
import { systemPool } from '../infra/db.js';
import { callbackMeta, mpesaConfigured, mpesaPhone, mpesaSimulated, stkPush, type StkCallback } from '../infra/mpesa.js';
import { logger } from '../logger.js';

const BASE = '/api/v1';
const TAG = 'Billing';
const IdParam = z.object({ id: z.uuid() });

const INVOICE_SELECT = `SELECT i.id, i.number, i.period_start::text, i.period_end::text, i.vehicle_count, i.unit_price, i.subtotal, i.tax_rate, i.tax_amount,
  i.total, i.amount_paid, (i.total - i.amount_paid) AS balance, i.currency, i.status, i.due_date::text, i.issued_at, i.paid_at, i.lines, i.notes, i.created_at
  FROM invoices i`;

/** Records the outcome of an STK push (callback or simulation). Idempotent on checkout_request_id. */
export async function settleStk(cb: StkCallback, raw: unknown): Promise<void> {
  await withTransaction(systemPool, async (c) => {
    const req = (
      await c.query<{ id: string; payment_id: string | null; status: string; tenant_id: string }>(
        'SELECT id, payment_id, status, tenant_id FROM mpesa_requests WHERE checkout_request_id = $1 FOR UPDATE',
        [cb.CheckoutRequestID],
      )
    ).rows[0];
    if (!req) {
      logger.warn({ checkout: cb.CheckoutRequestID }, 'M-Pesa callback for unknown request');
      return;
    }
    if (req.status !== 'initiated' && req.status !== 'timeout') return; // already handled
    const ok = Number(cb.ResultCode) === 0;
    const meta = callbackMeta(cb);
    const status = ok ? 'succeeded' : Number(cb.ResultCode) === 1032 ? 'cancelled' : 'failed';
    await c.query(
      `UPDATE mpesa_requests SET status = $2, result_code = $3, result_desc = $4, mpesa_receipt = $5, raw_callback = $6, callback_at = now() WHERE id = $1`,
      [req.id, status, cb.ResultCode, cb.ResultDesc, meta.receipt, JSON.stringify(raw)],
    );
    if (!req.payment_id) return;
    await c.query(
      `UPDATE payments SET status = $2, provider_reference = coalesce($3, provider_reference), paid_at = CASE WHEN $2 = 'succeeded' THEN now() END,
         amount = CASE WHEN $2 = 'succeeded' AND $4::numeric > 0 THEN $4 ELSE amount END, failure_reason = CASE WHEN $2 <> 'succeeded' THEN $5 END
       WHERE id = $1`,
      [req.payment_id, status, meta.receipt, meta.amount ?? 0, cb.ResultDesc],
    );
    if (ok) {
      await applyPayment(c, req.payment_id);
      forgetTenantStatus(req.tenant_id);
      await c.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, action, entity_type, entity_id, metadata) VALUES ($1, 'system', 'payment.received', 'payment', $2, $3)`,
        [req.tenant_id, req.payment_id, JSON.stringify({ method: 'mpesa_ke', receipt: meta.receipt, amount: meta.amount })],
      );
    }
  });
}

async function invoiceDoc(c: PoolClient, id: string): Promise<Row> {
  const inv = rowsOf(await c.query<Row>(`${INVOICE_SELECT} WHERE i.id = $1`, [id]), { keep: ['total'] })[0];
  if (!inv) throw notFound('Invoice');
  const payments = await listRows(
    c,
    `SELECT id, method, amount, currency, status, provider_reference, payer_phone, paid_at, failure_reason, created_at FROM payments WHERE invoice_id = $1 ORDER BY created_at`,
    [id],
  );
  return { ...inv, payments };
}

export function registerBillingRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/billing/overview',
    tags: [TAG],
    summary: 'Subscription, plan, vehicle usage vs quota, outstanding balance and next invoice estimate',
    auth: true,
    middleware: guard('billing:read'),
    responses: { 200: { description: 'Overview', schema: AnyRow } },
    handler: async ({ req }) =>
      tenantDb(req, async (c) => {
        const sub = rowsOf(
          await c.query<Row>(
            `SELECT s.id, s.status, s.vehicle_quota, s.price_per_vehicle, s.currency, s.current_period_start, s.current_period_end, s.cancel_at_period_end,
               p.code AS plan_code, p.name AS plan_name, p.min_vehicles, p.features, p.limits, p.billing_interval, t.status AS tenant_status, t.trial_ends_at, t.country_code
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN tenants t ON t.id = s.tenant_id ORDER BY s.created_at DESC LIMIT 1`,
          ),
        )[0];
        const usage = (
          await c.query<{ vehicles: string; devices: string; users: string; drivers: string }>(
            `SELECT (SELECT count(*) FROM vehicles WHERE deleted_at IS NULL AND status NOT IN ('sold', 'written_off')) AS vehicles,
               (SELECT count(*) FROM devices WHERE deleted_at IS NULL AND status = 'active') AS devices,
               (SELECT count(*) FROM users WHERE deleted_at IS NULL AND status <> 'disabled') AS users,
               (SELECT count(*) FROM drivers WHERE deleted_at IS NULL AND status = 'active') AS drivers`,
          )
        ).rows[0]!;
        const owed = (
          await c.query<{ balance: string; overdue: string; open: string }>(
            `SELECT coalesce(sum(total - amount_paid), 0) AS balance, count(*) FILTER (WHERE status = 'overdue') AS overdue, count(*) AS open
             FROM invoices WHERE status IN ('open', 'overdue')`,
          )
        ).rows[0]!;
        const tax = { KE: 16, TZ: 18, UG: 18, RW: 18 }[String(sub?.country_code ?? 'KE')] ?? 0;
        const qty = Math.max(Number(usage.vehicles), Number(sub?.min_vehicles ?? 1));
        const sub_total = qty * Number(sub?.price_per_vehicle ?? 0);
        return {
          subscription: sub ?? null,
          usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, Number(v)])),
          over_quota: sub ? Number(usage.vehicles) > Number(sub.vehicle_quota) : false,
          balance: Number(owed.balance),
          overdue_invoices: Number(owed.overdue),
          open_invoices: Number(owed.open),
          next_invoice_estimate: sub
            ? { billable_vehicles: qty, subtotal: sub_total, tax_rate: tax, total: Math.round(sub_total * (100 + tax)) / 100, currency: sub.currency, date: sub.current_period_end }
            : null,
          payment_methods: { mpesa: mpesaConfigured() || mpesaSimulated(), mpesa_simulated: mpesaSimulated() },
        };
      }),
  });

  route(v1, BASE, {
    method: 'get',
    path: '/billing/plans',
    tags: [TAG],
    summary: 'Available plans priced in the company currency',
    auth: true,
    middleware: guard('billing:read'),
    responses: { 200: { description: 'Plans', schema: z.object({ data: z.array(AnyRow) }) } },
    handler: async ({ req }) =>
      tenantDb(req, async (c) => ({
        data: await listRows(
          c,
          `SELECT p.code, p.name, p.description, p.billing_interval, p.trial_days, p.min_vehicles, p.features, p.limits, pp.price_per_vehicle, pp.currency
           FROM plans p JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = (SELECT currency FROM tenants WHERE id = app.current_tenant_id())
           WHERE p.is_public AND p.is_active ORDER BY p.sort_order, pp.price_per_vehicle`,
          [],
        ),
      })),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/billing/change-plan',
    tags: [TAG],
    summary: 'Switch plan (new price applies from the next invoice) and/or vehicle quota',
    auth: true,
    body: z.object({ plan_code: z.string().min(2).max(40).optional(), vehicle_quota: z.number().int().min(1).max(100000).optional() }),
    middleware: guard('billing:manage'),
    responses: { 200: { description: 'Subscription', schema: AnyRow } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      if (!body.plan_code && !body.vehicle_quota) throw unprocessable('Nothing to change');
      const out = await withTransaction(systemPool, async (c) => {
        const cur = (
          await c.query<{ id: string; currency: string; plan_id: string }>(
            `SELECT id, currency, plan_id FROM subscriptions WHERE tenant_id = $1 AND status IN ('trialing', 'active', 'past_due') ORDER BY created_at DESC LIMIT 1`,
            [auth.tenantId],
          )
        ).rows[0];
        if (!cur) throw unprocessable('No active subscription - contact Jatelo support');
        let planId = cur.plan_id;
        let price: string | null = null;
        if (body.plan_code) {
          const p = (
            await c.query<{ id: string; price: string }>(
              `SELECT p.id, pp.price_per_vehicle AS price FROM plans p JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = $2
               WHERE p.code = $1 AND p.is_active AND p.is_public`,
              [body.plan_code, cur.currency],
            )
          ).rows[0];
          if (!p) throw unprocessable('That plan is not available in your currency');
          planId = p.id;
          price = p.price;
        }
        const r = await c.query<Row>(
          `UPDATE subscriptions SET plan_id = $2, price_per_vehicle = coalesce($3, price_per_vehicle), vehicle_quota = coalesce($4, vehicle_quota)
           WHERE id = $1 RETURNING id, plan_id, price_per_vehicle, vehicle_quota, status, current_period_end`,
          [cur.id, planId, price, body.vehicle_quota ?? null],
        );
        return rowsOf(r)[0]!;
      });
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'subscription.changed', entityType: 'subscription', entityId: String(out.id), changes: body, req });
      return out;
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/billing/invoices',
    tags: [TAG],
    summary: 'Invoices',
    auth: true,
    query: z.object({ ...PageQuery, status: z.enum(['open', 'paid', 'overdue', 'void']).optional() }),
    middleware: guard('billing:read'),
    responses: { 200: { description: 'Invoices', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `${INVOICE_SELECT.replace('FROM invoices i', ', count(*) OVER () AS total_rows FROM invoices i')} WHERE ($1::text IS NULL OR i.status = $1)
           ORDER BY i.period_start DESC LIMIT $2 OFFSET $3`,
          [query.status ?? null, query.page_size, (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r, { keep: ['total'] }).map(({ total_rows: _t, ...x }) => x), Number(r.rows[0]?.total_rows ?? 0), query.page, query.page_size);
      }),
  });

  route(v1, BASE, {
    method: 'get',
    path: '/billing/invoices/:id',
    tags: [TAG],
    summary: 'Invoice with payments',
    auth: true,
    params: IdParam,
    middleware: guard('billing:read'),
    responses: { 200: { description: 'Invoice', schema: AnyRow } },
    handler: async ({ req, params }) => tenantDb(req, (c) => invoiceDoc(c, params.id)),
  });

  route(v1, BASE, {
    method: 'get',
    path: '/billing/invoices/:id/pdf',
    tags: [TAG],
    summary: 'Download the invoice as PDF',
    auth: true,
    params: IdParam,
    middleware: guard('billing:read'),
    responses: { 200: { description: 'PDF' } },
    handler: async ({ req, res, params }) => {
      const data = await tenantDb(req, async (c) => {
        const inv = await invoiceDoc(c, params.id);
        const t = (
          await c.query<{ name: string; legal_name: string | null; tax_id: string | null; address: string | null; email: string | null; country_code: string }>(
            'SELECT name, legal_name, tax_id, address, email, country_code FROM tenants WHERE id = app.current_tenant_id()',
          )
        ).rows[0]!;
        return { inv, t };
      });
      const n = (v: unknown): number => Number(v ?? 0);
      const pdf = await renderInvoicePdf({
        number: String(data.inv.number), status: String(data.inv.status), issued_at: data.inv.issued_at as string, due_date: String(data.inv.due_date),
        period_start: String(data.inv.period_start), period_end: String(data.inv.period_end), currency: String(data.inv.currency), subtotal: n(data.inv.subtotal),
        tax_rate: n(data.inv.tax_rate), tax_amount: n(data.inv.tax_amount), total: n(data.inv.total), amount_paid: n(data.inv.amount_paid),
        lines: (data.inv.lines as InvoiceLine[]) ?? [], customer: data.t,
        payments: (data.inv.payments as Row[]).filter((p) => p.status === 'succeeded').map((p) => ({
          method: String(p.method), amount: n(p.amount), provider_reference: (p.provider_reference as string | null) ?? null, paid_at: (p.paid_at as string | null) ?? null,
        })),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${String(data.inv.number)}.pdf"`);
      res.status(200).end(pdf);
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/billing/payments',
    tags: [TAG],
    summary: 'Payments',
    auth: true,
    query: z.object(PageQuery),
    middleware: guard('billing:read'),
    responses: { 200: { description: 'Payments', schema: ListOf } },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const r = await c.query<Row>(
          `SELECT p.id, p.invoice_id, i.number AS invoice_number, p.method, p.amount, p.currency, p.status, p.provider_reference, p.payer_phone, p.paid_at,
             p.failure_reason, p.created_at, count(*) OVER () AS total
           FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
          [query.page_size, (query.page - 1) * query.page_size],
        );
        return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  route(v1, BASE, {
    method: 'get',
    path: '/billing/payments/:id',
    tags: [TAG],
    summary: 'Payment status (poll after an STK push)',
    auth: true,
    params: IdParam,
    middleware: guard('billing:read'),
    responses: { 200: { description: 'Payment', schema: AnyRow } },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => {
        const p = rowsOf(
          await c.query<Row>(
            `SELECT p.id, p.invoice_id, p.method, p.amount, p.currency, p.status, p.provider_reference, p.paid_at, p.failure_reason, i.status AS invoice_status
             FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.id = $1`,
            [params.id],
          ),
        )[0];
        if (!p) throw notFound('Payment');
        return p;
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/billing/invoices/:id/mpesa',
    tags: [TAG],
    summary: 'Pay an invoice with M-Pesa (STK push to the phone); poll the returned payment for the result',
    auth: true,
    params: IdParam,
    body: z.object({ phone: z.string().min(9).max(16).describe('Safaricom number, e.g. 0712345678'), amount: z.number().positive().optional() }),
    status: 202,
    middleware: [...guard('billing:manage'), rateLimit({ keyPrefix: 'stk', points: 5, durationSec: 300 })],
    responses: { 202: { description: 'STK push sent', schema: AnyRow } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      if (!mpesaConfigured() && !mpesaSimulated()) throw new AppError(503, 'mpesa_unavailable', 'M-Pesa payments are not available right now');
      const phone = mpesaPhone(body.phone);
      if (!phone) throw unprocessable('Enter a valid Safaricom number, e.g. 0712 345 678');
      const inv = await tenantDb(req, async (c) =>
        rowsOf(await c.query<Row>(`SELECT id, number, total, amount_paid, currency, status FROM invoices WHERE id = $1`, [params.id]), { keep: ['total'] })[0],
      );
      if (!inv) throw notFound('Invoice');
      if (!['open', 'overdue'].includes(String(inv.status))) throw unprocessable(`This invoice is ${String(inv.status)}`);
      if (inv.currency !== 'KES') throw unprocessable('M-Pesa Kenya can only pay KES invoices');
      const balance = Number(inv.total) - Number(inv.amount_paid);
      const amount = Math.ceil(Math.min(body.amount ?? balance, balance));
      if (amount < 1) throw unprocessable('Nothing left to pay on this invoice');
      const stk = await stkPush({ phone, amount, reference: String(inv.number).replace(/^JFS-/, ''), description: 'JFS invoice' }).catch((err: Error) => {
        throw new AppError(502, 'mpesa_error', err.message);
      });
      const paymentId = await withTransaction(systemPool, async (c) => {
        const p = (
          await c.query<{ id: string }>(
            `INSERT INTO payments (tenant_id, invoice_id, method, amount, currency, status, payer_phone, metadata) VALUES ($1,$2,'mpesa_ke',$3,'KES','pending',$4,$5) RETURNING id`,
            [auth.tenantId, inv.id, amount, `+${phone}`, JSON.stringify({ initiated_by: auth.userId, simulated: mpesaSimulated() })],
          )
        ).rows[0]!.id;
        await c.query(
          `INSERT INTO mpesa_requests (tenant_id, payment_id, environment, merchant_request_id, checkout_request_id, phone, amount, account_reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [auth.tenantId, p, config.MPESA_ENV, stk.merchantRequestId, stk.checkoutRequestId, phone, amount, String(inv.number)],
        );
        return p;
      });
      if (mpesaSimulated()) {
        setTimeout(() => {
          const cb: StkCallback = {
            MerchantRequestID: stk.merchantRequestId, CheckoutRequestID: stk.checkoutRequestId, ResultCode: 0, ResultDesc: 'Simulated success',
            CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: `SIM${Date.now().toString(36).toUpperCase()}` }, { Name: 'PhoneNumber', Value: Number(phone) }] },
          };
          settleStk(cb, { simulated: true }).catch((err) => logger.error({ err }, 'simulated M-Pesa settlement failed'));
        }, 3000).unref();
      }
      await audit({ tenantId: auth.tenantId, actorId: auth.userId, action: 'payment.initiated', entityType: 'invoice', entityId: params.id, metadata: { amount, method: 'mpesa_ke' }, req });
      return { payment_id: paymentId, status: 'pending', amount, message: stk.customerMessage, simulated: mpesaSimulated() };
    },
  });

  // ---------------------------------------------------------------- Safaricom callbacks (public, secret in path)
  route(v1, BASE, {
    method: 'post',
    path: '/public/mpesa/callback/:secret',
    tags: [TAG],
    summary: 'M-Pesa STK push result callback (called by Safaricom)',
    params: z.object({ secret: z.string().min(8).max(200) }),
    body: z.object({ Body: z.object({ stkCallback: z.any() }) }).loose(),
    middleware: [rateLimit({ keyPrefix: 'mpesa-cb', points: 600, durationSec: 60 })],
    responses: { 200: { description: 'Acknowledged', schema: AnyRow } },
    handler: async ({ params, body }) => {
      if (!config.MPESA_CALLBACK_SECRET || !safeEqual(params.secret, config.MPESA_CALLBACK_SECRET)) throw notFound();
      await settleStk(body.Body.stkCallback as StkCallback, body);
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/public/mpesa/c2b/:secret/confirmation',
    tags: [TAG],
    summary: 'M-Pesa Paybill (C2B) confirmation: matches the account number to an invoice number',
    params: z.object({ secret: z.string().min(8).max(200) }),
    body: z.object({ TransID: z.string(), TransAmount: z.union([z.string(), z.number()]), BillRefNumber: z.string(), MSISDN: z.union([z.string(), z.number()]).optional() }).loose(),
    middleware: [rateLimit({ keyPrefix: 'mpesa-c2b', points: 600, durationSec: 60 })],
    responses: { 200: { description: 'Acknowledged', schema: AnyRow } },
    handler: async ({ params, body }) => {
      if (!config.MPESA_CALLBACK_SECRET || !safeEqual(params.secret, config.MPESA_CALLBACK_SECRET)) throw notFound();
      const ref = body.BillRefNumber.trim().toUpperCase();
      await withTransaction(systemPool, async (c) => {
        const inv = (
          await c.query<{ id: string; tenant_id: string; currency: string }>(
            `SELECT id, tenant_id, currency FROM invoices WHERE upper(number) = $1 OR upper(number) = 'JFS-' || $1 LIMIT 1`,
            [ref],
          )
        ).rows[0];
        if (!inv) {
          logger.warn({ ref, trans: body.TransID }, 'C2B payment with unknown account number - needs manual matching');
          return;
        }
        const p = await c.query<{ id: string }>(
          `INSERT INTO payments (tenant_id, invoice_id, method, amount, currency, status, provider_reference, payer_phone, paid_at, metadata)
           VALUES ($1,$2,'mpesa_ke',$3,$4,'succeeded',$5,$6, now(), $7) ON CONFLICT (method, provider_reference) WHERE provider_reference IS NOT NULL DO NOTHING RETURNING id`,
          [inv.tenant_id, inv.id, Number(body.TransAmount), inv.currency, body.TransID, body.MSISDN ? `+${String(body.MSISDN)}` : null, JSON.stringify({ channel: 'c2b' })],
        );
        if (p.rows[0]) {
          await applyPayment(c, p.rows[0].id);
          forgetTenantStatus(inv.tenant_id);
        }
      });
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    },
  });
}

type InvoiceLine = { description: string; quantity: number; unit_price: number; amount: number; note?: string };
