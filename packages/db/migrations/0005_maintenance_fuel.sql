-- 0005_maintenance_fuel
-- Cross-tenant reference integrity, maintenance (schedules, reminders, parts, inspections,
-- defects, work orders) and fuel (cards, logs, imports, sensor events, prices).

-- ---------------------------------------------------------------- cross-tenant reference integrity
-- Foreign keys ignore RLS, so a leaked id from another tenant could otherwise be referenced.
-- Trigger args are 'column:table' pairs; every referenced row must share NEW.tenant_id.
CREATE OR REPLACE FUNCTION app.assert_tenant_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  i         integer;
  v_col     text;
  v_tbl     text;
  v_id      uuid;
  v_tenant  uuid;
  v_new     jsonb := to_jsonb(NEW);
  v_old     jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    v_col := split_part(TG_ARGV[i], ':', 1);
    v_tbl := split_part(TG_ARGV[i], ':', 2);
    v_id  := NULLIF(v_new ->> v_col, '')::uuid;
    CONTINUE WHEN v_id IS NULL;
    CONTINUE WHEN v_old IS NOT NULL
              AND (v_old ->> v_col) IS NOT DISTINCT FROM (v_new ->> v_col)
              AND (v_old ->> 'tenant_id') IS NOT DISTINCT FROM (v_new ->> 'tenant_id');
    EXECUTE format('SELECT tenant_id FROM public.%I WHERE id = $1', v_tbl) INTO v_tenant USING v_id;
    IF v_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'cross-tenant reference rejected: %.% -> %', TG_TABLE_NAME, v_col, v_tbl
        USING ERRCODE = '23503';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.add_tenant_ref_check(p_table regclass, VARIADIC p_refs text[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_tenant_refs ON %s', p_table);
  EXECUTE format(
    'CREATE TRIGGER trg_tenant_refs BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.assert_tenant_refs(%s)',
    p_table, (SELECT string_agg(quote_literal(r), ', ') FROM unnest(p_refs) AS r));
END
$$;

-- Existing tables (0002, 0004)
SELECT app.add_tenant_ref_check('vehicle_groups', 'parent_id:vehicle_groups');
SELECT app.add_tenant_ref_check('user_group_access', 'user_id:users', 'group_id:vehicle_groups');
SELECT app.add_tenant_ref_check('vehicles', 'group_id:vehicle_groups', 'photo_file_id:files');
SELECT app.add_tenant_ref_check('vehicle_documents', 'vehicle_id:vehicles', 'file_id:files');
SELECT app.add_tenant_ref_check('device_assignments', 'device_id:devices', 'vehicle_id:vehicles');
SELECT app.add_tenant_ref_check('drivers', 'user_id:users', 'photo_file_id:files');
SELECT app.add_tenant_ref_check('driver_licences', 'driver_id:drivers', 'file_id:files');
SELECT app.add_tenant_ref_check('driver_identifiers', 'driver_id:drivers');
SELECT app.add_tenant_ref_check('driver_vehicle_assignments', 'driver_id:drivers', 'vehicle_id:vehicles');
SELECT app.add_tenant_ref_check('shifts', 'driver_id:drivers', 'vehicle_id:vehicles');
SELECT app.add_tenant_ref_check('geofences', 'poi_id:pois');
SELECT app.add_tenant_ref_check('geofence_assignments', 'geofence_id:geofences', 'vehicle_id:vehicles', 'group_id:vehicle_groups');
SELECT app.add_tenant_ref_check('route_stops', 'route_id:routes', 'poi_id:pois');
SELECT app.add_tenant_ref_check('jobs', 'vehicle_id:vehicles', 'driver_id:drivers', 'route_id:routes');
SELECT app.add_tenant_ref_check('job_stops', 'job_id:jobs', 'poi_id:pois');
SELECT app.add_tenant_ref_check('proof_of_delivery', 'job_stop_id:job_stops', 'signature_file_id:files', 'driver_id:drivers');
SELECT app.add_tenant_ref_check('job_events', 'job_id:jobs', 'job_stop_id:job_stops');
SELECT app.add_tenant_ref_check('share_links', 'vehicle_id:vehicles', 'job_id:jobs');

-- ---------------------------------------------------------------- service catalogue & schedules
CREATE TABLE service_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  category            text NOT NULL DEFAULT 'other' CHECK (category IN (
                        'engine', 'oil_service', 'brakes', 'tyres', 'electrical', 'body', 'transmission',
                        'suspension', 'cooling', 'air_conditioning', 'inspection', 'other')),
  description         text,
  est_labour_hours    numeric(6, 2) CHECK (est_labour_hours IS NULL OR est_labour_hours >= 0),
  est_cost            numeric(14, 2) CHECK (est_cost IS NULL OR est_cost >= 0),
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX service_tasks_name_unique ON service_tasks (tenant_id, lower(name)) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('service_tasks');

CREATE TABLE service_schedules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id           uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  service_task_id      uuid REFERENCES service_tasks(id) ON DELETE SET NULL,
  name                 text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  interval_km          numeric(10, 1) CHECK (interval_km IS NULL OR interval_km > 0),
  interval_hours       numeric(10, 1) CHECK (interval_hours IS NULL OR interval_hours > 0),
  interval_days        integer CHECK (interval_days IS NULL OR interval_days > 0),
  remind_before_km     numeric(10, 1) NOT NULL DEFAULT 500 CHECK (remind_before_km >= 0),
  remind_before_hours  numeric(10, 1) NOT NULL DEFAULT 10 CHECK (remind_before_hours >= 0),
  remind_before_days   integer NOT NULL DEFAULT 7 CHECK (remind_before_days >= 0),
  last_done_at         timestamptz,
  last_done_km         numeric(12, 1),
  last_done_hours      numeric(10, 1),
  next_due_at          timestamptz,
  next_due_km          numeric(12, 1),
  next_due_hours       numeric(10, 1),
  status               text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'due_soon', 'due', 'overdue')),
  cycle                integer NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  notes                text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CHECK (interval_km IS NOT NULL OR interval_hours IS NOT NULL OR interval_days IS NOT NULL)
);
CREATE INDEX service_schedules_vehicle_idx ON service_schedules (vehicle_id) WHERE deleted_at IS NULL;
CREATE INDEX service_schedules_status_idx ON service_schedules (tenant_id, status) WHERE deleted_at IS NULL AND is_active;
SELECT app.enable_tenant_rls('service_schedules');
SELECT app.add_tenant_ref_check('service_schedules', 'vehicle_id:vehicles', 'service_task_id:service_tasks');

