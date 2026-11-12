import { Reader } from '../reader.js';
import type { DeviceEvent, StatusUpdate, TelemetryRecord } from '../types.js';
import { crcX25 } from './crc.js';
import { gt06Packet } from './packet.js';

export type Gt06Frame =
  | { type: 'login'; imei: string; accept: Buffer }
  | { type: 'records'; protocol: number; records: TelemetryRecord[]; reply?: Buffer }
  | { type: 'status'; protocol: number; status: StatusUpdate; reply?: Buffer }
  | { type: 'command_response'; text: string }
  | { type: 'time_request'; reply: Buffer }
  | { type: 'unknown'; protocol: number }
  | { type: 'invalid'; reason: string; fatal: boolean };

const MAX_BUFFER = 16 * 1024;
const VOLTAGE_LEVEL_PCT = [0, 10, 25, 40, 60, 80, 100];

// Alarm byte in 0x16/0x26 packets. Device-side geofence alarms (0x04/0x05) are ignored: server geofences are authoritative.
const ALARMS: Record<number, DeviceEvent['type']> = {
  0x01: 'sos',
  0x02: 'power_cut',
  0x03: 'tamper',
  0x06: 'overspeed',
  0x09: 'towing',
  0x0e: 'low_battery',
  0x13: 'tamper',
};
// Alarm bits 3-5 of the terminal information byte.
const TERMINAL_ALARMS: Record<number, DeviceEvent['type']> = {
  0b100: 'sos',
  0b011: 'low_battery',
  0b010: 'power_cut',
  0b001: 'tamper',
};

const empty = (r: Partial<TelemetryRecord>): TelemetryRecord => ({
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
  eventCode: 'gt06',
  io: {},
  ...r,
});

/** Reads date/time, satellites, lat/lng, speed and course/status (shared by 0x12, 0x22, 0x16, 0x26). */
function readGps(r: Reader): Partial<TelemetryRecord> {
  const d = r.bytes(6);
  const recordedAt = new Date(Date.UTC(2000 + d[0]!, d[1]! - 1, d[2]!, d[3]!, d[4]!, d[5]!));
  const satellites = r.u8() & 0x0f;
  const latRaw = r.u32();
  const lngRaw = r.u32();
  const speedKph = r.u8();
  const cs = r.u16();
  const round = (v: number): number => Math.round(v * 1e7) / 1e7;
  return {
    recordedAt,
    satellites,
    speedKph,
    valid: (cs & 0x1000) !== 0,
    lat: round(((cs & 0x0400) !== 0 ? 1 : -1) * (latRaw / 1_800_000)),
    lng: round(((cs & 0x0800) !== 0 ? -1 : 1) * (lngRaw / 1_800_000)),
    heading: (cs & 0x03ff) % 360,
  };
}

function terminalInfo(
  b: number,
): Pick<StatusUpdate, 'armed' | 'ignition' | 'charging' | 'engineCut'> & {
  alarm?: DeviceEvent['type'];
} {
  const alarm = TERMINAL_ALARMS[(b >> 3) & 0b111];
  return {
    armed: (b & 0x01) !== 0,
    ignition: (b & 0x02) !== 0,
    charging: (b & 0x04) !== 0,
    engineCut: (b & 0x80) !== 0,
    ...(alarm ? { alarm } : {}),
  };
}

export class Gt06Decoder {
  private buf: Buffer = Buffer.alloc(0);
  private imei: string | null = null;

  get identifier(): string | null {
    return this.imei;
  }

