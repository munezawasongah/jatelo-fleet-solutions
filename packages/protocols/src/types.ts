export type DeviceEventType =
  | 'harsh_accel'
  | 'harsh_brake'
  | 'harsh_corner'
  | 'overspeed'
  | 'crash'
  | 'towing'
  | 'power_cut'
  | 'tamper'
  | 'sos'
  | 'low_battery';

export interface DeviceEvent {
  type: DeviceEventType;
  /** g-force for harsh events, km/h for overspeed; otherwise undefined. */
  value?: number;
}

/** Protocol-independent telemetry record produced by every decoder. */
export interface TelemetryRecord {
  recordedAt: Date;
  lat: number;
  lng: number;
  altitudeM: number | null;
  heading: number | null;
  speedKph: number;
  satellites: number | null;
  hdop: number | null;
  /** True when the GPS fix can be trusted for position. */
  valid: boolean;
  ignition: boolean | null;
  movement: boolean | null;
  odometerKm: number | null;
  engineHours: number | null;
  fuelLevelPct: number | null;
  fuelLevelL: number | null;
  extVoltageMv: number | null;
  batteryVoltageMv: number | null;
  /** 0-100 regardless of the device's native scale. */
  gsmSignalPct: number | null;
  /** RFID card / iButton id as upper-case hex, when presented. */
  driverTag: string | null;
  events: DeviceEvent[];
  dtcCodes: string[];
  /** Protocol-specific trigger, e.g. "teltonika:253" or "periodic". */
  eventCode: string;
  /** Raw IO values, JSON-safe, for diagnostics and per-device mappings. */
  io: Record<string, number | string>;
}
