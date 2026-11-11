import { describe, expect, it } from 'vitest';
import {
  TeltonikaDecoder,
  encodeCodec8E,
  encodeCodec12Command,
  encodeTeltonikaLogin,
  type TeltonikaFrame,
} from '../src/index.js';

// Example packets published in the Teltonika data-sending protocol documentation.
const LOGIN = '000F333536333037303432343431303133';
const CODEC8 =
  '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';
const CODEC8E =
  '000000000000004A8E010000016B412CEE000100000000000000000000000000000000010005000100010100010011001D00010010015E2C880002000B000000003544C87A000E000000001DD7E06A00000100002994';
const CODEC12_RESPONSE =
  '00000000000000370C01060000002F4449313A31204449323A30204449333A302041494E313A302041494E323A313639323420444F313A3020444F323A3101000066E3';
const GETINFO = '000000000000000F0C010500000007676574696E666F0100004312';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const loggedIn = (): TeltonikaDecoder => {
  const d = new TeltonikaDecoder();
  d.push(hex(LOGIN));
  return d;
};

describe('Teltonika login', () => {
  it('reads the IMEI and offers accept/reject replies', () => {
    const [f] = new TeltonikaDecoder().push(hex(LOGIN));
    expect(f).toMatchObject({ type: 'login', imei: '356307042441013' });
    if (f?.type !== 'login') throw new Error('expected login');
    expect(f.accept.toString('hex')).toBe('01');
    expect(f.reject.toString('hex')).toBe('00');
  });

  it('rejects a non-numeric IMEI as fatal', () => {
    const [f] = new TeltonikaDecoder().push(
      Buffer.concat([hex('000F'), Buffer.from('35630704244ABCD', 'ascii')]),
    );
    expect(f).toMatchObject({ type: 'invalid', fatal: true });
  });
});

describe('Teltonika AVL decoding', () => {
  it('decodes the Codec 8 documentation example', () => {
    const [f] = loggedIn().push(hex(CODEC8));
    if (f?.type !== 'records') throw new Error(`expected records, got ${JSON.stringify(f)}`);
    expect(f.codec).toBe(0x08);
    expect(f.reply.toString('hex')).toBe('00000001');
    const r = f.raw[0]!;
    expect(r.timestamp.toISOString()).toBe('2019-06-10T10:04:46.000Z');
    expect(r.priority).toBe(1);
    expect(r.eventIoId).toBe(1);
    expect(r.io.get(21)).toBe(3);
    expect(r.io.get(1)).toBe(1);
    expect(r.io.get(66)).toBe(24079);
    expect(r.io.get(241)).toBe(24602);
    expect(r.io.get(78)).toBe(0n);
    const n = f.records[0]!;
    expect(n.extVoltageMv).toBe(24079);
    expect(n.gsmSignalPct).toBe(60);
    expect(n.valid).toBe(false); // no satellites, 0/0 position
    expect(n.driverTag).toBeNull();
  });

  it('decodes the Codec 8 Extended documentation example', () => {
    const [f] = loggedIn().push(hex(CODEC8E));
    if (f?.type !== 'records') throw new Error(`expected records, got ${JSON.stringify(f)}`);
    expect(f.codec).toBe(0x8e);
    const r = f.raw[0]!;
    expect(r.timestamp.toISOString()).toBe('2019-06-10T11:36:32.000Z');
    expect(r.io.get(0x0001)).toBe(1);
    expect(r.io.get(0x0011)).toBe(0x1d);
    expect(r.io.get(0x0010)).toBe(0x015e2c88);
    expect(r.io.get(0x000b)).toBe(0x3544c87an);
    expect(r.io.get(0x000e)).toBe(0x1dd7e06an);
    expect(f.records[0]!.odometerKm).toBeCloseTo(0x015e2c88 / 1000, 3);
  });

  it('reads a Codec 12 command response', () => {
    const [f] = loggedIn().push(hex(CODEC12_RESPONSE));
    expect(f).toEqual({
      type: 'command_response',
      text: 'DI1:1 DI2:0 DI3:0 AIN1:0 AIN2:16924 DO1:0 DO2:1',
    });
  });
});

