#!/usr/bin/env node
/**
 * Jatelo Fleet device simulator.
 *
 * Drives every provisioned tracker of the chosen tenant(s) along real city roads and reports over the real protocols
 * (Teltonika Codec 8E, GT06/Concox, Queclink ASCII, phone HTTP) to the ingest gateway - exactly like hardware would.
 *
 *   pnpm --filter @jfs/simulator dev -- --tenant lakeside-logistics            # live, one fix every 10 s
 *   pnpm --filter @jfs/simulator dev -- --backfill 48 --tenant all             # 48 h of history, sent as buffered data
 *   pnpm --filter @jfs/simulator dev -- --tenant all --interval 5 --overspeed 0.15 --duration 60
 *
 * Environment: DATABASE_URL or SYSTEM_DATABASE_URL (reads devices), INGEST_HOST (default 127.0.0.1), TELTONIKA_PORT 5027,
 * GT06_PORT 5023, QUECLINK_PORT 5004, INGEST_HTTP_URL (default http://127.0.0.1:5080), OSRM_URL (optional road snapping).
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import { createPool } from '@jfs/db';
import {
  encodeCodec8E,
  encodeGt06Heartbeat,
  encodeGt06Location,
  encodeGt06Login,
  encodeQueclinkHeartbeat,
  encodeQueclinkReport,
  encodeTeltonikaLogin,
  type EncodeRecord,
} from '@jfs/protocols';
import { CITY_FOR_COUNTRY, CITY_ROUTES, Path, meters, osrmPath } from './routes.js';

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const arg = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : 'true') : def;
};
if (argv.includes('--help')) {
  console.log(`jfs-sim [--tenant <slug>|all] [--interval s] [--backfill hours] [--duration minutes] [--limit n] [--overspeed 0-1] [--harsh 0-1] [--phone-tokens]`);
  process.exit(0);
}
const OPTS = {
  tenant: arg('tenant', 'all')!,
  interval: Number(arg('interval', '10')),
  backfillH: Number(arg('backfill', '0')),
  durationMin: Number(arg('duration', '0')),
  limit: Number(arg('limit', '0')),
  overspeed: Number(arg('overspeed', '0.08')),
  harsh: Number(arg('harsh', '0.02')),
  phoneTokens: arg('phone-tokens') === 'true',
  host: process.env.INGEST_HOST ?? '127.0.0.1',
  ports: { teltonika: Number(process.env.TELTONIKA_PORT ?? 5027), gt06: Number(process.env.GT06_PORT ?? 5023), queclink: Number(process.env.QUECLINK_PORT ?? 5004) },
  http: process.env.INGEST_HTTP_URL ?? 'http://127.0.0.1:5080',
  osrm: process.env.OSRM_URL,
};
const dbUrl = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Set DATABASE_URL (or SYSTEM_DATABASE_URL) so the simulator can read the provisioned trackers.');
  process.exit(1);
}

const log = (...a: unknown[]): void => console.log(new Date().toISOString().slice(11, 19), ...a);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

// ---------------------------------------------------------------- vehicle model
interface Device {
  device_id: string;
  identifier: string;
  protocol: 'teltonika' | 'gt06' | 'queclink' | 'http_json';
  plate_number: string;
  body_type: string | null;
  tank_capacity_l: string | null;
  odometer_km: string;
  country_code: string;
}

type Phase = 'parked' | 'warmup' | 'driving' | 'stop';
interface Fix {
  t: Date;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  ignition: boolean;
  moving: boolean;
  odometerM: number;
  fuelL: number;
  voltageMv: number;
  event?: 'harsh_brake' | 'harsh_accel' | 'harsh_corner';
  eventG?: number;
}

class Vehicle {
  phase: Phase = 'parked';
  phaseLeft: number;
  path: Path;
  d = 0;
  speed = 0;
  target = 50;
  cruise: number;
  stopsAt: number[] = [];
  odometerM: number;
  fuelL: number;
  tank: number;
  lPer100: number;
  heavy: boolean;
  pos: [number, number];
  heading = 0;

  constructor(public dev: Device, routes: [number, number][][]) {
    const r = pick(routes);
    this.path = new Path(Math.random() < 0.5 ? r : [...r].reverse());
    this.heavy = ['truck', 'prime_mover', 'tanker', 'bus'].includes(dev.body_type ?? '');
    this.tank = Number(dev.tank_capacity_l ?? (this.heavy ? 300 : 60));
    this.fuelL = this.tank * rnd(0.4, 0.95);
    this.lPer100 = this.heavy ? rnd(28, 38) : dev.body_type === 'motorcycle' ? 3 : rnd(9, 14);
    this.cruise = this.heavy ? rnd(45, 65) : rnd(50, 75);
    this.odometerM = Number(dev.odometer_km) * 1000;
    this.pos = this.path.at(0).pos;
    this.phaseLeft = rnd(30, 600); // stagger fleet start
  }

  private newTrip(routes: [number, number][][]): void {
    const end = this.pos;
    // continue from where we are: reverse the current path, or pick a route starting near here
    const near = routes.map((r) => [r, meters(end, r[0]!), meters(end, r[r.length - 1]!)] as const).sort((a, b) => Math.min(a[1], a[2]) - Math.min(b[1], b[2]))[0]!;
    const r = near[1] <= near[2] ? near[0] : [...near[0]].reverse();
    this.path = Math.min(near[1], near[2]) < 2000 ? new Path(r) : this.path.reversed();
    this.d = 0;
    const n = Math.floor(rnd(0, 3));
    this.stopsAt = Array.from({ length: n }, () => rnd(0.2, 0.85) * this.path.length).sort((a, b) => a - b);
  }

  /** Advances the simulation by dt seconds and returns the fix to report at time t. */
  step(dt: number, t: Date, routes: [number, number][][]): Fix {
    let event: Fix['event'];
    let eventG: number | undefined;
    this.phaseLeft -= dt;
    switch (this.phase) {
      case 'parked':
        this.speed = 0;
        if (this.phaseLeft <= 0) {
          this.phase = 'warmup';
          this.phaseLeft = rnd(40, 180);
          if (this.fuelL < this.tank * 0.25) this.fuelL = this.tank * rnd(0.85, 1); // refuelled while parked
          else if (Math.random() < 0.03) this.fuelL = Math.max(5, this.fuelL - rnd(15, 40)); // siphoned overnight
        }
        break;
      case 'warmup':
        this.fuelL -= ((this.heavy ? 2.5 : 0.8) * dt) / 3600;
        if (this.phaseLeft <= 0) {
          this.phase = 'driving';
          this.newTrip(routes);
          this.target = this.cruise;
        }
        break;
      case 'stop':
        this.speed = 0;
        if (this.phaseLeft <= 0) {
          this.phase = 'driving';
          this.target = this.cruise;
        }
        break;
      case 'driving': {
        // speed control: accelerate/brake towards the target, vary the target every few hundred metres
        if (Math.random() < 0.08) this.target = Math.random() < OPTS.overspeed ? rnd(92, 118) : this.cruise + rnd(-20, 15);
        const nextStop = this.stopsAt[0];
        const remaining = (nextStop ?? this.path.length) - this.d;
        if (remaining < 250) this.target = Math.max(8, remaining / 10);
        const diff = this.target - this.speed;
        const rate = diff > 0 ? rnd(1.5, 3.5) : rnd(2, 5); // km/h per second
        this.speed = Math.max(0, this.speed + Math.sign(diff) * Math.min(Math.abs(diff), rate * dt));
        if (Math.random() < OPTS.harsh) {
          const kind = pick(['harsh_brake', 'harsh_accel', 'harsh_corner'] as const);
          event = kind;
          eventG = rnd(0.38, 0.7);
          if (kind === 'harsh_brake') this.speed = Math.max(0, this.speed - 25);
        }
        const moved = (this.speed / 3.6) * dt;
        this.d += moved;
        this.odometerM += moved;
        this.fuelL -= (moved / 1000) * (this.lPer100 / 100) * rnd(0.9, 1.15);
        if (nextStop !== undefined && this.d >= nextStop) {
          this.stopsAt.shift();
          this.phase = 'stop';
          this.phaseLeft = rnd(180, 900);
          this.speed = 0;
        } else if (this.d >= this.path.length) {
          this.phase = 'parked';
          this.phaseLeft = rnd(300, 2400);
          this.speed = 0;
        }
        const p = this.path.at(this.d);
        this.pos = p.pos;
        this.heading = p.heading;
        break;
      }
    }
    this.fuelL = Math.max(0, this.fuelL);
    const ignition = this.phase === 'warmup' || this.phase === 'driving';
    return {
      t, lat: this.pos[0] + rnd(-0.000015, 0.000015), lng: this.pos[1] + rnd(-0.000015, 0.000015), speed: Math.round(this.speed), heading: Math.round(this.heading),
      ignition, moving: this.speed > 3, odometerM: Math.round(this.odometerM), fuelL: this.fuelL, voltageMv: ignition ? Math.round(rnd(13600, 14200)) * (this.heavy ? 2 : 1) : Math.round(rnd(12300, 12700)) * (this.heavy ? 2 : 1),
      event, eventG,
    };
  }
}

