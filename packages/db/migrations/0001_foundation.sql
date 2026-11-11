-- 0001_foundation
-- Roles, context helpers, domains, plans, tenancy, subscriptions, identity and audit.

-- ---------------------------------------------------------------- roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jfs_app') THEN
    CREATE ROLE jfs_app NOLOGIN;      -- API: Row-Level Security enforced
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jfs_system') THEN
    CREATE ROLE jfs_system NOLOGIN;   -- worker/ingest/super-admin (login role gets BYPASSRLS)
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA public, app TO jfs_app, jfs_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jfs_app, jfs_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO jfs_app, jfs_system;

-- ---------------------------------------------------------------- domains
CREATE DOMAIN country_code  AS char(2) CHECK (VALUE IN ('KE', 'TZ', 'UG', 'RW'));
CREATE DOMAIN currency_code AS char(3) CHECK (VALUE IN ('KES', 'TZS', 'UGX', 'RWF', 'USD'));
CREATE DOMAIN locale_code   AS text    CHECK (VALUE IN ('en', 'sw'));

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.track_updated_at(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON %s', p_table);
  EXECUTE format('CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', p_table);
END
$$;

-- Standard tenant isolation: rows visible/writable only when tenant_id = app.tenant_id.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
    p_table);
END
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO jfs_app, jfs_system;

-- ---------------------------------------------------------------- plans (global catalogue)
CREATE TABLE plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          citext NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,40}$'),
  name          text NOT NULL,
  description   text,
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  trial_days    integer NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 90),
  min_vehicles  integer NOT NULL DEFAULT 1 CHECK (min_vehicles >= 1),
  features      jsonb NOT NULL DEFAULT '[]'::jsonb,
  limits        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_public     boolean NOT NULL DEFAULT true,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_prices (
  plan_id            uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  currency           currency_code NOT NULL,
  price_per_vehicle  numeric(14, 2) NOT NULL CHECK (price_per_vehicle >= 0),
  PRIMARY KEY (plan_id, currency)
);

-- ---------------------------------------------------------------- tenants
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  slug          citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),
  legal_name    text,
  tax_id        text,                       -- KRA PIN / TIN
  country_code  country_code NOT NULL,
  currency      currency_code NOT NULL,
  timezone      text NOT NULL DEFAULT 'Africa/Nairobi',
  locale        locale_code NOT NULL DEFAULT 'en',
  email         citext,
  phone         text,
  address       text,
  logo_url      text,
  status        text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  trial_ends_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX tenants_status_idx ON tenants (status) WHERE deleted_at IS NULL;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