describe('Teltonika stream handling', () => {
  it('handles data split into single bytes and several frames in one chunk', () => {
    const d = new TeltonikaDecoder();
    const stream = Buffer.concat([hex(LOGIN), hex(CODEC8), hex(CODEC8E)]);
    const frames: TeltonikaFrame[] = [];
    for (const byte of stream) frames.push(...d.push(Buffer.from([byte])));
    expect(frames.map((f) => f.type)).toEqual(['login', 'records', 'records']);
    const together = new TeltonikaDecoder().push(stream);
    expect(together.map((f) => f.type)).toEqual(['login', 'records', 'records']);
  });

  it('answers a corrupted packet with 0 accepted and keeps the connection usable', () => {
    const d = loggedIn();
    const bad = hex(CODEC8);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    const frames = d.push(Buffer.concat([bad, hex(CODEC8)]));
    expect(frames[0]).toMatchObject({ type: 'invalid', reason: 'CRC mismatch', fatal: false });
    expect(frames[0]?.type === 'invalid' && frames[0].reply?.toString('hex')).toBe('00000000');
    expect(frames[1]?.type).toBe('records');
  });

  it('treats an out-of-sync stream as fatal', () => {
    const [f] = loggedIn().push(Buffer.from('ffffffffffffffff', 'hex'));
    expect(f).toMatchObject({ type: 'invalid', fatal: true });
  });
});

describe('Teltonika encoder', () => {
  it('produces the documented getinfo command bytes', () => {
    expect(encodeCodec12Command('getinfo').toString('hex').toUpperCase()).toBe(GETINFO);
  });

  it('round-trips a full record through encode and decode, with normalisation', () => {
    const at = new Date('2026-11-12T08:00:00.000Z');
    const packet = encodeCodec8E([
      {
        timestamp: at,
        priority: 1,
        lat: -0.1022,
        lng: 34.7617,
        altitude: 1140,
        angle: 90,
        satellites: 12,
        speed: 62,
        eventIoId: 253,
        io: [
          { id: 239, size: 1, value: 1 },
          { id: 240, size: 1, value: 1 },
          { id: 21, size: 1, value: 4 },
          { id: 69, size: 1, value: 1 },
          { id: 66, size: 2, value: 27450 },
          { id: 67, size: 2, value: 4100 },
          { id: 182, size: 2, value: 8 },
          { id: 253, size: 1, value: 2 },
          { id: 254, size: 2, value: 45 },
          { id: 16, size: 4, value: 184500123 },
          { id: 89, size: 1, value: 64 },
          { id: 84, size: 2, value: 1285 },
          { id: 207, size: 8, value: 0xa1b2c3d4n },
          { id: 281, size: 'x', value: Buffer.from('P0300,P0171,P0300') },
        ],
      },
    ]);
    const d = new TeltonikaDecoder();
    const frames = d.push(Buffer.concat([encodeTeltonikaLogin('350209100000001'), packet]));
    expect(frames[0]).toMatchObject({ type: 'login', imei: '350209100000001' });
    const f = frames[1];
    if (f?.type !== 'records') throw new Error('expected records');
    const n = f.records[0]!;
    expect(n.recordedAt.toISOString()).toBe(at.toISOString());
    expect(n.lat).toBe(-0.1022);
    expect(n.lng).toBe(34.7617);
    expect(n).toMatchObject({
      altitudeM: 1140,
      heading: 90,
      speedKph: 62,
      satellites: 12,
      hdop: 0.8,
      valid: true,
      ignition: true,
      movement: true,
      extVoltageMv: 27450,
      batteryVoltageMv: 4100,
      gsmSignalPct: 80,
      fuelLevelPct: 64,
      fuelLevelL: 128.5,
      driverTag: 'A1B2C3D4',
      eventCode: 'teltonika:253',
      dtcCodes: ['P0300', 'P0171'],
    });
    expect(n.odometerKm).toBeCloseTo(184500.123, 3);
    expect(n.events).toEqual([{ type: 'harsh_brake', value: 0.45 }]);
  });
});