// ---------------------------------------------------------------- transports
abstract class Link {
  sock: net.Socket | null = null;
  ready = false;
  queue: Fix[] = [];
  sent = 0;
  constructor(public v: Vehicle) {}
  abstract port(): number;
  abstract hello(): Buffer;
  abstract encode(fixes: Fix[]): Buffer[];
  onData(_b: Buffer): void {}
  connect(): void {
    if (this.sock) return;
    const s = net.connect(this.port(), OPTS.host);
    this.sock = s;
    s.setNoDelay(true);
    s.on('connect', () => s.write(this.hello()));
    s.on('data', (b: Buffer) => this.onData(b));
    s.on('error', (e) => log(`${this.v.dev.plate_number}: ${e.message}`));
    s.on('close', () => {
      this.sock = null;
      this.ready = false;
      setTimeout(() => this.connect(), 5000).unref();
    });
  }
  push(f: Fix): void {
    this.queue.push(f);
    this.flush();
  }
  flush(): void {
    if (!this.ready || !this.sock || !this.queue.length) return;
    const batch = this.queue.splice(0, this.batchSize());
    for (const b of this.encode(batch)) this.sock.write(b);
    this.sent += batch.length;
  }
  batchSize(): number {
    return 1;
  }
}

class TeltonikaLink extends Link {
  inflight = false;
  port(): number { return OPTS.ports.teltonika; }
  hello(): Buffer { return encodeTeltonikaLogin(this.v.dev.identifier); }
  override batchSize(): number { return this.inflight ? 0 : 25; }
  override onData(b: Buffer): void {
    if (!this.ready && b.length >= 1 && b[0] === 0x01) {
      this.ready = true;
      this.flush();
      return;
    }
    if (b.length === 4) {
      this.inflight = false; // ack of record count
      this.flush();
    }
    // Codec 12 command (0x0C): acknowledge politely with a canned response
    if (b.length > 12 && b[8] === 0x0c) log(`${this.v.dev.plate_number}: command received`);
  }
  override flush(): void {
    if (this.inflight) return;
    const before = this.queue.length;
    super.flush();
    if (this.queue.length < before) this.inflight = true;
  }
  encode(fixes: Fix[]): Buffer[] {
    const recs: EncodeRecord[] = fixes.map((f) => ({
      timestamp: f.t, lat: f.lat, lng: f.lng, speed: f.speed, angle: f.heading, satellites: 11, altitude: 1140,
      priority: f.event ? 1 : 0,
      eventIoId: f.event ? 253 : 0,
      io: [
        { id: 239, size: 1, value: f.ignition ? 1 : 0 },
        { id: 240, size: 1, value: f.moving ? 1 : 0 },
        { id: 21, size: 1, value: 4 },
        { id: 69, size: 1, value: 1 },
        { id: 66, size: 2, value: f.voltageMv },
        { id: 182, size: 2, value: 9 },
        { id: 16, size: 4, value: f.odometerM },
        { id: 84, size: 2, value: Math.round(f.fuelL * 10) },
        ...(f.event ? [{ id: 253, size: 1 as const, value: f.event === 'harsh_accel' ? 1 : f.event === 'harsh_brake' ? 2 : 3 }, { id: 254, size: 1 as const, value: Math.round((f.eventG ?? 0.4) * 100) }] : []),
      ],
    }));
    return [encodeCodec8E(recs)];
  }
}

