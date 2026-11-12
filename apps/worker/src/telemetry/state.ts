import { db, redis } from '../infra.js';
import type { Assignment } from './resolve.js';
import type { DeviceState, LiveState } from './types.js';
import { newTripState } from './trips.js';

const key = (deviceId: string): string => `wstate:${deviceId}`;
const TTL_S = 7 * 86400;

export async function loadState(deviceId: string, assignment: Assignment): Promise<DeviceState> {
  const raw = await redis.get(key(deviceId));
  if (raw) return JSON.parse(raw) as DeviceState;
  const trips = await recoverTrips(assignment.vehicleId);
  const s = (
    await db.query<{
      lat: number | null;
      lng: number | null;
      last_fix_at: Date | null;
      last_seen_at: Date | null;
      odometer_km: string | null;
      engine_hours: string | null;
      ignition: boolean | null;
      state: LiveState;
      state_since: Date | null;
    }>(
      'SELECT lat, lng, last_fix_at, last_seen_at, odometer_km, engine_hours, ignition, state, state_since FROM device_status WHERE device_id = $1',
      [deviceId],
    )
  ).rows[0];
  return {
    lastValid:
      s?.lat !== null && s?.lat !== undefined && s.lng !== null && s.last_fix_at
        ? { lat: s.lat, lng: s.lng, at: s.last_fix_at.getTime() }
        : null,
    lastAt: s?.last_seen_at?.getTime() ?? 0,
    odometerKm:
      s?.odometer_km !== null && s?.odometer_km !== undefined
        ? Number(s.odometer_km)
        : assignment.odometerKm,
    engineHours:
      s?.engine_hours !== null && s?.engine_hours !== undefined
        ? Number(s.engine_hours)
        : assignment.engineHours,
    ignition: s?.ignition ?? null,
    state: s?.state ?? 'never',
    stateSince: s?.state_since?.getTime() ?? Date.now(),
    ...(trips ? { trips } : {}),
  };
}

export async function saveState(deviceId: string, state: DeviceState): Promise<void> {
  await redis.set(key(deviceId), JSON.stringify(state), 'EX', TTL_S);
}

export async function patchState(deviceId: string, patch: Partial<DeviceState>): Promise<void> {
  const raw = await redis.get(key(deviceId));
  if (raw) await saveState(deviceId, { ...(JSON.parse(raw) as DeviceState), ...patch });
}

export function liveState(
  speedKph: number,
  ignition: boolean | null,
  movement: boolean | null,
): LiveState {
  if (speedKph > 5 || (movement === true && speedKph > 2)) return 'moving';
  if (ignition === true) return 'idle';
  return 'stopped';
}

/**
 * Worker state was lost (Redis flushed/expired): close any open trip at its last update so a new trip can never overlap it,
 * and keep tracking the latest open stop.
 */
async function recoverTrips(vehicleId: string | null): Promise<DeviceState['trips']> {
  if (!vehicleId) return undefined;
  await db.query(
    `UPDATE trips SET ended_at = greatest(started_at, updated_at) WHERE vehicle_id = $1 AND ended_at IS NULL`,
    [vehicleId],
  );
  const stop = (
    await db.query<{ id: string; started_at: Date }>(
      'SELECT id, started_at FROM stops WHERE vehicle_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [vehicleId],
    )
  ).rows[0];
  const ts = newTripState(vehicleId);
  if (stop) ts.stop = { id: stop.id, startedAt: stop.started_at.getTime() };
  return ts;
}