CREATE OR REPLACE FUNCTION app.compute_schedule_due() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.next_due_km    := CASE WHEN NEW.interval_km IS NOT NULL AND NEW.last_done_km IS NOT NULL
                             THEN NEW.last_done_km + NEW.interval_km END;
  NEW.next_due_hours := CASE WHEN NEW.interval_hours IS NOT NULL AND NEW.last_done_hours IS NOT NULL
                             THEN NEW.last_done_hours + NEW.interval_hours END;
  NEW.next_due_at    := CASE WHEN NEW.interval_days IS NOT NULL AND NEW.last_done_at IS NOT NULL
                             THEN NEW.last_done_at + make_interval(days => NEW.interval_days) END;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_compute_schedule_due BEFORE INSERT OR UPDATE ON service_schedules
  FOR EACH ROW EXECUTE FUNCTION app.compute_schedule_due();

CREATE TABLE service_reminders (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_id      uuid NOT NULL REFERENCES service_schedules(id) ON DELETE CASCADE,
  vehicle_id       uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  cycle            integer NOT NULL,
  stage            text NOT NULL CHECK (stage IN ('due_soon', 'due', 'overdue')),
  triggered_at     timestamptz NOT NULL DEFAULT now(),
  due_at           timestamptz,
  due_km           numeric(12, 1),
  due_hours        numeric(10, 1),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT service_reminders_once UNIQUE (schedule_id, cycle, stage)
);
CREATE INDEX service_reminders_tenant_time_idx ON service_reminders (tenant_id, triggered_at DESC);
SELECT app.enable_tenant_rls('service_reminders');
REVOKE INSERT, UPDATE, DELETE ON service_reminders FROM jfs_app;
GRANT UPDATE (acknowledged_at, acknowledged_by) ON service_reminders TO jfs_app;

