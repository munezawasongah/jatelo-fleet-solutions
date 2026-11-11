import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectionName: 'jfs-api',
});
redis.on('error', (err) => logger.error({ err }, 'redis error'));

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
