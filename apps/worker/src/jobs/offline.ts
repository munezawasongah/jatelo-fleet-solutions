import { EVENTS_STREAM, liveChannel } from '../config.js';
import { db, redis } from '../infra.js';
import { logger } from '../logger.js';
import { patchState } from '../telemetry/state.js';

/** Marks devices offline once silent beyond their company's threshold, and publishes the change. */
export async function detectOffline(): Promise<number> {
  const { rows } = await db.query<{
    device_id: string;
    vehicle_id: string | null;
    tenant_id: string;
    lat: number | null;
    lng: number | null;
    last_seen_at: Date;
  }>(
    `UPDATE device_status ds SET state = 'offline', state_since = ds.last_seen_at, updated_at = now()
     FROM tenant_settings ts
     WHERE ts.tenant_id = ds.tenant_id AND ds.state NOT IN ('offline', 'never')
       AND ds.last_seen_at < now() - make_interval(mins => ts.offline_threshold_minutes)
     RETURNING ds.device_id, ds.vehicle_id, ds.tenant_id, ds.lat, ds.lng, ds.last_seen_at`,
  );
  for (const r of rows) {
    await patchState(r.device_id, { state: 'offline', stateSince: r.last_seen_at.getTime() });
    await redis.publish(
      liveChannel(r.tenant_id),
      JSON.stringify({
        type: 'status',
        vehicle_id: r.vehicle_id,
        device_id: r.device_id,
        state: 'offline',
        state_since: r.last_seen_at.toISOString(),
      }),
    );
    await redis.xadd(
      EVENTS_STREAM,
      'MAXLEN',
      '~',
      '500000',
      '*',
      'data',
      JSON.stringify({
        type: 'device_offline',
        tenant_id: r.tenant_id,
        vehicle_id: r.vehicle_id,
        device_id: r.device_id,
        at: new Date().toISOString(),
        lat: r.lat,
        lng: r.lng,
        last_seen_at: r.last_seen_at.toISOString(),
      }),
    );
  }
  if (rows.length) logger.info({ count: rows.length }, 'devices marked offline');
  return rows.length;
}