-- ---------------------------------------------------------------- parts inventory
CREATE TABLE parts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  part_number        text,
  name               text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  category           text,
  unit               text NOT NULL DEFAULT 'pcs' CHECK (unit IN ('pcs', 'litre', 'set', 'pair', 'metre', 'kg')),
  unit_cost          numeric(14, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  currency           currency_code NOT NULL,
  quantity_on_hand   numeric(12, 2) NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  reorder_level      numeric(12, 2) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  reorder_qty        numeric(12, 2) NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  location           text,
  supplier_name      text,
  supplier_contact   text,
  compatible_models  text,
  is_active          boolean NOT NULL DEFAULT true,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX parts_number_unique ON parts (tenant_id, upper(part_number))
  WHERE part_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX parts_low_stock_idx ON parts (tenant_id) WHERE deleted_at IS NULL AND quantity_on_hand <= reorder_level;
CREATE INDEX parts_name_trgm ON parts USING gin (lower(name) gin_trgm_ops);
SELECT app.enable_tenant_rls('parts');
REVOKE UPDATE ON parts FROM jfs_app;
GRANT UPDATE (part_number, name, category, unit, unit_cost, currency, reorder_level, reorder_qty, location,
              supplier_name, supplier_contact, compatible_models, is_active, notes, deleted_at) ON parts TO jfs_app;

-- ---------------------------------------------------------------- work orders (before movements, which reference them)
CREATE TABLE work_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            text NOT NULL,
  vehicle_id        uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 160),
  description       text,
  wo_type           text NOT NULL DEFAULT 'corrective' CHECK (wo_type IN (
                      'preventive', 'corrective', 'inspection', 'accident', 'recall', 'tyre')),
  priority          text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN (
                      'open', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled')),
  assigned_to       uuid REFERENCES users(id) ON DELETE SET NULL,      -- mechanic
  vendor_name       text,                                               -- external garage
  scheduled_for     timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  odometer_km       numeric(12, 1),
  engine_hours      numeric(10, 1),
  labour_cost       numeric(14, 2) NOT NULL DEFAULT 0,
  parts_cost        numeric(14, 2) NOT NULL DEFAULT 0,
  other_cost        numeric(14, 2) NOT NULL DEFAULT 0,
  total_cost        numeric(14, 2) GENERATED ALWAYS AS (labour_cost + parts_cost + other_cost) STORED,
  currency          currency_code NOT NULL DEFAULT 'KES',
  invoice_number    text,
  invoice_file_id   uuid REFERENCES files(id) ON DELETE SET NULL,
  notes             text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);
