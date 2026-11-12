import { withTransaction } from '@jfs/db';
import { config } from '../config.js';
import { db, redis } from '../infra.js';
import { logger } from '../logger.js';
import { tenantSettings } from '../telemetry/settings.js';
import { saveState } from '../telemetry/state.js';
import { endTrip, type TripCtx } from '../telemetry/trips.js';
import type { DeviceState } from '../telemetry/types.js';

const SILENT_MS = 15 * 60_000;

/** Closes trips whose vehicle went silent (e.g. parked and the tracker sleeps) so they don't stay "in progress". */
export async function closeSilentTrips(): Promise<number> {
  const { rows } = await db.query<{ device_id: string; tenant_id: string }>(
    'SELECT DISTINCT device_id, tenant_id FROM trips WHERE ended_at IS NULL AND device_id IS NOT NULL',
  );
  let closed = 0;
  for (const r of rows) {
    const lock = `lock:dev:${r.device_id}`;
    if ((await redis.set(lock, config.INSTANCE_ID, 'PX', 30_000, 'NX')) !== 'OK') continue;
    try {
      const raw = await redis.get(`wstate:${r.device_id}`);
      const state = raw ? (JSON.parse(raw) as DeviceState) : null;
      const ts = state?.trips;
      if (!state || !ts?.trip) {
        await db.query(
          `UPDATE trips SET ended_at = greatest(started_at, updated_at) WHERE device_id = $1 AND ended_at IS NULL AND updated_at < now() - interval '15 minutes'`,
          [r.device_id],
        );
        continue;
      }
      if (Date.now() - state.lastAt < SILENT_MS) continue;
      const ctx: TripCtx = {
        tenantId: r.tenant_id,
        deviceId: r.device_id,
        speedLimitKph: 0,
        cfg: await tenantSettings(r.tenant_id),
        ops: [],
        events: [],
      };
      const at = ts.stillSince ?? ts.trip.lastAt;
      endTrip(
        ctx,
        ts,
        at,
        ts.stillSince !== null ? ts.stillLat : ts.trip.endLat,
        ts.stillSince !== null ? ts.stillLng : ts.trip.endLng,
        false,
      );
      await withTransaction(db, async (c) => {
        for (const op of ctx.ops) await c.query(op.text, op.values);
      });
      await saveState(r.device_id, state);
      closed++;
    } finally {
      if ((await redis.get(lock)) === config.INSTANCE_ID) await redis.del(lock);
    }
  }
  if (closed) logger.info({ closed }, 'silent trips closed');
  return closed;
}