CREATE TABLE tenant_settings (
  tenant_id                  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  distance_unit              text NOT NULL DEFAULT 'km' CHECK (distance_unit IN ('km', 'mi')),
  volume_unit                text NOT NULL DEFAULT 'l'  CHECK (volume_unit IN ('l', 'gal')),
  speed_limit_kph            smallint NOT NULL DEFAULT 80 CHECK (speed_limit_kph BETWEEN 20 AND 200),
  overspeed_tolerance_kph    smallint NOT NULL DEFAULT 5  CHECK (overspeed_tolerance_kph BETWEEN 0 AND 30),
  overspeed_min_seconds      smallint NOT NULL DEFAULT 10 CHECK (overspeed_min_seconds BETWEEN 0 AND 600),
  harsh_thresholds           jsonb NOT NULL DEFAULT '{"brake_g": 0.35, "accel_g": 0.30, "corner_g": 0.35}'::jsonb,
  idle_threshold_seconds     integer NOT NULL DEFAULT 300 CHECK (idle_threshold_seconds BETWEEN 30 AND 7200),
  offline_threshold_minutes  integer NOT NULL DEFAULT 30  CHECK (offline_threshold_minutes BETWEEN 5 AND 10080),
  night_start                time NOT NULL DEFAULT '22:00',
  night_end                  time NOT NULL DEFAULT '05:00',
  gps_retention_days         integer NOT NULL DEFAULT 180 CHECK (gps_retention_days BETWEEN 30 AND 1825),
  raw_packet_retention_days  integer NOT NULL DEFAULT 7   CHECK (raw_packet_retention_days BETWEEN 1 AND 90),
  audit_retention_days       integer NOT NULL DEFAULT 365 CHECK (audit_retention_days BETWEEN 90 AND 3650),
  extra                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('tenant_settings');

CREATE OR REPLACE FUNCTION app.create_tenant_settings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_settings (tenant_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_tenant_settings AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.create_tenant_settings();

-- ---------------------------------------------------------------- subscriptions
CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id               uuid NOT NULL REFERENCES plans(id),
  status                text NOT NULL DEFAULT 'trialing'
                          CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  vehicle_quota         integer NOT NULL CHECK (vehicle_quota >= 1),
  price_per_vehicle     numeric(14, 2) NOT NULL CHECK (price_per_vehicle >= 0),
  currency              currency_code NOT NULL,
  current_period_start  timestamptz NOT NULL DEFAULT now(),
  current_period_end    timestamptz NOT NULL,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
CREATE UNIQUE INDEX subscriptions_one_live_per_tenant
  ON subscriptions (tenant_id) WHERE status IN ('trialing', 'active', 'past_due');
SELECT app.enable_tenant_rls('subscriptions');

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL only for Jatelo super admins
  email                citext NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone                text,
  full_name            text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 120),
  password_hash        text,
  role                 text NOT NULL CHECK (role IN (
                         'super_admin', 'company_admin', 'fleet_manager', 'dispatcher',
                         'mechanic', 'accountant', 'driver')),
  locale               locale_code NOT NULL DEFAULT 'en',
  avatar_url           text,
  status               text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  email_verified_at    timestamptz,
  last_login_at        timestamptz,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  password_changed_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT users_super_admin_has_no_tenant CHECK ((role = 'super_admin') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX users_email_unique ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX users_tenant_role_idx ON users (tenant_id, role) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('users');

CREATE TABLE user_mfa (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id           uuid REFERENCES tenants(id) ON DELETE CASCADE,
  totp_secret_enc     text NOT NULL,                 -- AES-256-GCM encrypted at app level
  enabled_at          timestamptz,
  backup_code_hashes  text[] NOT NULL DEFAULT '{}',
  last_used_step      bigint,                        -- blocks TOTP code replay
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('user_mfa');

CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,
  family_id       uuid NOT NULL,                     -- rotation family; reuse revokes the family
  token_hash      text NOT NULL UNIQUE,
  user_agent      text,
  ip              inet,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  replaced_by     uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);
SELECT app.enable_tenant_rls('refresh_tokens');

CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('invite', 'password_reset', 'email_verify')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_user_purpose_idx ON user_tokens (user_id, purpose);
SELECT app.enable_tenant_rls('user_tokens');

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  key_prefix    text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  scopes        text[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);
SELECT app.enable_tenant_rls('api_keys');

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE audit_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid,
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system', 'device')),
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  changes      jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           inet,
  user_agent   text,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
SELECT app.enable_tenant_rls('audit_logs');

-- ---------------------------------------------------------------- updated_at triggers
SELECT app.track_updated_at(t) FROM unnest(ARRAY[
  'plans', 'tenants', 'tenant_settings', 'subscriptions', 'users', 'user_mfa', 'api_keys'
]::regclass[]) AS t;

-- ---------------------------------------------------------------- API (tenant) privilege limits
REVOKE INSERT, UPDATE, DELETE ON plans, plan_prices FROM jfs_app;
REVOKE INSERT, UPDATE, DELETE ON subscriptions FROM jfs_app;
REVOKE INSERT, UPDATE, DELETE ON tenants FROM jfs_app;
GRANT UPDATE (name, legal_name, tax_id, timezone, locale, email, phone, address, logo_url) ON tenants TO jfs_app;
REVOKE UPDATE, DELETE ON audit_logs FROM jfs_app;