CREATE UNIQUE INDEX work_orders_number_unique ON work_orders (tenant_id, number);
CREATE INDEX work_orders_status_idx ON work_orders (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX work_orders_vehicle_idx ON work_orders (vehicle_id, created_at DESC) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('work_orders');
SELECT app.add_tenant_ref_check('work_orders', 'vehicle_id:vehicles', 'assigned_to:users', 'invoice_file_id:files');
REVOKE UPDATE ON work_orders FROM jfs_app;
GRANT UPDATE (number, vehicle_id, title, description, wo_type, priority, status, assigned_to, vendor_name,
              scheduled_for, started_at, completed_at, odometer_km, engine_hours, currency, invoice_number,
              invoice_file_id, notes, deleted_at) ON work_orders TO jfs_app;

CREATE TABLE work_order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_order_id    uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  item_type        text NOT NULL CHECK (item_type IN ('labour', 'part', 'service', 'other')),
  service_task_id  uuid REFERENCES service_tasks(id) ON DELETE SET NULL,
  schedule_id      uuid REFERENCES service_schedules(id) ON DELETE SET NULL,  -- completing a scheduled service
  part_id          uuid REFERENCES parts(id) ON DELETE SET NULL,
  mechanic_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  description      text NOT NULL,
  quantity         numeric(12, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),       -- hours for labour
  unit_cost        numeric(14, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  total            numeric(14, 2) GENERATED ALWAYS AS (round(quantity * unit_cost, 2)) STORED,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_order_items_wo_idx ON work_order_items (work_order_id);
SELECT app.enable_tenant_rls('work_order_items');
SELECT app.add_tenant_ref_check('work_order_items', 'work_order_id:work_orders', 'service_task_id:service_tasks',
                                'schedule_id:service_schedules', 'part_id:parts', 'mechanic_id:users');

CREATE OR REPLACE FUNCTION app.work_order_recalc(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE work_orders w SET
    labour_cost = coalesce((SELECT sum(total) FROM work_order_items WHERE work_order_id = p_id AND item_type = 'labour'), 0),
    parts_cost  = coalesce((SELECT sum(total) FROM work_order_items WHERE work_order_id = p_id AND item_type = 'part'), 0),
    other_cost  = coalesce((SELECT sum(total) FROM work_order_items WHERE work_order_id = p_id AND item_type IN ('service', 'other')), 0)
  WHERE w.id = p_id;
$$;
REVOKE ALL ON FUNCTION app.work_order_recalc(uuid) FROM PUBLIC, jfs_app;

CREATE OR REPLACE FUNCTION app.work_order_items_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM app.work_order_recalc(OLD.work_order_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM app.work_order_recalc(NEW.work_order_id); END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER trg_work_order_items_totals AFTER INSERT OR UPDATE OR DELETE ON work_order_items
  FOR EACH ROW EXECUTE FUNCTION app.work_order_items_changed();

ALTER TABLE dtc_codes ADD COLUMN work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL;
GRANT UPDATE (work_order_id) ON dtc_codes TO jfs_app;
SELECT app.add_tenant_ref_check('dtc_codes', 'work_order_id:work_orders');

-- ---------------------------------------------------------------- stock ledger (append-only)
CREATE TABLE part_stock_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  part_id        uuid NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  movement_type  text NOT NULL CHECK (movement_type IN (
                   'purchase', 'issue', 'return', 'adjustment', 'transfer_in', 'transfer_out')),
  quantity       numeric(12, 2) NOT NULL,          -- positive; adjustment may be +/-
  unit_cost      numeric(14, 2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  reference      text,
  work_order_id  uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  notes          text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((movement_type = 'adjustment' AND quantity <> 0) OR (movement_type <> 'adjustment' AND quantity > 0))
);
CREATE INDEX part_stock_movements_part_idx ON part_stock_movements (part_id, created_at DESC);
SELECT app.enable_tenant_rls('part_stock_movements');
SELECT app.add_tenant_ref_check('part_stock_movements', 'part_id:parts', 'work_order_id:work_orders');
REVOKE UPDATE, DELETE ON part_stock_movements FROM jfs_app;

CREATE OR REPLACE FUNCTION app.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_delta numeric := CASE
    WHEN NEW.movement_type IN ('purchase', 'return', 'transfer_in') THEN NEW.quantity
    WHEN NEW.movement_type IN ('issue', 'transfer_out') THEN -NEW.quantity
    ELSE NEW.quantity END;
BEGIN
  UPDATE parts SET quantity_on_hand = quantity_on_hand + v_delta
  WHERE id = NEW.part_id AND tenant_id = NEW.tenant_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER trg_apply_stock_movement AFTER INSERT ON part_stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_movement();

-- ---------------------------------------------------------------- inspections & defects
CREATE TABLE inspection_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  inspection_type   text NOT NULL DEFAULT 'pre_trip' CHECK (inspection_type IN ('pre_trip', 'post_trip', 'periodic')),
  body_types        text[],                         -- NULL = all vehicle types
  is_default        boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
SELECT app.enable_tenant_rls('inspection_templates');

CREATE TABLE inspection_template_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id            uuid NOT NULL REFERENCES inspection_templates(id) ON DELETE CASCADE,
  seq                    integer NOT NULL CHECK (seq >= 1),
  label                  text NOT NULL,
  label_sw               text,
  category               text NOT NULL DEFAULT 'general',
  is_critical            boolean NOT NULL DEFAULT false,      -- critical defect = vehicle unsafe
  requires_photo_on_fail boolean NOT NULL DEFAULT true,
  CONSTRAINT inspection_template_items_seq UNIQUE (template_id, seq) DEFERRABLE INITIALLY DEFERRED
);
SELECT app.enable_tenant_rls('inspection_template_items');
SELECT app.add_tenant_ref_check('inspection_template_items', 'template_id:inspection_templates');

CREATE TABLE inspections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id         uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  driver_id          uuid REFERENCES drivers(id) ON DELETE SET NULL,
  template_id        uuid REFERENCES inspection_templates(id) ON DELETE SET NULL,
  inspection_type    text NOT NULL CHECK (inspection_type IN ('pre_trip', 'post_trip', 'periodic')),
  started_at         timestamptz NOT NULL,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  odometer_km        numeric(12, 1),
  lat                double precision,
  lng                double precision,
  result             text NOT NULL CHECK (result IN ('pass', 'pass_with_defects', 'fail')),
  signature_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inspections_vehicle_idx ON inspections (vehicle_id, submitted_at DESC);
CREATE INDEX inspections_tenant_idx ON inspections (tenant_id, submitted_at DESC);
SELECT app.enable_tenant_rls('inspections');
SELECT app.add_tenant_ref_check('inspections', 'vehicle_id:vehicles', 'driver_id:drivers',
                                'template_id:inspection_templates', 'signature_file_id:files');

CREATE TABLE inspection_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inspection_id     uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  template_item_id  uuid REFERENCES inspection_template_items(id) ON DELETE SET NULL,
  label             text NOT NULL,                     -- snapshot of the item label
  category          text NOT NULL DEFAULT 'general',
  status            text NOT NULL CHECK (status IN ('ok', 'defect', 'na')),
  is_critical       boolean NOT NULL DEFAULT false,
  note              text,
  photo_file_ids    uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX inspection_results_inspection_idx ON inspection_results (inspection_id);
SELECT app.enable_tenant_rls('inspection_results');
SELECT app.add_tenant_ref_check('inspection_results', 'inspection_id:inspections', 'template_item_id:inspection_template_items');

CREATE TABLE defects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id             uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  inspection_result_id   uuid REFERENCES inspection_results(id) ON DELETE SET NULL,
  reported_by_driver_id  uuid REFERENCES drivers(id) ON DELETE SET NULL,
  reported_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  title                  text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 160),
  description            text,
  severity               text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major', 'critical')),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'deferred', 'rejected')),
  work_order_id          uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  photo_file_ids         uuid[] NOT NULL DEFAULT '{}',
  reported_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  resolution_note        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX defects_open_idx ON defects (tenant_id, status, severity) WHERE status IN ('open', 'in_progress');
CREATE INDEX defects_vehicle_idx ON defects (vehicle_id, reported_at DESC);
SELECT app.enable_tenant_rls('defects');
SELECT app.add_tenant_ref_check('defects', 'vehicle_id:vehicles', 'inspection_result_id:inspection_results',
                                'reported_by_driver_id:drivers', 'work_order_id:work_orders');

-- ---------------------------------------------------------------- fuel
CREATE TABLE fuel_cards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN (
                       'totalenergies', 'rubis', 'shell', 'vivo', 'ola', 'puma', 'oryx', 'gulf', 'other')),
  card_last4         char(4) NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),   -- never store full card numbers
  label              text,
  vehicle_id         uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  driver_id          uuid REFERENCES drivers(id) ON DELETE SET NULL,
  monthly_limit      numeric(14, 2) CHECK (monthly_limit IS NULL OR monthly_limit > 0),
  currency           currency_code NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'expired', 'lost')),
  expires_on         date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX fuel_cards_tenant_idx ON fuel_cards (tenant_id) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('fuel_cards');
