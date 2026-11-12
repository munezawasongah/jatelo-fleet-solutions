import { db, blocking, bullConnection, redis } from './infra.js';
import { jobNames, runJob } from './jobs/scheduler.js';

const name = process.argv[2];
if (!name) {
  console.error(`Usage: pnpm --filter @jfs/worker job <${jobNames.join('|')}>`);
  process.exit(1);
}
try {
  console.log(JSON.stringify({ job: name, result: await runJob(name) }));
} finally {
  await Promise.allSettled([db.end(), redis.quit(), bullConnection.quit()]);
  blocking.disconnect();
}
