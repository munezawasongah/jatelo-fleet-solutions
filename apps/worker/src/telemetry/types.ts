import type { DeviceEvent, StatusUpdate } from '@jfs/protocols';
import type { TripState } from './trips.js';
import type { FuelState } from './fuel.js';

/** A TelemetryRecord after JSON transport (dates are ISO strings). */
export interface WireRecord {
  recordedAt: string;
  lat: number;
  lng: number;
  altitudeM: number | null;
  heading: number | null;
  speedKph: number;
  satellites: number | null;
  hdop: number | null;
  valid: boolean;
  ignition: boolean | null;
  movement: boolean | null;
  odometerKm: number | null;
  engineHours: number | null;
  fuelLevelPct: number | null;
  fuelLevelL: number | null;
  extVoltageMv: number | null;
  batteryVoltageMv: number | null;
  gsmSignalPct: number | null;
  driverTag: string | null;
  events: DeviceEvent[];
  dtcCodes: string[];
  eventCode: string;
  io: Record<string, number | string>;
}

export interface WireMessage {
  v: 1;
  kind: 'records' | 'status';
  device_id: string;
  tenant_id: string;
  identifier: string;
  protocol: string;
  received_at: string;
  records?: WireRecord[];
  status?: Omit<StatusUpdate, 'receivedAt'> & { receivedAt: string };
}

export type LiveState = 'moving' | 'idle' | 'stopped' | 'offline' | 'never';

/** Per-device processing state kept in Redis between batches. */
export interface DeviceState {
  lastValid: { lat: number; lng: number; at: number } | null;
  lastAt: number;
  odometerKm: number | null;
  engineHours: number | null;
  ignition: boolean | null;
  state: LiveState;
  stateSince: number;
  trips?: TripState;
  fuel?: FuelState;
}
