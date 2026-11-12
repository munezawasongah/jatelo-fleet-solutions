import { randomUUID } from 'node:crypto';
import { haversineKm } from '../geo.js';
import { encodePolyline } from '../polyline.js';
import type { TenantSettings } from './settings.js';

const MOVING_KPH = 5;
const END_IGN_OFF_MS = 120_000;
const END_IGN_ON_STILL_MS = 600_000;
const END_NO_IGN_STILL_MS = 300_000;
const GAP_MS = 30 * 60_000;
const MAX_STEP_S = 600;
const MIN_TRIP_KM = 0.2;
const POLY_MIN_KM = 0.05;
const POLY_MAX_POINTS = 5000;

export interface Op {
  text: string;
  values: unknown[];
}
export interface ComputedEvent {
  type: 'overspeed' | 'excessive_idle' | 'night_driving';
  at: number;
  lat: number;
  lng: number;
  speed: number | null;
  value: number | null;
  driverId: string | null;
}

interface OpenTrip {
  id: string;
  startedAt: number;
  startLat: number;
  startLng: number;
  startOdo: number | null;
  endOdo: number | null;
  driverId: string | null;
  distanceKm: number;
  movingS: number;
  idleS: number;
  pendingIdleS: number;
  maxSpeed: number;
  harsh: number;
  overspeed: number;
  confirmed: boolean;
  lastAt: number;
  endLat: number;
  endLng: number;
  poly: [number, number][];
  night: boolean;
  fuelStartL: number | null;
  fuelEndL: number | null;
}

export interface TripState {
  vehicleId: string;
  trip: OpenTrip | null;
  stop: { id: string; startedAt: number } | null;
  stillSince: number | null;
  stillLat: number;
  stillLng: number;
  ignOffSince: number | null;
  prevAt: number | null;
  over: { startedAt: number; maxSpeed: number; lat: number; lng: number; limit: number } | null;
  idle: { startedAt: number; lat: number; lng: number; flagged: boolean } | null;
}

export interface TripPoint {
  at: number;
  lat: number;
  lng: number;
  valid: boolean;
  speed: number;
  ignition: boolean | null;
  stepKm: number;
  driverId: string | null;
  odometerKm: number | null;
  fuelL: number | null;
  harsh: number;
}

export interface TripCtx {
  tenantId: string;
  deviceId: string;
  speedLimitKph: number;
  cfg: TenantSettings;
  ops: Op[];
  events: ComputedEvent[];
}

export const newTripState = (vehicleId: string): TripState => ({
  vehicleId,
  trip: null,
  stop: null,
  stillSince: null,
  stillLat: 0,
  stillLng: 0,
  ignOffSince: null,
  prevAt: null,
  over: null,
  idle: null,
});

// ---------------------------------------------------------------- night window in the tenant's time zone
const formatters = new Map<string, Intl.DateTimeFormat>();
function localMinutes(at: number, tz: string): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(at));
  return (
    Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 +
    Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  );
}
const toMinutes = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function isNight(at: number, cfg: TenantSettings): boolean {
  const t = localMinutes(at, cfg.timezone);
  const s = toMinutes(cfg.nightStart);
  const e = toMinutes(cfg.nightEnd);
  return s > e ? t >= s || t < e : t >= s && t < e;
}

// ---------------------------------------------------------------- operations
function eventOp(
  ctx: TripCtx,
  ts: TripState,
  e: {
    type: ComputedEvent['type'];
    at: number;
    endedAt: number | null;
    lat: number;
    lng: number;
    speed: number | null;
    limit: number | null;
    value: number | null;
    severity: string;
    details: Record<string, unknown>;
  },
): void {
  const tripId = ts.trip?.confirmed ? ts.trip.id : null;
  const duration = e.endedAt !== null ? Math.round((e.endedAt - e.at) / 1000) : null;
  ctx.ops.push({
    text: `INSERT INTO driving_events (tenant_id, vehicle_id, device_id, driver_id, trip_id, event_type, severity, occurred_at, ended_at,
             duration_s, lat, lng, speed_kph, speed_limit_kph, value, source, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'computed', $16)
           ON CONFLICT (device_id, event_type, occurred_at) DO UPDATE SET ended_at = EXCLUDED.ended_at, duration_s = EXCLUDED.duration_s,
             value = EXCLUDED.value, speed_kph = greatest(driving_events.speed_kph, EXCLUDED.speed_kph),
             trip_id = coalesce(driving_events.trip_id, EXCLUDED.trip_id)`,
    values: [
      ctx.tenantId,
      ts.vehicleId,
      ctx.deviceId,
      ts.trip?.driverId ?? null,
      tripId,
      e.type,
      e.severity,
      new Date(e.at),
      e.endedAt !== null ? new Date(e.endedAt) : null,
      duration,
      e.lat,
      e.lng,
      e.speed === null ? null : Math.round(e.speed),
      e.limit,
      e.value,
      JSON.stringify(e.details),
    ],
  });
}

