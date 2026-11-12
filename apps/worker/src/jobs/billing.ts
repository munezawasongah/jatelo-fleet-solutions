import { runBillingCycle } from '@jfs/db';
import { db } from '../infra.js';
import { logger } from '../logger.js';

/** Daily: roll subscription periods, issue invoices, mark overdue, suspend long-overdue tenants, time out STK pushes. */
export async function billingCycle(): Promise<unknown> {
  const r = await runBillingCycle(db);
  if (r.invoiced || r.overdue || r.suspended) logger.info(r, 'billing cycle');
  return r;
}
