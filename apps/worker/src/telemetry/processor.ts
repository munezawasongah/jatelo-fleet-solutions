import type { DeviceEvent } from '@jfs/protocols';
import { withTransaction } from '@jfs/db';
import { EVENTS_STREAM, liveChannel } from '../config.js';
import { haversineKm } from '../geo.js';
import { db, redis } from '../infra.js';
import { logger } from '../logger.js';
import { resolveAssignment, resolveTag } from './resolve.js';
import { liveState, loadState, saveState } from './state.js';
import type { DeviceState, WireMessage, WireRecord } from './types.js';
import { tenantSettings } from './settings.js';
import { processGeofences, type GeofenceEvent } from './geofences.js';
import {
  advanceTrip,
  newTripState,
  tripUpdateOp,
  type ComputedEvent,
  type TripCtx,
} from './trips.js';

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 34 * 86_400_000;
const SPIKE_KPH = 300;
const MAX_ENGINE_STEP_H = 10 / 60;
const HIGH: DeviceEvent['type'][] = ['crash', 'sos', 'tamper', 'towing'];
const LOW: DeviceEvent['type'][] = ['low_battery', 'power_cut'];

interface PointRow {
  recordedAt: Date;
  lat: number;
  lng: number;
  valid: boolean;
  rec: WireRecord;
  driverId: string | null;
  odometerKm: number | null;
  engineHours: number | null;
}

export interface DeviceBatchResult {
  points: number;
  dropped: number;
  events: number;
}

