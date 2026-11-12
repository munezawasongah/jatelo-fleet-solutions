import { Queue, Worker } from 'bullmq';
import { bullConnection } from '../infra.js';
import { logger } from '../logger.js';
import { detectOffline } from './offline.js';
import { maintainPartitions } from './partitions.js';
import { closeSilentTrips } from './trips.js';
import { buildRollups } from './rollups.js';
import { expiryReminders, serviceReminders } from './reminders.js';
import { runScheduledReports } from './reports.js';
import { deliverQueuedCommands } from './commands.js';
import { billingCycle } from './billing.js';

const JOBS: Record<string, () => Promise<unknown>> = {
  partitions: maintainPartitions,
  offline: detectOffline,
  trips: closeSilentTrips,
  rollups: () => buildRollups(1),
  'rollups-backfill': () => buildRollups(7),
  services: serviceReminders,
  expiries: expiryReminders,
  reports: runScheduledReports,
  commands: deliverQueuedCommands,
  billing: billingCycle,
};
export const jobNames = Object.keys(JOBS);

export async function runJob(name: string): Promise<unknown> {
  const fn = JOBS[name];
  if (!fn) throw new Error(`Unknown job "${name}". Available: ${jobNames.join(', ')}`);
  return fn();
}

export async function startScheduler(): Promise<{ close(): Promise<void> }> {
  const queue = new Queue('maintenance', { connection: bullConnection });
  await queue.upsertJobScheduler(
    'partitions-daily',
    { pattern: '10 0 * * *', tz: 'UTC' },
    { name: 'partitions' },
  );
  await queue.upsertJobScheduler('offline-every-minute', { every: 60_000 }, { name: 'offline' });
  await queue.upsertJobScheduler(
    'silent-trips-every-5-minutes',
    { every: 300_000 },
    { name: 'trips' },
  );
  await queue.upsertJobScheduler(
    'rollups-every-10-minutes',
    { every: 600_000 },
    { name: 'rollups' },
  );
  await queue.upsertJobScheduler(
    'rollups-nightly',
    { pattern: '40 21 * * *', tz: 'UTC' },
    { name: 'rollups-backfill' },
  );
  await queue.upsertJobScheduler(
    'service-reminders-hourly',
    { every: 3_600_000 },
    { name: 'services' },
  );
  await queue.upsertJobScheduler(
    'expiry-reminders-hourly',
    { every: 3_600_000 },
    { name: 'expiries' },
  );
  await queue.upsertJobScheduler('reports-every-minute', { every: 60_000 }, { name: 'reports' });
  await queue.upsertJobScheduler('commands-every-minute', { every: 60_000 }, { name: 'commands' });
  await queue.upsertJobScheduler('billing-hourly', { every: 3_600_000 }, { name: 'billing' });
  const worker = new Worker('maintenance', async (job) => runJob(job.name), {
    connection: bullConnection,
    concurrency: 1,
  });
  worker.on('failed', (job, err) => logger.error({ err, job: job?.name }, 'scheduled job failed'));
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
