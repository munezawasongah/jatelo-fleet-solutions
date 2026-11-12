import '@jfs/db'; // loads the monorepo root .env before validation
import { z } from 'zod';

const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL');
const bool = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  WEB_APP_URL: z.string().url().default('http://localhost:5173'),
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
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'must be exactly 32 bytes, base64-encoded',
    ),
  SMTP_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MAIL_FROM: z.string().default('Jatelo Fleet Solutions <no-reply@jatelo-techs.com>'),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z
    .string()
    .url()
    .optional()
    .transform((v) => (v ? v : undefined)),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid bucket name'),
  S3_ACCESS_KEY_ID: z.string().min(3),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
  S3_FORCE_PATH_STYLE: bool('true'),
  S3_AUTO_CREATE_BUCKET: bool('false'),
  OSRM_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  VROOM_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MPESA_CONSUMER_SECRET: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MPESA_SHORTCODE: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MPESA_PASSKEY: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MPESA_CALLBACK_SECRET: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  MPESA_TRANSACTION_TYPE: z.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']).default('CustomerPayBillOnline'),
  INGEST_CONTROL_CHANNEL: z.string().default('ingest:cmd'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues)
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  S3_PUBLIC_ENDPOINT: parsed.data.S3_PUBLIC_ENDPOINT ?? parsed.data.S3_ENDPOINT,
};
export type Config = typeof config;
export const isProduction = config.NODE_ENV === 'production';
