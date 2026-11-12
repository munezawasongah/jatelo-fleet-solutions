import { db } from '../infra.js';
import { logger } from '../logger.js';

/**
 * Rebuilds vehicle_daily_stats and driver_daily_scores for the given tenant-local days (default: yesterday and today).
 * Idempotent: rows are upserted, so it can run every few minutes.
 *
 * Driver score (0-100): 100 minus penalty points per 100 km driven (min 50 km basis so short days aren't over-penalised):
 *   harsh brake 4, harsh acceleration 3, harsh corner 3, overspeed episode 5 (+1 per minute over), excessive idle 0.1/min,
 *   night driving 1/hour, crash 30, unauthorised/tamper 10.
 */
export async function buildRollups(daysBack = 1): Promise<{ vehicles: number; drivers: number }> {
  const tenants = (
    await db.query<{ id: string; timezone: string }>(
      `SELECT id, timezone FROM tenants WHERE status IN ('trial', 'active') AND deleted_at IS NULL`,
    )
  ).rows;
  let vehicles = 0;
  let drivers = 0;
  for (const t of tenants) {
    for (let back = daysBack; back >= 0; back--) {
      const dayRow = (
        await db.query<{ day: string; start: Date; stop: Date }>(
          `SELECT d::date::text AS day, (d::date)::timestamp AT TIME ZONE $1 AS start, (d::date + 1)::timestamp AT TIME ZONE $1 AS stop
         FROM (SELECT (now() AT TIME ZONE $1)::date - $2::int AS d) x`,
          [t.timezone, back],
        )
      ).rows[0]!;
      const params = [t.id, dayRow.day, dayRow.start, dayRow.stop];
      const v = await db.query(
        `WITH tr AS (
           SELECT vehicle_id, count(*) AS trips, sum(distance_km) AS km,
             sum(extract(epoch FROM least(coalesce(ended_at, now()), $4) - greatest(started_at, $3)) * moving_s / greatest(duration_s, 1)) AS moving_s,
             sum(idle_s) AS idle_s, max(max_speed_kph) AS max_speed, sum(fuel_used_l) AS fuel_l, min(started_at) AS first_on, max(coalesce(ended_at, now())) AS last_off
           FROM trips WHERE tenant_id = $1 AND started_at < $4 AND coalesce(ended_at, now()) > $3 GROUP BY vehicle_id),
         ev AS (
           SELECT vehicle_id, count(*) FILTER (WHERE event_type LIKE 'harsh_%') AS harsh, count(*) FILTER (WHERE event_type = 'overspeed') AS overspeed,
             coalesce(sum(duration_s) FILTER (WHERE event_type = 'excessive_idle'), 0) AS idle_extra
           FROM driving_events WHERE tenant_id = $1 AND occurred_at >= $3 AND occurred_at < $4 GROUP BY vehicle_id),
         fl AS (SELECT vehicle_id, sum(litres) AS litres, sum(total_cost) AS cost FROM fuel_logs WHERE tenant_id = $1 AND deleted_at IS NULL
           AND filled_at >= $3 AND filled_at < $4 GROUP BY vehicle_id),
         price AS (SELECT price_per_litre FROM fuel_prices WHERE tenant_id = $1 AND fuel_type = 'diesel' AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1)
         INSERT INTO vehicle_daily_stats AS s (vehicle_id, day, tenant_id, distance_km, trips, driving_s, idle_s, stopped_s, max_speed_kph, avg_speed_kph,
           fuel_used_l, fuel_cost, idle_fuel_l, engine_hours, harsh_events, overspeed_events, first_ignition_on, last_ignition_off, utilisation_pct, updated_at)
         SELECT v.id, $2::date, $1, coalesce(tr.km, 0), coalesce(tr.trips, 0), coalesce(tr.moving_s, 0)::int, coalesce(tr.idle_s, 0)::int,
           greatest(0, 86400 - coalesce(tr.moving_s, 0) - coalesce(tr.idle_s, 0))::int, coalesce(tr.max_speed, 0),
           CASE WHEN coalesce(tr.moving_s, 0) > 0 THEN round((tr.km / (tr.moving_s / 3600.0))::numeric, 1) ELSE 0 END,
           coalesce(tr.fuel_l, fl.litres), coalesce(fl.cost, coalesce(tr.fuel_l, 0) * (SELECT price_per_litre FROM price)),
           round(((coalesce(tr.idle_s, 0) + coalesce(ev.idle_extra, 0)) / 3600.0 *
             CASE WHEN v.body_type IN ('truck','prime_mover','bus','tanker') THEN 2.5 WHEN v.body_type = 'motorcycle' THEN 0.2 ELSE 0.8 END)::numeric, 2),
           round(((coalesce(tr.moving_s, 0) + coalesce(tr.idle_s, 0)) / 3600.0)::numeric, 2),
           coalesce(ev.harsh, 0), coalesce(ev.overspeed, 0), tr.first_on, tr.last_off,
           least(100, round(((coalesce(tr.moving_s, 0) + coalesce(tr.idle_s, 0)) / (10 * 36.0))::numeric, 2)), now()
         FROM vehicles v LEFT JOIN tr ON tr.vehicle_id = v.id LEFT JOIN ev ON ev.vehicle_id = v.id LEFT JOIN fl ON fl.vehicle_id = v.id
         WHERE v.tenant_id = $1 AND v.deleted_at IS NULL AND (tr.vehicle_id IS NOT NULL OR ev.vehicle_id IS NOT NULL OR fl.vehicle_id IS NOT NULL)
         ON CONFLICT (vehicle_id, day) DO UPDATE SET distance_km = EXCLUDED.distance_km, trips = EXCLUDED.trips, driving_s = EXCLUDED.driving_s,
           idle_s = EXCLUDED.idle_s, stopped_s = EXCLUDED.stopped_s, max_speed_kph = EXCLUDED.max_speed_kph, avg_speed_kph = EXCLUDED.avg_speed_kph,
           fuel_used_l = EXCLUDED.fuel_used_l, fuel_cost = EXCLUDED.fuel_cost, idle_fuel_l = EXCLUDED.idle_fuel_l, engine_hours = EXCLUDED.engine_hours,
           harsh_events = EXCLUDED.harsh_events, overspeed_events = EXCLUDED.overspeed_events, first_ignition_on = EXCLUDED.first_ignition_on,
           last_ignition_off = EXCLUDED.last_ignition_off, utilisation_pct = EXCLUDED.utilisation_pct, updated_at = now()`,
        params,
      );
      vehicles += v.rowCount ?? 0;
      const d = await db.query(
        `WITH tr AS (SELECT driver_id, sum(distance_km) AS km, sum(moving_s) AS moving_s FROM trips WHERE tenant_id = $1 AND driver_id IS NOT NULL
             AND started_at >= $3 AND started_at < $4 GROUP BY driver_id),
         ev AS (SELECT driver_id,
             count(*) FILTER (WHERE event_type = 'harsh_brake') AS hb, count(*) FILTER (WHERE event_type = 'harsh_accel') AS ha,
             count(*) FILTER (WHERE event_type = 'harsh_corner') AS hc, count(*) FILTER (WHERE event_type = 'overspeed') AS os,
             coalesce(sum(duration_s) FILTER (WHERE event_type = 'overspeed'), 0) AS os_s,
             coalesce(sum(coalesce(duration_s, value)) FILTER (WHERE event_type = 'excessive_idle'), 0) AS idle_s,
             count(*) FILTER (WHERE event_type = 'night_driving') AS night_trips,
             count(*) FILTER (WHERE event_type = 'crash') AS crash, count(*) FILTER (WHERE event_type IN ('tamper', 'unauthorized_driver')) AS tamper
           FROM driving_events WHERE tenant_id = $1 AND driver_id IS NOT NULL AND occurred_at >= $3 AND occurred_at < $4 GROUP BY driver_id),
         night AS (SELECT e.driver_id, sum(extract(epoch FROM coalesce(t.ended_at, now()) - e.occurred_at)) AS s FROM driving_events e JOIN trips t ON t.id = e.trip_id
           WHERE e.tenant_id = $1 AND e.event_type = 'night_driving' AND e.occurred_at >= $3 AND e.occurred_at < $4 GROUP BY e.driver_id)
         INSERT INTO driver_daily_scores AS s (driver_id, day, tenant_id, distance_km, driving_s, harsh_brake, harsh_accel, harsh_corner, overspeed_count,
           overspeed_s, idle_s, night_driving_s, score, updated_at)
         SELECT dr.id, $2::date, $1, coalesce(tr.km, 0), coalesce(tr.moving_s, 0), coalesce(ev.hb, 0), coalesce(ev.ha, 0), coalesce(ev.hc, 0), coalesce(ev.os, 0),
           coalesce(ev.os_s, 0), coalesce(ev.idle_s, 0)::int, coalesce(night.s, 0)::int,
           greatest(0, least(100, round((100 - (
             4 * coalesce(ev.hb, 0) + 3 * coalesce(ev.ha, 0) + 3 * coalesce(ev.hc, 0) + 5 * coalesce(ev.os, 0) + coalesce(ev.os_s, 0) / 60.0
             + 0.1 * coalesce(ev.idle_s, 0) / 60.0 + coalesce(night.s, 0) / 3600.0 + 30 * coalesce(ev.crash, 0) + 10 * coalesce(ev.tamper, 0)
           ) / (greatest(coalesce(tr.km, 0), 50) / 100.0))::numeric, 2))), now()
         FROM drivers dr LEFT JOIN tr ON tr.driver_id = dr.id LEFT JOIN ev ON ev.driver_id = dr.id LEFT JOIN night ON night.driver_id = dr.id
         WHERE dr.tenant_id = $1 AND dr.deleted_at IS NULL AND (tr.driver_id IS NOT NULL OR ev.driver_id IS NOT NULL)
         ON CONFLICT (driver_id, day) DO UPDATE SET distance_km = EXCLUDED.distance_km, driving_s = EXCLUDED.driving_s, harsh_brake = EXCLUDED.harsh_brake,
           harsh_accel = EXCLUDED.harsh_accel, harsh_corner = EXCLUDED.harsh_corner, overspeed_count = EXCLUDED.overspeed_count,
           overspeed_s = EXCLUDED.overspeed_s, idle_s = EXCLUDED.idle_s, night_driving_s = EXCLUDED.night_driving_s, score = EXCLUDED.score, updated_at = now()`,
        params,
      );
      drivers += d.rowCount ?? 0;
    }
  }
  logger.debug({ vehicles, drivers }, 'daily rollups rebuilt');
  return { vehicles, drivers };
}
