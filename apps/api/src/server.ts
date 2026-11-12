import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './infra/db.js';
import { closeRedis } from './infra/redis.js';
import { ensureBucket } from './infra/storage.js';
import { logger } from './logger.js';
import { attachRealtime } from './realtime.js';

if (config.S3_AUTO_CREATE_BUCKET) {
  ensureBucket().catch((err: unknown) => logger.error({ err }, 'could not ensure storage bucket'));
}

const server = createServer(createApp());
// Longer than the Railway/edge proxy idle timeout so the proxy closes first.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
const realtime = attachRealtime(server);

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Jatelo Fleet API listening');
});

let shuttingDown = false;
function shutdown(signal: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => {
    logger.error('forced exit after 10s');
    process.exit(1);
  }, 10_000).unref();
  void realtime.close();
  server.close((err) => {
    if (err) logger.error({ err }, 'error while closing server');
    void Promise.allSettled([closeDb(), closeRedis()]).then(() => {
      logger.info('shutdown complete');
      process.exit(code);
    });
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) =>
  logger.error({ err: reason }, 'unhandled promise rejection'),
);
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  shutdown('uncaughtException', 1);
});
