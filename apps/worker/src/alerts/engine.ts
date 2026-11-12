import { Queue, Worker } from 'bullmq';
import { ALERT_GROUP, config, EVENTS_STREAM } from '../config.js';
import { blocking, bullConnection, db, redis } from '../infra.js';

const alertReader = blocking.duplicate({ connectionName: 'jfs-worker-alerts' });
import { logger } from '../logger.js';
import { sendEmail, sendPush, sendSms, sendWebhook } from './channels.js';
import { render, type Locale } from './templates.js';

/** An event on the vehicle_events stream (telemetry, geofences, fuel, maintenance, dispatch...). */
export interface VehicleEvent {
  type: string;
  tenant_id: string;
  vehicle_id?: string | null;
  device_id?: string | null;
  driver_id?: string | null;
  geofence_id?: string | null;
  geofence_name?: string | null;
  job_id?: string | null;
  at: string;
  lat?: number | null;
  lng?: number | null;
  speed_kph?: number | null;
  speed_limit_kph?: number | null;
  value?: number | null;
  /** Free text used by some templates (DTC code, service name, document name...). */
  extra?: string | null;
  /** Overrides the plate in messages for non-vehicle alerts (e.g. licence expiry). */
  subject?: string | null;
  source?: string;
  source_type?: string;
  source_id?: string;
  /** Stable key so the same underlying fact never alerts twice (e.g. "doc:<id>:7"). */
  dedupe?: string;
}

interface Rule {
  id: string;
  name: string;
  rule_type: string;
  conditions: Record<string, unknown>;
  applies_to_all: boolean;
  schedule: { days: number[]; start: string; end: string } | null;
  severity: 'info' | 'warning' | 'critical';
  cooldown_minutes: number;
  channels: string[];
  targets: {
    vehicle_id: string | null;
    group_id: string | null;
    driver_id: string | null;
    geofence_id: string | null;
  }[];
  recipients: {
    user_id: string | null;
    role: string | null;
    phone: string | null;
    email: string | null;
  }[];
}
interface TenantCtx {
  rules: Rule[];
  timezone: string;
  locale: Locale;
  at: number;
}

const EVENT_TO_RULE: Record<string, string> = {
  harsh_brake: 'harsh_event',
  harsh_accel: 'harsh_event',
  harsh_corner: 'harsh_event',
  excessive_idle: 'idle',
};
/** Alert types that are always raised in-app (even without a rule) because they are safety-critical. */
const ALWAYS: Record<string, 'critical'> = { sos: 'critical', crash: 'critical' };

const ctxCache = new Map<string, TenantCtx>();
async function tenantCtx(tenantId: string): Promise<TenantCtx> {
  const hit = ctxCache.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const t = (
    await db.query<{ timezone: string; locale: Locale }>(
      'SELECT timezone, locale FROM tenants WHERE id = $1',
      [tenantId],
    )
  ).rows[0];
  const rules = (
    await db.query<Rule>(
      `SELECT r.id, r.name, r.rule_type, r.conditions, r.applies_to_all, r.schedule, r.severity, r.cooldown_minutes, r.channels,
         coalesce((SELECT json_agg(json_build_object('vehicle_id', x.vehicle_id, 'group_id', x.group_id, 'driver_id', x.driver_id, 'geofence_id', x.geofence_id))
           FROM alert_rule_targets x WHERE x.rule_id = r.id), '[]') AS targets,
         coalesce((SELECT json_agg(json_build_object('user_id', x.user_id, 'role', x.role, 'phone', x.phone, 'email', x.email))
           FROM alert_rule_recipients x WHERE x.rule_id = r.id), '[]') AS recipients
       FROM alert_rules r WHERE r.tenant_id = $1 AND r.is_active AND r.deleted_at IS NULL`,
      [tenantId],
    )
  ).rows;
  const ctx = {
    rules,
    timezone: t?.timezone ?? 'Africa/Nairobi',
    locale: t?.locale ?? 'en',
    at: Date.now(),
  };
  ctxCache.set(tenantId, ctx);
  return ctx;
}

function local(at: Date, tz: string): { day: number; minutes: number; hhmm: string } {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  const day =
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(
      p.find((x) => x.type === 'weekday')?.value ?? 'Mon',
    ) + 1;
  return {
    day,
    minutes: h * 60 + m,
    hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  };
}
const toMin = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const inWindow = (m: number, start: string, end: string): boolean => {
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
};

