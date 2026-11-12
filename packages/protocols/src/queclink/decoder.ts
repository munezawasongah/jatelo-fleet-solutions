import type { DeviceEvent, StatusUpdate, TelemetryRecord } from '../types.js';

export type QueclinkFrame =
  | { type: 'records'; imei: string; message: string; records: TelemetryRecord[]; reply?: Buffer }
  | { type: 'status'; imei: string; message: string; status: StatusUpdate; reply?: Buffer }
  | { type: 'heartbeat'; imei: string; reply: Buffer }
  | { type: 'command_ack'; imei: string; message: string; text: string }
  | { type: 'invalid'; reason: string; fatal: boolean };

const MAX_PENDING = 8 * 1024;
const BLOCK = 12; // accuracy, speed, azimuth, altitude, lng, lat, utc, mcc, mnc, lac, cell, reserved
const UTC = /^\d{14}$/;
const DEC = /^-?\d+(\.\d+)?$/;
const HOUR_METER = /^(\d{1,6}):(\d{2}):(\d{2})$/;
// Device status: first byte = motion state (11/12 ignition off, 21/22 ignition on, 16/1A tow, 41/42 sensor).
const STATE = /^(1[126A]|2[12]|4[12])[0-9A-F]{4}$/i;

const EVENTS: Record<string, DeviceEvent['type']> = {
  GTSOS: 'sos',
  GTSPD: 'overspeed',
  GTCRA: 'crash',
  GTTOW: 'towing',
  GTJDR: 'tamper',
  GTJDS: 'tamper',
  GTMPF: 'power_cut',
  GTBPL: 'low_battery',
};
// GTHBM report type: 0 harsh braking, 1 harsh acceleration, 2 harsh turning (firmware dependent - verify per model).
const HARSH: Record<string, DeviceEvent['type']> = {
  '0': 'harsh_brake',
  '1': 'harsh_accel',
  '2': 'harsh_corner',
};

function utcDate(s: string): Date {
  return new Date(
    Date.UTC(
      +s.slice(0, 4),
      +s.slice(4, 6) - 1,
      +s.slice(6, 8),
      +s.slice(8, 10),
      +s.slice(10, 12),
      +s.slice(12, 14),
    ),
  );
}

function isBlockAt(f: string[], i: number, sendTimeIndex: number): boolean {
  if (i + 6 >= f.length || i + 6 === sendTimeIndex) return false;
  const lng = Number(f[i + 4]);
  const lat = Number(f[i + 5]);
  return (
    UTC.test(f[i + 6]!) &&
    DEC.test(f[i + 4]!) &&
    DEC.test(f[i + 5]!) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90 &&
    /^\d{0,2}$/.test(f[i]!) &&
    (f[i + 1] === '' || DEC.test(f[i + 1]!))
  );
}

const nullRecord = (): TelemetryRecord => ({
  recordedAt: new Date(0),
  lat: 0,
  lng: 0,
  altitudeM: null,
  heading: null,
  speedKph: 0,
  satellites: null,
  hdop: null,
  valid: false,
  ignition: null,
  movement: null,
  odometerKm: null,
  engineHours: null,
  fuelLevelPct: null,
  fuelLevelL: null,
  extVoltageMv: null,
  batteryVoltageMv: null,
  gsmSignalPct: null,
  driverTag: null,
  events: [],
  dtcCodes: [],
  eventCode: '',
  io: {},
});

export class QueclinkDecoder {
  private pending = '';
  private imei: string | null = null;

  get identifier(): string | null {
    return this.imei;
  }

  push(chunk: Buffer): QueclinkFrame[] {
    this.pending += chunk.toString('latin1');
    const out: QueclinkFrame[] = [];
    let end: number;
    while ((end = this.pending.indexOf('$')) >= 0) {
      const msg = this.pending.slice(0, end).trim();
      this.pending = this.pending.slice(end + 1);
      if (!msg) continue;
      const frame = this.parse(msg);
      out.push(frame);
      if (frame.type === 'invalid' && frame.fatal) {
        this.pending = '';
        return out;
      }
    }
    if (this.pending.length > MAX_PENDING) {
      this.pending = '';
      out.push({ type: 'invalid', reason: 'message too long without terminator', fatal: true });
    }
    return out;
  }

