-- 0007_platform_extras
-- Generic OBD-II fault code catalogue, remote device commands, and job-level fields used by dispatch.

CREATE TABLE dtc_catalog (
  code         text PRIMARY KEY CHECK (code ~ '^[PCBU][0-9A-F]{4}$'),
  description  text NOT NULL,
  system       text NOT NULL
);
INSERT INTO dtc_catalog (code, description, system) VALUES
  ('P0010', 'Intake camshaft position actuator circuit (bank 1)', 'powertrain'),
  ('P0011', 'Intake camshaft timing over-advanced (bank 1)', 'powertrain'),
  ('P0016', 'Crankshaft/camshaft position correlation (bank 1 sensor A)', 'powertrain'),
  ('P0087', 'Fuel rail/system pressure too low', 'fuel'),
  ('P0088', 'Fuel rail/system pressure too high', 'fuel'),
  ('P0093', 'Fuel system large leak detected', 'fuel'),
  ('P0100', 'Mass air flow circuit malfunction', 'air'),
  ('P0101', 'Mass air flow circuit range/performance', 'air'),
  ('P0102', 'Mass air flow circuit low input', 'air'),
  ('P0103', 'Mass air flow circuit high input', 'air'),
  ('P0106', 'Manifold absolute pressure range/performance', 'air'),
  ('P0110', 'Intake air temperature circuit malfunction', 'air'),
  ('P0115', 'Engine coolant temperature circuit malfunction', 'cooling'),
  ('P0116', 'Engine coolant temperature range/performance', 'cooling'),
  ('P0117', 'Engine coolant temperature circuit low', 'cooling'),
  ('P0118', 'Engine coolant temperature circuit high', 'cooling'),
  ('P0120', 'Throttle position sensor circuit malfunction', 'air'),
  ('P0121', 'Throttle position sensor range/performance', 'air'),
  ('P0128', 'Coolant thermostat below regulating temperature', 'cooling'),
  ('P0130', 'O2 sensor circuit (bank 1 sensor 1)', 'emissions'),
  ('P0133', 'O2 sensor slow response (bank 1 sensor 1)', 'emissions'),
  ('P0135', 'O2 sensor heater circuit (bank 1 sensor 1)', 'emissions'),
  ('P0141', 'O2 sensor heater circuit (bank 1 sensor 2)', 'emissions'),
  ('P0171', 'System too lean (bank 1)', 'fuel'),
  ('P0172', 'System too rich (bank 1)', 'fuel'),
  ('P0174', 'System too lean (bank 2)', 'fuel'),
  ('P0175', 'System too rich (bank 2)', 'fuel'),
  ('P0190', 'Fuel rail pressure sensor circuit', 'fuel'),
  ('P0191', 'Fuel rail pressure sensor range/performance', 'fuel'),
  ('P0200', 'Injector circuit malfunction', 'fuel'),
  ('P0201', 'Injector circuit - cylinder 1', 'fuel'),
  ('P0202', 'Injector circuit - cylinder 2', 'fuel'),
  ('P0203', 'Injector circuit - cylinder 3', 'fuel'),
  ('P0204', 'Injector circuit - cylinder 4', 'fuel'),
  ('P0234', 'Turbocharger overboost condition', 'air'),
  ('P0237', 'Turbo boost sensor circuit low', 'air'),
  ('P0299', 'Turbocharger underboost', 'air'),
  ('P0300', 'Random/multiple cylinder misfire detected', 'ignition'),
  ('P0301', 'Cylinder 1 misfire detected', 'ignition'),
  ('P0302', 'Cylinder 2 misfire detected', 'ignition'),
  ('P0303', 'Cylinder 3 misfire detected', 'ignition'),
  ('P0304', 'Cylinder 4 misfire detected', 'ignition'),
  ('P0305', 'Cylinder 5 misfire detected', 'ignition'),
  ('P0306', 'Cylinder 6 misfire detected', 'ignition'),
  ('P0325', 'Knock sensor circuit (bank 1)', 'ignition'),
  ('P0335', 'Crankshaft position sensor circuit', 'ignition'),
  ('P0340', 'Camshaft position sensor circuit', 'ignition'),
  ('P0380', 'Glow plug/heater circuit A', 'ignition'),
  ('P0400', 'Exhaust gas recirculation flow', 'emissions'),
  ('P0401', 'EGR flow insufficient', 'emissions'),
  ('P0402', 'EGR flow excessive', 'emissions'),
  ('P0403', 'EGR circuit malfunction', 'emissions'),
  ('P0420', 'Catalyst system efficiency below threshold (bank 1)', 'emissions'),
  ('P0430', 'Catalyst system efficiency below threshold (bank 2)', 'emissions'),
  ('P0440', 'Evaporative emission system malfunction', 'emissions'),
  ('P0442', 'Evap system small leak detected', 'emissions'),
  ('P0455', 'Evap system large leak detected', 'emissions'),
  ('P0470', 'Exhaust pressure sensor', 'emissions'),
  ('P0480', 'Cooling fan 1 control circuit', 'cooling'),
  ('P0500', 'Vehicle speed sensor malfunction', 'speed'),
  ('P0505', 'Idle control system malfunction', 'idle'),
  ('P0506', 'Idle control RPM lower than expected', 'idle'),
  ('P0507', 'Idle control RPM higher than expected', 'idle'),
  ('P0520', 'Engine oil pressure sensor circuit', 'engine'),
  ('P0521', 'Engine oil pressure sensor range/performance', 'engine'),
  ('P0524', 'Engine oil pressure too low', 'engine'),
  ('P0562', 'System voltage low', 'electrical'),
  ('P0563', 'System voltage high', 'electrical'),
  ('P0600', 'Serial communication link', 'computer'),
  ('P0606', 'ECM/PCM processor fault', 'computer'),
  ('P0620', 'Generator control circuit', 'electrical'),
  ('P0700', 'Transmission control system malfunction', 'transmission'),
  ('P0705', 'Transmission range sensor circuit', 'transmission'),
  ('P0715', 'Input/turbine speed sensor circuit', 'transmission'),
  ('P0720', 'Output speed sensor circuit', 'transmission'),
  ('P0730', 'Incorrect gear ratio', 'transmission'),
  ('P0740', 'Torque converter clutch circuit', 'transmission'),
  ('P0750', 'Shift solenoid A malfunction', 'transmission'),
  ('P2002', 'Diesel particulate filter efficiency below threshold (bank 1)', 'emissions'),
  ('P2463', 'Diesel particulate filter soot accumulation', 'emissions'),
  ('P2BAD', 'NOx exceedance - root cause unknown', 'emissions'),
  ('P20EE', 'SCR NOx catalyst efficiency below threshold', 'emissions'),
  ('C0035', 'Left front wheel speed sensor circuit', 'chassis'),
  ('C0040', 'Right front wheel speed sensor circuit', 'chassis'),
  ('C0045', 'Left rear wheel speed sensor circuit', 'chassis'),
  ('C0050', 'Right rear wheel speed sensor circuit', 'chassis'),
  ('C0265', 'ABS motor relay circuit', 'chassis'),
  ('B0001', 'Driver frontal stage 1 deployment control', 'body'),
  ('B1000', 'ECU malfunction (body)', 'body'),
  ('U0001', 'High speed CAN communication bus', 'network'),
  ('U0100', 'Lost communication with ECM/PCM', 'network'),
  ('U0101', 'Lost communication with TCM', 'network'),
  ('U0121', 'Lost communication with ABS module', 'network'),
  ('U0140', 'Lost communication with body control module', 'network'),
  ('U0155', 'Lost communication with instrument cluster', 'network');
