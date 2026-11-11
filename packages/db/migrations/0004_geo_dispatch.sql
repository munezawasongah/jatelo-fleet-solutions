-- 0004_geo_dispatch
-- Points of interest, geofences (circle/polygon/corridor), presence and events,
-- planned routes, dispatch jobs and stops, proof of delivery, job timeline, share links.

-- ---------------------------------------------------------------- points of interest
CREATE TABLE pois (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  category       text NOT NULL DEFAULT 'other' CHECK (category IN (
                   'depot', 'customer', 'supplier', 'fuel_station', 'workshop', 'parking',
                   'border_post', 'weighbridge', 'police_checkpoint', 'other')),
  geom           geometry(Point, 4326) NOT NULL,
  radius_m       integer NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 10 AND 5000),
  address        text,
  contact_name   text,
  contact_phone  text,
  external_ref   text,
  notes          text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX pois_geom_gist ON pois USING gist (geom) WHERE deleted_at IS NULL;
CREATE INDEX pois_category_idx ON pois (tenant_id, category) WHERE deleted_at IS NULL;
CREATE INDEX pois_name_trgm ON pois USING gin (lower(name) gin_trgm_ops);
CREATE UNIQUE INDEX pois_external_ref_unique ON pois (tenant_id, external_ref)
  WHERE external_ref IS NOT NULL AND deleted_at IS NULL;
SELECT app.enable_tenant_rls('pois');

ALTER TABLE stops ADD COLUMN poi_id uuid REFERENCES pois(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- geofences
CREATE TABLE geofences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description     text,
  shape           text NOT NULL CHECK (shape IN ('circle', 'polygon', 'corridor')),
  center          geometry(Point, 4326),                 -- circle centre; label point for others
  radius_m        integer CHECK (radius_m IS NULL OR radius_m BETWEEN 20 AND 100000),
  path            geometry(LineString, 4326),            -- corridor centre line
  width_m         integer CHECK (width_m IS NULL OR width_m BETWEEN 20 AND 5000),
  geom            geometry(Geometry, 4326) NOT NULL,     -- always a valid MULTIPOLYGON (set by trigger)
  speed_limit_kph smallint CHECK (speed_limit_kph IS NULL OR speed_limit_kph BETWEEN 5 AND 200),
  color           text NOT NULL DEFAULT '#2563EB' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  applies_to_all  boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  poi_id          uuid REFERENCES pois(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT geofences_geom_multipolygon CHECK (GeometryType(geom) = 'MULTIPOLYGON' AND ST_IsValid(geom))
);
CREATE INDEX geofences_geom_gist ON geofences USING gist (geom) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX geofences_tenant_idx ON geofences (tenant_id) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('geofences');

CREATE OR REPLACE FUNCTION app.compute_geofence_geom() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shape = 'circle' THEN
    IF NEW.center IS NULL OR NEW.radius_m IS NULL THEN
      RAISE EXCEPTION 'circle geofence requires center and radius_m' USING ERRCODE = '23514';
    END IF;
    NEW.geom := ST_Multi(ST_Buffer(NEW.center::geography, NEW.radius_m, 16)::geometry);
    NEW.path := NULL; NEW.width_m := NULL;
  ELSIF NEW.shape = 'corridor' THEN
    IF NEW.path IS NULL OR NEW.width_m IS NULL THEN
      RAISE EXCEPTION 'corridor geofence requires path and width_m' USING ERRCODE = '23514';
    END IF;
    NEW.geom := ST_Multi(ST_Buffer(NEW.path::geography, NEW.width_m / 2.0, 8)::geometry);
    NEW.center := ST_LineInterpolatePoint(NEW.path, 0.5);
    NEW.radius_m := NULL;
  ELSE
    IF NEW.geom IS NULL THEN
      RAISE EXCEPTION 'polygon geofence requires geom' USING ERRCODE = '23514';
    END IF;
    NEW.geom := ST_Multi(ST_CollectionExtract(ST_MakeValid(NEW.geom), 3));
    IF ST_IsEmpty(NEW.geom) THEN
      RAISE EXCEPTION 'polygon geofence has no area' USING ERRCODE = '23514';
    END IF;
    NEW.center := ST_PointOnSurface(NEW.geom);
    NEW.radius_m := NULL; NEW.path := NULL; NEW.width_m := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_compute_geofence_geom BEFORE INSERT OR UPDATE ON geofences
  FOR EACH ROW EXECUTE FUNCTION app.compute_geofence_geom();

CREATE TABLE geofence_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geofence_id     uuid NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  group_id        uuid REFERENCES vehicle_groups(id) ON DELETE CASCADE,
  alert_on_entry  boolean NOT NULL DEFAULT true,
  alert_on_exit   boolean NOT NULL DEFAULT true,
  dwell_minutes   integer CHECK (dwell_minutes IS NULL OR dwell_minutes BETWEEN 1 AND 10080),
  schedule        jsonb,                                  -- {"days":[1..7],"start":"06:00","end":"20:00"}; NULL = always
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((vehicle_id IS NOT NULL) <> (group_id IS NOT NULL))
);
CREATE UNIQUE INDEX geofence_assignments_vehicle_unique ON geofence_assignments (geofence_id, vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE UNIQUE INDEX geofence_assignments_group_unique ON geofence_assignments (geofence_id, group_id) WHERE group_id IS NOT NULL;
SELECT app.enable_tenant_rls('geofence_assignments');

-- Which vehicle is currently inside which geofence (maintained by the worker).
CREATE TABLE geofence_presence (
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  geofence_id   uuid NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entered_at    timestamptz NOT NULL,
  dwell_alerted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (vehicle_id, geofence_id)
);
SELECT app.enable_tenant_rls('geofence_presence');
REVOKE INSERT, UPDATE, DELETE ON geofence_presence FROM jfs_app;

CREATE TABLE geofence_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geofence_id  uuid NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
  driver_id    uuid REFERENCES drivers(id) ON DELETE SET NULL,
  event_type   text NOT NULL CHECK (event_type IN ('enter', 'exit', 'dwell')),
  occurred_at  timestamptz NOT NULL,
  lat          double precision,
  lng          double precision,
  speed_kph    smallint,
  dwell_s      integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT geofence_events_dedupe UNIQUE (vehicle_id, geofence_id, event_type, occurred_at)
);
CREATE INDEX geofence_events_tenant_time_idx ON geofence_events (tenant_id, occurred_at DESC);
CREATE INDEX geofence_events_geofence_time_idx ON geofence_events (geofence_id, occurred_at DESC);
SELECT app.enable_tenant_rls('geofence_events');
REVOKE INSERT, UPDATE, DELETE ON geofence_events FROM jfs_app;

