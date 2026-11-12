import '@jfs/db';
import { hostname } from 'node:os';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SYSTEM_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),
  WEB_APP_URL: z.string().default('http://localhost:5173'),
  SMTP_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MAIL_FROM: z.string().default('Jatelo Fleet Solutions <no-reply@jatelo-techs.com>'),
  AT_USERNAME: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  AT_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  AT_SENDER_ID: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  FCM_SERVICE_ACCOUNT_JSON: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MFA_ENCRYPTION_KEY: z.string().optional(),
  OSRM_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(10).max(2000).default(300),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
export const config = parsed.data;
export const STREAM = 'telemetry';
export const GROUP = 'telemetry-workers';
export const EVENTS_STREAM = 'vehicle_events';
export const ALERT_GROUP = 'alert-engine';
export const liveChannel = (tenantId: string): string => `live:tenant:${tenantId}`;
