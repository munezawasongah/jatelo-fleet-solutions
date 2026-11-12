import { config } from '../config.js';
import { db, redis } from '../infra.js';
import { logger } from '../logger.js';

const RESULTS = 'device_command_results';
const GROUP = 'command-results';

/** Re-sends queued commands to trackers that are online now; expires commands older than 24 h. */
export async function deliverQueuedCommands(): Promise<{ sent: number; expired: number }> {
  const expired = await db.query(`UPDATE device_commands SET status = 'expired' WHERE status = 'queued' AND created_at < now() - interval '24 hours'`);
  const queued = (
    await db.query<{ id: string; device_id: string; payload: string }>(
      `SELECT id, device_id, payload FROM device_commands WHERE status = 'queued' ORDER BY created_at LIMIT 500`,
    )
  ).rows;
  let sent = 0;
  for (const q of queued) {
    const conn = await redis.get(`conn:${q.device_id}`);
    if (!conn) continue;
    const instance = conn.slice(0, conn.lastIndexOf(':'));
    if ((await redis.publish(`ingest:cmd:${instance}`, JSON.stringify({ command_id: q.id, device_id: q.device_id, text: q.payload }))) > 0) sent++;
  }
  return { sent, expired: expired.rowCount ?? 0 };
}

/** Tracks delivery (`ingest:cmd_status` pub/sub) and device replies (`device_command_results` stream). */
export async function runCommandTracking(signal: AbortSignal): Promise<{ close(): Promise<void> }> {
  const sub = redis.duplicate({ connectionName: 'jfs-worker-cmd-sub' });
  const reader = redis.duplicate({ connectionName: 'jfs-worker-cmd-results' });
  await sub.subscribe('ingest:cmd_status');
  sub.on('message', (_ch, msg) => {
    try {
      const m = JSON.parse(msg) as { command_id: string; sent: boolean; at: string };
      if (m.sent)
        void db.query(`UPDATE device_commands SET status = 'sent', sent_at = $2 WHERE id = $1 AND status = 'queued'`, [m.command_id, m.at]).catch((err) =>
          logger.warn({ err }, 'command status update failed'),
        );
    } catch {
      /* ignore malformed */
    }
  });
  try {
    await redis.xgroup('CREATE', RESULTS, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
  const consumer = `${config.INSTANCE_ID}-cmd`;
  const loop = (async () => {
    while (!signal.aborted) {
      try {
        const res = (await reader.xreadgroup('GROUP', GROUP, consumer, 'COUNT', 100, 'BLOCK', 5000, 'STREAMS', RESULTS, '>')) as
          | [string, [string, string[]][]][]
          | null;
        for (const [id, fields] of res?.[0]?.[1] ?? []) {
          try {
            const r = JSON.parse(fields[fields.indexOf('data') + 1] ?? '{}') as { command_id: string | null; device_id: string; tenant_id: string; text: string; at: string };
            const upd = await db.query<{ id: string; tenant_id: string; requested_by: string | null; command_type: string }>(
              `UPDATE device_commands SET status = 'acknowledged', response = $3, responded_at = $4
               WHERE id = coalesce($1::uuid, (SELECT id FROM device_commands WHERE device_id = $2 AND status IN ('sent', 'queued') ORDER BY created_at DESC LIMIT 1))
               RETURNING id, tenant_id, requested_by, command_type`,
              [r.command_id, r.device_id, r.text.slice(0, 2000), r.at],
            );
            const c = upd.rows[0];
            if (c?.requested_by)
              await redis.publish(`rt:user:${c.requested_by}`, JSON.stringify({ type: 'device_command', command_id: c.id, device_id: r.device_id, status: 'acknowledged', response: r.text.slice(0, 500) }));
          } catch (err) {
            logger.warn({ err, id }, 'command result failed');
          }
          await redis.xack(RESULTS, GROUP, id);
        }
      } catch (err) {
        if (signal.aborted) break;
        logger.error({ err }, 'command result consumer error');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  return {
    async close() {
      sub.disconnect();
      reader.disconnect();
      await loop.catch(() => undefined);
    },
  };
}
