import type { PoolClient } from '@jfs/db';

export interface GeoPoint {
  at: number;
  lat: number;
  lng: number;
  speed: number;
  driverId: string | null;
}

export interface GeofenceEvent {
  type: 'geofence_enter' | 'geofence_exit' | 'geofence_dwell' | 'overspeed';
  geofenceId: string;
  geofenceName: string;
  at: number;
  lat: number;
  lng: number;
  speed: number;
  driverId: string | null;
  dwellS?: number;
  limit?: number;
}

interface Applicable {
  id: string;
  name: string;
  speed_limit_kph: number | null;
  dwell_minutes: number | null;
}

/**
 * Detects geofence entry/exit/dwell and zone overspeed for one vehicle's batch of valid points (time ordered),
 * persisting presence and events inside the caller's transaction.
 */
export async function processGeofences(
  c: PoolClient,
  tenantId: string,
  vehicleId: string,
  deviceId: string,
  points: GeoPoint[],
  toleranceKph: number,
): Promise<GeofenceEvent[]> {
  if (points.length === 0) return [];
  const fences = (
    await c.query<Applicable>(
      `SELECT g.id, g.name, g.speed_limit_kph,
         coalesce(
           (SELECT min(a.dwell_minutes) FROM geofence_assignments a
              WHERE a.geofence_id = g.id AND (a.vehicle_id = $2 OR a.group_id = (SELECT group_id FROM vehicles WHERE id = $2))),
           (SELECT min((r.conditions->>'minutes')::int) FROM alert_rules r
              WHERE r.tenant_id = $1 AND r.rule_type = 'geofence_dwell' AND r.is_active AND r.deleted_at IS NULL AND r.conditions ? 'minutes')
         ) AS dwell_minutes
       FROM geofences g
       WHERE g.tenant_id = $1 AND g.deleted_at IS NULL AND g.is_active
         AND (g.applies_to_all OR EXISTS (SELECT 1 FROM geofence_assignments a WHERE a.geofence_id = g.id
               AND (a.vehicle_id = $2 OR a.group_id = (SELECT group_id FROM vehicles WHERE id = $2))))`,
      [tenantId, vehicleId],
    )
  ).rows;
  const presence = new Map(
    (
      await c.query<{ geofence_id: string; entered_at: Date; dwell_alerted: boolean }>(
        'SELECT geofence_id, entered_at, dwell_alerted FROM geofence_presence WHERE vehicle_id = $1',
        [vehicleId],
      )
    ).rows.map((r) => [
      r.geofence_id,
      { enteredAt: r.entered_at.getTime(), dwellAlerted: r.dwell_alerted },
    ]),
  );
  // drop presence in geofences that no longer apply
  for (const id of [...presence.keys()]) if (!fences.some((f) => f.id === id)) presence.delete(id);
  if (fences.length === 0) {
    await c.query('DELETE FROM geofence_presence WHERE vehicle_id = $1', [vehicleId]);
    return [];
  }

  // one spatial query for every (point, geofence) containment
  const inside = (
    await c.query<{ i: number; geofence_id: string }>(
      `SELECT p.i, g.id AS geofence_id
       FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS p(lat, lng, i)
       JOIN geofences g ON g.id = ANY($3::uuid[]) AND ST_Intersects(g.geom, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326))`,
      [points.map((p) => p.lat), points.map((p) => p.lng), fences.map((f) => f.id)],
    )
  ).rows;
  const byPoint = new Map<number, Set<string>>();
  for (const r of inside) {
    const s = byPoint.get(Number(r.i)) ?? new Set<string>();
    s.add(r.geofence_id);
    byPoint.set(Number(r.i), s);
  }

  const events: GeofenceEvent[] = [];
  const zoneOver = new Map<
    string,
    { at: number; max: number; lat: number; lng: number; driverId: string | null }
  >();
  points.forEach((p, idx) => {
    const now = byPoint.get(idx + 1) ?? new Set<string>();
    for (const f of fences) {
      const was = presence.get(f.id);
      const is = now.has(f.id);
      const base = {
        geofenceId: f.id,
        geofenceName: f.name,
        at: p.at,
        lat: p.lat,
        lng: p.lng,
        speed: p.speed,
        driverId: p.driverId,
      };
      if (is && !was) {
        presence.set(f.id, { enteredAt: p.at, dwellAlerted: false });
        events.push({ type: 'geofence_enter', ...base });
      } else if (!is && was) {
        presence.delete(f.id);
        events.push({
          type: 'geofence_exit',
          ...base,
          dwellS: Math.round((p.at - was.enteredAt) / 1000),
        });
      } else if (
        is &&
        was &&
        !was.dwellAlerted &&
        f.dwell_minutes &&
        p.at - was.enteredAt >= f.dwell_minutes * 60_000
      ) {
        was.dwellAlerted = true;
        events.push({
          type: 'geofence_dwell',
          ...base,
          dwellS: Math.round((p.at - was.enteredAt) / 1000),
        });
      }
      // zone speed limit (e.g. school zones): one event per episode
      if (f.speed_limit_kph) {
        const over = is && p.speed > f.speed_limit_kph + toleranceKph;
        const cur = zoneOver.get(f.id);
        if (over && !cur)
          zoneOver.set(f.id, {
            at: p.at,
            max: p.speed,
            lat: p.lat,
            lng: p.lng,
            driverId: p.driverId,
          });
        else if (over && cur) cur.max = Math.max(cur.max, p.speed);
        else if (!over && cur) {
          zoneOver.delete(f.id);
          events.push({
            type: 'overspeed',
            geofenceId: f.id,
            geofenceName: f.name,
            at: cur.at,
            lat: cur.lat,
            lng: cur.lng,
            speed: cur.max,
            driverId: cur.driverId,
            limit: f.speed_limit_kph,
          });
        }
      }
    }
  });

  // persist presence
  await c.query('DELETE FROM geofence_presence WHERE vehicle_id = $1', [vehicleId]);
  for (const [id, pr] of presence) {
    await c.query(
      'INSERT INTO geofence_presence (vehicle_id, geofence_id, tenant_id, entered_at, dwell_alerted) VALUES ($1, $2, $3, $4, $5)',
      [vehicleId, id, tenantId, new Date(pr.enteredAt), pr.dwellAlerted],
    );
  }
  for (const e of events) {
    if (e.type === 'overspeed') {
      await c.query(
        `INSERT INTO driving_events (tenant_id, vehicle_id, device_id, driver_id, event_type, severity, occurred_at, lat, lng, speed_kph,
           speed_limit_kph, value, source, details)
         VALUES ($1, $2, $3, $4, 'overspeed', $5, $6, $7, $8, $9, $10, $11, 'computed', $12) ON CONFLICT DO NOTHING`,
        [
          tenantId,
          vehicleId,
          deviceId,
          e.driverId,
          e.speed - e.limit! >= 20 ? 'high' : 'medium',
          new Date(e.at),
          e.lat,
          e.lng,
          Math.round(e.speed),
          e.limit,
          Math.round(e.speed - e.limit!),
          JSON.stringify({
            origin: 'geofence',
            geofence_id: e.geofenceId,
            geofence: e.geofenceName,
          }),
        ],
      );
      continue;
    }
    await c.query(
      `INSERT INTO geofence_events (tenant_id, geofence_id, vehicle_id, device_id, driver_id, event_type, occurred_at, lat, lng, speed_kph, dwell_s)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
      [
        tenantId,
        e.geofenceId,
        vehicleId,
        deviceId,
        e.driverId,
        e.type.replace('geofence_', ''),
        new Date(e.at),
        e.lat,
        e.lng,
        Math.round(e.speed),
        e.dwellS ?? null,
      ],
    );
  }
  return events;
}
