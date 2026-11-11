-- 0002_fleet_registry
-- Files, vehicle groups, vehicles, documents, devices, drivers, licences, identifiers, assignments, shifts.

-- ---------------------------------------------------------------- files (uploads registry)
CREATE TABLE files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key    text NOT NULL UNIQUE,
  purpose        text NOT NULL CHECK (purpose IN (
                   'vehicle_document', 'driver_licence', 'driver_photo', 'vehicle_photo', 'inspection',
                   'fuel_receipt', 'proof_of_delivery', 'work_order', 'tenant_logo', 'import', 'report', 'other')),
  original_name  text NOT NULL,
  content_type   text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 52428800),
  sha256         text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  uploaded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_tenant_purpose_idx ON files (tenant_id, purpose, created_at DESC);
SELECT app.enable_tenant_rls('files');

-- ---------------------------------------------------------------- vehicle groups
CREATE TABLE vehicle_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES vehicle_groups(id) ON DELETE SET NULL,
  name         citext NOT NULL CHECK (length(trim(name::text)) BETWEEN 1 AND 80),
  description  text,
  color        text CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX vehicle_groups_name_unique ON vehicle_groups (tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX vehicle_groups_parent_idx ON vehicle_groups (parent_id);
SELECT app.enable_tenant_rls('vehicle_groups');

-- Restricts a user (e.g. fleet manager / dispatcher) to specific groups. No rows = access to all.
CREATE TABLE user_group_access (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES vehicle_groups(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX user_group_access_group_idx ON user_group_access (group_id);
SELECT app.enable_tenant_rls('user_group_access');

-- ---------------------------------------------------------------- vehicles
CREATE TABLE vehicles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id                uuid REFERENCES vehicle_groups(id) ON DELETE SET NULL,
  plate_number            text NOT NULL CHECK (length(plate_number) BETWEEN 2 AND 20),
  plate_normalized        text GENERATED ALWAYS AS (upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g'))) STORED,
  fleet_number            text,
  label                   text,
  vin                     citext CHECK (vin IS NULL OR vin::text ~ '^[A-HJ-NPR-Za-hj-npr-z0-9]{11,17}$'),
  make                    text,
  model                   text,
  year                    smallint CHECK (year IS NULL OR year BETWEEN 1950 AND 2100),
  color                   text,
  body_type               text NOT NULL DEFAULT 'other' CHECK (body_type IN (
                            'saloon', 'hatchback', 'suv', 'pickup', 'van', 'minibus', 'bus', 'truck',
                            'prime_mover', 'trailer', 'tanker', 'motorcycle', 'tuk_tuk', 'other')),
  usage_type              text NOT NULL DEFAULT 'commercial' CHECK (usage_type IN (
                            'private', 'commercial', 'psv', 'government', 'ngo')),
  fuel_type               text NOT NULL DEFAULT 'diesel' CHECK (fuel_type IN (
                            'petrol', 'diesel', 'electric', 'hybrid', 'lpg', 'cng')),
  tank_capacity_l         numeric(7, 2) CHECK (tank_capacity_l IS NULL OR tank_capacity_l > 0),
  expected_l_per_100km    numeric(6, 2) CHECK (expected_l_per_100km IS NULL OR expected_l_per_100km > 0),
  seating_capacity        smallint CHECK (seating_capacity IS NULL OR seating_capacity > 0),
  payload_kg              integer CHECK (payload_kg IS NULL OR payload_kg > 0),
  speed_limit_kph         smallint CHECK (speed_limit_kph IS NULL OR speed_limit_kph BETWEEN 20 AND 200),
  speed_governor_fitted   boolean NOT NULL DEFAULT false,
  odometer_km             numeric(12, 1) NOT NULL DEFAULT 0 CHECK (odometer_km >= 0),
  engine_hours            numeric(10, 1) NOT NULL DEFAULT 0 CHECK (engine_hours >= 0),
  odometer_source         text NOT NULL DEFAULT 'gps' CHECK (odometer_source IN ('manual', 'gps', 'can')),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN (
                            'active', 'in_maintenance', 'inactive', 'sold', 'written_off')),
  purchase_date           date,
  purchase_price          numeric(14, 2) CHECK (purchase_price IS NULL OR purchase_price >= 0),
  photo_file_id           uuid REFERENCES files(id) ON DELETE SET NULL,
  icon                    text NOT NULL DEFAULT 'car',
  notes                   text,
  custom_fields           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);
CREATE UNIQUE INDEX vehicles_plate_unique ON vehicles (tenant_id, plate_normalized) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX vehicles_vin_unique ON vehicles (tenant_id, vin) WHERE vin IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX vehicles_group_idx ON vehicles (tenant_id, group_id) WHERE deleted_at IS NULL;
CREATE INDEX vehicles_status_idx ON vehicles (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX vehicles_search_trgm ON vehicles
  USING gin ((plate_normalized || ' ' || coalesce(lower(label), '') || ' ' || coalesce(lower(fleet_number), '')) gin_trgm_ops);
SELECT app.enable_tenant_rls('vehicles');

CREATE OR REPLACE FUNCTION app.normalize_vehicle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.plate_number := upper(regexp_replace(trim(NEW.plate_number), '\s+', ' ', 'g'));
  IF NEW.vin IS NOT NULL THEN NEW.vin := upper(trim(NEW.vin::text)); END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_normalize_vehicle BEFORE INSERT OR UPDATE OF plate_number, vin ON vehicles
  FOR EACH ROW EXECUTE FUNCTION app.normalize_vehicle();

-- ---------------------------------------------------------------- vehicle documents
CREATE TABLE vehicle_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id       uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  doc_type         text NOT NULL CHECK (doc_type IN (
                     'insurance', 'ntsa_inspection', 'tra_inspection', 'road_licence', 'psv_licence',
                     'logbook', 'speed_governor_cert', 'tracking_cert', 'transit_permit', 'comesa_card', 'other')),
  document_number  text,
  provider         text,
  issued_on        date,
  expires_on       date,
  reminder_days    integer[] NOT NULL DEFAULT '{30,14,7,1}',
  file_id          uuid REFERENCES files(id) ON DELETE SET NULL,
  notes            text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX vehicle_documents_vehicle_idx ON vehicle_documents (vehicle_id) WHERE deleted_at IS NULL;
CREATE INDEX vehicle_documents_expiry_idx ON vehicle_documents (tenant_id, expires_on) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('vehicle_documents');

-- ---------------------------------------------------------------- devices (provisioned by Jatelo)
CREATE TABLE devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid REFERENCES tenants(id) ON DELETE SET NULL,   -- NULL = Jatelo stock
  identifier        text NOT NULL UNIQUE CHECK (identifier ~ '^[A-Za-z0-9_-]{6,40}$'), -- IMEI or app device id
  protocol          text NOT NULL CHECK (protocol IN ('teltonika', 'gt06', 'queclink', 'http_json')),
  model             text,
  firmware          text,
  sim_iccid         text,
  sim_msisdn        text,
  sim_provider      text,
  auth_token_hash   text,                                              -- http_json devices (phones)
  status            text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'active', 'suspended', 'retired')),
  capabilities      jsonb NOT NULL DEFAULT '{}'::jsonb,
  io_mapping        jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_at      timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (status = 'in_stock' OR tenant_id IS NOT NULL OR status = 'retired')
);
CREATE INDEX devices_tenant_idx ON devices (tenant_id) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('devices');