async function vehicleGroup(vehicleId: string): Promise<string | null> {
  const k = `vgroup:${vehicleId}`;
  const c = await redis.get(k);
  if (c !== null) return c || null;
  const g =
    (
      await db.query<{ group_id: string | null }>('SELECT group_id FROM vehicles WHERE id = $1', [
        vehicleId,
      ])
    ).rows[0]?.group_id ?? null;
  await redis.set(k, g ?? '', 'EX', 300);
  return g;
}

/** Does this rule fire for this event? Checks type, targets, schedule and conditions. */
async function matches(rule: Rule, e: VehicleEvent, ctx: TenantCtx): Promise<boolean> {
  const at = new Date(e.at);
  const ruleType = EVENT_TO_RULE[e.type] ?? e.type;
  const c = rule.conditions ?? {};
  if (rule.rule_type === 'after_hours_use') {
    if (e.type !== 'ignition_on') return false;
    const start = typeof c.start === 'string' ? c.start : '20:00';
    const end = typeof c.end === 'string' ? c.end : '05:00';
    if (!inWindow(local(at, ctx.timezone).minutes, start, end)) return false;
  } else if (rule.rule_type !== ruleType) return false;

  if (rule.targets.length) {
    const group = e.vehicle_id ? await vehicleGroup(e.vehicle_id) : null;
    const hit = rule.targets.some(
      (t) =>
        (t.vehicle_id && t.vehicle_id === e.vehicle_id) ||
        (t.group_id && t.group_id === group) ||
        (t.driver_id && t.driver_id === e.driver_id) ||
        (t.geofence_id && t.geofence_id === e.geofence_id),
    );
    if (!hit) return false;
  }
  if (rule.schedule) {
    const l = local(at, ctx.timezone);
    if (
      !rule.schedule.days.includes(l.day) ||
      !inWindow(l.minutes, rule.schedule.start, rule.schedule.end)
    )
      return false;
  }
  switch (rule.rule_type) {
    case 'overspeed':
      return typeof c.speed_kph !== 'number' || (e.speed_kph ?? 0) >= c.speed_kph;
    case 'harsh_event':
      return !Array.isArray(c.types) || c.types.includes(e.type);
    case 'idle':
      return typeof c.minutes !== 'number' || (e.value ?? 0) >= c.minutes * 60;
    case 'fuel_drain':
    case 'refuel':
      return typeof c.min_litres !== 'number' || (e.value ?? 0) >= c.min_litres;
    case 'fuel_level_low':
      return typeof c.below_pct !== 'number' || (e.value ?? 100) <= c.below_pct;
    case 'route_deviation':
      return typeof c.meters !== 'number' || (e.value ?? 0) >= c.meters;
    case 'document_expiry':
    case 'licence_expiry':
      return (
        !Array.isArray(c.days_before) ||
        e.value === null ||
        e.value === undefined ||
        c.days_before.includes(e.value) ||
        e.value < 0
      );
    default:
      return true;
  }
}

