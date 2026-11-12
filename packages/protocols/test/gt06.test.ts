import { describe, expect, it } from 'vitest';
import {
  Gt06Decoder,
  encodeGt06Alarm,
  encodeGt06Command,
  encodeGt06Heartbeat,
  encodeGt06Location,
  encodeGt06Login,
  gt06Packet,
  type Gt06Frame,
} from '../src/index.js';

// Examples from the Concox GT06 communication protocol document.
const DOC_LOGIN = '78780D01012345678901234500018CDD0D0A';
const DOC_LOGIN_REPLY = '787805010001D9DC0D0A';
const DOC_GPS = '78781F120B081D112E10CF027AC7EB0C46584900148F01CC00287D001FB8000380810D0A';
const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const loggedIn = (): Gt06Decoder => {
  const d = new Gt06Decoder();
  d.push(encodeGt06Login('862710030000001'));
  return d;
};

describe('GT06 documentation vectors', () => {
  it('decodes the login packet and produces the documented reply', () => {
    const [f] = new Gt06Decoder().push(hex(DOC_LOGIN));
    if (f?.type !== 'login') throw new Error(JSON.stringify(f));
    expect(f.imei).toBe('123456789012345');
    expect(f.accept.toString('hex').toUpperCase()).toBe(DOC_LOGIN_REPLY);
  });

  it('decodes the classic 0x12 GPS packet', () => {
    const d = new Gt06Decoder();
    const [, f] = d.push(Buffer.concat([hex(DOC_LOGIN), hex(DOC_GPS)]));
    if (f?.type !== 'records') throw new Error(JSON.stringify(f));
    const r = f.records[0]!;
    expect(r.recordedAt.toISOString()).toBe('2011-08-29T17:46:16.000Z');
    expect(r.satellites).toBe(15);
    expect(r.lat).toBeCloseTo(23.1116683, 6);
    expect(r.lng).toBeCloseTo(114.409285, 6);
    expect(r).toMatchObject({ speedKph: 0, heading: 143, valid: true });
    expect(f.reply).toBeUndefined();
  });
});

describe('GT06 round trips', () => {
  it('encodes and decodes a 0x22 position in the southern/eastern hemisphere with ACC and mileage', () => {
    const at = new Date('2026-11-12T05:30:00.000Z');
    const [f] = loggedIn().push(
      encodeGt06Location(
        {
          timestamp: at,
          lat: -6.846,
          lng: 39.283,
          speedKph: 47,
          course: 215,
          satellites: 9,
          acc: true,
          mileageM: 287500400,
        },
        7,
      ),
    );
    if (f?.type !== 'records') throw new Error(JSON.stringify(f));
    const r = f.records[0]!;
    expect(r.recordedAt.toISOString()).toBe(at.toISOString());
    expect(r.lat).toBeCloseTo(-6.846, 6);
    expect(r.lng).toBeCloseTo(39.283, 6);
    expect(r).toMatchObject({
      speedKph: 47,
      heading: 215,
      satellites: 9,
      valid: true,
      ignition: true,
      eventCode: 'gt06:0x22',
    });
    expect(r.odometerKm).toBeCloseTo(287500.4, 3);
  });

  it('turns a heartbeat into a status update and acknowledges it', () => {
    const [f] = loggedIn().push(
      encodeGt06Heartbeat({ acc: true, armed: false, charging: true, voltageLevel: 4, gsm: 4 }, 9),
    );
    if (f?.type !== 'status') throw new Error(JSON.stringify(f));
    expect(f.status).toMatchObject({
      ignition: true,
      armed: false,
      charging: true,
      engineCut: false,
      batteryLevelPct: 60,
      gsmSignalPct: 100,
      events: [],
    });
    expect(f.reply?.toString('hex')).toMatch(/^78780513/);
  });

  it('turns an SOS alarm packet into an sos event with position, and acknowledges it', () => {
    const [f] = loggedIn().push(
      encodeGt06Alarm(
        {
          timestamp: new Date('2026-11-12T06:00:00Z'),
          lat: -1.2921,
          lng: 36.8219,
          speedKph: 0,
          acc: false,
          alarm: 0x01,
        },
        11,
      ),
    );
    if (f?.type !== 'records') throw new Error(JSON.stringify(f));
    expect(f.records[0]!.events).toEqual([{ type: 'sos' }]);
    expect(f.records[0]!.eventCode).toBe('gt06:alarm:01');
    expect(f.reply?.toString('hex')).toMatch(/^78780516/);
  });

  it('reads a command reply and answers a time request', () => {
    const cmd = encodeGt06Command('RELAY,1#', 20);
    expect(cmd[3]).toBe(0x80);
    const replyText = Buffer.from('RELAY=1:Success!', 'ascii');
    const response = gt06Packet(
      0x15,
      Buffer.concat([
        Buffer.from([4 + replyText.length]),
        Buffer.alloc(4),
        replyText,
        Buffer.from([0x00, 0x02]),
      ]),
      21,
    );
    const d = loggedIn();
    const [f] = d.push(response);
    expect(f).toEqual({ type: 'command_response', text: 'RELAY=1:Success!' });
    const [t] = d.push(gt06Packet(0x8a, Buffer.alloc(0), 22));
    if (t?.type !== 'time_request') throw new Error(JSON.stringify(t));
    expect(t.reply[3]).toBe(0x8a);
    expect(t.reply[4]).toBe(new Date().getUTCFullYear() - 2000);
  });
});

describe('GT06 stream handling', () => {
  it('rejects data before login as fatal', () => {
    const [f] = new Gt06Decoder().push(hex(DOC_GPS));
    expect(f).toMatchObject({ type: 'invalid', fatal: true });
  });

  it('skips garbage, survives a bad CRC, and handles single-byte delivery', () => {
    const bad = encodeGt06Location({ timestamp: new Date(), lat: 1, lng: 1, acc: false }, 3);
    bad[bad.length - 3] = bad[bad.length - 3]! ^ 0xff;
    const good = encodeGt06Location({ timestamp: new Date(), lat: -0.1, lng: 34.7, acc: true }, 4);
    const stream = Buffer.concat([
      Buffer.from('deadbeef', 'hex'),
      encodeGt06Login('862710030000001'),
      bad,
      good,
    ]);
    const frames: Gt06Frame[] = [];
    const d = new Gt06Decoder();
    for (const byte of stream) frames.push(...d.push(Buffer.from([byte])));
    const kinds = frames.map((f) => (f.type === 'invalid' ? `invalid:${f.reason}` : f.type));
    expect(kinds.filter((k) => k.startsWith('invalid:skipped')).length).toBeGreaterThan(0);
    expect(kinds).toContain('login');
    expect(kinds).toContain('invalid:CRC mismatch');
    expect(kinds[kinds.length - 1]).toBe('records');
  });
});
