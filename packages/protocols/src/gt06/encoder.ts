import { gt06Packet } from './packet.js';

const u16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xffff);
  return b;
};
const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};

export interface Gt06Fix {
  timestamp: Date;
  lat: number;
  lng: number;
  speedKph?: number;
  course?: number;
  satellites?: number;
  valid?: boolean;
}

function gps(f: Gt06Fix): Buffer {
  const t = f.timestamp;
  const cs =
    ((f.valid ?? true) ? 0x1000 : 0) |
    (f.lng < 0 ? 0x0800 : 0) |
    (f.lat >= 0 ? 0x0400 : 0) |
    (Math.round(f.course ?? 0) & 0x03ff);
  return Buffer.concat([
    Buffer.from([
      t.getUTCFullYear() - 2000,
      t.getUTCMonth() + 1,
      t.getUTCDate(),
      t.getUTCHours(),
      t.getUTCMinutes(),
      t.getUTCSeconds(),
    ]),
    Buffer.from([0xc0 | ((f.satellites ?? 10) & 0x0f)]),
    u32(Math.round(Math.abs(f.lat) * 1_800_000)),
    u32(Math.round(Math.abs(f.lng) * 1_800_000)),
    Buffer.from([Math.min(255, Math.round(f.speedKph ?? 0))]),
    u16(cs),
  ]);
}
// Safaricom-style LBS placeholder (MCC 639, MNC 2) - positions come from GPS, LBS is informational only.
const LBS = Buffer.from([0x02, 0x7f, 0x02, 0x00, 0x01, 0x00, 0x00, 0x01]);

export function encodeGt06Login(imei: string, serial = 1): Buffer {
  return gt06Packet(0x01, Buffer.from(`0${imei}`, 'hex'), serial);
}

export function encodeGt06Location(
  f: Gt06Fix & { acc: boolean; mileageM?: number },
  serial: number,
): Buffer {
  return gt06Packet(
    0x22,
    Buffer.concat([
      gps(f),
      LBS,
      Buffer.from([f.acc ? 1 : 0, 0x00, 0x00]),
      f.mileageM !== undefined ? u32(f.mileageM) : Buffer.alloc(0),
    ]),
    serial,
  );
}

export interface Gt06Terminal {
  acc: boolean;
  armed?: boolean;
  charging?: boolean;
  engineCut?: boolean;
  /** 0-6 */
  voltageLevel?: number;
  /** 0-4 */
  gsm?: number;
}
const terminalByte = (t: Gt06Terminal): number =>
  (t.armed ? 0x01 : 0) |
  (t.acc ? 0x02 : 0) |
  ((t.charging ?? true) ? 0x04 : 0) |
  0x40 |
  (t.engineCut ? 0x80 : 0);

export function encodeGt06Heartbeat(t: Gt06Terminal, serial: number): Buffer {
  return gt06Packet(
    0x13,
    Buffer.from([terminalByte(t), t.voltageLevel ?? 6, t.gsm ?? 4, 0x00, 0x02]),
    serial,
  );
}

export function encodeGt06Alarm(
  f: Gt06Fix & Gt06Terminal & { alarm: number },
  serial: number,
): Buffer {
  return gt06Packet(
    0x16,
    Buffer.concat([
      gps(f),
      Buffer.from([0x09]),
      LBS,
      Buffer.from([terminalByte(f), f.voltageLevel ?? 6, f.gsm ?? 4, f.alarm, 0x02]),
    ]),
    serial,
  );
}

/** Server command, e.g. engine cut "RELAY,1#" or "DYD,000000#" (model dependent). */
export function encodeGt06Command(command: string, serial: number, serverFlag = 0): Buffer {
  const text = Buffer.from(command, 'ascii');
  return gt06Packet(
    0x80,
    Buffer.concat([Buffer.from([4 + text.length]), u32(serverFlag), text]),
    serial,
  );
}
