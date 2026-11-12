import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'jfs-ingest', instance: config.INSTANCE_ID },
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,service,instance',
          },
        }
      : undefined,
});