SELECT app.add_tenant_ref_check('fuel_cards', 'vehicle_id:vehicles', 'driver_id:drivers');

CREATE TABLE fuel_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  file_id         uuid REFERENCES files(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  rows_total      integer NOT NULL DEFAULT 0,
  rows_imported   integer NOT NULL DEFAULT 0,
  rows_skipped    integer NOT NULL DEFAULT 0,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,         -- [{row, message}]
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
SELECT app.enable_tenant_rls('fuel_import_batches');
SELECT app.add_tenant_ref_check('fuel_import_batches', 'file_id:files');

CREATE TABLE fuel_logs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id               uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  driver_id                uuid REFERENCES drivers(id) ON DELETE SET NULL,
  fuel_card_id             uuid REFERENCES fuel_cards(id) ON DELETE SET NULL,
  filled_at                timestamptz NOT NULL,
  litres                   numeric(8, 2) NOT NULL CHECK (litres > 0 AND litres <= 2000),
  unit_price               numeric(10, 3) CHECK (unit_price IS NULL OR unit_price > 0),
  total_cost               numeric(14, 2) NOT NULL CHECK (total_cost >= 0),
  currency                 currency_code NOT NULL,
  odometer_km              numeric(12, 1) CHECK (odometer_km IS NULL OR odometer_km >= 0),
  is_full_tank             boolean NOT NULL DEFAULT true,
  fuel_type                text NOT NULL DEFAULT 'diesel' CHECK (fuel_type IN ('petrol', 'diesel', 'lpg', 'cng', 'adblue')),
  station_name             text,
  poi_id                   uuid REFERENCES pois(id) ON DELETE SET NULL,
  lat                      double precision,
  lng                      double precision,
  receipt_number           text,
  receipt_file_id          uuid REFERENCES files(id) ON DELETE SET NULL,
  source                   text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'app', 'card_import', 'sensor')),
  external_ref             text,
  import_batch_id          uuid REFERENCES fuel_import_batches(id) ON DELETE SET NULL,
  distance_since_last_km   numeric(10, 1),             -- full-tank to full-tank, set by worker
  consumption_l_per_100km  numeric(6, 2),
  flags                    text[] NOT NULL DEFAULT '{}',  -- e.g. over_tank_capacity, location_mismatch, duplicate
  verified                 boolean NOT NULL DEFAULT false,
  notes                    text,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz
);
CREATE INDEX fuel_logs_vehicle_time_idx ON fuel_logs (vehicle_id, filled_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX fuel_logs_tenant_time_idx ON fuel_logs (tenant_id, filled_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX fuel_logs_driver_time_idx ON fuel_logs (driver_id, filled_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX fuel_logs_external_ref_unique ON fuel_logs (tenant_id, source, external_ref)
  WHERE external_ref IS NOT NULL AND deleted_at IS NULL;
SELECT app.enable_tenant_rls('fuel_logs');
SELECT app.add_tenant_ref_check('fuel_logs', 'vehicle_id:vehicles', 'driver_id:drivers', 'fuel_card_id:fuel_cards',
                                'poi_id:pois', 'receipt_file_id:files', 'import_batch_id:fuel_import_batches');

CREATE TABLE fuel_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vehicle_id           uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  device_id            uuid REFERENCES devices(id) ON DELETE SET NULL,
  driver_id            uuid REFERENCES drivers(id) ON DELETE SET NULL,
  event_type           text NOT NULL CHECK (event_type IN ('refuel', 'drain', 'sensor_fault')),
  started_at           timestamptz NOT NULL,
  ended_at             timestamptz,
  level_before_l       numeric(8, 2),
  level_after_l        numeric(8, 2),
  change_l             numeric(8, 2),
  lat                  double precision,
  lng                  double precision,
  matched_fuel_log_id  uuid REFERENCES fuel_logs(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  reviewed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at          timestamptz,
  review_note          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fuel_events_dedupe UNIQUE (vehicle_id, event_type, started_at)
);
CREATE INDEX fuel_events_tenant_time_idx ON fuel_events (tenant_id, started_at DESC);
SELECT app.enable_tenant_rls('fuel_events');
REVOKE INSERT, UPDATE, DELETE ON fuel_events FROM jfs_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note, matched_fuel_log_id) ON fuel_events TO jfs_app;
SELECT app.add_tenant_ref_check('fuel_events', 'matched_fuel_log_id:fuel_logs');

CREATE TABLE fuel_prices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fuel_type        text NOT NULL CHECK (fuel_type IN ('petrol', 'diesel', 'lpg', 'cng')),
  price_per_litre  numeric(10, 3) NOT NULL CHECK (price_per_litre > 0),
  currency         currency_code NOT NULL,
  effective_from   date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fuel_prices_unique UNIQUE (tenant_id, fuel_type, effective_from)
);
SELECT app.enable_tenant_rls('fuel_prices');

-- ---------------------------------------------------------------- updated_at triggers
SELECT app.track_updated_at(t) FROM unnest(ARRAY[
  'service_tasks', 'service_schedules', 'parts', 'work_orders', 'inspection_templates',
  'defects', 'fuel_cards', 'fuel_logs'
]::regclass[]) AS t;