class Gt06Link extends Link {
  serial = 1;
  hb = 0;
  port(): number { return OPTS.ports.gt06; }
  hello(): Buffer { return encodeGt06Login(this.v.dev.identifier, this.serial++); }
  override onData(b: Buffer): void {
    if (!this.ready && b.length >= 5 && b[3] === 0x01) {
      this.ready = true;
      this.flush();
    }
  }
  override batchSize(): number { return 50; }
  encode(fixes: Fix[]): Buffer[] {
    const out = fixes.map((f) => encodeGt06Location({ timestamp: f.t, lat: f.lat, lng: f.lng, speedKph: f.speed, course: f.heading, satellites: 10, acc: f.ignition, mileageM: f.odometerM }, this.serial++ & 0xffff));
    if (++this.hb % 18 === 0) out.push(encodeGt06Heartbeat({ acc: fixes[fixes.length - 1]!.ignition, gsm: 4, voltageLevel: 6 }, this.serial++ & 0xffff));
    return out;
  }
}

class QueclinkLink extends Link {
  count = 1;
  lastIgn: boolean | null = null;
  port(): number { return OPTS.ports.queclink; }
  hello(): Buffer {
    setImmediate(() => { this.ready = true; this.flush(); });
    return encodeQueclinkHeartbeat(this.v.dev.identifier, new Date(), this.count++);
  }
  override batchSize(): number { return 50; }
  encode(fixes: Fix[]): Buffer[] {
    const out: Buffer[] = [];
    for (const f of fixes) {
      const historic = Date.now() - f.t.getTime() > 120_000;
      if (this.lastIgn !== null && this.lastIgn !== f.ignition)
        out.push(encodeQueclinkReport({ message: f.ignition ? 'GTIGN' : 'GTIGF', imei: this.v.dev.identifier, fixes: [{ lat: f.lat, lng: f.lng, time: f.t, speedKph: f.speed, azimuth: f.heading }], sendTime: f.t, count: this.count++, mileageKm: f.odometerM / 1000, buffered: historic }));
      this.lastIgn = f.ignition;
      out.push(encodeQueclinkReport({
        message: 'GTFRI', imei: this.v.dev.identifier, extVoltageMv: f.voltageMv, fixes: [{ lat: f.lat, lng: f.lng, time: f.t, speedKph: f.speed, azimuth: f.heading, accuracy: 1 }],
        mileageKm: f.odometerM / 1000, sendTime: f.t, count: this.count++, deviceStatus: f.ignition ? '220100' : '210000', buffered: historic,
      }));
    }
    return out;
  }
}