  push(chunk: Buffer): Gt06Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Gt06Frame[] = [];
    if (this.buf.length > MAX_BUFFER) {
      this.buf = Buffer.alloc(0);
      return [{ type: 'invalid', reason: 'buffer overflow', fatal: true }];
    }
    while (this.buf.length >= 2) {
      const start = this.buf.readUInt16BE(0);
      if (start !== 0x7878 && start !== 0x7979) {
        const next = this.findStart(1);
        out.push({ type: 'invalid', reason: 'skipped bytes before a start marker', fatal: false });
        this.buf = next < 0 ? this.buf.subarray(this.buf.length - 1) : this.buf.subarray(next);
        continue;
      }
      const long = start === 0x7979;
      const lenBytes = long ? 2 : 1;
      if (this.buf.length < 2 + lenBytes) break;
      const len = long ? this.buf.readUInt16BE(2) : this.buf.readUInt8(2);
      const total = 2 + lenBytes + len + 2;
      if (len < 5) {
        out.push({ type: 'invalid', reason: `bad length ${len}`, fatal: false });
        this.buf = this.buf.subarray(2);
        continue;
      }
      if (this.buf.length < total) break;
      if (this.buf[total - 2] !== 0x0d || this.buf[total - 1] !== 0x0a) {
        out.push({ type: 'invalid', reason: 'missing stop bytes', fatal: false });
        this.buf = this.buf.subarray(2);
        continue;
      }
      const packet = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      const body = packet.subarray(2, total - 4);
      if (crcX25(body) !== packet.readUInt16BE(total - 4)) {
        out.push({ type: 'invalid', reason: 'CRC mismatch', fatal: false });
        continue;
      }
      const protocol = packet[2 + lenBytes]!;
      const content = packet.subarray(3 + lenBytes, total - 6);
      const serial = packet.readUInt16BE(total - 6);
      try {
        const frame = this.handle(protocol, content, serial);
        out.push(frame);
        if (frame.type === 'invalid' && frame.fatal) {
          this.buf = Buffer.alloc(0);
          break;
        }
      } catch (err) {
        out.push({
          type: 'invalid',
          reason: `malformed 0x${protocol.toString(16)} packet: ${err instanceof Error ? err.message : String(err)}`,
          fatal: false,
        });
      }
    }
    return out;
  }

  private findStart(from: number): number {
    for (let i = from; i < this.buf.length - 1; i++) {
      const b = this.buf[i];
      if ((b === 0x78 || b === 0x79) && this.buf[i + 1] === b) return i;
    }
    return -1;
  }

  private handle(protocol: number, content: Buffer, serial: number): Gt06Frame {
    const ack = (): Buffer => gt06Packet(protocol, Buffer.alloc(0), serial);
    if (protocol === 0x01) {
      const imei = content.subarray(0, 8).toString('hex').replace(/^0+/, '');
      if (!/^\d{15}$/.test(imei))
        return { type: 'invalid', reason: 'IMEI is not 15 digits', fatal: true };
      this.imei = imei;
      return { type: 'login', imei, accept: ack() };
    }
    if (this.imei === null) return { type: 'invalid', reason: 'data before login', fatal: true };
    const r = new Reader(content);

    switch (protocol) {
      case 0x12: {
        const gps = readGps(r);
        return { type: 'records', protocol, records: [empty({ ...gps, eventCode: 'gt06:0x12' })] };
      }
      case 0x22: {
        const gps = readGps(r);
        r.bytes(8); // MCC 2, MNC 1, LAC 2, cell id 3
        const acc = r.u8();
        r.u8(); // data upload mode
        r.u8(); // real-time / re-upload
        const mileageM = r.remaining >= 4 ? r.u32() : null;
        return {
          type: 'records',
          protocol,
          records: [
            empty({
              ...gps,
              ignition: acc === 1,
              odometerKm: mileageM !== null ? mileageM / 1000 : null,
              eventCode: 'gt06:0x22',
            }),
          ],
        };
      }
      case 0x16:
      case 0x26: {
        const gps = readGps(r);
        r.bytes(r.u8() - 1); // LBS block (length includes itself)
        const ti = terminalInfo(r.u8());
        const voltageLevel = r.u8();
        const gsm = r.u8();
        const alarmCode = r.u8();
        const event = ALARMS[alarmCode];
        return {
          type: 'records',
          protocol,
          records: [
            empty({
              ...gps,
              ignition: ti.ignition,
              gsmSignalPct: Math.min(100, gsm * 25),
              events: event ? [{ type: event }] : [],
              eventCode: `gt06:alarm:${alarmCode.toString(16).padStart(2, '0')}`,
              io: {
                armed: ti.armed ? 1 : 0,
                charging: ti.charging ? 1 : 0,
                engine_cut: ti.engineCut ? 1 : 0,
                battery_level_pct: VOLTAGE_LEVEL_PCT[voltageLevel] ?? 0,
              },
            }),
          ],
          reply: ack(),
        };
      }
      case 0x13:
      case 0x23: {
        const ti = terminalInfo(r.u8());
        let battery: number | null = null;
        let ext: number | null = null;
        if (protocol === 0x13) battery = VOLTAGE_LEVEL_PCT[r.u8()] ?? null;
        else ext = r.u16() * 10;
        const gsm = r.u8();
        return {
          type: 'status',
          protocol,
          status: {
            receivedAt: new Date(),
            ignition: ti.ignition,
            armed: ti.armed,
            charging: ti.charging,
            engineCut: ti.engineCut,
            batteryLevelPct: battery,
            extVoltageMv: ext,
            gsmSignalPct: Math.min(100, gsm * 25),
            events: ti.alarm ? [{ type: ti.alarm }] : [],
          },
          reply: ack(),
        };
      }
      case 0x8a: {
        const n = new Date();
        const t = Buffer.from([
          n.getUTCFullYear() - 2000,
          n.getUTCMonth() + 1,
          n.getUTCDate(),
          n.getUTCHours(),
          n.getUTCMinutes(),
          n.getUTCSeconds(),
        ]);
        return { type: 'time_request', reply: gt06Packet(0x8a, t, serial) };
      }
      case 0x15: {
        const cmdLen = r.u8();
        r.u32(); // server flag
        return { type: 'command_response', text: r.bytes(cmdLen - 4).toString('ascii') };
      }
      case 0x21: {
        r.u32(); // server flag
        r.u8(); // encoding
        return { type: 'command_response', text: r.bytes(r.remaining).toString('ascii') };
      }
      case 0x94: {
        if (r.u8() !== 0x00) return { type: 'unknown', protocol };
        return {
          type: 'status',
          protocol,
          status: {
            receivedAt: new Date(),
            ignition: null,
            armed: null,
            charging: null,
            engineCut: null,
            batteryLevelPct: null,
            extVoltageMv: r.u16() * 10,
            gsmSignalPct: null,
            events: [],
          },
        };
      }
      default:
        return { type: 'unknown', protocol };
    }
  }
}
