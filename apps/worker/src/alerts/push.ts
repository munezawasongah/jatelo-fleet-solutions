import { config } from '../config.js';
import { db, redis } from '../infra.js';
import { logger } from '../logger.js';
import { sendPush } from './channels.js';

/** Direct push notifications requested by the API (new message, job dispatched) via the `push` stream. */
const STREAM = 'push';
const GROUP = 'push-senders';

export async function runPushConsumer(signal: AbortSignal): Promise<{ close(): Promise<void> }> {
  const reader = redis.duplicate({ connectionName: 'jfs-worker-push' });
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
  const consumer = `${config.INSTANCE_ID}-push`;
  const loop = (async () => {
    while (!signal.aborted) {
      try {
        const res = (await reader.xreadgroup('GROUP', GROUP, consumer, 'COUNT', 100, 'BLOCK', 5000, 'STREAMS', STREAM, '>')) as
          | [string, [string, string[]][]][]
          | null;
        for (const [id, fields] of res?.[0]?.[1] ?? []) {
          try {
            const m = JSON.parse(fields[fields.indexOf('data') + 1] ?? '{}') as {
              user_id: string;
              title: string;
              body: string;
              data?: Record<string, string>;
            };
            const tokens = (await db.query<{ id: string; token: string }>('SELECT id, token FROM push_tokens WHERE user_id = $1', [m.user_id])).rows;
            for (const t of tokens) {
              const r = await sendPush(t.token, m.title, m.body, m.data ?? {});
              if (r.error === 'invalid_token') await db.query('DELETE FROM push_tokens WHERE id = $1', [t.id]);
            }
          } catch (err) {
            logger.warn({ err, id }, 'direct push failed');
          }
          await redis.xack(STREAM, GROUP, id);
        }
      } catch (err) {
        if (signal.aborted) break;
        logger.error({ err }, 'push consumer error - retrying in 2s');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  return {
    async close() {
      reader.disconnect();
      await loop.catch(() => undefined);
    },
  };
}
