-- 0003_telemetry
-- Partitioned GPS points and raw packets, partition maintenance, device status, trips, stops, events, DTCs.

-- ---------------------------------------------------------------- partition maintenance
-- Creates one partition per UTC day in [p_from, p_to]. Runs with owner rights; new partitions
-- are closed to the API role so tenant RLS on the parent table can never be bypassed.
CREATE OR REPLACE FUNCTION app.ensure_daily_partitions(p_parent regclass, p_from date, p_to date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_parent  text := (SELECT relname FROM pg_class WHERE oid = p_parent);
  v_day     date := p_from;
  v_name    text;
  v_created integer := 0;
BEGIN
  IF p_to < p_from THEN
    RAISE EXCEPTION 'ensure_daily_partitions: p_to (%) is before p_from (%)', p_to, p_from;
  END IF;
  IF p_to - p_from > 400 THEN
    RAISE EXCEPTION 'ensure_daily_partitions: range too large (% days)', p_to - p_from;
  END IF;
  WHILE v_day <= p_to LOOP
    v_name := v_parent || '_p' || to_char(v_day, 'YYYYMMDD');
    IF to_regclass('public.' || quote_ident(v_name)) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        v_name, p_parent,
        (v_day::timestamp AT TIME ZONE 'UTC'),
        ((v_day + 1)::timestamp AT TIME ZONE 'UTC'));
      EXECUTE format('REVOKE ALL ON public.%I FROM jfs_app', v_name);
      v_created := v_created + 1;
    END IF;
    v_day := v_day + 1;
  END LOOP;
  RETURN v_created;
END
$$;