class PhoneLink extends Link {
  busy = false;
  port(): number { return 0; }
  hello(): Buffer { return Buffer.alloc(0); }
  override connect(): void { this.ready = true; }
  override batchSize(): number { return 200; }
  encode(): Buffer[] { return []; }
  override flush(): void {
    if (this.busy || !this.queue.length) return;
    const batch = this.queue.splice(0, 200);
    this.busy = true;
    fetch(`${OPTS.http}/v1/positions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': this.v.dev.identifier, authorization: `Bearer sim-${this.v.dev.identifier}` },
      body: JSON.stringify({ positions: batch.map((f) => ({ t: f.t.toISOString(), lat: f.lat, lng: f.lng, speed_kph: f.speed, heading: f.heading, ignition: f.ignition, accuracy_m: 8, battery_pct: 80, ...(f.event ? { event: f.event, event_value: f.eventG } : {}) })) }),
    })
      .then((r) => { if (!r.ok) log(`${this.v.dev.plate_number}: phone upload HTTP ${r.status}`); else this.sent += batch.length; })
      .catch((e: Error) => log(`${this.v.dev.plate_number}: ${e.message}`))
      .finally(() => { this.busy = false; if (this.queue.length) this.flush(); });
  }
}

const makeLink = (v: Vehicle): Link =>
  v.dev.protocol === 'teltonika' ? new TeltonikaLink(v) : v.dev.protocol === 'gt06' ? new Gt06Link(v) : v.dev.protocol === 'queclink' ? new QueclinkLink(v) : new PhoneLink(v);

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
  const db = createPool(dbUrl!, { max: 2 });
  const devices = (
    await db.query<Device>(
      `SELECT d.id AS device_id, d.identifier, d.protocol, v.plate_number, v.body_type, v.tank_capacity_l, v.odometer_km, t.country_code
       FROM devices d JOIN device_assignments da ON da.device_id = d.id AND da.unassigned_at IS NULL
       JOIN vehicles v ON v.id = da.vehicle_id AND v.deleted_at IS NULL JOIN tenants t ON t.id = d.tenant_id
       WHERE d.deleted_at IS NULL AND d.status = 'active' AND ($1 = 'all' OR t.slug = $1)
       ORDER BY t.slug, v.plate_number ${OPTS.limit ? `LIMIT ${Math.floor(OPTS.limit)}` : ''}`,
      [OPTS.tenant],
    )
  ).rows;
  if (OPTS.phoneTokens) {
    for (const d of devices.filter((x) => x.protocol === 'http_json'))
      await db.query('UPDATE devices SET auth_token_hash = $2 WHERE id = $1', [d.device_id, createHash('sha256').update(`sim-${d.identifier}`).digest('hex')]);
  }
  await db.end();
  if (!devices.length) {
    console.error(`No active, assigned trackers found for tenant "${OPTS.tenant}". Run the seed first (pnpm db:seed).`);
    process.exit(1);
  }
  const routes: Record<string, [number, number][][]> = {};
  for (const [city, rs] of Object.entries(CITY_ROUTES)) {
    routes[city] = [];
    for (const r of rs) routes[city]!.push((OPTS.osrm && (await osrmPath(OPTS.osrm, r))) || r);
  }
  const fleet = devices.map((d) => {
    const city = pick(CITY_FOR_COUNTRY[d.country_code] ?? ['kisumu']);
    const v = new Vehicle(d, routes[city]!);
    return { v, city, link: makeLink(v) };
  });
  log(`Simulating ${fleet.length} trackers: ${Object.entries(fleet.reduce<Record<string, number>>((a, f) => ({ ...a, [f.v.dev.protocol]: (a[f.v.dev.protocol] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  for (const f of fleet) f.link.connect();

  // history first: generate past fixes and send them as buffered data
  if (OPTS.backfillH > 0) {
    const start = Date.now() - OPTS.backfillH * 3_600_000;
    for (const f of fleet) {
      for (let t = start; t < Date.now() - OPTS.interval * 1000; t += OPTS.interval * 1000) f.link.queue.push(f.v.step(OPTS.interval, new Date(t), routes[f.city]!));
    }
    log(`Queued ${fleet.reduce((a, f) => a + f.link.queue.length, 0)} historical fixes (${OPTS.backfillH} h)`);
  }

  const tick = setInterval(() => {
    const now = new Date();
    for (const f of fleet) f.link.push(f.v.step(OPTS.interval, now, routes[f.city]!));
  }, OPTS.interval * 1000);
  const flusher = setInterval(() => { for (const f of fleet) f.link.flush(); }, 250);
  const status = setInterval(() => {
    const moving = fleet.filter((f) => f.v.phase === 'driving').length;
    const backlog = fleet.reduce((a, f) => a + f.link.queue.length, 0);
    log(`${moving}/${fleet.length} driving · sent ${fleet.reduce((a, f) => a + f.link.sent, 0)} fixes · backlog ${backlog} · connected ${fleet.filter((f) => f.link.ready).length}`);
  }, 30_000);

  const stop = (): void => {
    clearInterval(tick);
    clearInterval(flusher);
    clearInterval(status);
    for (const f of fleet) f.link.sock?.destroy();
    log('Simulator stopped');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (OPTS.durationMin > 0) setTimeout(stop, OPTS.durationMin * 60_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
