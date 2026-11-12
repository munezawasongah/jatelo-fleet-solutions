import type pg from 'pg';

/** VAT applied to SaaS subscriptions per country (KE 16%, TZ/UG/RW 18%). */
export const TAX_RATES: Record<string, number> = { KE: 16, TZ: 18, UG: 18, RW: 18 };
/** Days after the period starts that an invoice falls due. */
export const PAYMENT_TERMS_DAYS = 14;
/** Days overdue after which a tenant is suspended. */
export const SUSPEND_AFTER_DAYS = 30;

type Client = pg.PoolClient | pg.Pool;

async function nextInvoiceNumber(c: Client): Promise<string> {
  const y = new Date().getUTCFullYear();
  const r = await c.query<{ n: number }>(
    `SELECT coalesce(max(substring(number FROM '^JFS-${y}-(\\d+)$')::int), 0) + 1 AS n FROM invoices WHERE number ~ '^JFS-${y}-\\d+$'`,
  );
  return `JFS-${y}-${String(r.rows[0]!.n).padStart(6, '0')}`;
}

/**
 * Issues the invoice for a tenant's current subscription period (system connection required).
 * Billable vehicles = max(plan minimum, active vehicles now). Idempotent per (tenant, period_start).
 */
export async function issueInvoice(c: Client, tenantId: string): Promise<{ id: string; number: string; total: number; created: boolean } | null> {
  const s = (
    await c.query<{
      id: string;
      current_period_start: Date;
      current_period_end: Date;
      price_per_vehicle: string;
      currency: string;
      min_vehicles: number;
      plan_name: string;
      country_code: string;
      status: string;
    }>(
      `SELECT s.id, s.current_period_start, s.current_period_end, s.price_per_vehicle, s.currency, p.min_vehicles, p.name AS plan_name, t.country_code, s.status
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN tenants t ON t.id = s.tenant_id
       WHERE s.tenant_id = $1 AND s.status IN ('trialing', 'active', 'past_due') ORDER BY s.created_at DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
  if (!s) return null;
  const periodStart = s.current_period_start.toISOString().slice(0, 10);
  const periodEnd = new Date(s.current_period_end.getTime() - 1000).toISOString().slice(0, 10);
  const existing = (
    await c.query<{ id: string; number: string; total: string }>(
      `SELECT id, number, total FROM invoices WHERE tenant_id = $1 AND period_start = $2 AND status <> 'void'`,
      [tenantId, periodStart],
    )
  ).rows[0];
  if (existing) return { id: existing.id, number: existing.number, total: Number(existing.total), created: false };
  const vehicles = Number(
    (
      await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM vehicles WHERE tenant_id = $1 AND deleted_at IS NULL AND status NOT IN ('sold', 'written_off')`,
        [tenantId],
      )
    ).rows[0]!.n,
  );
  const qty = Math.max(vehicles, s.min_vehicles);
  const unit = Number(s.price_per_vehicle);
  const subtotal = Math.round(qty * unit * 100) / 100;
  const taxRate = TAX_RATES[s.country_code] ?? 0;
  const tax = Math.round(subtotal * taxRate) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const number = await nextInvoiceNumber(c);
  const lines = [
    {
      description: `${s.plan_name} plan - ${qty} vehicle${qty === 1 ? '' : 's'} (${periodStart} to ${periodEnd})`,
      quantity: qty,
      unit_price: unit,
      amount: subtotal,
      ...(vehicles < s.min_vehicles ? { note: `Plan minimum of ${s.min_vehicles} vehicles applies` } : {}),
    },
  ];
  const r = await c.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, number, subscription_id, period_start, period_end, vehicle_count, unit_price, subtotal, tax_rate, tax_amount, total,
       currency, status, due_date, issued_at, lines)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $11::numeric = 0 THEN 'paid' ELSE 'open' END, $4::date + $13::int, now(), $14) RETURNING id`,
    [tenantId, number, s.id, periodStart, periodEnd, qty, unit, subtotal, taxRate, tax, total, s.currency, PAYMENT_TERMS_DAYS, JSON.stringify(lines)],
  );
  return { id: r.rows[0]!.id, number, total, created: true };
}

/** Applies a succeeded payment to its invoice; marks invoice paid and reactivates the subscription/tenant when settled. */
export async function applyPayment(c: Client, paymentId: string): Promise<void> {
  const p = (
    await c.query<{ invoice_id: string | null; amount: string; tenant_id: string; status: string }>(
      'SELECT invoice_id, amount, tenant_id, status FROM payments WHERE id = $1',
      [paymentId],
    )
  ).rows[0];
  if (!p || p.status !== 'succeeded' || !p.invoice_id) return;
  const inv = (
    await c.query<{ status: string; total: string; amount_paid: string }>(
      `UPDATE invoices SET amount_paid = (SELECT coalesce(sum(amount), 0) FROM payments WHERE invoice_id = $1 AND status = 'succeeded')
       WHERE id = $1 RETURNING status, total, amount_paid`,
      [p.invoice_id],
    )
  ).rows[0]!;
  if (Number(inv.amount_paid) + 0.005 >= Number(inv.total) && inv.status !== 'paid') {
    await c.query(`UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1`, [p.invoice_id]);
    const owing = (
      await c.query<{ n: string }>(`SELECT count(*) AS n FROM invoices WHERE tenant_id = $1 AND status = 'overdue'`, [p.tenant_id])
    ).rows[0]!.n;
    if (Number(owing) === 0) {
      await c.query(`UPDATE subscriptions SET status = 'active' WHERE tenant_id = $1 AND status IN ('trialing', 'past_due')`, [p.tenant_id]);
      await c.query(`UPDATE tenants SET status = 'active' WHERE id = $1 AND status IN ('trial', 'suspended')`, [p.tenant_id]);
    }
  }
}

/**
 * Daily billing cycle (system connection): rolls subscriptions whose period ended into the next period and invoices them,
 * converts ended trials, marks unpaid invoices overdue, and suspends tenants long overdue.
 */
export async function runBillingCycle(c: pg.Pool): Promise<{ invoiced: number; overdue: number; suspended: number }> {
  let invoiced = 0;
  // trials that ended -> first paid period starts now
  await c.query(
    `UPDATE subscriptions s SET status = 'active', current_period_start = now(),
       current_period_end = now() + CASE p.billing_interval WHEN 'year' THEN interval '1 year' ELSE interval '1 month' END
     FROM plans p WHERE p.id = s.plan_id AND s.status = 'trialing' AND s.current_period_end <= now()`,
  );
  // roll finished periods forward (unless cancelling)
  await c.query(
    `UPDATE subscriptions s SET status = 'cancelled', cancelled_at = now() WHERE s.cancel_at_period_end AND s.current_period_end <= now() AND s.status <> 'cancelled'`,
  );
  await c.query(
    `UPDATE subscriptions s SET current_period_start = s.current_period_end,
       current_period_end = s.current_period_end + CASE p.billing_interval WHEN 'year' THEN interval '1 year' ELSE interval '1 month' END
     FROM plans p WHERE p.id = s.plan_id AND s.status IN ('active', 'past_due') AND s.current_period_end <= now()`,
  );
  const due = (
    await c.query<{ tenant_id: string }>(
      `SELECT s.tenant_id FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id AND t.deleted_at IS NULL AND t.status <> 'cancelled'
       WHERE s.status IN ('active', 'past_due')
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = s.tenant_id AND i.period_start = s.current_period_start::date AND i.status <> 'void')`,
    )
  ).rows;
  for (const d of due) if ((await issueInvoice(c, d.tenant_id))?.created) invoiced++;
  const overdue = await c.query<{ tenant_id: string }>(
    `UPDATE invoices SET status = 'overdue' WHERE status = 'open' AND due_date < current_date RETURNING tenant_id`,
  );
  if (overdue.rowCount)
    await c.query(`UPDATE subscriptions SET status = 'past_due' WHERE status = 'active' AND tenant_id = ANY($1)`, [overdue.rows.map((r) => r.tenant_id)]);
  const suspended = await c.query(
    `UPDATE tenants t SET status = 'suspended' WHERE t.status IN ('active', 'trial') AND EXISTS (
       SELECT 1 FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'overdue' AND i.due_date < current_date - $1::int)`,
    [SUSPEND_AFTER_DAYS],
  );
  // STK pushes that never got a callback
  await c.query(`UPDATE mpesa_requests SET status = 'timeout' WHERE status = 'initiated' AND created_at < now() - interval '10 minutes'`);
  await c.query(
    `UPDATE payments SET status = 'failed', failure_reason = 'No confirmation from M-Pesa' WHERE status = 'pending' AND method = 'mpesa_ke'
       AND created_at < now() - interval '10 minutes'`,
  );
  return { invoiced, overdue: overdue.rowCount ?? 0, suspended: suspended.rowCount ?? 0 };
}
