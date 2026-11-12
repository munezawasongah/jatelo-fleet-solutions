import { db, redis } from '../infra.js';
import { EVENTS_STREAM } from '../config.js';
import { logger } from '../logger.js';

/**
 * Live dispatch tracking for a vehicle's active jobs (dispatched / in progress):
 *  - auto-arrival when the vehicle is slow inside a stop's arrival radius, and departure when it leaves again
 *  - route deviation: off the planned line by more than the job threshold for 60 s -> job event + route_deviation alert;
 *    back_on_route when it returns
 *  - ETAs re-estimated every 3 minutes from the live position (1.3 detour factor, 40 km/h, 10 min per stop);
 *    a stop whose ETA passes the end of its time window raises job_late once.
 * Throttled to one evaluation per vehicle every 20 s.
 */
const DEVIATION_HOLD_MS = 60_000;
const ETA_EVERY_S = 180;
const AVG_KPH = 40;
const SERVICE_MIN = 10;

interface Pos {
  lat: number;
  lng: number;
  speedKph: number;
  at: Date;
}

const R = 6371008.8;
const rad = (d: number): number => (d * Math.PI) / 180;
const meters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

async function event(tenantId: string, jobId: string, type: string, details: Record<string, unknown>, p: Pos, stopId?: string): Promise<void> {
  await db.query(
    `INSERT INTO job_events (tenant_id, job_id, job_stop_id, event_type, occurred_at, lat, lng, details, actor_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'system')`,
    [tenantId, jobId, stopId ?? null, type, p.at, p.lat, p.lng, JSON.stringify(details)],
  );
}

async function alert(e: Record<string, unknown>): Promise<void> {
  await redis.xadd(EVENTS_STREAM, 'MAXLEN', '~', '500000', '*', 'data', JSON.stringify(e));
}

