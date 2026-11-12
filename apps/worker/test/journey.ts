// Publishes a scripted night journey for KDB 202B straight onto the telemetry stream.
import { createPool } from '@jfs/db';
import { Redis } from 'ioredis';

const db = createPool(process.env.SYSTEM_DATABASE_URL!, { max: 1 });
const dev = (
  await db.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM devices WHERE identifier = '350209100000002'`,
  )
).rows[0]!;
await db.end();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

type P = [lat: number, lng: number];
const DEPOT: P = [-0.1022, 34.7617];
const EAST: P = [-0.1022, 34.8];
const WORKSHOP: P = [-0.095, 34.755];
const R = 6371.0088;
const km = (a: P, b: P): number => {
  const r = (d: number): number => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b[0] - a[0]) / 2) ** 2 +
    Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
function path(points: P[], stepKm: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    const n = Math.max(1, Math.round(km(a, b) / stepKm));
    for (let k = 0; k < n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(points[points.length - 1]!);
  return out;
}

// Start 23:00 Nairobi time yesterday so the trips fall inside the 22:00-05:00 night window.
const midnight = new Date();
midnight.setUTCHours(21, 0, 0, 0); // 00:00 EAT = 21:00 UTC previous day
if (midnight.getTime() > Date.now()) midnight.setUTCDate(midnight.getUTCDate() - 1);
let t = midnight.getTime() - 60 * 60_000;
const recs: Record<string, unknown>[] = [];
let odo = 132400;
const rec = (p: P, speed: number, ign: boolean | null, stepS: number, dKm = 0): void => {
  t += stepS * 1000;
  odo += dKm;
  recs.push({
    recordedAt: new Date(t).toISOString(),
    lat: p[0],
    lng: p[1],
    altitudeM: 1140,
    heading: 90,
    speedKph: speed,
    satellites: 11,
    hdop: 0.9,
    valid: true,
    ignition: ign,
    movement: speed > 0,
    odometerKm: null,
    engineHours: null,
    fuelLevelPct: null,
    fuelLevelL: null,
    extVoltageMv: 27600,
    batteryVoltageMv: 4100,
    gsmSignalPct: 80,
    driverTag: null,
    events: [],
    dtcCodes: [],
    eventCode: 'periodic',
    io: {},
  });
};
for (let i = 0; i < 5; i++) rec(DEPOT, 0, false, 60); // parked, ignition off
for (let i = 0; i < 8; i++) rec(DEPOT, 0, true, 60); // engine idling 7+ minutes
const drive = path([DEPOT, EAST, WORKSHOP], 0.5).slice(1);
drive.forEach((p, i) => rec(p, i >= 3 && i < 7 ? 95 : 60, true, 30)); // 4 points at 95 km/h = 90 s overspeed
rec(WORKSHOP, 0, true, 30);
rec(WORKSHOP, 0, true, 30);
for (let i = 0; i < 4; i++) rec(WORKSHOP, 0, false, 60); // ignition off 3+ minutes -> trip ends
const second = path([WORKSHOP, [-0.088, 34.755]], 0.3).slice(1);
second.forEach((p) => rec(p, 40, true, 30)); // short second trip
rec([-0.088, 34.755], 0, false, 60);

const chunks = [recs.slice(0, 13), recs.slice(13, 30), recs.slice(30)];
for (const records of chunks) {
  await redis.xadd(
    'telemetry',
    '*',
    'data',
    JSON.stringify({
      v: 1,
      kind: 'records',
      device_id: dev.id,
      tenant_id: dev.tenant_id,
      identifier: '350209100000002',
      protocol: 'teltonika',
      received_at: new Date().toISOString(),
      records,
    }),
  );
}
console.log(
  `published ${recs.length} points in ${chunks.length} messages, journey ${new Date(midnight.getTime() - 3_600_000).toISOString()} onwards`,
);
await redis.quit();
