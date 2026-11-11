import { createPool } from '@jfs/db';
import { config } from '../config.js';

/** Row-Level Security enforced: always use through withTenant(). */
export const appPool = createPool(config.APP_DATABASE_URL, { max: 20, applicationName: 'jfs-api' });
/** Bypasses RLS: only for auth lookups and super-admin operations. */
export const systemPool = createPool(config.SYSTEM_DATABASE_URL, {
  max: 5,
  applicationName: 'jfs-api-system',
});

export async function closeDb(): Promise<void> {
  await Promise.allSettled([appPool.end(), systemPool.end()]);
}
