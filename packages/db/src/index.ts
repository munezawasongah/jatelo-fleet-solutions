import pg from 'pg';

export { requireEnv } from './env.js';
export * from './migrator.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PoolOptions {
  max?: number;
  applicationName?: string;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'jfs',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    console.error('[db] idle client error', err);
  });
  return pool;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs fn inside a transaction scoped to one tenant. Row-Level Security policies read
 * app.tenant_id, so with the API (RLS-enforced) pool only that tenant's rows are visible.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  ctx: { userId?: string } = {},
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('withTenant: invalid tenant id');
  if (ctx.userId && !UUID_RE.test(ctx.userId)) throw new Error('withTenant: invalid user id');
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [tenantId, ctx.userId ?? ''],
    );
    return fn(client);
  });
}
