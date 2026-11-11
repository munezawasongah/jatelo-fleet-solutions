import type { Router } from 'express';
import { z } from 'zod';
import { route } from '../http/route.js';
import { appPool, systemPool } from '../infra/db.js';
import { redis } from '../infra/redis.js';
import { startedAt, version } from '../version.js';

const Liveness = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptime_s: z.number(),
  time: z.string(),
});
const Check = z.object({ ok: z.boolean(), latency_ms: z.number(), error: z.string().optional() });
const Readiness = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), Check),
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref();
    }),
  ]);
}

async function check(fn: () => Promise<unknown>): Promise<z.infer<typeof Check>> {
  const t = performance.now();
  try {
    await withTimeout(fn(), 2000);
    return { ok: true, latency_ms: Math.round(performance.now() - t) };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Math.round(performance.now() - t),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerHealthRoutes(router: Router): void {
  route(router, '', {
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Liveness probe',
    responses: { 200: { description: 'The API process is running', schema: Liveness } },
    handler: () => ({
      status: 'ok' as const,
      service: 'jatelo-fleet-api',
      version,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    }),
  });

  route(router, '', {
    method: 'get',
    path: '/health/ready',
    tags: ['Health'],
    summary: 'Readiness probe (database pools and Redis)',
    responses: {
      200: { description: 'All dependencies reachable', schema: Readiness },
      503: { description: 'At least one dependency is unreachable', schema: Readiness },
    },
    handler: async ({ res }) => {
      const [dbApp, dbSystem, cache] = await Promise.all([
        check(() => appPool.query('SELECT 1')),
        check(() => systemPool.query('SELECT 1')),
        check(() => redis.ping()),
      ]);
      const checks = { database_app: dbApp, database_system: dbSystem, redis: cache };
      const ok = Object.values(checks).every((c) => c.ok);
      res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
    },
  });
}