CREATE TABLE device_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id      uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  unassigned_at  timestamptz,
  assigned_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  notes          text,
  CHECK (unassigned_at IS NULL OR unassigned_at > assigned_at),
  CONSTRAINT device_assignments_device_no_overlap
    EXCLUDE USING gist (device_id WITH =, tstzrange(assigned_at, unassigned_at) WITH &&),
  CONSTRAINT device_assignments_vehicle_no_overlap
    EXCLUDE USING gist (vehicle_id WITH =, tstzrange(assigned_at, unassigned_at) WITH &&)
);
CREATE INDEX device_assignments_active_device ON device_assignments (device_id) WHERE unassigned_at IS NULL;
CREATE INDEX device_assignments_active_vehicle ON device_assignments (vehicle_id) WHERE unassigned_at IS NULL;
SELECT app.enable_tenant_rls('device_assignments');

-- ---------------------------------------------------------------- drivers
CREATE TABLE drivers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                   uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,  -- driver app login
  employee_number           text,
  full_name                 text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 120),
  phone                     text,
  email                     citext,
  national_id               text,
  date_of_birth             date,
  photo_file_id             uuid REFERENCES files(id) ON DELETE SET NULL,
  address                   text,
  emergency_contact_name    text,
  emergency_contact_phone   text,
  hire_date                 date,
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive', 'terminated')),
  notes                     text,
  custom_fields             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz
);
CREATE UNIQUE INDEX drivers_employee_number_unique ON drivers (tenant_id, employee_number)
  WHERE employee_number IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX drivers_national_id_unique ON drivers (tenant_id, national_id)
  WHERE national_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX drivers_status_idx ON drivers (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX drivers_search_trgm ON drivers USING gin (lower(full_name) gin_trgm_ops);
SELECT app.enable_tenant_rls('drivers');

CREATE TABLE driver_licences (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id         uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  licence_type      text NOT NULL CHECK (licence_type IN ('driving', 'psv_badge', 'hazmat', 'defensive_driving', 'other')),
  licence_number    text NOT NULL,
  classes           text[] NOT NULL DEFAULT '{}',
  issuing_country   country_code,
  issued_on         date,
  expires_on        date,
  reminder_days     integer[] NOT NULL DEFAULT '{30,14,7,1}',
  file_id           uuid REFERENCES files(id) ON DELETE SET NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX driver_licences_driver_idx ON driver_licences (driver_id) WHERE deleted_at IS NULL;
CREATE INDEX driver_licences_expiry_idx ON driver_licences (tenant_id, expires_on) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('driver_licences');

CREATE TABLE driver_identifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id   uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('rfid', 'ibutton')),
  value       text NOT NULL CHECK (value ~ '^[A-Fa-f0-9]{4,32}$'),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX driver_identifiers_unique ON driver_identifiers (tenant_id, kind, upper(value));
CREATE INDEX driver_identifiers_driver_idx ON driver_identifiers (driver_id);
SELECT app.enable_tenant_rls('driver_identifiers');

CREATE TABLE driver_vehicle_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id        uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  vehicle_id       uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz,
  assignment_type  text NOT NULL DEFAULT 'primary' CHECK (assignment_type IN ('primary', 'temporary')),
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'rfid', 'app', 'dispatch')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT dva_driver_no_overlap
    EXCLUDE USING gist (driver_id WITH =, tstzrange(starts_at, ends_at) WITH &&),
  CONSTRAINT dva_vehicle_no_overlap
    EXCLUDE USING gist (vehicle_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);
