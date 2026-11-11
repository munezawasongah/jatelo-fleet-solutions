-- 0006_alerts_analytics_billing
-- Alert rules/targets/recipients, alerts, deliveries, in-app notifications, push tokens, webhooks,
-- driver messaging, daily vehicle stats, driver scores, report schedules/runs, invoices, payments, M-Pesa.

-- ---------------------------------------------------------------- alert rules
CREATE TABLE alert_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  description       text,
  rule_type         text NOT NULL CHECK (rule_type IN (
                      'overspeed', 'harsh_event', 'geofence_enter', 'geofence_exit', 'geofence_dwell',
                      'ignition_on', 'ignition_off', 'idle', 'device_offline', 'low_battery', 'power_cut',
                      'sos', 'tamper', 'towing', 'crash', 'fuel_drain', 'refuel', 'fuel_level_low',
                      'service_due', 'document_expiry', 'licence_expiry', 'dtc', 'route_deviation',
                      'job_late', 'unauthorized_driver', 'after_hours_use', 'inspection_failed', 'defect_critical')),
  conditions        jsonb NOT NULL DEFAULT '{}'::jsonb,       -- e.g. {"speed_kph":80,"min_duration_s":10}
  applies_to_all    boolean NOT NULL DEFAULT true,
  schedule          jsonb,                                     -- {"days":[1..7],"start":"06:00","end":"20:00"}; NULL = always
  severity          text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  cooldown_minutes  integer NOT NULL DEFAULT 15 CHECK (cooldown_minutes BETWEEN 0 AND 10080),
  channels          text[] NOT NULL DEFAULT '{in_app}' CHECK (
                      cardinality(channels) >= 1
                      AND channels <@ ARRAY['in_app', 'sms', 'email', 'push', 'webhook']::text[]),
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX alert_rules_active_idx ON alert_rules (tenant_id, rule_type) WHERE deleted_at IS NULL AND is_active;
SELECT app.enable_tenant_rls('alert_rules');

CREATE TABLE alert_rule_targets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id      uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  vehicle_id   uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  group_id     uuid REFERENCES vehicle_groups(id) ON DELETE CASCADE,
  driver_id    uuid REFERENCES drivers(id) ON DELETE CASCADE,
  geofence_id  uuid REFERENCES geofences(id) ON DELETE CASCADE,
  CHECK (num_nonnulls(vehicle_id, group_id, driver_id, geofence_id) = 1)
);
CREATE INDEX alert_rule_targets_rule_idx ON alert_rule_targets (rule_id);
SELECT app.enable_tenant_rls('alert_rule_targets');
SELECT app.add_tenant_ref_check('alert_rule_targets', 'rule_id:alert_rules', 'vehicle_id:vehicles',
                                'group_id:vehicle_groups', 'driver_id:drivers', 'geofence_id:geofences');

CREATE TABLE alert_rule_recipients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id    uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  role       text CHECK (role IS NULL OR role IN (
               'company_admin', 'fleet_manager', 'dispatcher', 'mechanic', 'accountant', 'driver')),
  phone      text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  email      citext,
  CHECK (num_nonnulls(user_id, role, phone, email) = 1)
);
CREATE INDEX alert_rule_recipients_rule_idx ON alert_rule_recipients (rule_id);
SELECT app.enable_tenant_rls('alert_rule_recipients');
SELECT app.add_tenant_ref_check('alert_rule_recipients', 'rule_id:alert_rules', 'user_id:users');

