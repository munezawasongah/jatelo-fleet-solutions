import { config } from './config.js';
import { blocking, bullConnection, db, redis } from './infra.js';
import { maintainPartitions } from './jobs/partitions.js';
import { startScheduler } from './jobs/scheduler.js';
import { logger } from './logger.js';
import { runTelemetryConsumer, telemetryStats } from './telemetry/consumer.js';

const controller = new AbortController();
logger.info({ instance: config.INSTANCE_ID }, 'worker starting');
await maintainPartitions();
const scheduler = await startScheduler();
const consumer = runTelemetryConsumer(controller.signal);

let last = { ...telemetryStats };
setInterval(() => {
  const d = Object.fromEntries(
    Object.entries(telemetryStats).map(([k, v]) => [k, v - last[k as keyof typeof last]]),
  );
  last = { ...telemetryStats };
  if (Object.values(d).some((v) => v > 0)) logger.info({ lastMinute: d }, 'telemetry throughput');
}, 60_000).unref();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker shutting down');
  setTimeout(() => process.exit(1), 15_000).unref();
  controller.abort();
  blocking.disconnect();
  await Promise.allSettled([consumer, scheduler.close()]);
  await Promise.allSettled([db.end(), redis.quit(), bullConnection.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