const notifyQueue = new Queue('notify', {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

async function describe(
  e: VehicleEvent,
): Promise<{ plate: string; driver: string | null; place: string | null }> {
  const r = (
    await db.query<{ plate: string | null; driver: string | null; place: string | null }>(
      `SELECT (SELECT plate_number FROM vehicles WHERE id = $1) AS plate, (SELECT full_name FROM drivers WHERE id = $2) AS driver,
         (SELECT name FROM pois WHERE tenant_id = $5 AND deleted_at IS NULL AND $3::float8 IS NOT NULL
            AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, greatest(radius_m, 1000))
          ORDER BY geom::geography <-> ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography LIMIT 1) AS place`,
      [e.vehicle_id ?? null, e.driver_id ?? null, e.lat ?? null, e.lng ?? null, e.tenant_id],
    )
  ).rows[0]!;
  return {
    plate: e.subject ?? r.plate ?? 'Vehicle',
    driver: r.driver,
    place: e.type.startsWith('service') ? (e.extra ?? null) : r.place,
  };
}

/** Evaluates one event against the tenant's rules and raises alerts + deliveries. Returns alerts created. */
export async function evaluate(e: VehicleEvent): Promise<number> {
  const ctx = await tenantCtx(e.tenant_id);
  const fired: { rule: Rule | null; severity: 'info' | 'warning' | 'critical' }[] = [];
  for (const rule of ctx.rules)
    if (await matches(rule, e, ctx)) fired.push({ rule, severity: rule.severity });
  if (!fired.length && ALWAYS[e.type]) fired.push({ rule: null, severity: ALWAYS[e.type]! });
  if (!fired.length) return 0;

  const d = await describe(e);
  const at = new Date(e.at);
  let created = 0;
  for (const f of fired) {
    const cooldownKey = `alertcd:${f.rule?.id ?? e.type}:${e.vehicle_id ?? e.driver_id ?? e.subject ?? '-'}:${e.geofence_id ?? ''}`;
    const cd = f.rule?.cooldown_minutes ?? 1;
    if (cd > 0 && (await redis.set(cooldownKey, '1', 'EX', cd * 60, 'NX')) !== 'OK') continue;
    const alertType = f.rule?.rule_type === 'after_hours_use' ? 'after_hours_use' : e.type;
    const text = render(alertType, ctx.locale, {
      plate: d.plate,
      driver: d.driver,
      speed: e.speed_kph ?? null,
      value: e.value ?? null,
      limit: e.speed_limit_kph ?? null,
      place: d.place,
      geofence: e.geofence_name ?? null,
      time: local(at, ctx.timezone).hhmm,
      extra: e.extra ?? null,
    });
    const dedupe = `${f.rule?.id ?? 'builtin'}:${e.dedupe ?? `${e.type}:${e.vehicle_id ?? e.driver_id}:${e.at}`}`;
    const ins = (
      await db.query<{ id: string }>(
        `INSERT INTO alerts (tenant_id, rule_id, alert_type, severity, title, message, data, vehicle_id, driver_id, device_id, geofence_id, job_id,
           source_type, source_id, occurred_at, lat, lng, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING id`,
        [
          e.tenant_id,
          f.rule?.id ?? null,
          alertType,
          f.severity,
          text.title,
          text.message,
          JSON.stringify(e),
          e.vehicle_id ?? null,
          e.driver_id ?? null,
          e.device_id ?? null,
          e.geofence_id ?? null,
          e.job_id ?? null,
          e.source_type ?? null,
          e.source_id ?? null,
          at,
          e.lat ?? null,
          e.lng ?? null,
          dedupe,
        ],
      )
    ).rows[0];
    if (!ins) continue;
    created++;
    await deliver(ins.id, e, f.rule, f.severity, text);
  }
  return created;
}

interface Recipient {
  userId: string | null;
  phone: string | null;
  email: string | null;
  locale: Locale;
}

async function recipients(tenantId: string, rule: Rule | null): Promise<Recipient[]> {
  const specs = rule?.recipients.length
    ? rule.recipients
    : [{ role: 'company_admin' }, { role: 'fleet_manager' }].map((r) => ({
        user_id: null,
        phone: null,
        email: null,
        ...r,
      }));
  const ids = specs.filter((s) => s.user_id).map((s) => s.user_id!);
  const roles = specs.filter((s) => s.role).map((s) => s.role!);
  const users = (
    await db.query<{ id: string; phone: string | null; email: string; locale: Locale }>(
      `SELECT id, phone, email, locale FROM users WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL AND (id = ANY($2::uuid[]) OR role = ANY($3::text[]))`,
      [tenantId, ids, roles],
    )
  ).rows;
  const out: Recipient[] = users.map((u) => ({
    userId: u.id,
    phone: u.phone,
    email: u.email,
    locale: u.locale,
  }));
  for (const s of specs) {
    if (s.phone) out.push({ userId: null, phone: s.phone, email: null, locale: 'en' });
    if (s.email) out.push({ userId: null, phone: null, email: s.email, locale: 'en' });
  }
  return out;
}

async function deliver(
  alertId: string,
  e: VehicleEvent,
  rule: Rule | null,
  severity: string,
  text: { title: string; message: string },
): Promise<void> {
  const channels = rule?.channels ?? ['in_app', 'push'];
  const list = await recipients(e.tenant_id, rule);
  const queued: string[] = [];
  const add = async (channel: string, recipient: string, userId: string | null): Promise<void> => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO alert_deliveries (tenant_id, alert_id, channel, user_id, recipient) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [e.tenant_id, alertId, channel, userId, recipient],
    );
    queued.push(r.rows[0]!.id);
  };
  for (const r of list) {
    if (channels.includes('in_app') && r.userId) {
      const n = await db.query<{ id: string }>(
        `INSERT INTO notifications (tenant_id, user_id, alert_id, type, title, body, data, link) VALUES ($1,$2,$3,'alert',$4,$5,$6,$7) RETURNING id`,
        [
          e.tenant_id,
          r.userId,
          alertId,
          text.title,
          text.message,
          JSON.stringify({ alert_type: e.type, severity, vehicle_id: e.vehicle_id ?? null }),
          `/alerts/${alertId}`,
        ],
      );
      await db.query(
        `INSERT INTO alert_deliveries (tenant_id, alert_id, channel, user_id, recipient, status, sent_at, delivered_at) VALUES ($1,$2,'in_app',$3::uuid,$3::text,'delivered',now(),now())`,
        [e.tenant_id, alertId, r.userId],
      );
      await redis.publish(
        `rt:user:${r.userId}`,
        JSON.stringify({
          type: 'notification',
          id: n.rows[0]!.id,
          title: text.title,
          body: text.message,
          severity,
          alert_id: alertId,
        }),
      );
    }
    if (channels.includes('sms') && r.phone) await add('sms', r.phone, r.userId);
    if (channels.includes('email') && r.email) await add('email', r.email, r.userId);
    if (channels.includes('push') && r.userId) {
      const tokens = (
        await db.query<{ id: string }>('SELECT id FROM push_tokens WHERE user_id = $1', [r.userId])
      ).rows;
      for (const t of tokens) await add('push', t.id, r.userId);
    }
  }
  if (channels.includes('webhook')) {
    const hooks = (
      await db.query<{ id: string; events: string[] }>(
        'SELECT id, events FROM webhook_endpoints WHERE tenant_id = $1 AND is_active AND disabled_at IS NULL',
        [e.tenant_id],
      )
    ).rows;
    for (const h of hooks)
      if (!h.events.length || h.events.includes(e.type) || h.events.includes('alert'))
        await add('webhook', h.id, null);
  }
  for (const id of queued)
    await notifyQueue.add('deliver', { delivery_id: id }, { jobId: `d-${id}` });
  await redis.publish(
    `rt:tenant:${e.tenant_id}`,
    JSON.stringify({
      type: 'alert',
      id: alertId,
      alert_type: e.type,
      severity,
      title: text.title,
      message: text.message,
      vehicle_id: e.vehicle_id ?? null,
      lat: e.lat ?? null,
      lng: e.lng ?? null,
      occurred_at: e.at,
    }),
  );
}