-- ---------------------------------------------------------------- alerts (written by the worker)
CREATE TABLE alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id          uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  alert_type       text NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title            text NOT NULL,
  message          text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,       -- values for re-rendering in en/sw
  vehicle_id       uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  driver_id        uuid REFERENCES drivers(id) ON DELETE SET NULL,
  device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
  geofence_id      uuid REFERENCES geofences(id) ON DELETE SET NULL,
  job_id           uuid REFERENCES jobs(id) ON DELETE SET NULL,
  source_type      text,                                     -- e.g. driving_events, fuel_events
  source_id        text,
  occurred_at      timestamptz NOT NULL,
  lat              double precision,
  lng              double precision,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  note             text,
  dedupe_key       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_dedupe_unique ON alerts (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX alerts_tenant_time_idx ON alerts (tenant_id, occurred_at DESC);
CREATE INDEX alerts_open_idx ON alerts (tenant_id, severity, occurred_at DESC) WHERE status = 'open';
CREATE INDEX alerts_vehicle_time_idx ON alerts (vehicle_id, occurred_at DESC);
SELECT app.enable_tenant_rls('alerts');
REVOKE INSERT, UPDATE, DELETE ON alerts FROM jfs_app;
GRANT UPDATE (status, acknowledged_at, acknowledged_by, resolved_at, resolved_by, note) ON alerts TO jfs_app;

CREATE TABLE alert_deliveries (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alert_id             uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel              text NOT NULL CHECK (channel IN ('in_app', 'sms', 'email', 'push', 'webhook')),
  user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient            text NOT NULL,                        -- phone, email, token id, webhook id
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  provider             text,
  provider_message_id  text,
  attempts             integer NOT NULL DEFAULT 0,
  error                text,
  cost                 numeric(10, 4),
  cost_currency        currency_code,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_deliveries_alert_idx ON alert_deliveries (alert_id);
CREATE INDEX alert_deliveries_provider_idx ON alert_deliveries (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
SELECT app.enable_tenant_rls('alert_deliveries');
REVOKE INSERT, UPDATE, DELETE ON alert_deliveries FROM jfs_app;

-- ---------------------------------------------------------------- in-app notifications & push tokens (own user only)
CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id    uuid REFERENCES alerts(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_user_time_idx ON notifications (user_id, created_at DESC);
SELECT app.enable_tenant_rls('notifications');
CREATE POLICY own_user ON notifications AS RESTRICTIVE
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
REVOKE INSERT, UPDATE ON notifications FROM jfs_app;
GRANT UPDATE (read_at) ON notifications TO jfs_app;

CREATE TABLE push_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         text NOT NULL UNIQUE,
  platform      text NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  device_name   text,
  app_version   text,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id);
SELECT app.enable_tenant_rls('push_tokens');
CREATE POLICY own_user ON push_tokens AS RESTRICTIVE
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  url             text NOT NULL CHECK (url ~ '^https://'),
  secret_enc      text NOT NULL,                             -- HMAC signing secret, encrypted at app level
  events          text[] NOT NULL DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT true,
  last_status     integer,
  failure_count   integer NOT NULL DEFAULT 0,
  disabled_at     timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('webhook_endpoints');

-- ---------------------------------------------------------------- dispatcher <-> driver messaging
CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id           uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,   -- thread key
  sender_type         text NOT NULL CHECK (sender_type IN ('user', 'driver', 'system')),
  sender_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  body                text CHECK (body IS NULL OR length(body) <= 4000),
  attachment_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
  job_id              uuid REFERENCES jobs(id) ON DELETE SET NULL,
  client_msg_id       text,                                  -- idempotency key from offline app
  sent_at             timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz,
  read_at             timestamptz,
  CHECK (body IS NOT NULL OR attachment_file_id IS NOT NULL)
);
CREATE UNIQUE INDEX messages_client_msg_unique ON messages (tenant_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX messages_thread_idx ON messages (driver_id, sent_at DESC);
SELECT app.enable_tenant_rls('messages');
SELECT app.add_tenant_ref_check('messages', 'driver_id:drivers', 'sender_user_id:users', 'job_id:jobs', 'attachment_file_id:files');
REVOKE UPDATE, DELETE ON messages FROM jfs_app;
GRANT UPDATE (delivered_at, read_at) ON messages TO jfs_app;

-- ---------------------------------------------------------------- analytics rollups (written by the worker)
CREATE TABLE vehicle_daily_stats (
  vehicle_id            uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  day                   date NOT NULL,                       -- tenant-local day
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  distance_km           numeric(10, 2) NOT NULL DEFAULT 0,
  trips                 integer NOT NULL DEFAULT 0,
  driving_s             integer NOT NULL DEFAULT 0,
  idle_s                integer NOT NULL DEFAULT 0,
  stopped_s             integer NOT NULL DEFAULT 0,
  max_speed_kph         smallint NOT NULL DEFAULT 0,
  avg_speed_kph         numeric(5, 1) NOT NULL DEFAULT 0,
  fuel_used_l           numeric(10, 2),
  fuel_cost             numeric(14, 2),
  idle_fuel_l           numeric(10, 2),
  engine_hours          numeric(8, 2),
  harsh_events          integer NOT NULL DEFAULT 0,
  overspeed_events      integer NOT NULL DEFAULT 0,
  first_ignition_on     timestamptz,
  last_ignition_off     timestamptz,
  utilisation_pct       numeric(5, 2) NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, day)
);
CREATE INDEX vehicle_daily_stats_tenant_day_idx ON vehicle_daily_stats (tenant_id, day);
SELECT app.enable_tenant_rls('vehicle_daily_stats');
REVOKE INSERT, UPDATE, DELETE ON vehicle_daily_stats FROM jfs_app;

CREATE TABLE driver_daily_scores (
  driver_id         uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  day               date NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  distance_km       numeric(10, 2) NOT NULL DEFAULT 0,
  driving_s         integer NOT NULL DEFAULT 0,
  harsh_brake       integer NOT NULL DEFAULT 0,
  harsh_accel       integer NOT NULL DEFAULT 0,
  harsh_corner      integer NOT NULL DEFAULT 0,
  overspeed_count   integer NOT NULL DEFAULT 0,
  overspeed_s       integer NOT NULL DEFAULT 0,
  idle_s            integer NOT NULL DEFAULT 0,
  night_driving_s   integer NOT NULL DEFAULT 0,
  score             numeric(5, 2) NOT NULL DEFAULT 100 CHECK (score BETWEEN 0 AND 100),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_id, day)
);
CREATE INDEX driver_daily_scores_tenant_day_idx ON driver_daily_scores (tenant_id, day);
SELECT app.enable_tenant_rls('driver_daily_scores');
REVOKE INSERT, UPDATE, DELETE ON driver_daily_scores FROM jfs_app;

-- ---------------------------------------------------------------- reports
CREATE TABLE report_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  report_type    text NOT NULL CHECK (report_type IN (
                   'trips', 'stops', 'mileage', 'fuel', 'speeding', 'geofence', 'maintenance',
                   'driver_scores', 'utilisation', 'idle', 'alerts', 'executive_summary')),
  filters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  format         text NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf', 'xlsx', 'csv')),
  frequency      text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  send_time      time NOT NULL DEFAULT '07:00',
  day_of_week    smallint CHECK (day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7),
  day_of_month   smallint CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),
  locale         locale_code NOT NULL DEFAULT 'en',
  recipients     text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 20),
  is_active      boolean NOT NULL DEFAULT true,
  last_run_at    timestamptz,
  next_run_at    timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CHECK (frequency <> 'weekly' OR day_of_week IS NOT NULL),
  CHECK (frequency <> 'monthly' OR day_of_month IS NOT NULL)
);
CREATE INDEX report_schedules_due_idx ON report_schedules (next_run_at) WHERE is_active AND deleted_at IS NULL;
SELECT app.enable_tenant_rls('report_schedules');

