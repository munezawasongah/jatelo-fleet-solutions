import { createPool } from '@jfs/db';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const db = createPool(config.SYSTEM_DATABASE_URL, {
  max: 5,
  applicationName: `jfs-ingest-${config.INSTANCE_ID}`,
});
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectionName: 'jfs-ingest',
});
export const subscriber = new Redis(config.REDIS_URL, { connectionName: 'jfs-ingest-sub' });
for (const r of [redis, subscriber]) r.on('error', (err) => logger.error({ err }, 'redis error'));