-- ---------------------------------------------------------------- planned routes (templates)
CREATE TABLE routes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description            text,
  profile                text NOT NULL DEFAULT 'car' CHECK (profile IN ('car', 'truck', 'motorcycle')),
  optimize_order         boolean NOT NULL DEFAULT false,
  return_to_start        boolean NOT NULL DEFAULT false,
  geometry               geometry(LineString, 4326),
  distance_km            numeric(10, 2),
  duration_s             integer,
  deviation_threshold_m  integer NOT NULL DEFAULT 500 CHECK (deviation_threshold_m BETWEEN 50 AND 20000),
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz
);
CREATE INDEX routes_tenant_idx ON routes (tenant_id) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('routes');

CREATE TABLE route_stops (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id             uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq                  integer NOT NULL CHECK (seq >= 1),
  poi_id               uuid REFERENCES pois(id) ON DELETE SET NULL,
  name                 text NOT NULL,
  geom                 geometry(Point, 4326) NOT NULL,
  address              text,
  service_minutes      integer NOT NULL DEFAULT 0 CHECK (service_minutes BETWEEN 0 AND 1440),
  time_window_start    time,
  time_window_end      time,
  CONSTRAINT route_stops_seq_unique UNIQUE (route_id, seq) DEFERRABLE INITIALLY DEFERRED
);
SELECT app.enable_tenant_rls('route_stops');

