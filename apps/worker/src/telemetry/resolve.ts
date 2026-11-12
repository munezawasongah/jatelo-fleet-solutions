import { db } from '../infra.js';

export interface Assignment {
  vehicleId: string | null;
  driverId: string | null;
  odometerKm: number | null;
  engineHours: number | null;
  odometerManual: boolean;
  speedLimitKph: number | null;
}

const ASSIGN_TTL = 60_000;
const TAG_TTL = 300_000;
const assignments = new Map<string, { at: number; value: Assignment }>();
const tags = new Map<string, { at: number; value: string | null }>();

/** Current vehicle (and its current driver) for a device. Cached per worker for 60 s. */
export async function resolveAssignment(deviceId: string): Promise<Assignment> {
  const hit = assignments.get(deviceId);
  if (hit && Date.now() - hit.at < ASSIGN_TTL) return hit.value;
  const row = (
    await db.query<{ vehicle_id: string; odometer_km: string; engine_hours: string; odometer_source: string; speed_limit_kph: number | null; driver_id: string | null }>(
      `SELECT da.vehicle_id, v.odometer_km, v.engine_hours, v.odometer_source, v.speed_limit_kph, dva.driver_id
       FROM device_assignments da
       JOIN vehicles v ON v.id = da.vehicle_id AND v.deleted_at IS NULL
       LEFT JOIN driver_vehicle_assignments dva ON dva.vehicle_id = da.vehicle_id AND dva.ends_at IS NULL AND dva.starts_at <= now()
       WHERE da.device_id = $1 AND da.unassigned_at IS NULL`,
      [deviceId],
    )
  ).rows[0];
  const value: Assignment = row
    ? { vehicleId: row.vehicle_id, driverId: row.driver_id, odometerKm: Number(row.odometer_km), engineHours: Number(row.engine_hours),
        odometerManual: row.odometer_source === 'manual', speedLimitKph: row.speed_limit_kph }
    : { vehicleId: null, driverId: null, odometerKm: null, engineHours: null, odometerManual: false, speedLimitKph: null };
  assignments.set(deviceId, { at: Date.now(), value });
  return value;
}

/** Driver presenting an RFID/iButton tag (null when unknown). Cached 5 minutes. */
export async function resolveTag(tenantId: string, tag: string): Promise<string | null> {
  const k = `${tenantId}:${tag}`;
  const hit = tags.get(k);
  if (hit && Date.now() - hit.at < TAG_TTL) return hit.value;
  const row = (
    await db.query<{ driver_id: string }>(
      `SELECT di.driver_id FROM driver_identifiers di JOIN drivers d ON d.id = di.driver_id AND d.deleted_at IS NULL
       WHERE di.tenant_id = $1 AND upper(di.value) = upper($2) AND di.is_active LIMIT 1`,
      [tenantId, tag],
    )
  ).rows[0];
  const value = row?.driver_id ?? null;
  tags.set(k, { at: Date.now(), value });
  return value;
}

export function forgetDevice(deviceId: string): void {
  assignments.delete(deviceId);
}