CREATE TABLE report_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_id   uuid REFERENCES report_schedules(id) ON DELETE SET NULL,
  report_type   text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  format        text NOT NULL CHECK (format IN ('pdf', 'xlsx', 'csv')),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  file_id       uuid REFERENCES files(id) ON DELETE SET NULL,
  row_count     integer,
  error         text,
  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz
);
CREATE INDEX report_runs_tenant_time_idx ON report_runs (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('report_runs');
SELECT app.add_tenant_ref_check('report_runs', 'schedule_id:report_schedules', 'file_id:files');
REVOKE UPDATE, DELETE ON report_runs FROM jfs_app;

-- ---------------------------------------------------------------- billing (system-written, tenant read-only)
CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number           text NOT NULL UNIQUE,                     -- JFS-2026-000123
  subscription_id  uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  vehicle_count    integer NOT NULL CHECK (vehicle_count >= 0),
  unit_price       numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  subtotal         numeric(14, 2) NOT NULL CHECK (subtotal >= 0),
  tax_rate         numeric(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_amount       numeric(14, 2) NOT NULL DEFAULT 0,
  total            numeric(14, 2) NOT NULL CHECK (total >= 0),
  amount_paid      numeric(14, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  currency         currency_code NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'overdue', 'void')),
  due_date         date NOT NULL,
  issued_at        timestamptz,
  paid_at          timestamptz,
  lines            jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, period_start DESC);
CREATE INDEX invoices_status_idx ON invoices (status, due_date) WHERE status IN ('open', 'overdue');
SELECT app.enable_tenant_rls('invoices');
REVOKE INSERT, UPDATE, DELETE ON invoices FROM jfs_app;

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id          uuid REFERENCES invoices(id) ON DELETE SET NULL,
  method              text NOT NULL CHECK (method IN (
                        'mpesa_ke', 'mpesa_tz', 'airtel_money', 'mixx_tz', 'mtn_momo', 'bank_transfer', 'card', 'manual')),
  amount              numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency            currency_code NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'refunded')),
  provider_reference  text,                                  -- e.g. M-Pesa receipt number
  payer_phone         text,
  paid_at             timestamptz,
  failure_reason      text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_ref_unique ON payments (method, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payments_tenant_idx ON payments (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('payments');
REVOKE INSERT, UPDATE, DELETE ON payments FROM jfs_app;

CREATE TABLE mpesa_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id            uuid REFERENCES payments(id) ON DELETE SET NULL,
  environment           text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  merchant_request_id   text,
  checkout_request_id   text UNIQUE,
  phone                 text NOT NULL,
  amount                numeric(14, 2) NOT NULL CHECK (amount > 0),
  account_reference     text NOT NULL,
  status                text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'succeeded', 'failed', 'cancelled', 'timeout')),
  result_code           integer,
  result_desc           text,
  mpesa_receipt         text,
  raw_callback          jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  callback_at           timestamptz
);
CREATE INDEX mpesa_requests_tenant_idx ON mpesa_requests (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('mpesa_requests');
REVOKE ALL ON mpesa_requests FROM jfs_app;

SELECT app.track_updated_at(t) FROM unnest(ARRAY[
  'alert_rules', 'webhook_endpoints', 'report_schedules', 'invoices', 'payments'
]::regclass[]) AS t;