/** Processes all queued messages for one device, in time order, in a single transaction. */
export async function processDevice(
  deviceId: string,
  tenantId: string,
  messages: WireMessage[],
): Promise<DeviceBatchResult> {
  const assignment = await resolveAssignment(deviceId);
  const state: DeviceState = await loadState(deviceId, assignment);
  const prevState = state.state;
  const cfg = await tenantSettings(tenantId);
  const tripCtx: TripCtx = {
    tenantId,
    deviceId,
    speedLimitKph: assignment.speedLimitKph ?? cfg.speedLimitKph,
    cfg,
    ops: [],
    events: [],
  };
  if (assignment.vehicleId && state.trips && state.trips.vehicleId !== assignment.vehicleId) {
    // device moved to another vehicle: close the old vehicle's trip where it was last seen
    const old = state.trips;
    if (old.trip) tripCtx.ops.push(tripUpdateOp(old.trip, old.trip.lastAt));
    state.trips = undefined;
  }
  if (assignment.vehicleId && !state.trips) state.trips = newTripState(assignment.vehicleId);
  const now = Date.now();
  let dropped = 0;

  const records = messages
    .flatMap((m) => (m.kind === 'records' ? (m.records ?? []) : []))
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const statuses = messages.filter((m) => m.kind === 'status' && m.status).map((m) => m.status!);

  const points: PointRow[] = [];
  const ignitionChanges: {
    on: boolean;
    at: number;
    lat: number;
    lng: number;
    driverId: string | null;
  }[] = [];
  let geoEvents: GeofenceEvent[] = [];
  const events: {
    at: Date;
    lat: number | null;
    lng: number | null;
    speed: number | null;
    ev: DeviceEvent;
    driverId: string | null;
    source: string;
  }[] = [];
  const dtcs: { code: string; at: Date }[] = [];

  for (const rec of records) {
    const at = Date.parse(rec.recordedAt);
    if (!Number.isFinite(at) || at > now + MAX_FUTURE_MS || at < now - MAX_AGE_MS) {
      dropped++;
      continue;
    }
    let valid = rec.valid && !(rec.lat === 0 && rec.lng === 0);
    let stepKm = 0;
    if (valid && state.lastValid) {
      const hours = Math.max((at - state.lastValid.at) / 3_600_000, 1 / 3600);
      stepKm = haversineKm(state.lastValid.lat, state.lastValid.lng, rec.lat, rec.lng);
      if (stepKm > 1 && stepKm / hours > SPIKE_KPH) valid = false; // GPS jump
    }
    const lat = valid ? rec.lat : state.lastValid?.lat;
    const lng = valid ? rec.lng : state.lastValid?.lng;
    if (lat === undefined || lng === undefined) {
      dropped++;
      continue;
    }

    // odometer: device counter wins; otherwise accumulate GPS distance between valid fixes
    if (rec.odometerKm !== null) state.odometerKm = Math.max(state.odometerKm ?? 0, rec.odometerKm);
    else if (valid && state.lastValid && at > state.lastValid.at)
      state.odometerKm = (state.odometerKm ?? 0) + stepKm;
    // engine hours: device counter wins; otherwise accumulate while ignition stays on
    if (rec.engineHours !== null)
      state.engineHours = Math.max(state.engineHours ?? 0, rec.engineHours);
    else if (rec.ignition && state.ignition && at > state.lastAt) {
      state.engineHours =
        (state.engineHours ?? 0) + Math.min((at - state.lastAt) / 3_600_000, MAX_ENGINE_STEP_H);
    }

    const driverId = rec.driverTag
      ? ((await resolveTag(tenantId, rec.driverTag)) ?? assignment.driverId)
      : assignment.driverId;
    const ls = liveState(rec.speedKph, rec.ignition, rec.movement);
    if (ls !== state.state) {
      state.state = ls;
      state.stateSince = at;
    }
    if (rec.ignition !== null && state.ignition !== null && rec.ignition !== state.ignition) {
      ignitionChanges.push({ on: rec.ignition, at, lat, lng, driverId });
    }
    if (rec.ignition !== null) state.ignition = rec.ignition;
    if (valid) state.lastValid = { lat: rec.lat, lng: rec.lng, at };
    state.lastAt = Math.max(state.lastAt, at);

    points.push({
      recordedAt: new Date(at),
      lat,
      lng,
      valid,
      rec,
      driverId,
      odometerKm: state.odometerKm,
      engineHours: state.engineHours,
    });
    if (state.trips) {
      advanceTrip(tripCtx, state.trips, {
        at,
        lat,
        lng,
        valid,
        speed: rec.speedKph,
        ignition: rec.ignition,
        stepKm: valid ? stepKm : 0,
        driverId,
        odometerKm: state.odometerKm,
        fuelL: rec.fuelLevelL,
        harsh: rec.events.filter((e) => e.type.startsWith('harsh_')).length,
      });
    }
    for (const ev of rec.events) {
      events.push({
        at: new Date(at),
        lat,
        lng,
        speed: rec.speedKph,
        ev,
        driverId,
        source: rec.eventCode.startsWith('phone') ? 'app' : 'device',
      });
    }
    for (const code of rec.dtcCodes) dtcs.push({ code, at: new Date(at) });
  }

  for (const s of statuses) {
    if (s.ignition !== null) state.ignition = s.ignition;
    for (const ev of s.events) {
      events.push({
        at: new Date(s.receivedAt),
        lat: state.lastValid?.lat ?? null,
        lng: state.lastValid?.lng ?? null,
        speed: null,
        ev,
        driverId: assignment.driverId,
        source: 'device',
      });
    }
    if (s.ignition === true && state.state === 'stopped') {
      state.state = 'idle';
      state.stateSince = Date.parse(s.receivedAt);
    }
  }
  if (prevState === 'offline' || prevState === 'never') {
    if (points.length === 0 && statuses.length > 0) {
      state.state = state.ignition ? 'idle' : 'stopped';
      state.stateSince = now;
    }
  }

  const latest = points[points.length - 1];
  const lastStatus = statuses[statuses.length - 1];
  const vehicleId = assignment.vehicleId;
  const receivedAt = new Date(Math.max(...messages.map((m) => Date.parse(m.received_at))));

  await withTransaction(db, async (c) => {
    if (points.length) {
      await c.query(
        `INSERT INTO gps_points (tenant_id, device_id, vehicle_id, driver_id, recorded_at, received_at, lat, lng, altitude_m, speed_kph,
           heading, satellites, hdop, is_valid, ignition, movement, odometer_km, engine_hours, fuel_level_pct, fuel_level_l,
           ext_voltage_mv, battery_voltage_mv, gsm_signal, event_code, io)
         SELECT $1, $2, $3, d, t, $4, la, ln, alt, sp, hd, sat, hdp, ok, ign, mov, odo, eh, fp, fl, ev, bv, gsm, code, io
         FROM unnest($5::uuid[], $6::timestamptz[], $7::float8[], $8::float8[], $9::int2[], $10::int2[], $11::int2[], $12::int2[],
           $13::float4[], $14::bool[], $15::bool[], $16::bool[], $17::numeric[], $18::numeric[], $19::float4[], $20::float4[],
           $21::int4[], $22::int4[], $23::int2[], $24::text[], $25::jsonb[])
           AS u(d, t, la, ln, alt, sp, hd, sat, hdp, ok, ign, mov, odo, eh, fp, fl, ev, bv, gsm, code, io)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          deviceId,
          vehicleId,
          receivedAt,
          points.map((p) => p.driverId),
          points.map((p) => p.recordedAt),
          points.map((p) => p.lat),
          points.map((p) => p.lng),
          points.map((p) =>
            p.rec.altitudeM === null ? null : Math.max(-32768, Math.min(32767, p.rec.altitudeM)),
          ),
          points.map((p) => Math.min(400, Math.max(0, Math.round(p.rec.speedKph)))),
          points.map((p) => (p.rec.heading === null ? null : Math.round(p.rec.heading) % 360)),
          points.map((p) => p.rec.satellites),
          points.map((p) => p.rec.hdop),
          points.map((p) => p.valid),
          points.map((p) => p.rec.ignition),
          points.map((p) => p.rec.movement),
          points.map((p) => (p.odometerKm === null ? null : p.odometerKm.toFixed(1))),
          points.map((p) => (p.engineHours === null ? null : p.engineHours.toFixed(1))),
          points.map((p) => p.rec.fuelLevelPct),
          points.map((p) => p.rec.fuelLevelL),
          points.map((p) => p.rec.extVoltageMv),
          points.map((p) => p.rec.batteryVoltageMv),
          points.map((p) => p.rec.gsmSignalPct),
          points.map((p) => p.rec.eventCode),
          points.map((p) => JSON.stringify(p.rec.io)),
        ],
      );
    }
    for (const op of tripCtx.ops) await c.query(op.text, op.values);
    if (vehicleId) {
      geoEvents = await processGeofences(
        c,
        tenantId,
        vehicleId,
        deviceId,
        points
          .filter((p) => p.valid)
          .map((p) => ({
            at: p.recordedAt.getTime(),
            lat: p.lat,
            lng: p.lng,
            speed: p.rec.speedKph,
            driverId: p.driverId,
          })),
        cfg.toleranceKph,
      );
    }
    if (state.trips?.trip?.confirmed) {
      const u = tripUpdateOp(state.trips.trip, null);
      await c.query(u.text, u.values);
    }
    for (const e of events) {
      await c.query(
        `INSERT INTO driving_events (tenant_id, vehicle_id, device_id, driver_id, event_type, severity, occurred_at, lat, lng, speed_kph, value, source, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING`,
        [
          tenantId,
          vehicleId,
          deviceId,
          e.driverId,
          e.ev.type,
          HIGH.includes(e.ev.type) ? 'high' : LOW.includes(e.ev.type) ? 'low' : 'medium',
          e.at,
          e.lat,
          e.lng,
          e.speed === null ? null : Math.round(e.speed),
          e.ev.value ?? null,
          e.source,
          JSON.stringify({ origin: 'device' }),
        ],
      );
    }
    if (vehicleId) {
      for (const d of dtcs) {
        await c.query(
          `INSERT INTO dtc_codes (tenant_id, vehicle_id, device_id, code, first_seen_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (vehicle_id, code) WHERE status <> 'cleared'
           DO UPDATE SET last_seen_at = greatest(dtc_codes.last_seen_at, EXCLUDED.last_seen_at), occurrences = dtc_codes.occurrences + 1`,
          [tenantId, vehicleId, deviceId, d.code, d.at],
        );
      }
      if (!assignment.odometerManual && state.odometerKm !== null) {
        await c.query(
          `UPDATE vehicles SET odometer_km = greatest(odometer_km, $2), engine_hours = greatest(engine_hours, coalesce($3, engine_hours)) WHERE id = $1`,
          [
            vehicleId,
            state.odometerKm.toFixed(1),
            state.engineHours === null ? null : state.engineHours.toFixed(1),
          ],
        );
      }
    }
    const r = latest?.rec;
    await c.query(
      `INSERT INTO device_status (device_id, tenant_id, vehicle_id, driver_id, state, state_since, last_seen_at, last_fix_at, lat, lng,
         speed_kph, heading, satellites, ignition, movement, odometer_km, engine_hours, fuel_level_pct, fuel_level_l, ext_voltage_mv,
         battery_voltage_mv, gsm_signal, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now())
       ON CONFLICT (device_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id, vehicle_id = EXCLUDED.vehicle_id, driver_id = coalesce(EXCLUDED.driver_id, device_status.driver_id),
         state = EXCLUDED.state, state_since = EXCLUDED.state_since,
         last_seen_at = greatest(device_status.last_seen_at, EXCLUDED.last_seen_at),
         last_fix_at = coalesce(greatest(device_status.last_fix_at, EXCLUDED.last_fix_at), device_status.last_fix_at),
         lat = coalesce(EXCLUDED.lat, device_status.lat), lng = coalesce(EXCLUDED.lng, device_status.lng),
         speed_kph = coalesce(EXCLUDED.speed_kph, device_status.speed_kph), heading = coalesce(EXCLUDED.heading, device_status.heading),
         satellites = coalesce(EXCLUDED.satellites, device_status.satellites), ignition = coalesce(EXCLUDED.ignition, device_status.ignition),
         movement = coalesce(EXCLUDED.movement, device_status.movement), odometer_km = coalesce(EXCLUDED.odometer_km, device_status.odometer_km),
         engine_hours = coalesce(EXCLUDED.engine_hours, device_status.engine_hours),
         fuel_level_pct = coalesce(EXCLUDED.fuel_level_pct, device_status.fuel_level_pct),
         fuel_level_l = coalesce(EXCLUDED.fuel_level_l, device_status.fuel_level_l),
         ext_voltage_mv = coalesce(EXCLUDED.ext_voltage_mv, device_status.ext_voltage_mv),
         battery_voltage_mv = coalesce(EXCLUDED.battery_voltage_mv, device_status.battery_voltage_mv),
         gsm_signal = coalesce(EXCLUDED.gsm_signal, device_status.gsm_signal), updated_at = now()
       WHERE device_status.last_seen_at IS NULL OR device_status.last_seen_at <= EXCLUDED.last_seen_at`,
      [
        deviceId,
        tenantId,
        vehicleId,
        latest?.driverId ?? assignment.driverId,
        state.state,
        new Date(state.stateSince),
        receivedAt,
        state.lastValid ? new Date(state.lastValid.at) : null,
        latest?.lat ?? null,
        latest?.lng ?? null,
        r ? Math.min(400, Math.round(r.speedKph)) : null,
        r?.heading === null || r?.heading === undefined ? null : Math.round(r.heading) % 360,
        r?.satellites ?? null,
        r?.ignition ?? lastStatus?.ignition ?? null,
        r?.movement ?? null,
        state.odometerKm === null ? null : state.odometerKm.toFixed(1),
        state.engineHours === null ? null : state.engineHours.toFixed(1),
        r?.fuelLevelPct ?? null,
        r?.fuelLevelL ?? null,
        r?.extVoltageMv ?? lastStatus?.extVoltageMv ?? null,
        r?.batteryVoltageMv ?? null,
        r?.gsmSignalPct ?? lastStatus?.gsmSignalPct ?? null,
      ],
    );
  });

  await saveState(deviceId, state);

  // real-time fan-out (after commit)
  if (latest || lastStatus) {
    await redis.publish(
      liveChannel(tenantId),
      JSON.stringify({
        type: 'position',
        vehicle_id: vehicleId,
        device_id: deviceId,
        lat: latest?.lat ?? state.lastValid?.lat ?? null,
        lng: latest?.lng ?? state.lastValid?.lng ?? null,
        speed_kph: latest ? Math.round(latest.rec.speedKph) : 0,
        heading: latest?.rec.heading ?? null,
        state: state.state,
        state_since: new Date(state.stateSince).toISOString(),
        ignition: state.ignition,
        odometer_km: state.odometerKm,
        recorded_at: latest?.recordedAt.toISOString() ?? new Date().toISOString(),
      }),
    );
  }
  for (const e of events) {
    await redis.xadd(
      EVENTS_STREAM,
      'MAXLEN',
      '~',
      '500000',
      '*',
      'data',
      JSON.stringify({
        type: e.ev.type,
        tenant_id: tenantId,
        vehicle_id: vehicleId,
        device_id: deviceId,
        driver_id: e.driverId,
        at: e.at.toISOString(),
        lat: e.lat,
        lng: e.lng,
        speed_kph: e.speed,
        value: e.ev.value ?? null,
        source: e.source,
      }),
    );
  }
  const publishEvent = (e: Record<string, unknown>): Promise<unknown> =>
    redis.xadd(
      EVENTS_STREAM,
      'MAXLEN',
      '~',
      '500000',
      '*',
      'data',
      JSON.stringify({ tenant_id: tenantId, vehicle_id: vehicleId, device_id: deviceId, ...e }),
    );
  for (const g of geoEvents) {
    await publishEvent({
      type: g.type,
      driver_id: g.driverId,
      at: new Date(g.at).toISOString(),
      lat: g.lat,
      lng: g.lng,
      speed_kph: Math.round(g.speed),
      value: g.type === 'overspeed' ? Math.round(g.speed - (g.limit ?? 0)) : (g.dwellS ?? null),
      geofence_id: g.geofenceId,
      geofence_name: g.geofenceName,
      speed_limit_kph: g.limit ?? null,
      source: 'computed',
    });
  }
  for (const ig of ignitionChanges) {
    await publishEvent({
      type: ig.on ? 'ignition_on' : 'ignition_off',
      driver_id: ig.driverId,
      at: new Date(ig.at).toISOString(),
      lat: ig.lat,
      lng: ig.lng,
      source: 'device',
    });
  }
  for (const e of tripCtx.events as ComputedEvent[]) {
    await redis.xadd(
      EVENTS_STREAM,
      'MAXLEN',
      '~',
      '500000',
      '*',
      'data',
      JSON.stringify({
        type: e.type,
        tenant_id: tenantId,
        vehicle_id: vehicleId,
        device_id: deviceId,
        driver_id: e.driverId,
        at: new Date(e.at).toISOString(),
        lat: e.lat,
        lng: e.lng,
        speed_kph: e.speed,
        value: e.value,
        source: 'computed',
      }),
    );
  }
  if (dropped) logger.debug({ deviceId, dropped }, 'records dropped by sanity filters');
  return { points: points.length, dropped, events: events.length };
}