-- Drops daily partitions whose day is strictly before p_before. Returns the number dropped.
CREATE OR REPLACE FUNCTION app.drop_daily_partitions_before(p_parent regclass, p_before date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_parent  text := (SELECT relname FROM pg_class WHERE oid = p_parent);
  r         record;
  v_dropped integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = p_parent
      AND c.relname ~ ('^' || v_parent || '_p[0-9]{8}$')
  LOOP
    IF to_date(right(r.relname, 8), 'YYYYMMDD') < p_before THEN
      EXECUTE format('DROP TABLE public.%I', r.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;
  RETURN v_dropped;
END
$$;

REVOKE ALL ON FUNCTION app.ensure_daily_partitions(regclass, date, date) FROM PUBLIC, jfs_app;
REVOKE ALL ON FUNCTION app.drop_daily_partitions_before(regclass, date) FROM PUBLIC, jfs_app;
GRANT EXECUTE ON FUNCTION app.ensure_daily_partitions(regclass, date, date) TO jfs_system;
GRANT EXECUTE ON FUNCTION app.drop_daily_partitions_before(regclass, date) TO jfs_system;

-- ---------------------------------------------------------------- gps points (daily partitions)
CREATE TABLE gps_points (
  tenant_id           uuid NOT NULL,
  device_id           uuid NOT NULL,
  vehicle_id          uuid,
  driver_id           uuid,
  recorded_at         timestamptz NOT NULL,              -- device fix time (UTC)
  received_at         timestamptz NOT NULL DEFAULT now(),
  lat                 double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                 double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  altitude_m          smallint,
  speed_kph           smallint NOT NULL DEFAULT 0 CHECK (speed_kph BETWEEN 0 AND 400),
  heading             smallint CHECK (heading BETWEEN 0 AND 359),
  satellites          smallint,
  hdop                real,
  is_valid            boolean NOT NULL DEFAULT true,     -- GPS fix valid
  ignition            boolean,
  movement            boolean,
  odometer_km         numeric(12, 1),
  engine_hours        numeric(10, 1),
  fuel_level_pct      real,
  fuel_level_l        real,
  ext_voltage_mv      integer,
  battery_voltage_mv  integer,
  gsm_signal          smallint,
  event_code          text,
  io                  jsonb,
  PRIMARY KEY (device_id, recorded_at)
) PARTITION BY RANGE (recorded_at);
CREATE INDEX gps_points_vehicle_time_idx ON gps_points (vehicle_id, recorded_at);
CREATE INDEX gps_points_tenant_time_idx ON gps_points (tenant_id, recorded_at);
SELECT app.enable_tenant_rls('gps_points');
REVOKE INSERT, UPDATE, DELETE ON gps_points FROM jfs_app;

-- ---------------------------------------------------------------- raw packets (debug, super admin only)
CREATE TABLE raw_packets (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     uuid,
  device_id     uuid,
  identifier    text,
  protocol      text NOT NULL,
  remote_addr   inet,
  payload       bytea NOT NULL,
  decode_error  text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);
CREATE INDEX raw_packets_identifier_idx ON raw_packets (identifier, received_at DESC);
REVOKE ALL ON raw_packets FROM jfs_app;

SELECT app.ensure_daily_partitions('gps_points', current_date - 35, current_date + 7);
SELECT app.ensure_daily_partitions('raw_packets', current_date - 7, current_date + 7);

-- ---------------------------------------------------------------- device status (latest state)
CREATE TABLE device_status (
  device_id           uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id          uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  driver_id           uuid REFERENCES drivers(id) ON DELETE SET NULL,
  state               text NOT NULL DEFAULT 'never' CHECK (state IN ('moving', 'idle', 'stopped', 'offline', 'never')),
  state_since         timestamptz,
  last_seen_at        timestamptz,                       -- last packet received
  last_fix_at         timestamptz,                       -- last valid GPS fix
  lat                 double precision,
  lng                 double precision,
  speed_kph           smallint,
  heading             smallint,
  satellites          smallint,
  ignition            boolean,
  movement            boolean,
  odometer_km         numeric(12, 1),
  engine_hours        numeric(10, 1),
  fuel_level_pct      real,
  fuel_level_l        real,
  ext_voltage_mv      integer,
  battery_voltage_mv  integer,
  gsm_signal          smallint,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_status_tenant_state_idx ON device_status (tenant_id, state);
CREATE INDEX device_status_vehicle_idx ON device_status (vehicle_id);
SELECT app.enable_tenant_rls('device_status');
REVOKE INSERT, UPDATE, DELETE ON device_status FROM jfs_app;

-- ---------------------------------------------------------------- trips
CREATE TABLE trips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id         uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  device_id          uuid REFERENCES devices(id) ON DELETE SET NULL,
  driver_id          uuid REFERENCES drivers(id) ON DELETE SET NULL,
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,                        -- NULL = trip in progress
  start_lat          double precision NOT NULL,
  start_lng          double precision NOT NULL,
  end_lat            double precision,
  end_lng            double precision,
  start_address      text,
  end_address        text,
  distance_km        numeric(10, 2) NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
  duration_s         integer NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  moving_s           integer NOT NULL DEFAULT 0 CHECK (moving_s >= 0),
  idle_s             integer NOT NULL DEFAULT 0 CHECK (idle_s >= 0),
  max_speed_kph      smallint NOT NULL DEFAULT 0,
  avg_speed_kph      numeric(5, 1) NOT NULL DEFAULT 0,
  start_odometer_km  numeric(12, 1),
  end_odometer_km    numeric(12, 1),
  fuel_used_l        numeric(8, 2),
  harsh_event_count  integer NOT NULL DEFAULT 0,
  overspeed_count    integer NOT NULL DEFAULT 0,
  route_polyline     text,                               -- encoded, simplified
  purpose            text NOT NULL DEFAULT 'business' CHECK (purpose IN ('business', 'private', 'commute', 'unknown')),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT trips_vehicle_no_overlap
    EXCLUDE USING gist (vehicle_id WITH =, tstzrange(started_at, ended_at) WITH &&)
);
CREATE INDEX trips_vehicle_time_idx ON trips (tenant_id, vehicle_id, started_at DESC);
CREATE INDEX trips_driver_time_idx ON trips (tenant_id, driver_id, started_at DESC);
CREATE INDEX trips_open_idx ON trips (vehicle_id) WHERE ended_at IS NULL;
SELECT app.enable_tenant_rls('trips');
REVOKE INSERT, UPDATE, DELETE ON trips FROM jfs_app;
GRANT UPDATE (purpose, notes) ON trips TO jfs_app;

-- ---------------------------------------------------------------- stops
CREATE TABLE stops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
  driver_id    uuid REFERENCES drivers(id) ON DELETE SET NULL,
  trip_id      uuid REFERENCES trips(id) ON DELETE SET NULL,  -- the trip that ended at this stop
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  duration_s   integer NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  address      text,
  ignition_on  boolean NOT NULL DEFAULT false,               -- true = idling, false = parked
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX stops_vehicle_time_idx ON stops (tenant_id, vehicle_id, started_at DESC);
SELECT app.enable_tenant_rls('stops');
REVOKE INSERT, UPDATE, DELETE ON stops FROM jfs_app;

-- ---------------------------------------------------------------- driving events
CREATE TABLE driving_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id       uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  driver_id        uuid REFERENCES drivers(id) ON DELETE SET NULL,
  trip_id          uuid REFERENCES trips(id) ON DELETE SET NULL,
  event_type       text NOT NULL CHECK (event_type IN (
                     'harsh_brake', 'harsh_accel', 'harsh_corner', 'overspeed', 'excessive_idle',
                     'night_driving', 'sos', 'power_cut', 'low_battery', 'tamper', 'towing',
                     'crash', 'fatigue', 'seatbelt', 'unauthorized_driver')),
  severity         text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  occurred_at      timestamptz NOT NULL,
  ended_at         timestamptz,
  duration_s       integer,
  lat              double precision,
  lng              double precision,
  speed_kph        smallint,
  speed_limit_kph  smallint,
  value            numeric(10, 3),                         -- g-force, km/h over limit, idle seconds...
  source           text NOT NULL DEFAULT 'computed' CHECK (source IN ('device', 'computed', 'app')),
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at      timestamptz,
  reviewed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driving_events_dedupe UNIQUE (device_id, event_type, occurred_at)
);
CREATE INDEX driving_events_tenant_time_idx ON driving_events (tenant_id, occurred_at DESC);
CREATE INDEX driving_events_driver_time_idx ON driving_events (driver_id, occurred_at DESC);
CREATE INDEX driving_events_vehicle_time_idx ON driving_events (vehicle_id, occurred_at DESC);
CREATE INDEX driving_events_trip_idx ON driving_events (trip_id);
SELECT app.enable_tenant_rls('driving_events');
REVOKE INSERT, UPDATE, DELETE ON driving_events FROM jfs_app;
GRANT UPDATE (reviewed_at, reviewed_by, review_note) ON driving_events TO jfs_app;

-- ---------------------------------------------------------------- diagnostic trouble codes
CREATE TABLE dtc_codes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  device_id      uuid REFERENCES devices(id) ON DELETE SET NULL,
  code           text NOT NULL CHECK (code ~ '^[PCBU][0-9A-F]{4}$'),
  description    text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'cleared')),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  occurrences    integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  cleared_at     timestamptz,
  cleared_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dtc_codes_open_unique ON dtc_codes (vehicle_id, code) WHERE status <> 'cleared';
CREATE INDEX dtc_codes_tenant_status_idx ON dtc_codes (tenant_id, status, last_seen_at DESC);
SELECT app.enable_tenant_rls('dtc_codes');
REVOKE INSERT, UPDATE, DELETE ON dtc_codes FROM jfs_app;
GRANT UPDATE (status, cleared_at, cleared_by) ON dtc_codes TO jfs_app;

SELECT app.track_updated_at(t) FROM unnest(ARRAY['trips', 'dtc_codes']::regclass[]) AS t;