export async function trackJobs(tenantId: string, vehicleId: string, p: Pos): Promise<void> {
  if ((await redis.set(`jobtrack:${vehicleId}`, '1', 'EX', 20, 'NX')) !== 'OK') return;
  const jobs = (
    await db.query<{
      id: string;
      reference: string;
      status: string;
      driver_id: string | null;
      deviation_threshold_m: number;
      off_route_since: Date | null;
      last_deviation_m: number | null;
      off_m: number | null;
    }>(
      `SELECT j.id, j.reference, j.status, j.driver_id, j.deviation_threshold_m, j.off_route_since, j.last_deviation_m,
         CASE WHEN j.planned_geometry IS NOT NULL THEN ST_Distance(j.planned_geometry::geography, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) END AS off_m
       FROM jobs j WHERE j.vehicle_id = $1 AND j.deleted_at IS NULL AND j.status IN ('dispatched', 'in_progress')`,
      [vehicleId, p.lat, p.lng],
    )
  ).rows;
  for (const j of jobs) {
    try {
      let changed = false;
      const stops = (
        await db.query<{
          id: string;
          seq: number;
          name: string;
          lat: number;
          lng: number;
          arrival_radius_m: number;
          status: string;
          arrived_at: Date | null;
          departed_at: Date | null;
          eta: Date | null;
          time_window_end: Date | null;
        }>(
          `SELECT id, seq, name, ST_Y(geom) AS lat, ST_X(geom) AS lng, arrival_radius_m, status, arrived_at, departed_at, eta, time_window_end
           FROM job_stops WHERE job_id = $1 ORDER BY seq`,
          [j.id],
        )
      ).rows;

      // arrival / departure
      for (const s of stops) {
        const d = meters(p, s);
        if ((s.status === 'pending' || s.status === 'en_route') && d <= s.arrival_radius_m && p.speedKph < 15) {
          await db.query(`UPDATE job_stops SET status = 'arrived', arrived_at = $2 WHERE id = $1`, [s.id, p.at]);
          await event(tenantId, j.id, 'arrived', { auto: true, stop: s.name, distance_m: Math.round(d) }, p, s.id);
          if (j.status === 'dispatched') {
            await db.query(`UPDATE jobs SET status = 'in_progress', actual_start = coalesce(actual_start, $2) WHERE id = $1`, [j.id, p.at]);
            await event(tenantId, j.id, 'status_change', { from: 'dispatched', to: 'in_progress', auto: true }, p);
            j.status = 'in_progress';
          }
          s.status = 'arrived';
          changed = true;
        } else if (s.status === 'arrived' && !s.departed_at && d > Math.max(2 * s.arrival_radius_m, 300)) {
          await db.query('UPDATE job_stops SET departed_at = greatest($2, arrived_at) WHERE id = $1', [s.id, p.at]);
          await event(tenantId, j.id, 'departed', { auto: true, stop: s.name }, p, s.id);
          changed = true;
        }
      }
      // the next open stop is "en route" once the vehicle moves
      const next = stops.find((s) => s.status === 'pending' || s.status === 'en_route');
      if (next && next.status === 'pending' && p.speedKph > 5 && !stops.some((s) => s.status === 'arrived' && !s.departed_at)) {
        await db.query(`UPDATE job_stops SET status = 'en_route' WHERE id = $1 AND status = 'pending'`, [next.id]);
        if (j.status === 'dispatched') {
          await db.query(`UPDATE jobs SET status = 'in_progress', actual_start = coalesce(actual_start, $2) WHERE id = $1`, [j.id, p.at]);
          await event(tenantId, j.id, 'status_change', { from: 'dispatched', to: 'in_progress', auto: true }, p);
          j.status = 'in_progress';
        }
        changed = true;
      }

      // route deviation
      if (j.off_m !== null) {
        const off = Math.round(j.off_m);
        if (off > j.deviation_threshold_m) {
          if (!j.off_route_since) {
            await db.query('UPDATE jobs SET off_route_since = $2 WHERE id = $1', [j.id, p.at]);
          } else if (j.last_deviation_m === null && p.at.getTime() - j.off_route_since.getTime() >= DEVIATION_HOLD_MS) {
            await db.query('UPDATE jobs SET last_deviation_m = $2 WHERE id = $1', [j.id, off]);
            await event(tenantId, j.id, 'deviation', { distance_m: off, threshold_m: j.deviation_threshold_m }, p);
            await alert({
              type: 'route_deviation', tenant_id: tenantId, vehicle_id: vehicleId, driver_id: j.driver_id, job_id: j.id, at: p.at.toISOString(),
              lat: p.lat, lng: p.lng, speed_kph: Math.round(p.speedKph), value: off, extra: j.reference, dedupe: `dev:${j.id}:${j.off_route_since.getTime()}`,
            });
            changed = true;
          }
        } else if (j.off_route_since) {
          await db.query('UPDATE jobs SET off_route_since = NULL, last_deviation_m = NULL WHERE id = $1', [j.id]);
          if (j.last_deviation_m !== null) {
            await event(tenantId, j.id, 'back_on_route', { max_distance_m: j.last_deviation_m }, p);
            changed = true;
          }
        }
      }

      // ETA refresh
      if ((await redis.set(`jobeta:${j.id}`, '1', 'EX', ETA_EVERY_S, 'NX')) === 'OK') {
        let t = p.at.getTime();
        let from: { lat: number; lng: number } = p;
        for (const s of stops.filter((x) => x.status === 'pending' || x.status === 'en_route')) {
          t += ((meters(from, s) * 1.3) / 1000 / AVG_KPH) * 3_600_000;
          const eta = new Date(t);
          const shift = s.eta ? Math.abs(eta.getTime() - s.eta.getTime()) : Infinity;
          await db.query('UPDATE job_stops SET eta = $2 WHERE id = $1', [s.id, eta]);
          if (shift >= 10 * 60_000 && s === next) await event(tenantId, j.id, 'eta_update', { stop: s.name, eta: eta.toISOString(), previous: s.eta?.toISOString() ?? null }, p, s.id);
          if (s.time_window_end && eta > s.time_window_end && (await redis.set(`joblate:${s.id}`, '1', 'EX', 86_400, 'NX')) === 'OK') {
            await alert({
              type: 'job_late', tenant_id: tenantId, vehicle_id: vehicleId, driver_id: j.driver_id, job_id: j.id, at: p.at.toISOString(),
              lat: p.lat, lng: p.lng, value: Math.round((eta.getTime() - s.time_window_end.getTime()) / 60_000), extra: `${j.reference} - ${s.name}`,
              dedupe: `late:${s.id}`,
            });
            await event(tenantId, j.id, 'note', { late_minutes: Math.round((eta.getTime() - s.time_window_end.getTime()) / 60_000), stop: s.name, kind: 'late' }, p, s.id);
          }
          t += SERVICE_MIN * 60_000;
          from = s;
        }
        changed = true;
      }
      if (changed) {
        await db.query(
          `UPDATE jobs SET progress_pct = (SELECT round(100.0 * count(*) FILTER (WHERE status IN ('completed', 'failed', 'skipped')) / greatest(count(*), 1), 2)
             FROM job_stops WHERE job_id = $1) WHERE id = $1`,
          [j.id],
        );
        await redis.publish(`rt:tenant:${tenantId}`, JSON.stringify({ type: 'job', kind: 'progress', job_id: j.id, vehicle_id: vehicleId, status: j.status }));
      }
    } catch (err) {
      logger.warn({ err, job: j.id }, 'job tracking failed');
    }
  }
}
