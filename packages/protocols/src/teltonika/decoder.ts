import { crc16Ibm } from '../crc16.js';
import { NeedMoreData, Reader } from '../reader.js';
import type { TelemetryRecord } from '../types.js';
import { normalizeTeltonika } from './normalize.js';

export type IoValue = number | bigint | Buffer;

export interface RawAvlRecord {
  timestamp: Date;
  priority: number;
  lng: number;
  lat: number;
  altitude: number;
  angle: number;
  satellites: number;
  speed: number;
  eventIoId: number;
  generationType?: number;
  io: Map<number, IoValue>;
}

export type TeltonikaFrame =
  | { type: 'login'; imei: string; accept: Buffer; reject: Buffer }
  | {
      type: 'records';
      codec: number;
      raw: RawAvlRecord[];
      records: TelemetryRecord[];
      reply: Buffer;
    }
  | { type: 'command_response'; text: string }
  | { type: 'invalid'; reason: string; reply?: Buffer; fatal: boolean };

const MAX_FRAME = 64 * 1024;
const CODEC8 = 0x08;
const CODEC8E = 0x8e;
const CODEC16 = 0x10;
const CODEC12 = 0x0c;

const ack = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function readValue(r: Reader, size: 1 | 2 | 4 | 8): IoValue {
  switch (size) {
    case 1:
      return r.u8();
    case 2:
      return r.u16();
    case 4:
      return r.u32();
    default:
      return r.u64();
  }
}

function decodeRecord(r: Reader, codec: number): RawAvlRecord {
  const timestamp = new Date(Number(r.u64()));
  const priority = r.u8();
  const lng = r.i32() / 1e7;
  const lat = r.i32() / 1e7;
  const altitude = r.i16();
  const angle = r.u16();
  const satellites = r.u8();
  const speed = r.u16();
  const io = new Map<number, IoValue>();
  let eventIoId: number;
  let generationType: number | undefined;

  if (codec === CODEC8) {
    eventIoId = r.u8();
    r.u8(); // total IO count
    for (const size of [1, 2, 4, 8] as const) {
      const n = r.u8();
      for (let i = 0; i < n; i++) io.set(r.u8(), readValue(r, size));
    }
  } else if (codec === CODEC8E) {
    eventIoId = r.u16();
    r.u16();
    for (const size of [1, 2, 4, 8] as const) {
      const n = r.u16();
      for (let i = 0; i < n; i++) io.set(r.u16(), readValue(r, size));
    }
    const nx = r.u16();
    for (let i = 0; i < nx; i++) {
      const id = r.u16();
      io.set(id, Buffer.from(r.bytes(r.u16())));
    }
  } else {
    eventIoId = r.u16();
    generationType = r.u8();
    r.u8();
    for (const size of [1, 2, 4, 8] as const) {
      const n = r.u8();
      for (let i = 0; i < n; i++) io.set(r.u16(), readValue(r, size));
    }
  }
  return {
    timestamp,
    priority,
    lng,
    lat,
    altitude,
    angle,
    satellites,
    speed,
    eventIoId,
    generationType,
    io,
  };
}

/** Decodes the data field (codec id ... record count) of an AVL packet. Throws on malformed content. */
export function decodeAvlData(data: Buffer): { codec: number; raw: RawAvlRecord[] } {
  const r = new Reader(data);
  const codec = r.u8();
  if (codec !== CODEC8 && codec !== CODEC8E && codec !== CODEC16)
    throw new Error(`unsupported codec 0x${codec.toString(16)}`);
  const count = r.u8();
  const raw: RawAvlRecord[] = [];
  for (let i = 0; i < count; i++) raw.push(decodeRecord(r, codec));
  const count2 = r.u8();
  if (count2 !== count) throw new Error(`record count mismatch (${count} vs ${count2})`);
  if (r.remaining !== 0) throw new Error(`${r.remaining} unexpected trailing bytes`);
  return { codec, raw };
}

/**
 * Stateful per-connection decoder for Teltonika TCP. Feed it every chunk received; it returns complete
 * frames and keeps partial data until the rest arrives.
 */
export class TeltonikaDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private imei: string | null = null;

  get identifier(): string | null {
    return this.imei;
  }

  push(chunk: Buffer): TeltonikaFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: TeltonikaFrame[] = [];
    while (this.buf.length > 0) {
      const res = this.imei === null ? this.tryLogin() : this.tryPacket();
      if (!res) break;
      out.push(res.frame);
      this.buf = this.buf.subarray(res.consumed);
      if (res.frame.type === 'invalid' && res.frame.fatal) {
        this.buf = Buffer.alloc(0);
        break;
      }
    }
    return out;
  }

  private tryLogin(): { frame: TeltonikaFrame; consumed: number } | null {
    if (this.buf.length < 2) return null;
    const len = this.buf.readUInt16BE(0);
    if (len < 10 || len > 20)
      return {
        frame: { type: 'invalid', reason: `bad IMEI length ${len}`, fatal: true },
        consumed: this.buf.length,
      };
    if (this.buf.length < 2 + len) return null;
    const imei = this.buf.subarray(2, 2 + len).toString('ascii');
    if (!/^\d{15}$/.test(imei))
      return {
        frame: { type: 'invalid', reason: 'IMEI is not 15 digits', fatal: true },
        consumed: this.buf.length,
      };
    this.imei = imei;
    return {
      frame: { type: 'login', imei, accept: Buffer.from([0x01]), reject: Buffer.from([0x00]) },
      consumed: 2 + len,
    };
  }

  private tryPacket(): { frame: TeltonikaFrame; consumed: number } | null {
    if (this.buf.length < 8) return null;
    if (this.buf.readUInt32BE(0) !== 0) {
      return {
        frame: { type: 'invalid', reason: 'missing preamble (stream out of sync)', fatal: true },
        consumed: this.buf.length,
      };
    }
    const len = this.buf.readUInt32BE(4);
    if (len < 3 || len > MAX_FRAME)
      return {
        frame: { type: 'invalid', reason: `bad data length ${len}`, fatal: true },
        consumed: this.buf.length,
      };
    const total = 8 + len + 4;
    if (this.buf.length < total) return null;
    const data = this.buf.subarray(8, 8 + len);
    const crc = this.buf.readUInt32BE(8 + len);
    if (crc16Ibm(data) !== crc) {
      return {
        frame: { type: 'invalid', reason: 'CRC mismatch', reply: ack(0), fatal: false },
        consumed: total,
      };
    }
    const codec = data[0]!;
    try {
      if (codec === CODEC12) {
        const r = new Reader(data);
        r.u8();
        r.u8();
        const kind = r.u8();
        const text = r.bytes(r.u32()).toString('utf8');
        return {
          frame:
            kind === 0x06
              ? { type: 'command_response', text }
              : { type: 'invalid', reason: 'unexpected codec 12 type', fatal: false },
          consumed: total,
        };
      }
      const { raw } = decodeAvlData(Buffer.from(data));
      return {
        frame: {
          type: 'records',
          codec,
          raw,
          records: raw.map(normalizeTeltonika),
          reply: ack(raw.length),
        },
        consumed: total,
      };
    } catch (err) {
      const reason =
        err instanceof NeedMoreData
          ? 'record extends past packet end'
          : err instanceof Error
            ? err.message
            : String(err);
      return { frame: { type: 'invalid', reason, reply: ack(0), fatal: false }, consumed: total };
    }
  }
}
