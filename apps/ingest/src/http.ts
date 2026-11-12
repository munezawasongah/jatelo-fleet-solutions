import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DeviceEvent, TelemetryRecord } from '@jfs/protocols';
import { z } from 'zod';
import { STREAM } from './config.js';
import { resolveDevice } from './devices.js';
import { redis } from './infra.js';
import { logger } from './logger.js';
import { publishRecords } from './publish.js';
import { stats } from './stats.js';

const MAX_BODY = 1024 * 1024;
const PHONE_EVENTS = ['sos', 'harsh_brake', 'harsh_accel', 'harsh_corner', 'crash'] as const;

const Position = z.object({
  t: z.union([z.iso.datetime({ offset: true }), z.number().int().positive()]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speed_kph: z.number().min(0).max(400).optional(),
  heading: z.number().min(0).max(360).optional(),
  accuracy_m: z.number().min(0).max(100000).optional(),
  altitude_m: z.number().min(-500).max(10000).optional(),
  battery_pct: z.number().min(0).max(100).optional(),
  charging: z.boolean().optional(),
  ignition: z.boolean().optional(),
  event: z.enum(PHONE_EVENTS).optional(),
  event_value: z.number().optional(),
});
const Body = z.object({ positions: z.array(Position).min(1).max(500) });

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too_large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sameHash = (token: string, hash: string | null): boolean => {
  if (!hash) return false;
  const a = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function phonePositions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const identifier = String(req.headers['x-device-id'] ?? '');
  const auth = String(req.headers.authorization ?? '');
  if (!identifier || !auth.startsWith('Bearer '))
    return send(res, 401, {
      error: { code: 'unauthorized', message: 'Device id and token required' },
    });
  const r = await resolveDevice(identifier, 'http_json');
  if (!r.ok || !sameHash(auth.slice(7).trim(), r.device.tokenHash)) {
    stats.rejected++;
    return send(res, 401, {
      error: { code: 'unauthorized', message: 'Unknown device or wrong token' },
    });
  }
  const rl = `rl:phone:${r.device.id}`;
  const n = await redis.incr(rl);
  if (n === 1) await redis.expire(rl, 60);
  if (n > 60)
    return send(res, 429, {
      error: { code: 'rate_limited', message: 'Too many uploads, slow down' },
    });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(JSON.parse(await readBody(req)));
  } catch (err) {
    const msg =
      err instanceof Error && err.message === 'too_large' ? 'Body too large' : 'Invalid payload';
    return send(res, 400, {
      error: {
        code: 'invalid_payload',
        message: msg,
        ...(err instanceof z.ZodError ? { details: err.issues.slice(0, 5) } : {}),
      },
    });
  }
  const now = Date.now();
  const records: TelemetryRecord[] = body.positions
    .map((p): TelemetryRecord => {
      const at = new Date(p.t);
      const events: DeviceEvent[] = p.event
        ? [{ type: p.event, ...(p.event_value !== undefined ? { value: p.event_value } : {}) }]
        : [];
      return {
        recordedAt: at,
        lat: p.lat,
        lng: p.lng,
        altitudeM: p.altitude_m !== undefined ? Math.round(p.altitude_m) : null,
        heading: p.heading !== undefined ? Math.round(p.heading) % 360 : null,
        speedKph: p.speed_kph ?? 0,
        satellites: null,
        hdop: null,
        valid: p.accuracy_m === undefined || p.accuracy_m <= 100,
        ignition: p.ignition ?? null,
        movement: null,
        odometerKm: null,
        engineHours: null,
        fuelLevelPct: null,
        fuelLevelL: null,
        extVoltageMv: null,
        batteryVoltageMv: null,
        gsmSignalPct: null,
        driverTag: null,
        events,
        dtcCodes: [],
        eventCode: p.event ? `phone:${p.event}` : 'phone',
        io: {
          ...(p.accuracy_m !== undefined ? { accuracy_m: p.accuracy_m } : {}),
          ...(p.battery_pct !== undefined ? { battery_pct: p.battery_pct } : {}),
          ...(p.charging !== undefined ? { charging: p.charging ? 1 : 0 } : {}),
        },
      };
    })
    .filter((rec) => rec.recordedAt.getTime() <= now + 5 * 60_000)
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  await publishRecords(r.device, records);
  return send(res, 202, {
    accepted: records.length,
    rejected: body.positions.length - records.length,
  });
}

export function startHttp(port: number, connections: () => Record<string, number>): Server {
  const started = Date.now();
  let lastRecords = 0;
  let perMinute = 0;
  setInterval(() => {
    perMinute = stats.records - lastRecords;
    lastRecords = stats.records;
  }, 60_000).unref();

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    void (async () => {
      try {
        if (req.method === 'GET' && url === '/health') {
          let redisOk = true;
          let depth = 0;
          try {
            depth = await redis.xlen(STREAM);
          } catch {
            redisOk = false;
          }
          return send(res, redisOk ? 200 : 503, {
            status: redisOk ? 'ok' : 'degraded',
            uptime_s: Math.round((Date.now() - started) / 1000),
            connections: connections(),
            records_last_minute: perMinute,
            totals: stats,
            stream_depth: depth,
          });
        }
        if (req.method === 'POST' && url === '/v1/positions') return await phonePositions(req, res);
        return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
      } catch (err) {
        logger.error({ err }, 'http request failed');
        if (!res.headersSent)
          send(res, 503, { error: { code: 'service_unavailable', message: 'Try again shortly' } });
      }
    })();
  });
  server.listen(port, () => logger.info({ port }, 'HTTP (health + phone positions) listening'));
  return server;
}
