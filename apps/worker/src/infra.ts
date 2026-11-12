import { createPool } from '@jfs/db';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const db = createPool(config.SYSTEM_DATABASE_URL, {
  max: 10,
  applicationName: `jfs-worker-${config.INSTANCE_ID}`,
});
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectionName: 'jfs-worker',
});
/** Dedicated connection for blocking XREADGROUP calls. */
export const blocking = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectionName: 'jfs-worker-stream',
});
/** BullMQ requires maxRetriesPerRequest = null. */
export const bullConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectionName: 'jfs-worker-bull',
});
for (const r of [redis, blocking, bullConnection])
  r.on('error', (err) => logger.error({ err }, 'redis error'));
