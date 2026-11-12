import { Queue, Worker } from 'bullmq';
import { bullConnection } from '../infra.js';
import { logger } from '../logger.js';
import { detectOffline } from './offline.js';
import { maintainPartitions } from './partitions.js';

const JOBS: Record<string, () => Promise<unknown>> = {
  partitions: maintainPartitions,
  offline: detectOffline,
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
