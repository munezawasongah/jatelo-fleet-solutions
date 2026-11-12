import { describe, expect, it } from 'vitest';
import {
  QueclinkDecoder,
  encodeQueclinkHeartbeat,
  encodeQueclinkReport,
  type QueclinkFrame,
} from '../src/index.js';

const IMEI = '860599000000448';
const at = (s: string): Date => new Date(s);

describe('Queclink fixed reports', () => {
  it('decodes a GV300 GTFRI with mileage, hour meter, voltage and device state, and acknowledges it', () => {
    const msg =
      '+RESP:GTFRI,300400,860599000000448,GV300,24180,10,1,1,42.0,215,1140.0,34.761700,-0.102200,20261112080000,' +
      '0639,0002,0001,0001,00,184512.3,03215:20:11,,,98,220000,,,,20261112080002,0A1F$';
    const d = new QueclinkDecoder();
    const [f] = d.push(Buffer.from(msg, 'latin1'));
    if (f?.type !== 'records') throw new Error(JSON.stringify(f));
    expect(d.identifier).toBe(IMEI);
    expect(f.reply?.toString()).toBe('+SACK:0A1F$');
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      lat: -0.1022,
      lng: 34.7617,
      speedKph: 42,
      heading: 215,
      altitudeM: 1140,
      valid: true,
      hdop: 1,
      odometerKm: 184512.3,
      extVoltageMv: 24180,
      ignition: true,
      movement: true,
      eventCode: 'queclink:GTFRI',
    });
    expect(f.records[0]!.engineHours).toBeCloseTo(3215.336, 3);
    expect(f.records[0]!.recordedAt.toISOString()).toBe('2026-11-12T08:00:00.000Z');
  });

  it('decodes a multi-position buffered report delivered in pieces', () => {
    const msg = encodeQueclinkReport({
      message: 'GTFRI',
      imei: IMEI,
      buffered: true,
      extVoltageMv: 12650,
      fixes: [
        { lat: -1.308, lng: 36.851, speedKph: 0, time: at('2026-11-12T06:00:00Z') },
        { lat: -1.3, lng: 36.86, speedKph: 35.5, azimuth: 45, time: at('2026-11-12T06:00:30Z') },
      ],
      mileageKm: 88200.4,
      hourMeter: '01960:00:00',
      deviceStatus: '220000',
      sendTime: at('2026-11-12T09:00:00Z'),
      count: 33,
    });
    const d = new QueclinkDecoder();
    const frames: QueclinkFrame[] = [];
    for (let i = 0; i < msg.length; i += 7) frames.push(...d.push(msg.subarray(i, i + 7)));
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    if (f.type !== 'records') throw new Error(JSON.stringify(f));
    expect(f.records.map((r) => [r.lat, r.lng, r.speedKph])).toEqual([
      [-1.308, 36.851, 0],
      [-1.3, 36.86, 35.5],
    ]);
    expect(f.records[1]!.io.buffered).toBe(1);
    expect(f.reply?.toString()).toBe('+SACK:0021$');
  });

  it('marks a fix with accuracy 0 as invalid', () => {
    const [f] = new QueclinkDecoder().push(
      encodeQueclinkReport({
        message: 'GTFRI',
        imei: IMEI,
        fixes: [{ accuracy: 0, lat: -0.1, lng: 34.7, time: at('2026-11-12T06:00:00Z') }],
        sendTime: at('2026-11-12T06:00:05Z'),
        count: 1,
      }),
    );
    if (f?.type !== 'records') throw new Error(JSON.stringify(f));
    expect(f.records[0]!.valid).toBe(false);
  });
});

describe('Queclink events', () => {
  const event = (
    message: string,
    extra: Partial<Parameters<typeof encodeQueclinkReport>[0]> = {},
  ): QueclinkFrame =>
    new QueclinkDecoder().push(
      encodeQueclinkReport({
        message,
        imei: IMEI,
        fixes: [{ lat: -0.1, lng: 34.7, speedKph: 96, time: at('2026-11-12T07:00:00Z') }],
        sendTime: at('2026-11-12T07:00:01Z'),
        count: 5,
        ...extra,
      }),
    )[0]!;

  it('maps SOS, crash, tow, power cut and overspeed', () => {
    const types = ['GTSOS', 'GTCRA', 'GTTOW', 'GTMPF', 'GTSPD'].map((m) => {
      const f = event(m);
      return f.type === 'records' ? f.records[0]!.events : [];
    });
    expect(types).toEqual([
      [{ type: 'sos' }],
      [{ type: 'crash' }],
      [{ type: 'towing' }],
      [{ type: 'power_cut' }],
      [{ type: 'overspeed', value: 96 }],
    ]);
  });

  it('maps harsh behaviour by report type', () => {
    const f = event('GTHBM', { reportType: '10' });
    expect(f.type === 'records' && f.records[0]!.events).toEqual([{ type: 'harsh_brake' }]);
    const g = event('GTHBM', { reportType: '11' });
    expect(g.type === 'records' && g.records[0]!.events).toEqual([{ type: 'harsh_accel' }]);
  });

  it('turns an ignition-off report without a fix into a status update', () => {
    const msg = '+RESP:GTIGF,300400,860599000000448,GV300,,,,,,,,,,,,,,,20261112180000,0042$';
    const [f] = new QueclinkDecoder().push(Buffer.from(msg, 'latin1'));
    if (f?.type !== 'status') throw new Error(JSON.stringify(f));
    expect(f.status.ignition).toBe(false);
    expect(f.reply?.toString()).toBe('+SACK:0042$');
  });
});

describe('Queclink session handling', () => {
  it('answers heartbeats with SACK:GTHBD and reports command acknowledgements', () => {
    const d = new QueclinkDecoder();
    const frames = d.push(
      Buffer.concat([
        encodeQueclinkHeartbeat(IMEI, at('2026-11-12T07:00:00Z'), 0x21),
        Buffer.from('+ACK:GTOUT,300400,860599000000448,GV300,0001,20261112070001,0022$', 'latin1'),
      ]),
    );
    expect(frames[0]).toMatchObject({ type: 'heartbeat', imei: IMEI });
    expect(frames[0]?.type === 'heartbeat' && frames[0].reply.toString()).toBe(
      '+SACK:GTHBD,300400,0021$',
    );
    expect(frames[1]).toMatchObject({ type: 'command_ack', message: 'GTOUT' });
  });

  it('drops a connection whose IMEI changes, and runaway data without a terminator', () => {
    const d = new QueclinkDecoder();
    d.push(encodeQueclinkHeartbeat(IMEI, new Date(), 1));
    const [f] = d.push(encodeQueclinkHeartbeat('860599000000999', new Date(), 2));
    expect(f).toMatchObject({ type: 'invalid', fatal: true });
    const [g] = new QueclinkDecoder().push(Buffer.alloc(9000, 0x41));
    expect(g).toMatchObject({ type: 'invalid', fatal: true });
  });
});