function insertTrip(ctx: TripCtx, ts: TripState, t: OpenTrip): void {
  ctx.ops.push({
    text: `INSERT INTO trips (id, tenant_id, vehicle_id, device_id, driver_id, started_at, start_lat, start_lng, start_odometer_km)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values: [
      t.id,
      ctx.tenantId,
      ts.vehicleId,
      ctx.deviceId,
      t.driverId,
      new Date(t.startedAt),
      t.startLat,
      t.startLng,
      t.startOdo,
    ],
  });
}

/** Writes the trip's running (or final) statistics. */
export function tripUpdateOp(t: OpenTrip, endedAt: number | null): Op {
  const durationS = Math.max(0, Math.round(((endedAt ?? t.lastAt) - t.startedAt) / 1000));
  const avg = t.movingS > 0 ? t.distanceKm / (t.movingS / 3600) : 0;
  const fuel =
    t.fuelStartL !== null && t.fuelEndL !== null && t.fuelStartL > t.fuelEndL
      ? t.fuelStartL - t.fuelEndL
      : null;
  return {
    text: `UPDATE trips SET ended_at = $2, end_lat = $3, end_lng = $4, distance_km = $5, duration_s = $6, moving_s = $7, idle_s = $8,
             max_speed_kph = $9, avg_speed_kph = $10, end_odometer_km = $11, fuel_used_l = $12, harsh_event_count = $13,
             overspeed_count = $14, route_polyline = $15
           WHERE id = $1`,
    values: [
      t.id,
      endedAt !== null ? new Date(endedAt) : null,
      t.endLat,
      t.endLng,
      t.distanceKm.toFixed(2),
      durationS,
      Math.round(t.movingS),
      Math.round(t.idleS),
      Math.min(400, Math.round(t.maxSpeed)),
      Math.min(999, avg).toFixed(1),
      t.endOdo,
      fuel === null ? null : fuel.toFixed(2),
      t.harsh,
      t.overspeed,
      encodePolyline(t.poly),
    ],
  };
}

function openStop(
  ctx: TripCtx,
  ts: TripState,
  at: number,
  lat: number,
  lng: number,
  ignitionOn: boolean,
  tripId: string | null,
  driverId: string | null,
): void {
  const id = randomUUID();
  ts.stop = { id, startedAt: at };
  ctx.ops.push({
    text: `INSERT INTO stops (id, tenant_id, vehicle_id, device_id, driver_id, trip_id, started_at, lat, lng, ignition_on, poi_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             (SELECT p.id FROM pois p WHERE p.tenant_id = $2 AND p.deleted_at IS NULL
                AND ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint($9, $8), 4326)::geography, p.radius_m)
              ORDER BY p.geom::geography <-> ST_SetSRID(ST_MakePoint($9, $8), 4326)::geography LIMIT 1))`,
    values: [
      id,
      ctx.tenantId,
      ts.vehicleId,
      ctx.deviceId,
      driverId,
      tripId,
      new Date(at),
      lat,
      lng,
      ignitionOn,
    ],
  });
}

function closeStop(ctx: TripCtx, ts: TripState, at: number): void {
  if (!ts.stop) return;
  ctx.ops.push({
    text: `UPDATE stops SET ended_at = greatest($2, started_at), duration_s = greatest(0, round(extract(epoch FROM ($2 - started_at)))) WHERE id = $1`,
    values: [ts.stop.id, new Date(at)],
  });
  ts.stop = null;
}

/** Ends the open trip at the given moment/place and opens a stop there. */
export function endTrip(
  ctx: TripCtx,
  ts: TripState,
  at: number,
  lat: number,
  lng: number,
  ignitionOn: boolean,
): void {
  const t = ts.trip;
  if (!t) return;
  const endAt = Math.max(at, t.startedAt);
  if (t.confirmed) {
    t.endLat = lat;
    t.endLng = lng;
    ctx.ops.push(tripUpdateOp(t, endAt));
    openStop(ctx, ts, endAt, lat, lng, ignitionOn, t.id, t.driverId);
  } else if (!ts.stop) {
    openStop(ctx, ts, endAt, lat, lng, ignitionOn, null, t.driverId);
  }
  ts.trip = null;
}

function finishOverspeed(ctx: TripCtx, ts: TripState, endAt: number): void {
  const o = ts.over;
  ts.over = null;
  if (!o || (endAt - o.startedAt) / 1000 < ctx.cfg.minOverspeedS) return;
  if (ts.trip) ts.trip.overspeed++;
  eventOp(ctx, ts, {
    type: 'overspeed',
    at: o.startedAt,
    endedAt: endAt,
    lat: o.lat,
    lng: o.lng,
    speed: o.maxSpeed,
    limit: o.limit,
    value: Math.round(o.maxSpeed - o.limit),
    severity: o.maxSpeed - o.limit >= 30 ? 'high' : 'medium',
    details: { origin: 'computed' },
  });
  ctx.events.push({
    type: 'overspeed',
    at: o.startedAt,
    lat: o.lat,
    lng: o.lng,
    speed: o.maxSpeed,
    value: Math.round(o.maxSpeed - o.limit),
    driverId: ts.trip?.driverId ?? null,
  });
}

/** Advances the trip/stop/event state machine by one point (points must arrive in time order). */
export function advanceTrip(ctx: TripCtx, ts: TripState, p: TripPoint): void {
  if (ts.prevAt !== null && p.at <= ts.prevAt) return; // out-of-order backlog never rewinds the state machine
  const moving = p.speed > MOVING_KPH;
  const dt = ts.prevAt === null ? 0 : Math.min(MAX_STEP_S, (p.at - ts.prevAt) / 1000);

  // coverage gap: close the trip at its last known point
  if (ts.trip && ts.prevAt !== null && p.at - ts.prevAt > GAP_MS) {
    finishOverspeed(ctx, ts, ts.trip.lastAt);
    endTrip(ctx, ts, ts.trip.lastAt, ts.trip.endLat, ts.trip.endLng, false);
    ts.stillSince = null;
  }

  // overspeed episodes
  const limit = ctx.speedLimitKph;
  if (p.valid && p.speed > limit + ctx.cfg.toleranceKph) {
    if (!ts.over) ts.over = { startedAt: p.at, maxSpeed: p.speed, lat: p.lat, lng: p.lng, limit };
    else ts.over.maxSpeed = Math.max(ts.over.maxSpeed, p.speed);
  } else if (ts.over) {
    finishOverspeed(ctx, ts, p.at);
  }

  // excessive idle (engine on, stationary)
  if (!moving && p.ignition === true) {
    if (!ts.idle) ts.idle = { startedAt: p.at, lat: p.lat, lng: p.lng, flagged: false };
    const idleS = (p.at - ts.idle.startedAt) / 1000;
    if (!ts.idle.flagged && idleS >= ctx.cfg.idleThresholdS) {
      ts.idle.flagged = true;
      eventOp(ctx, ts, {
        type: 'excessive_idle',
        at: ts.idle.startedAt,
        endedAt: null,
        lat: ts.idle.lat,
        lng: ts.idle.lng,
        speed: 0,
        limit: null,
        value: Math.round(idleS),
        severity: 'low',
        details: { origin: 'computed', in_progress: true },
      });
      ctx.events.push({
        type: 'excessive_idle',
        at: ts.idle.startedAt,
        lat: ts.idle.lat,
        lng: ts.idle.lng,
        speed: 0,
        value: Math.round(idleS),
        driverId: ts.trip?.driverId ?? p.driverId,
      });
    }
  } else if (ts.idle) {
    const idleS = (p.at - ts.idle.startedAt) / 1000;
    if (ts.idle.flagged) {
      eventOp(ctx, ts, {
        type: 'excessive_idle',
        at: ts.idle.startedAt,
        endedAt: p.at,
        lat: ts.idle.lat,
        lng: ts.idle.lng,
        speed: 0,
        limit: null,
        value: Math.round(idleS),
        severity: idleS >= 1800 ? 'medium' : 'low',
        details: { origin: 'computed' },
      });
    }
    ts.idle = null;
  }

  // stationary bookkeeping
  if (moving) {
    ts.stillSince = null;
  } else if (ts.stillSince === null) {
    ts.stillSince = p.at;
    ts.stillLat = p.lat;
    ts.stillLng = p.lng;
  }
  if (p.ignition === false) ts.ignOffSince ??= p.at;
  else if (p.ignition === true || moving) ts.ignOffSince = null;

  // trip start
  if (!ts.trip && moving) {
    closeStop(ctx, ts, p.at);
    ts.trip = {
      id: randomUUID(),
      startedAt: p.at,
      startLat: p.lat,
      startLng: p.lng,
      startOdo: p.odometerKm,
      endOdo: p.odometerKm,
      driverId: p.driverId,
      distanceKm: 0,
      movingS: 0,
      idleS: 0,
      pendingIdleS: 0,
      maxSpeed: p.speed,
      harsh: 0,
      overspeed: 0,
      confirmed: false,
      lastAt: p.at,
      endLat: p.lat,
      endLng: p.lng,
      poly: [[p.lat, p.lng]],
      night: false,
      fuelStartL: p.fuelL,
      fuelEndL: p.fuelL,
    };
  }

  const t = ts.trip;
  if (t) {
    if (moving) {
      t.movingS += dt;
      t.idleS += t.pendingIdleS;
      t.pendingIdleS = 0;
    } else if (p.ignition === true) {
      t.pendingIdleS += dt;
    }
    if (p.valid) {
      t.distanceKm += p.stepKm;
      t.endLat = p.lat;
      t.endLng = p.lng;
      const last = t.poly[t.poly.length - 1]!;
      if (
        t.poly.length < POLY_MAX_POINTS &&
        haversineKm(last[0], last[1], p.lat, p.lng) >= POLY_MIN_KM
      )
        t.poly.push([p.lat, p.lng]);
    }
    t.maxSpeed = Math.max(t.maxSpeed, p.speed);
    t.harsh += p.harsh;
    t.lastAt = p.at;
    if (p.odometerKm !== null) t.endOdo = p.odometerKm;
    if (p.fuelL !== null) t.fuelEndL = p.fuelL;
    if (!t.confirmed && t.distanceKm >= MIN_TRIP_KM) {
      t.confirmed = true;
      insertTrip(ctx, ts, t);
    }
    if (t.confirmed && moving && !t.night && isNight(p.at, ctx.cfg)) {
      t.night = true;
      eventOp(ctx, ts, {
        type: 'night_driving',
        at: p.at,
        endedAt: null,
        lat: p.lat,
        lng: p.lng,
        speed: p.speed,
        limit: null,
        value: null,
        severity: 'low',
        details: {
          origin: 'computed',
          window: `${ctx.cfg.nightStart.slice(0, 5)}-${ctx.cfg.nightEnd.slice(0, 5)}`,
        },
      });
      ctx.events.push({
        type: 'night_driving',
        at: p.at,
        lat: p.lat,
        lng: p.lng,
        speed: p.speed,
        value: null,
        driverId: t.driverId,
      });
    }
    // trip end
    if (!moving && ts.stillSince !== null) {
      const stillFor = p.at - ts.stillSince;
      const end =
        (p.ignition === false &&
          ts.ignOffSince !== null &&
          p.at - ts.ignOffSince >= END_IGN_OFF_MS) ||
        (p.ignition === true && stillFor >= END_IGN_ON_STILL_MS) ||
        (p.ignition === null && stillFor >= END_NO_IGN_STILL_MS);
      if (end) {
        finishOverspeed(ctx, ts, ts.stillSince);
        endTrip(ctx, ts, ts.stillSince, ts.stillLat, ts.stillLng, p.ignition === true);
      }
    }
  }
  ts.prevAt = p.at;
}