-- ---------------------------------------------------------------- dispatch jobs
CREATE TABLE jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference              text NOT NULL,
  title                  text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  customer_name          text,
  customer_phone         text,
  vehicle_id             uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  driver_id              uuid REFERENCES drivers(id) ON DELETE SET NULL,
  route_id               uuid REFERENCES routes(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN (
                           'draft', 'scheduled', 'dispatched', 'in_progress', 'completed', 'cancelled', 'failed')),
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  scheduled_start        timestamptz,
  scheduled_end          timestamptz,
  actual_start           timestamptz,
  actual_end             timestamptz,
  planned_geometry       geometry(LineString, 4326),
  planned_distance_km    numeric(10, 2),
  planned_duration_s     integer,
  actual_distance_km     numeric(10, 2),
  deviation_threshold_m  integer NOT NULL DEFAULT 500 CHECK (deviation_threshold_m BETWEEN 50 AND 20000),
  notes                  text,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start),
  CHECK (actual_end IS NULL OR actual_start IS NULL OR actual_end >= actual_start)
);
CREATE UNIQUE INDEX jobs_reference_unique ON jobs (tenant_id, reference);
CREATE INDEX jobs_status_idx ON jobs (tenant_id, status, scheduled_start) WHERE deleted_at IS NULL;
CREATE INDEX jobs_driver_idx ON jobs (driver_id, scheduled_start) WHERE deleted_at IS NULL;
CREATE INDEX jobs_vehicle_idx ON jobs (vehicle_id, scheduled_start) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('jobs');

CREATE TABLE job_stops (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id             uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq                integer NOT NULL CHECK (seq >= 1),
  stop_type          text NOT NULL DEFAULT 'delivery' CHECK (stop_type IN ('pickup', 'delivery', 'service', 'waypoint')),
  poi_id             uuid REFERENCES pois(id) ON DELETE SET NULL,
  name               text NOT NULL,
  geom               geometry(Point, 4326) NOT NULL,
  arrival_radius_m   integer NOT NULL DEFAULT 150 CHECK (arrival_radius_m BETWEEN 20 AND 5000),
  address            text,
  contact_name       text,
  contact_phone      text,
  instructions       text,
  items              jsonb NOT NULL DEFAULT '[]'::jsonb,
  time_window_start  timestamptz,
  time_window_end    timestamptz,
  planned_arrival    timestamptz,
  eta                timestamptz,
  arrived_at         timestamptz,
  departed_at        timestamptz,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'en_route', 'arrived', 'completed', 'failed', 'skipped')),
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_stops_seq_unique UNIQUE (job_id, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK (time_window_end IS NULL OR time_window_start IS NULL OR time_window_end >= time_window_start),
  CHECK (departed_at IS NULL OR arrived_at IS NULL OR departed_at >= arrived_at)
);
CREATE INDEX job_stops_job_idx ON job_stops (job_id, seq);
CREATE INDEX job_stops_geom_gist ON job_stops USING gist (geom);
SELECT app.enable_tenant_rls('job_stops');

CREATE TABLE proof_of_delivery (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_stop_id         uuid NOT NULL UNIQUE REFERENCES job_stops(id) ON DELETE CASCADE,
  recipient_name      text NOT NULL,
  recipient_phone     text,
  signature_file_id   uuid REFERENCES files(id) ON DELETE SET NULL,
  photo_file_ids      uuid[] NOT NULL DEFAULT '{}',
  notes               text,
  lat                 double precision,
  lng                 double precision,
  captured_at         timestamptz NOT NULL,
  driver_id           uuid REFERENCES drivers(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('proof_of_delivery');

CREATE TABLE job_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_stop_id  uuid REFERENCES job_stops(id) ON DELETE SET NULL,
  event_type   text NOT NULL CHECK (event_type IN (
                 'created', 'status_change', 'assigned', 'deviation', 'back_on_route',
                 'arrived', 'departed', 'eta_update', 'pod_captured', 'note')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  lat          double precision,
  lng          double precision,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type   text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'driver', 'system')),
  actor_id     uuid
);
CREATE INDEX job_events_job_time_idx ON job_events (job_id, occurred_at);
SELECT app.enable_tenant_rls('job_events');
REVOKE UPDATE, DELETE ON job_events FROM jfs_app;

-- ---------------------------------------------------------------- customer share links
CREATE TABLE share_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  job_id          uuid REFERENCES jobs(id) ON DELETE CASCADE,
  label           text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  view_count      integer NOT NULL DEFAULT 0,
  last_viewed_at  timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((vehicle_id IS NOT NULL) <> (job_id IS NOT NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);
CREATE INDEX share_links_tenant_idx ON share_links (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('share_links');

SELECT app.track_updated_at(t) FROM unnest(ARRAY[
  'pois', 'geofences', 'routes', 'jobs', 'job_stops'
]::regclass[]) AS t;