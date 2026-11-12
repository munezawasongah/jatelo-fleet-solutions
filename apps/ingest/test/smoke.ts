// End-to-end smoke test: impersonates real trackers over TCP/HTTP against a running gateway.
import '@jfs/db';
import { connect, type Socket } from 'node:net';
import {
  encodeCodec8E,
  encodeGt06Heartbeat,
  encodeGt06Location,
  encodeGt06Login,
  encodeQueclinkReport,
  encodeTeltonikaLogin,
} from '@jfs/protocols';
import { Redis } from 'ioredis';

const HOST = '127.0.0.1';
const T_PORT = Number(process.env.TELTONIKA_PORT ?? 5027);
const G_PORT = Number(process.env.GT06_PORT ?? 5023);
const Q_PORT = Number(process.env.QUECLINK_PORT ?? 5004);
const H_PORT = Number(process.env.INGEST_HTTP_PORT ?? 5080);
const results: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

function client(
  port: number,
): Promise<{
  sock: Socket;
  send(b: Buffer, waitMs?: number): Promise<Buffer>;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, HOST);
    let buf = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => (buf = Buffer.concat([buf, d])));
    const closed = new Promise<void>((r) => sock.on('close', () => r()));
    sock.once('error', reject);
    sock.once('connect', () =>
      resolve({
        sock,
        closed,
        async send(b, waitMs = 600) {
          buf = Buffer.alloc(0);
          sock.write(b);
          await new Promise((r) => setTimeout(r, waitMs));
          return buf;
        },
      }),
    );
  });
}
const closedWithin = (p: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

const now = Date.now();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const startId = (await redis.xrevrange('telemetry', '+', '-', 'COUNT', 1))[0]?.[0] ?? '0-0';

// 1. Teltonika - KDA 101A tracker
{
  const c = await client(T_PORT);
  const login = await c.send(encodeTeltonikaLogin('350209100000001'));
  check('Teltonika login accepted', login.toString('hex') === '01', login.toString('hex'));
  const pkt = encodeCodec8E(
    [0, 1, 2].map((i) => ({
      timestamp: new Date(now - (3 - i) * 30_000),
      priority: 1,
      lat: -0.1022 + i * 0.001,
      lng: 34.7617 + i * 0.001,
      altitude: 1140,
      angle: 45,
      satellites: 11,
      speed: 30 + i * 5,
      eventIoId: 0,
      io: [
        { id: 239, size: 1, value: 1 },
        { id: 240, size: 1, value: 1 },
        { id: 66, size: 2, value: 27800 },
        { id: 16, size: 4, value: 184500000 + i * 250 },
      ],
    })),
  );
  const ack = await c.send(pkt);
  check(
    'Teltonika 3 records acknowledged after durable write',
    ack.toString('hex') === '00000003',
    ack.toString('hex'),
  );
  c.sock.end();
}
// 2. Unknown IMEI is rejected and disconnected
{
  const c = await client(T_PORT);
  const r = await c.send(encodeTeltonikaLogin('359999999999999'));
  check('Unknown Teltonika IMEI rejected', r.toString('hex') === '00', r.toString('hex'));
  check('Unknown device disconnected', await closedWithin(c.closed, 3000));
}
// 3. Protocol mismatch: a GT06 device connecting to the Teltonika port
{
  const c = await client(T_PORT);
  const r = await c.send(encodeTeltonikaLogin('350209100000003'));
  check('GT06 device on Teltonika port rejected', r.toString('hex') === '00', r.toString('hex'));
}
// 4. GT06 - KCZ 303C tracker
{
  const c = await client(G_PORT);
  const login = await c.send(encodeGt06Login('350209100000003', 1));
  check('GT06 login acknowledged', login.length >= 10 && login[3] === 0x01, login.toString('hex'));
  const loc = await c.send(
    encodeGt06Location(
      {
        timestamp: new Date(now - 20_000),
        lat: -1.2921,
        lng: 36.8219,
        speedKph: 42,
        course: 90,
        satellites: 9,
        acc: true,
      },
      2,
    ),
  );
  check('GT06 position sent (no reply expected)', loc.length === 0);
  const hb = await c.send(encodeGt06Heartbeat({ acc: true, voltageLevel: 5, gsm: 4 }, 3));
  check('GT06 heartbeat acknowledged', hb.length >= 10 && hb[3] === 0x13, hb.toString('hex'));
  c.sock.end();
}
// 5. Queclink - KDE 606F tracker
{
  const c = await client(Q_PORT);
  const r = await c.send(
    encodeQueclinkReport({
      message: 'GTFRI',
      imei: '350209100000006',
      extVoltageMv: 24100,
      fixes: [
        {
          lat: -1.456,
          lng: 36.985,
          speedKph: 61,
          azimuth: 120,
          altitude: 1550,
          time: new Date(now - 10_000),
        },
      ],
      mileageKm: 356100.5,
      hourMeter: '07913:20:00',
      deviceStatus: '220000',
      sendTime: new Date(now),
      count: 0x2a,
    }),
  );
  check('Queclink report acknowledged with SACK', r.toString() === '+SACK:002A$', r.toString());
  c.sock.end();
}
// 6. Phone tracker over HTTP - Bahari boda boda
const post = async (token: string, body: unknown): Promise<{ status: number; json: unknown }> => {
  const res = await fetch(`http://${HOST}:${H_PORT}/v1/positions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-id': 'APP-BAHARI-0007',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
{
  const body = {
    positions: [
      {
        t: new Date(now - 60_000).toISOString(),
        lat: -6.8161,
        lng: 39.2803,
        speed_kph: 28,
        heading: 180,
        accuracy_m: 8,
        battery_pct: 76,
      },
      { t: now - 30_000, lat: -6.8175, lng: 39.2798, speed_kph: 0, accuracy_m: 6, event: 'sos' },
    ],
  };
  const ok = await post('demo-token-APP-BAHARI-0007', body);
  check(
    'Phone positions accepted',
    ok.status === 202 && (ok.json as { accepted: number }).accepted === 2,
    JSON.stringify(ok.json),
  );
  const bad = await post('wrong-token', body);
  check('Phone with wrong token rejected', bad.status === 401, String(bad.status));
  const invalid = await post('demo-token-APP-BAHARI-0007', {
    positions: [{ t: 'yesterday', lat: 200, lng: 0 }],
  });
  check('Phone invalid payload rejected', invalid.status === 400, String(invalid.status));
}
// 7. What reached the stream
await new Promise((r) => setTimeout(r, 300));
const entries = await redis.xrange('telemetry', `(${startId}`, '+');
const msgs = entries.map(
  ([, f]) => JSON.parse(f[1]!) as { kind: string; identifier: string; records?: unknown[] },
);
const summary = msgs
  .map((m) => `${m.identifier}:${m.kind}${m.records ? `x${m.records.length}` : ''}`)
  .join(', ');
check(
  'Stream holds teltonika x3, gt06 records + status, queclink x1, phone x2',
  msgs.length === 5,
  summary,
);
const health = (await (await fetch(`http://${HOST}:${H_PORT}/health`)).json()) as {
  status: string;
  totals: unknown;
};
check('Health endpoint', health.status === 'ok', JSON.stringify(health.totals));

console.log(results.join('\n'));
console.log(
  `\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`,
);
await redis.quit();
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
