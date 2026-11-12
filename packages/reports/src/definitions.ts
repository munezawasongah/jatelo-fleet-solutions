export const REPORT_TYPES = [
  'trips',
  'stops',
  'mileage',
  'fuel',
  'speeding',
  'geofence',
  'maintenance',
  'driver_scores',
  'utilisation',
  'idle',
  'alerts',
  'executive_summary',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export type Locale = 'en' | 'sw';
export type ColType = 'text' | 'number' | 'decimal' | 'datetime' | 'date' | 'duration' | 'money' | 'percent' | 'bool';

export interface Column {
  key: string;
  label: Record<Locale, string>;
  type: ColType;
  width?: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface ReportParams {
  /** Tenant-local dates, inclusive (YYYY-MM-DD). */
  from: string;
  to: string;
  vehicle_ids?: string[] | null;
  group_id?: string | null;
  driver_ids?: string[] | null;
}

export interface Def {
  title: Record<Locale, string>;
  columns: Column[];
  /**
   * SQL with parameters: $1 tenant_id, $2 period start (timestamptz), $3 period end (exclusive), $4 vehicle ids (uuid[] | null),
   * $5 group id, $6 driver ids, $7 from date, $8 to date. Vehicles are aliased v, drivers d.
   */
  sql: string;
  summary?: (rows: Record<string, unknown>[]) => { label: Record<Locale, string>; value: number | string; type: ColType }[];
}

const L = (en: string, sw: string): Record<Locale, string> => ({ en, sw });
const col = (key: string, en: string, sw: string, type: ColType = 'text', width?: number): Column => ({ key, label: L(en, sw), type, width });
const sum = (rows: Record<string, unknown>[], k: string): number => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const VEH = `($4::uuid[] IS NULL OR v.id = ANY($4)) AND ($5::uuid IS NULL OR v.group_id = $5)`;
const DRV = `($6::uuid[] IS NULL OR d.id = ANY($6))`;
const PLATE = col('plate_number', 'Vehicle', 'Gari', 'text', 12);
const DRIVER = col('driver_name', 'Driver', 'Dereva', 'text', 18);

export const DEFS: Record<ReportType, Def> = {
  trips: {
    title: L('Trip report', 'Ripoti ya safari'),
    columns: [
      col('started_at', 'Start', 'Mwanzo', 'datetime'), col('ended_at', 'End', 'Mwisho', 'datetime'), PLATE, DRIVER,
      col('start_address', 'From', 'Kutoka', 'text', 20), col('end_address', 'To', 'Hadi', 'text', 20), col('distance_km', 'Distance (km)', 'Umbali (km)', 'decimal'),
      col('duration_s', 'Duration', 'Muda', 'duration'), col('idle_s', 'Idle', 'Kusimama', 'duration'), col('max_speed_kph', 'Max km/h', 'Kasi ya juu', 'number'),
      col('avg_speed_kph', 'Avg km/h', 'Kasi wastani', 'decimal'), col('fuel_used_l', 'Fuel (L)', 'Mafuta (L)', 'decimal'),
      col('harsh_event_count', 'Harsh', 'Matukio makali', 'number'), col('overspeed_count', 'Overspeed', 'Mwendo kasi', 'number'),
    ],
    sql: `SELECT t.started_at, t.ended_at, v.plate_number, d.full_name AS driver_name, coalesce(t.start_address, round(t.start_lat::numeric, 5) || ', ' || round(t.start_lng::numeric, 5)) AS start_address,
      coalesce(t.end_address, round(t.end_lat::numeric, 5) || ', ' || round(t.end_lng::numeric, 5)) AS end_address, t.distance_km, t.duration_s, t.idle_s, t.max_speed_kph,
      t.avg_speed_kph, t.fuel_used_l, t.harsh_event_count, t.overspeed_count
      FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.tenant_id = $1 AND t.started_at >= $2 AND t.started_at < $3 AND ${VEH} AND ($6::uuid[] IS NULL OR t.driver_id = ANY($6))
      ORDER BY t.started_at LIMIT 50000`,
    summary: (r) => [
      { label: L('Trips', 'Safari'), value: r.length, type: 'number' },
      { label: L('Distance (km)', 'Umbali (km)'), value: sum(r, 'distance_km'), type: 'decimal' },
      { label: L('Driving time', 'Muda wa kuendesha'), value: sum(r, 'duration_s'), type: 'duration' },
      { label: L('Fuel (L)', 'Mafuta (L)'), value: sum(r, 'fuel_used_l'), type: 'decimal' },
    ],
  },
  stops: {
    title: L('Stops report', 'Ripoti ya vituo'),
    columns: [
      col('started_at', 'Arrived', 'Kufika', 'datetime'), col('ended_at', 'Left', 'Kuondoka', 'datetime'), PLATE, DRIVER,
      col('place', 'Location', 'Mahali', 'text', 34), col('duration_s', 'Duration', 'Muda', 'duration'), col('ignition_on', 'Engine on', 'Injini imewashwa', 'bool'),
    ],
    sql: `SELECT s.started_at, s.ended_at, v.plate_number, d.full_name AS driver_name,
      coalesce(s.address, (SELECT p.name FROM pois p WHERE p.tenant_id = s.tenant_id AND p.deleted_at IS NULL
        AND ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography, greatest(p.radius_m, 150)) LIMIT 1),
        round(s.lat::numeric, 5) || ', ' || round(s.lng::numeric, 5)) AS place,
      s.duration_s, s.ignition_on
      FROM stops s JOIN vehicles v ON v.id = s.vehicle_id LEFT JOIN drivers d ON d.id = s.driver_id
      WHERE s.tenant_id = $1 AND s.started_at >= $2 AND s.started_at < $3 AND coalesce(s.duration_s, 0) >= 120 AND ${VEH}
        AND ($6::uuid[] IS NULL OR s.driver_id = ANY($6))
      ORDER BY s.started_at LIMIT 50000`,
    summary: (r) => [
      { label: L('Stops', 'Vituo'), value: r.length, type: 'number' },
      { label: L('Total stopped', 'Jumla ya kusimama'), value: sum(r, 'duration_s'), type: 'duration' },
    ],
  },
  mileage: {
    title: L('Mileage report', 'Ripoti ya umbali'),
    columns: [
      PLATE, col('group_name', 'Group', 'Kundi', 'text', 16), col('active_days', 'Active days', 'Siku za kazi', 'number'), col('trips', 'Trips', 'Safari', 'number'),
      col('distance_km', 'Distance (km)', 'Umbali (km)', 'decimal'), col('avg_km_day', 'Avg km / active day', 'Wastani km/siku', 'decimal'),
      col('driving_s', 'Driving time', 'Muda wa kuendesha', 'duration'), col('max_speed_kph', 'Max km/h', 'Kasi ya juu', 'number'),
      col('odometer_km', 'Odometer now (km)', 'Odometa sasa (km)', 'decimal'),
    ],
    sql: `SELECT v.plate_number, g.name AS group_name, count(*) FILTER (WHERE s.distance_km > 0) AS active_days, coalesce(sum(s.trips), 0) AS trips,
      coalesce(sum(s.distance_km), 0) AS distance_km, round(coalesce(sum(s.distance_km), 0) / greatest(count(*) FILTER (WHERE s.distance_km > 0), 1), 1) AS avg_km_day,
      coalesce(sum(s.driving_s), 0) AS driving_s, coalesce(max(s.max_speed_kph), 0) AS max_speed_kph, v.odometer_km
      FROM vehicles v LEFT JOIN vehicle_groups g ON g.id = v.group_id
      LEFT JOIN vehicle_daily_stats s ON s.vehicle_id = v.id AND s.day BETWEEN $7::date AND $8::date
      WHERE v.tenant_id = $1 AND v.deleted_at IS NULL AND ${VEH}
      GROUP BY v.id, g.name ORDER BY distance_km DESC`,
    summary: (r) => [
      { label: L('Vehicles', 'Magari'), value: r.length, type: 'number' },
      { label: L('Distance (km)', 'Umbali (km)'), value: sum(r, 'distance_km'), type: 'decimal' },
      { label: L('Trips', 'Safari'), value: sum(r, 'trips'), type: 'number' },
    ],
  },
  fuel: {
    title: L('Fuel report', 'Ripoti ya mafuta'),
    columns: [
      PLATE, col('fuel_type', 'Fuel', 'Aina', 'text', 8), col('fills', 'Fill-ups', 'Kujaza', 'number'), col('litres', 'Litres', 'Lita', 'decimal'),
      col('cost', 'Cost', 'Gharama', 'money'), col('distance_km', 'Distance (km)', 'Umbali (km)', 'decimal'),
      col('l_per_100km', 'L/100 km', 'L/100 km', 'decimal'), col('expected_l_per_100km', 'Expected L/100 km', 'Inayotarajiwa', 'decimal'),
      col('variance_pct', 'Variance', 'Tofauti', 'percent'), col('cost_per_km', 'Cost / km', 'Gharama/km', 'money'),
      col('idle_fuel_l', 'Idle fuel (L)', 'Mafuta ya kusimama (L)', 'decimal'), col('drains', 'Suspected drains', 'Wizi unaoshukiwa', 'number'),
      col('drained_l', 'Drained (L)', 'Lita zilizopotea', 'decimal'),
    ],
    sql: `WITH fl AS (SELECT vehicle_id, count(*) AS fills, sum(litres) AS litres, sum(total_cost) AS cost FROM fuel_logs
        WHERE tenant_id = $1 AND deleted_at IS NULL AND filled_at >= $2 AND filled_at < $3 GROUP BY vehicle_id),
      st AS (SELECT vehicle_id, sum(distance_km) AS km, sum(idle_fuel_l) AS idle_l FROM vehicle_daily_stats WHERE tenant_id = $1 AND day BETWEEN $7::date AND $8::date GROUP BY vehicle_id),
      fe AS (SELECT vehicle_id, count(*) AS drains, sum(abs(change_l)) AS drained FROM fuel_events WHERE tenant_id = $1 AND event_type = 'drain'
        AND status <> 'dismissed' AND started_at >= $2 AND started_at < $3 GROUP BY vehicle_id)
      SELECT v.plate_number, v.fuel_type, coalesce(fl.fills, 0) AS fills, coalesce(fl.litres, 0) AS litres, coalesce(fl.cost, 0) AS cost, coalesce(st.km, 0) AS distance_km,
        CASE WHEN st.km > 20 THEN round(fl.litres / st.km * 100, 2) END AS l_per_100km, v.expected_l_per_100km,
        CASE WHEN st.km > 20 AND v.expected_l_per_100km > 0 THEN round((fl.litres / st.km * 100 - v.expected_l_per_100km) / v.expected_l_per_100km * 100, 1) END AS variance_pct,
        CASE WHEN st.km > 0 THEN round(fl.cost / st.km, 2) END AS cost_per_km, coalesce(st.idle_l, 0) AS idle_fuel_l, coalesce(fe.drains, 0) AS drains, coalesce(fe.drained, 0) AS drained_l
      FROM vehicles v LEFT JOIN fl ON fl.vehicle_id = v.id LEFT JOIN st ON st.vehicle_id = v.id LEFT JOIN fe ON fe.vehicle_id = v.id
      WHERE v.tenant_id = $1 AND v.deleted_at IS NULL AND ${VEH} AND (fl.vehicle_id IS NOT NULL OR st.km > 0 OR fe.vehicle_id IS NOT NULL)
      ORDER BY cost DESC`,
    summary: (r) => {
      const litres = sum(r, 'litres');
      const km = sum(r, 'distance_km');
      const cost = sum(r, 'cost');
      return [
        { label: L('Litres', 'Lita'), value: litres, type: 'decimal' },
        { label: L('Fuel cost', 'Gharama ya mafuta'), value: cost, type: 'money' },
        {
          label: L('Fleet L/100 km', 'L/100 km ya kundi'),
          value: (() => {
            const m = r.filter((x) => x.l_per_100km !== null && x.l_per_100km !== undefined);
            const k = sum(m, 'distance_km');
            return k > 0 ? Math.round((sum(m, 'litres') / k) * 10000) / 100 : 0;
          })(),
          type: 'decimal',
        },
        { label: L('Cost per km', 'Gharama kwa km'), value: km > 0 ? Math.round((cost / km) * 100) / 100 : 0, type: 'money' },
        { label: L('Suspected drains', 'Wizi unaoshukiwa'), value: sum(r, 'drains'), type: 'number' },
      ];
    },
  },
  speeding: {
    title: L('Speeding report', 'Ripoti ya mwendo kasi'),
    columns: [
      col('occurred_at', 'Time', 'Saa', 'datetime'), PLATE, DRIVER, col('speed_kph', 'Speed km/h', 'Kasi km/h', 'number'),
      col('speed_limit_kph', 'Limit km/h', 'Kikomo km/h', 'number'), col('over_kph', 'Over by', 'Zaidi kwa', 'number'),
      col('duration_s', 'Duration', 'Muda', 'duration'), col('location', 'Location', 'Mahali', 'text', 22),
    ],
    sql: `SELECT e.occurred_at, v.plate_number, d.full_name AS driver_name, e.speed_kph, e.speed_limit_kph, (e.speed_kph - e.speed_limit_kph) AS over_kph,
      e.duration_s, round(e.lat::numeric, 5) || ', ' || round(e.lng::numeric, 5) AS location
      FROM driving_events e JOIN vehicles v ON v.id = e.vehicle_id LEFT JOIN drivers d ON d.id = e.driver_id
      WHERE e.tenant_id = $1 AND e.event_type = 'overspeed' AND e.occurred_at >= $2 AND e.occurred_at < $3 AND ${VEH}
        AND ($6::uuid[] IS NULL OR e.driver_id = ANY($6))
      ORDER BY e.occurred_at LIMIT 50000`,
    summary: (r) => [
      { label: L('Overspeed events', 'Matukio ya mwendo kasi'), value: r.length, type: 'number' },
      { label: L('Highest speed', 'Kasi ya juu zaidi'), value: r.reduce((a, x) => Math.max(a, Number(x.speed_kph) || 0), 0), type: 'number' },
      { label: L('Time over limit', 'Muda juu ya kikomo'), value: sum(r, 'duration_s'), type: 'duration' },
    ],
  },
  geofence: {
    title: L('Geofence report', 'Ripoti ya maeneo'),
    columns: [
      col('occurred_at', 'Time', 'Saa', 'datetime'), PLATE, DRIVER, col('geofence', 'Geofence', 'Eneo', 'text', 22), col('event_type', 'Event', 'Tukio', 'text', 10),
      col('dwell_s', 'Time inside', 'Muda ndani', 'duration'), col('speed_kph', 'Speed km/h', 'Kasi km/h', 'number'),
    ],
    sql: `SELECT ge.occurred_at, v.plate_number, d.full_name AS driver_name, gf.name AS geofence, ge.event_type, ge.dwell_s, ge.speed_kph
      FROM geofence_events ge JOIN vehicles v ON v.id = ge.vehicle_id JOIN geofences gf ON gf.id = ge.geofence_id LEFT JOIN drivers d ON d.id = ge.driver_id
      WHERE ge.tenant_id = $1 AND ge.occurred_at >= $2 AND ge.occurred_at < $3 AND ${VEH} AND ($6::uuid[] IS NULL OR ge.driver_id = ANY($6))
      ORDER BY ge.occurred_at LIMIT 50000`,
    summary: (r) => [
      { label: L('Entries', 'Kuingia'), value: r.filter((x) => x.event_type === 'enter').length, type: 'number' },
      { label: L('Exits', 'Kutoka'), value: r.filter((x) => x.event_type === 'exit').length, type: 'number' },
    ],
  },
  maintenance: {
    title: L('Maintenance report', 'Ripoti ya matengenezo'),
    columns: [
      col('number', 'Work order', 'Agizo', 'text', 10), PLATE, col('title', 'Work', 'Kazi', 'text', 26), col('wo_type', 'Type', 'Aina', 'text', 10),
      col('status', 'Status', 'Hali', 'text', 10), col('opened_at', 'Opened', 'Imefunguliwa', 'date'), col('completed_at', 'Completed', 'Imekamilika', 'date'),
      col('downtime_h', 'Downtime (h)', 'Muda nje (saa)', 'decimal'), col('labour_cost', 'Labour', 'Ufundi', 'money'), col('parts_cost', 'Parts', 'Vipuri', 'money'),
      col('total_cost', 'Total', 'Jumla', 'money'),
    ],
    sql: `SELECT w.number, v.plate_number, w.title, w.wo_type, w.status, w.created_at AS opened_at, w.completed_at,
      CASE WHEN w.completed_at IS NOT NULL AND w.started_at IS NOT NULL THEN round(extract(epoch FROM w.completed_at - w.started_at) / 3600, 1) END AS downtime_h,
      w.labour_cost, w.parts_cost, w.total_cost
      FROM work_orders w JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.tenant_id = $1 AND w.deleted_at IS NULL AND coalesce(w.completed_at, w.created_at) >= $2 AND coalesce(w.completed_at, w.created_at) < $3 AND ${VEH}
      ORDER BY coalesce(w.completed_at, w.created_at)`,
    summary: (r) => [
      { label: L('Work orders', 'Maagizo'), value: r.length, type: 'number' },
      { label: L('Completed', 'Yamekamilika'), value: r.filter((x) => x.status === 'completed').length, type: 'number' },
      { label: L('Maintenance cost', 'Gharama ya matengenezo'), value: sum(r, 'total_cost'), type: 'money' },
      { label: L('Downtime (h)', 'Muda nje (saa)'), value: sum(r, 'downtime_h'), type: 'decimal' },
    ],
  },
  driver_scores: {
    title: L('Driver scorecard', 'Alama za madereva'),
    columns: [
      col('rank', '#', '#', 'number', 4), DRIVER, col('score', 'Score', 'Alama', 'decimal'), col('distance_km', 'Distance (km)', 'Umbali (km)', 'decimal'),
      col('driving_s', 'Driving time', 'Muda wa kuendesha', 'duration'), col('harsh_brake', 'Harsh brake', 'Breki kali', 'number'),
      col('harsh_accel', 'Harsh accel.', 'Kuongeza kasi ghafla', 'number'), col('harsh_corner', 'Harsh corner', 'Kona kali', 'number'),
      col('overspeed_count', 'Overspeed', 'Mwendo kasi', 'number'), col('idle_s', 'Excess idle', 'Kusimama kupita kiasi', 'duration'),
      col('night_driving_s', 'Night driving', 'Kuendesha usiku', 'duration'), col('per_100km', 'Events / 100 km', 'Matukio/100 km', 'decimal'),
    ],
    sql: `SELECT row_number() OVER (ORDER BY round(sum(s.score * greatest(s.distance_km, 1)) / sum(greatest(s.distance_km, 1)), 1) DESC) AS rank, d.full_name AS driver_name,
      round(sum(s.score * greatest(s.distance_km, 1)) / sum(greatest(s.distance_km, 1)), 1) AS score, sum(s.distance_km) AS distance_km, sum(s.driving_s) AS driving_s,
      sum(s.harsh_brake) AS harsh_brake, sum(s.harsh_accel) AS harsh_accel, sum(s.harsh_corner) AS harsh_corner, sum(s.overspeed_count) AS overspeed_count,
      sum(s.idle_s) AS idle_s, sum(s.night_driving_s) AS night_driving_s,
      round((sum(s.harsh_brake + s.harsh_accel + s.harsh_corner + s.overspeed_count)) / greatest(sum(s.distance_km), 1) * 100, 2) AS per_100km
      FROM driver_daily_scores s JOIN drivers d ON d.id = s.driver_id
      WHERE s.tenant_id = $1 AND s.day BETWEEN $7::date AND $8::date AND d.deleted_at IS NULL AND ${DRV}
      GROUP BY d.id ORDER BY score DESC`,
    summary: (r) => [
      { label: L('Drivers', 'Madereva'), value: r.length, type: 'number' },
      {
        label: L('Fleet score', 'Alama ya kundi'),
        value: sum(r, 'distance_km') > 0 ? Math.round((r.reduce((a, x) => a + Number(x.score) * Math.max(Number(x.distance_km), 1), 0) / r.reduce((a, x) => a + Math.max(Number(x.distance_km), 1), 0)) * 10) / 10 : 0,
        type: 'decimal',
      },
      { label: L('Harsh events', 'Matukio makali'), value: sum(r, 'harsh_brake') + sum(r, 'harsh_accel') + sum(r, 'harsh_corner'), type: 'number' },
    ],
  },
  utilisation: {
    title: L('Utilisation report', 'Ripoti ya matumizi ya magari'),
    columns: [
      PLATE, col('days', 'Days', 'Siku', 'number'), col('active_days', 'Active days', 'Siku za kazi', 'number'), col('active_pct', 'Days used', 'Asilimia ya siku', 'percent'),
      col('engine_hours', 'Engine hours', 'Saa za injini', 'decimal'), col('driving_s', 'Driving', 'Kuendesha', 'duration'), col('idle_s', 'Idling', 'Kusimama', 'duration'),
      col('idle_pct', 'Idle share', 'Asilimia ya kusimama', 'percent'), col('utilisation_pct', 'Utilisation (10 h day)', 'Matumizi (siku ya saa 10)', 'percent'),
    ],
    sql: `SELECT v.plate_number, ($8::date - $7::date + 1) AS days, count(*) FILTER (WHERE s.distance_km > 0) AS active_days,
      round(100.0 * count(*) FILTER (WHERE s.distance_km > 0) / ($8::date - $7::date + 1), 1) AS active_pct, coalesce(sum(s.engine_hours), 0) AS engine_hours,
      coalesce(sum(s.driving_s), 0) AS driving_s, coalesce(sum(s.idle_s), 0) AS idle_s,
      CASE WHEN sum(s.driving_s + s.idle_s) > 0 THEN round(100.0 * sum(s.idle_s) / sum(s.driving_s + s.idle_s), 1) END AS idle_pct,
      round(coalesce(sum(s.utilisation_pct), 0) / ($8::date - $7::date + 1), 1) AS utilisation_pct
      FROM vehicles v LEFT JOIN vehicle_daily_stats s ON s.vehicle_id = v.id AND s.day BETWEEN $7::date AND $8::date
      WHERE v.tenant_id = $1 AND v.deleted_at IS NULL AND v.status NOT IN ('sold', 'written_off') AND ${VEH}
      GROUP BY v.id ORDER BY utilisation_pct DESC`,
    summary: (r) => [
      { label: L('Vehicles', 'Magari'), value: r.length, type: 'number' },
      { label: L('Average utilisation', 'Wastani wa matumizi'), value: r.length ? Math.round((sum(r, 'utilisation_pct') / r.length) * 10) / 10 : 0, type: 'percent' },
      { label: L('Idle time', 'Muda wa kusimama'), value: sum(r, 'idle_s'), type: 'duration' },
    ],
  },
  idle: {
    title: L('Idling report', 'Ripoti ya kusimama injini ikiwaka'),
    columns: [
      col('occurred_at', 'Start', 'Mwanzo', 'datetime'), PLATE, DRIVER, col('duration_s', 'Duration', 'Muda', 'duration'),
      col('fuel_wasted_l', 'Est. fuel (L)', 'Mafuta yaliyopotea (L)', 'decimal'), col('location', 'Location', 'Mahali', 'text', 24),
    ],
    sql: `SELECT e.occurred_at, v.plate_number, d.full_name AS driver_name, coalesce(e.duration_s, e.value)::int AS duration_s,
      round((coalesce(e.duration_s, e.value) / 3600.0 * CASE WHEN v.body_type IN ('truck', 'prime_mover', 'bus', 'tanker') THEN 2.5 WHEN v.body_type = 'motorcycle' THEN 0.2 ELSE 0.8 END)::numeric, 2) AS fuel_wasted_l,
      round(e.lat::numeric, 5) || ', ' || round(e.lng::numeric, 5) AS location
      FROM driving_events e JOIN vehicles v ON v.id = e.vehicle_id LEFT JOIN drivers d ON d.id = e.driver_id
      WHERE e.tenant_id = $1 AND e.event_type = 'excessive_idle' AND e.occurred_at >= $2 AND e.occurred_at < $3 AND ${VEH}
        AND ($6::uuid[] IS NULL OR e.driver_id = ANY($6))
      ORDER BY e.occurred_at LIMIT 50000`,
    summary: (r) => [
      { label: L('Idle events', 'Matukio'), value: r.length, type: 'number' },
      { label: L('Idle time', 'Muda wa kusimama'), value: sum(r, 'duration_s'), type: 'duration' },
      { label: L('Est. fuel wasted (L)', 'Mafuta yaliyopotea (L)'), value: sum(r, 'fuel_wasted_l'), type: 'decimal' },
    ],
  },
  alerts: {
    title: L('Alerts report', 'Ripoti ya tahadhari'),
    columns: [
      col('occurred_at', 'Time', 'Saa', 'datetime'), col('alert_type', 'Type', 'Aina', 'text', 14), col('severity', 'Severity', 'Uzito', 'text', 8),
      col('title', 'Alert', 'Tahadhari', 'text', 30), PLATE, DRIVER, col('status', 'Status', 'Hali', 'text', 10),
      col('acknowledged_by_name', 'Handled by', 'Imeshughulikiwa na', 'text', 16), col('response_s', 'Response time', 'Muda wa kujibu', 'duration'),
    ],
    sql: `SELECT a.occurred_at, a.alert_type, a.severity, a.title, v.plate_number, d.full_name AS driver_name, a.status, u.full_name AS acknowledged_by_name,
      CASE WHEN a.acknowledged_at IS NOT NULL THEN extract(epoch FROM a.acknowledged_at - a.occurred_at)::int END AS response_s
      FROM alerts a LEFT JOIN vehicles v ON v.id = a.vehicle_id LEFT JOIN drivers d ON d.id = a.driver_id LEFT JOIN users u ON u.id = a.acknowledged_by
      WHERE a.tenant_id = $1 AND a.occurred_at >= $2 AND a.occurred_at < $3 AND ($4::uuid[] IS NULL OR a.vehicle_id = ANY($4))
        AND ($5::uuid IS NULL OR v.group_id = $5) AND ($6::uuid[] IS NULL OR a.driver_id = ANY($6))
      ORDER BY a.occurred_at LIMIT 50000`,
    summary: (r) => [
      { label: L('Alerts', 'Tahadhari'), value: r.length, type: 'number' },
      { label: L('Critical', 'Hatari'), value: r.filter((x) => x.severity === 'critical').length, type: 'number' },
      { label: L('Unhandled', 'Hazijashughulikiwa'), value: r.filter((x) => x.status === 'open').length, type: 'number' },
    ],
  },
  executive_summary: {
    title: L('Executive summary', 'Muhtasari wa uongozi'),
    columns: [col('metric', 'Metric', 'Kipimo', 'text', 34), col('value', 'Value', 'Thamani', 'text', 18), col('previous', 'Previous period', 'Kipindi kilichopita', 'text', 18), col('change', 'Change', 'Mabadiliko', 'text', 10)],
    sql: '', // built in code (two periods)
  },
};
