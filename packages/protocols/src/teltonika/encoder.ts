import { crc16Ibm } from '../crc16.js';

/** One IO element to encode. size 'x' = variable length (Codec 8 Extended only). */
export interface EncodeIo {
  id: number;
  size: 1 | 2 | 4 | 8 | 'x';
  value: number | bigint | Buffer;
}

export interface EncodeRecord {
  timestamp: Date;
  priority?: number;
  lat: number;
  lng: number;
  altitude?: number;
  angle?: number;
  satellites?: number;
  speed?: number;
  eventIoId?: number;
  io?: EncodeIo[];
}

const u8 = (v: number): Buffer => Buffer.from([v & 0xff]);
const u16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xffff);
  return b;
};
const i16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v);
  return b;
};
const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};
const i32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};
const u64 = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(v);
  return b;
};

function value(size: 1 | 2 | 4 | 8, v: number | bigint | Buffer): Buffer {
  if (Buffer.isBuffer(v)) throw new Error('fixed-size IO values must be numbers');
  if (size === 8) return u64(typeof v === 'bigint' ? v : BigInt(v));
  const n = Number(v);
  return size === 1 ? u8(n) : size === 2 ? u16(n) : u32(n);
}

/** Wraps a data field into a TCP packet: preamble, length, data, CRC. */
export function framePacket(data: Buffer): Buffer {
  return Buffer.concat([u32(0), u32(data.length), data, u32(crc16Ibm(data))]);
}

export function encodeTeltonikaLogin(imei: string): Buffer {
  return Buffer.concat([u16(imei.length), Buffer.from(imei, 'ascii')]);
}

/** Builds a Codec 8 Extended AVL packet - used by the device simulator and tests. */
export function encodeCodec8E(records: EncodeRecord[]): Buffer {
  if (records.length < 1 || records.length > 255) throw new Error('1-255 records per packet');
  const parts: Buffer[] = [u8(0x8e), u8(records.length)];
  for (const r of records) {
    const io = r.io ?? [];
    parts.push(
      u64(BigInt(r.timestamp.getTime())),
      u8(r.priority ?? 0),
      i32(Math.round(r.lng * 1e7)),
      i32(Math.round(r.lat * 1e7)),
      i16(Math.round(r.altitude ?? 0)),
      u16(Math.round(r.angle ?? 0)),
      u8(r.satellites ?? 0),
      u16(Math.round(r.speed ?? 0)),
      u16(r.eventIoId ?? 0),
      u16(io.length),
    );
    for (const size of [1, 2, 4, 8] as const) {
      const items = io.filter((x) => x.size === size);
      parts.push(u16(items.length));
      for (const it of items) parts.push(u16(it.id), value(size, it.value));
    }
    const nx = io.filter((x) => x.size === 'x');
    parts.push(u16(nx.length));
    for (const it of nx) {
      const b = Buffer.isBuffer(it.value) ? it.value : Buffer.from(String(it.value), 'latin1');
      parts.push(u16(it.id), u16(b.length), b);
    }
  }
  parts.push(u8(records.length));
  return framePacket(Buffer.concat(parts));
}

/** Codec 12 server -> device command (e.g. "getinfo", "setdigout 1"). */
export function encodeCodec12Command(command: string): Buffer {
  const text = Buffer.from(command, 'ascii');
  return framePacket(Buffer.concat([u8(0x0c), u8(1), u8(0x05), u32(text.length), text, u8(1)]));
}
