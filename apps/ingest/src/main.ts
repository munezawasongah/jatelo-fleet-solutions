import { createServer, type Server } from 'node:net';
import { config } from './config.js';
import { startHttp } from './http.js';
import { db, redis, subscriber } from './infra.js';
import { logger } from './logger.js';
import { Session, type TcpProtocol } from './session.js';

const sessions = new Set<Session>();
const byDevice = new Map<string, Session>();

const host = {
  attach(s: Session): void {
    const old = s.device ? byDevice.get(s.device.id) : undefined;
    if (old && old !== s) old.close('replaced by a newer connection');
    if (s.device) byDevice.set(s.device.id, s);
  },
  detach(s: Session): void {
    sessions.delete(s);
    if (s.device && byDevice.get(s.device.id) === s) {
      byDevice.delete(s.device.id);
      void redis
        .get(`conn:${s.device.id}`)
        .then((v) =>
          v === `${config.INSTANCE_ID}:${s.id}` ? redis.del(`conn:${s.device!.id}`) : 0,
        )
        .catch(() => undefined);
    }
  },
};

const servers: Server[] = [];
function listen(protocol: TcpProtocol, port: number): void {
  if (!port) return;
  const server = createServer((socket) => {
    if (sessions.size >= config.INGEST_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sessions.add(new Session(socket, protocol, host));
  });
  server.on('error', (err) => logger.fatal({ err, protocol, port }, 'listener failed'));
  server.listen(port, () => logger.info({ protocol, port }, 'TCP listener ready'));
  servers.push(server);
}

listen('teltonika', config.TELTONIKA_PORT);
listen('gt06', config.GT06_PORT);
listen('queclink', config.QUECLINK_PORT);

const connections = (): Record<string, number> => {
  const c: Record<string, number> = {
    total: sessions.size,
    identified: byDevice.size,
    teltonika: 0,
    gt06: 0,
    queclink: 0,
  };
  for (const s of sessions) c[s.protocol] = (c[s.protocol] ?? 0) + 1;
  return c;
};
const http = startHttp(config.HTTP_PORT, connections);

// Commands for devices connected to this instance: {"command_id","device_id","text"}
void subscriber.subscribe(`ingest:cmd:${config.INSTANCE_ID}`);
subscriber.on('message', (_channel, message) => {
  try {
    const cmd = JSON.parse(message) as { command_id: string; device_id: string; text: string };
    const session = byDevice.get(cmd.device_id);
    const sent = session?.sendCommand(cmd.command_id, cmd.text) ?? false;
    logger.info({ device: cmd.device_id, sent }, 'command delivery');
    void redis.publish(
      'ingest:cmd_status',
      JSON.stringify({ command_id: cmd.command_id, sent, at: new Date().toISOString() }),
    );
  } catch (err) {
    logger.warn({ err }, 'bad command message');
  }
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal, connections: sessions.size }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  for (const s of servers) s.close();
  http.close();
  for (const s of sessions) s.close('server shutting down');
  await Promise.allSettled([db.end(), redis.quit(), subscriber.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
