import '@jfs/db'; // loads the monorepo root .env before validation
import { z } from 'zod';

const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  APP_DATABASE_URL: pgUrl,
  SYSTEM_DATABASE_URL: pgUrl,
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// URL'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100000).default(300),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues)
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
export const isProduction = config.NODE_ENV === 'production';
