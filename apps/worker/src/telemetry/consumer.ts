import { config, GROUP, STREAM } from '../config.js';
import { blocking, redis } from '../infra.js';
import { logger } from '../logger.js';
import { processDevice } from './processor.js';
import type { WireMessage } from './types.js';

type Entry = [id: string, fields: string[]];
const LOCK_MS = 30_000;
export const telemetryStats = { messages: 0, points: 0, dropped: 0, events: 0, failures: 0 };

async function ensureGroup(): Promise<void> {
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    logger.info({ stream: STREAM, group: GROUP }, 'consumer group created');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

async function handle(entries: Entry[]): Promise<void> {
  const byDevice = new Map<string, { tenantId: string; ids: string[]; msgs: WireMessage[] }>();
  const poison: string[] = [];
  for (const [id, fields] of entries) {
    try {
      const msg = JSON.parse(fields[fields.indexOf('data') + 1] ?? '') as WireMessage;
      if (msg.v !== 1 || !msg.device_id || !msg.tenant_id)
        throw new Error('unexpected message shape');
      const g = byDevice.get(msg.device_id) ?? { tenantId: msg.tenant_id, ids: [], msgs: [] };
      g.ids.push(id);
      g.msgs.push(msg);
      byDevice.set(msg.device_id, g);
    } catch (err) {
      logger.error({ err, id }, 'unreadable telemetry message - discarded');
      poison.push(id);
    }
  }
  if (poison.length) await redis.xack(STREAM, GROUP, ...poison);

  await Promise.all(
    [...byDevice].map(async ([deviceId, g]) => {
      const lock = `lock:dev:${deviceId}`;
      if ((await redis.set(lock, config.INSTANCE_ID, 'PX', LOCK_MS, 'NX')) !== 'OK') return; // another worker has it - retried later
      try {
        const r = await processDevice(deviceId, g.tenantId, g.msgs);
        await redis.xack(STREAM, GROUP, ...g.ids);
        telemetryStats.messages += g.ids.length;
        telemetryStats.points += r.points;
        telemetryStats.dropped += r.dropped;
        telemetryStats.events += r.events;
      } catch (err) {
        telemetryStats.failures++;
        logger.error({ err, deviceId }, 'device batch failed - will be retried');
      } finally {
        if ((await redis.get(lock)) === config.INSTANCE_ID) await redis.del(lock);
      }
    }),
  );
}

/** Reads the telemetry stream until aborted. Unacknowledged messages idle for 60 s are reclaimed (crash recovery). */
export async function runTelemetryConsumer(signal: AbortSignal): Promise<void> {
  await ensureGroup();
  let lastClaim = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() - lastClaim > 30_000) {
        lastClaim = Date.now();
        const [, claimed] = (await redis.xautoclaim(
          STREAM,
          GROUP,
          config.INSTANCE_ID,
          60_000,
          '0-0',
          'COUNT',
          config.WORKER_BATCH_SIZE,
        )) as [string, Entry[]];
        if (claimed.length) {
          logger.info({ count: claimed.length }, 'reclaimed stale messages');
          await handle(claimed.filter((e) => Array.isArray(e[1])));
        }
      }
      const res = (await blocking.xreadgroup(
        'GROUP',
        GROUP,
        config.INSTANCE_ID,
        'COUNT',
        config.WORKER_BATCH_SIZE,
        'BLOCK',
        5000,
        'STREAMS',
        STREAM,
        '>',
      )) as [string, Entry[]][] | null;
      if (res?.[0]?.[1].length) await handle(res[0][1]);
    } catch (err) {
      if (signal.aborted) break;
      logger.error({ err }, 'telemetry consumer error - retrying in 2s');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