/** BullMQ processor: sends one delivery and records the outcome. Throws to retry transient failures. */
async function processDelivery(deliveryId: string): Promise<void> {
  const d = (
    await db.query<{
      id: string;
      channel: string;
      recipient: string;
      status: string;
      title: string;
      message: string;
      alert_type: string;
      alert_id: string;
      data: Record<string, unknown>;
      severity: string;
      tenant_id: string;
    }>(
      `SELECT ad.id, ad.channel, ad.recipient, ad.status, a.title, a.message, a.alert_type, a.id AS alert_id, a.data, a.severity, a.tenant_id
       FROM alert_deliveries ad JOIN alerts a ON a.id = ad.alert_id WHERE ad.id = $1`,
      [deliveryId],
    )
  ).rows[0];
  if (!d || d.status === 'sent' || d.status === 'delivered') return;
  await db.query('UPDATE alert_deliveries SET attempts = attempts + 1 WHERE id = $1', [deliveryId]);
  let result;
  try {
    if (d.channel === 'sms') result = await sendSms(d.recipient, `${d.title}\n${d.message}`);
    else if (d.channel === 'email') {
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="color:${d.severity === 'critical' ? '#b91c1c' : '#1d4ed8'}">${escapeHtml(d.title)}</h2>
        <p>${escapeHtml(d.message)}</p><p><a href="${config.WEB_APP_URL}/alerts/${d.alert_id}">Open in Jatelo Fleet</a></p></div>`;
      result = await sendEmail(
        d.recipient,
        d.title,
        `${d.message}\n\n${config.WEB_APP_URL}/alerts/${d.alert_id}`,
        html,
      );
    } else if (d.channel === 'push') {
      const t = (
        await db.query<{ token: string }>('SELECT token FROM push_tokens WHERE id = $1', [
          d.recipient,
        ])
      ).rows[0];
      if (!t) result = { status: 'skipped' as const, provider: 'fcm', error: 'token removed' };
      else {
        result = await sendPush(t.token, d.title, d.message, {
          alert_id: d.alert_id,
          alert_type: d.alert_type,
          severity: d.severity,
        });
        if (result.error === 'invalid_token')
          await db.query('DELETE FROM push_tokens WHERE id = $1', [d.recipient]);
      }
    } else if (d.channel === 'webhook') {
      const h = (
        await db.query<{ url: string; secret_enc: string }>(
          'SELECT url, secret_enc FROM webhook_endpoints WHERE id = $1',
          [d.recipient],
        )
      ).rows[0];
      if (!h)
        result = { status: 'skipped' as const, provider: 'webhook', error: 'endpoint removed' };
      else {
        result = await sendWebhook(h.url, h.secret_enc, `alert.${d.alert_type}`, {
          alert_id: d.alert_id,
          severity: d.severity,
          title: d.title,
          message: d.message,
          ...d.data,
        });
        await db.query(
          `UPDATE webhook_endpoints SET last_status = $2, failure_count = CASE WHEN $3 THEN 0 ELSE failure_count + 1 END,
            disabled_at = CASE WHEN NOT $3 AND failure_count + 1 >= 20 THEN now() ELSE disabled_at END WHERE id = $1`,
          [d.recipient, result.httpStatus ?? null, result.status === 'sent'],
        );
        if (result.status === 'failed') throw new Error(result.error);
      }
    } else return;
  } catch (err) {
    await db.query(`UPDATE alert_deliveries SET status = 'failed', error = $2 WHERE id = $1`, [
      deliveryId,
      err instanceof Error ? err.message : String(err),
    ]);
    throw err;
  }
  await db.query(
    `UPDATE alert_deliveries SET status = $2, provider = $3, provider_message_id = $4, cost = $5, cost_currency = $6, error = $7,
       sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
    [
      deliveryId,
      result.status,
      result.provider,
      result.providerMessageId ?? null,
      result.cost ?? null,
      result.costCurrency ?? null,
      result.error ?? null,
    ],
  );
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const alertStats = { events: 0, alerts: 0, failures: 0 };

/** Consumes vehicle_events and runs the delivery queue until aborted. */
export async function runAlertEngine(signal: AbortSignal): Promise<{ close(): Promise<void> }> {
  try {
    await redis.xgroup('CREATE', EVENTS_STREAM, ALERT_GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
  const worker = new Worker(
    'notify',
    async (job) => processDelivery((job.data as { delivery_id: string }).delivery_id),
    {
      connection: bullConnection,
      concurrency: 10,
    },
  );
  worker.on('failed', (job, err) =>
    logger.warn({ err: err.message, job: job?.id }, 'delivery attempt failed'),
  );
  const consumer = `${config.INSTANCE_ID}-alerts`;
  const loop = (async () => {
    while (!signal.aborted) {
      try {
        const res = (await alertReader.xreadgroup(
          'GROUP',
          ALERT_GROUP,
          consumer,
          'COUNT',
          200,
          'BLOCK',
          5000,
          'STREAMS',
          EVENTS_STREAM,
          '>',
        )) as [string, [string, string[]][]][] | null;
        for (const [id, fields] of res?.[0]?.[1] ?? []) {
          try {
            const e = JSON.parse(fields[fields.indexOf('data') + 1] ?? '{}') as VehicleEvent;
            if (e.tenant_id && e.type && e.at) alertStats.alerts += await evaluate(e);
            alertStats.events++;
          } catch (err) {
            alertStats.failures++;
            logger.error({ err, id }, 'alert evaluation failed');
          }
          await redis.xack(EVENTS_STREAM, ALERT_GROUP, id);
        }
      } catch (err) {
        if (signal.aborted) break;
        logger.error({ err }, 'alert engine error - retrying in 2s');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  return {
    async close() {
      await worker.close();
      await notifyQueue.close();
      alertReader.disconnect();
      await loop;
    },
  };
}

/** Publishes an event for the alert engine from scheduled jobs (documents, services...). */
export async function publishEvent(e: VehicleEvent): Promise<void> {
  await redis.xadd(EVENTS_STREAM, 'MAXLEN', '~', '500000', '*', 'data', JSON.stringify(e));
}

/** Closes module-level queues/connections (for one-off scripts). */
export async function closeAlertResources(): Promise<void> {
  await notifyQueue.close();
  alertReader.disconnect();
}