  private parse(msg: string): QueclinkFrame {
    const start = msg.search(/\+(RESP|BUFF|ACK):GT[A-Z]{3}/);
    if (start < 0)
      return { type: 'invalid', reason: 'not a Queclink @Track message', fatal: false };
    const f = msg.slice(start).split(',');
    const [kind, message] = f[0]!.slice(1).split(':') as [string, string];
    const imei = f[2] ?? '';
    if (!/^\d{15}$/.test(imei)) return { type: 'invalid', reason: 'missing IMEI', fatal: false };
    if (this.imei && this.imei !== imei)
      return { type: 'invalid', reason: `IMEI changed from ${this.imei} to ${imei}`, fatal: true };
    this.imei = imei;
    const version = f[1] ?? '';
    const count = f[f.length - 1] ?? '';
    const sendIdx = f.length - 2;
    const sendTime = UTC.test(f[sendIdx] ?? '') ? utcDate(f[sendIdx]!) : new Date();
    const sack = /^[0-9A-F]{4}$/i.test(count)
      ? Buffer.from(`+SACK:${count}$`, 'latin1')
      : undefined;

    if (kind === 'ACK') {
      if (message === 'GTHBD')
        return {
          type: 'heartbeat',
          imei,
          reply: Buffer.from(`+SACK:GTHBD,${version},${count}$`, 'latin1'),
        };
      return { type: 'command_ack', imei, message, text: msg.slice(start) };
    }

    // ---- locate position blocks by shape
    const blocks: number[] = [];
    for (let i = 4; i < sendIdx; i++) {
      if (isBlockAt(f, i, sendIdx)) {
        blocks.push(i);
        i += BLOCK - 1;
      }
    }
    const afterBlocks = blocks.length ? blocks[blocks.length - 1]! + BLOCK : 4;
    const tail = f.slice(afterBlocks, sendIdx);

    // ---- values around the blocks
    let odometerKm: number | null = null;
    let engineHours: number | null = null;
    const hmIdx = tail.findIndex((x) => HOUR_METER.test(x));
    if (hmIdx >= 0) {
      const m = HOUR_METER.exec(tail[hmIdx]!)!;
      engineHours = Math.round((+m[1]! + +m[2]! / 60 + +m[3]! / 3600) * 1000) / 1000;
      if (hmIdx > 0 && DEC.test(tail[hmIdx - 1]!)) odometerKm = Number(tail[hmIdx - 1]);
    } else if (tail[0] && DEC.test(tail[0])) {
      odometerKm = Number(tail[0]);
    }
    const stateField = tail.find((x) => STATE.test(x));
    const motion = stateField?.slice(0, 2).toUpperCase();
    const ignition = motion
      ? motion.startsWith('2')
        ? true
        : motion.startsWith('1')
          ? false
          : null
      : null;
    const movement = motion ? motion.endsWith('2') || motion === '16' || motion === '1A' : null;
    const ext = f[4] && /^\d{3,5}$/.test(f[4]) && blocks[0] !== 4 ? Number(f[4]) : null;
    const extVoltageMv = ext !== null && ext <= 60000 ? ext : null;

    const events: DeviceEvent[] = [];
    let ignitionOverride: boolean | null = null;
    if (message === 'GTIGN') ignitionOverride = true;
    if (message === 'GTIGF') ignitionOverride = false;
    if (message === 'GTHBM' && blocks.length) {
      const t = f[blocks[0]! - 2]?.slice(-1) ?? '';
      if (HARSH[t]) events.push({ type: HARSH[t]! });
    } else if (EVENTS[message]) {
      events.push({ type: EVENTS[message]! });
    }
    let driverTag: string | null = null;
    if (message === 'GTIDA') {
      const id = f
        .slice(4, blocks[0] ?? sendIdx)
        .find((x) => /^[0-9A-F]{8,16}$/i.test(x) && !/^0+$/.test(x));
      driverTag = id ? id.replace(/^0+/, '').toUpperCase() : null;
    }
    const ign = ignitionOverride ?? ignition;
    const eventCode = `queclink:${message}`;

    if (!blocks.length) {
      return {
        type: 'status',
        imei,
        message,
        status: {
          receivedAt: sendTime,
          ignition: ign,
          armed: null,
          charging: null,
          engineCut: null,
          batteryLevelPct: null,
          extVoltageMv,
          gsmSignalPct: null,
          events,
        },
        ...(sack ? { reply: sack } : {}),
      };
    }

    const records = blocks.map((b): TelemetryRecord => {
      const accuracy = f[b] === '' ? 0 : Number(f[b]);
      const speed = Number(f[b + 1] || 0);
      const r = nullRecord();
      const rec: TelemetryRecord = {
        ...r,
        recordedAt: utcDate(f[b + 6]!),
        lng: Number(f[b + 4]),
        lat: Number(f[b + 5]),
        speedKph: Math.round(speed * 10) / 10,
        heading: f[b + 2] ? Number(f[b + 2]) % 360 : null,
        altitudeM: f[b + 3] ? Math.round(Number(f[b + 3])) : null,
        hdop: accuracy > 0 ? accuracy : null,
        valid: accuracy > 0,
        ignition: ign,
        movement,
        odometerKm,
        engineHours,
        extVoltageMv,
        driverTag,
        events: message === 'GTSPD' ? [{ type: 'overspeed', value: Math.round(speed) }] : events,
        eventCode,
        io: {
          report: message,
          ...(stateField ? { device_status: stateField.toUpperCase() } : {}),
          ...(kind === 'BUFF' ? { buffered: 1 } : {}),
        },
      };
      return rec;
    });
    return { type: 'records', imei, message, records, ...(sack ? { reply: sack } : {}) };
  }
}