CREATE INDEX dva_active_vehicle ON driver_vehicle_assignments (vehicle_id) WHERE ends_at IS NULL;
CREATE INDEX dva_active_driver ON driver_vehicle_assignments (driver_id) WHERE ends_at IS NULL;
SELECT app.enable_tenant_rls('driver_vehicle_assignments');

-- ---------------------------------------------------------------- shifts
CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id     uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  vehicle_id    uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  actual_start  timestamptz,
  actual_end    timestamptz,
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'missed', 'cancelled')),
  notes         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (actual_end IS NULL OR actual_start IS NULL OR actual_end > actual_start)
);
CREATE INDEX shifts_tenant_start_idx ON shifts (tenant_id, starts_at);
CREATE INDEX shifts_driver_idx ON shifts (driver_id, starts_at);
SELECT app.enable_tenant_rls('shifts');

-- ---------------------------------------------------------------- triggers & privilege limits
SELECT app.track_updated_at(t) FROM unnest(ARRAY[
  'vehicle_groups', 'vehicles', 'vehicle_documents', 'devices', 'drivers', 'driver_licences', 'shifts'
]::regclass[]) AS t;

-- Devices are provisioned by Jatelo; tenants may only edit their notes.
REVOKE INSERT, UPDATE, DELETE ON devices FROM jfs_app;
GRANT UPDATE (notes) ON devices TO jfs_app;