GRANT SELECT ON dtc_catalog TO jfs_app, jfs_system;
REVOKE INSERT, UPDATE, DELETE ON dtc_catalog FROM jfs_app;

-- Remote commands sent to trackers (e.g. engine immobilise, getinfo), delivered by the ingest gateway.
CREATE TABLE device_commands (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type  text NOT NULL CHECK (command_type IN ('immobilize', 'restore', 'get_info', 'reboot', 'custom')),
  payload       text NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'acknowledged', 'failed', 'expired')),
  response      text,
  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  responded_at  timestamptz
);
CREATE INDEX device_commands_device_idx ON device_commands (device_id, created_at DESC);
SELECT app.enable_tenant_rls('device_commands');
SELECT app.add_tenant_ref_check('device_commands', 'device_id:devices');
REVOKE UPDATE, DELETE ON device_commands FROM jfs_app;

-- Dispatch: track deviation state and live progress on jobs.
ALTER TABLE jobs ADD COLUMN off_route_since timestamptz;
ALTER TABLE jobs ADD COLUMN last_deviation_m integer;
ALTER TABLE jobs ADD COLUMN progress_pct numeric(5, 2);
ALTER TABLE jobs ADD COLUMN share_token_hash text;

-- Fuel: remember the sensor-smoothed level per device for drain/refuel detection across restarts.
ALTER TABLE device_status ADD COLUMN fuel_smoothed_l real;
