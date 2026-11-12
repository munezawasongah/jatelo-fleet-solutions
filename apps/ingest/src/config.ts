import '@jfs/db'; // loads the monorepo root .env
import { hostname } from 'node:os';
import { z } from 'zod';

const port = z.coerce.number().int().min(0).max(65535);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SYSTEM_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),
  INGEST_HTTP_PORT: port.optional(),
  PORT: port.optional(),
  TELTONIKA_PORT: port.default(5027),
  GT06_PORT: port.default(5023),
  QUECLINK_PORT: port.default(5004),
  INGEST_IDLE_TIMEOUT_S: z.coerce.number().int().min(60).max(86400).default(900),
  INGEST_MAX_CONNECTIONS: z.coerce.number().int().min(10).max(200000).default(20000),
  TELEMETRY_STREAM_MAXLEN: z.coerce.number().int().min(10000).default(2_000_000),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
const d = parsed.data;
/** 0 disables a listener. HTTP prefers INGEST_HTTP_PORT, then PORT (Railway), then 5080. */
export const config = { ...d, HTTP_PORT: d.INGEST_HTTP_PORT ?? d.PORT ?? 5080 };
export const STREAM = 'telemetry';
export const COMMAND_RESULTS_STREAM = 'device_command_results';
