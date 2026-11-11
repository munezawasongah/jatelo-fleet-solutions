import type { DeviceEvent, TelemetryRecord } from '../types.js';
import type { IoValue, RawAvlRecord } from './decoder.js';

// Teltonika FMB/FMC AVL IO ids (common across the FM family).
const IO = {
  gsmSignal: 21,
  extVoltage: 66,
  batteryVoltage: 67,
  gnssStatus: 69,
  totalOdometer: 16,
  hdop: 182,
  ibutton: 78,
  rfid: 207,
  ignition: 239,
  movement: 240,
  ignitionOnCounter: 449,
  canFuelLitres: 84,
  canTotalMileage: 87,
  canFuelPct: 89,
  canEngineWorktime: 102,
  alarm: 236,
  towing: 246,
  crash: 247,
  jamming: 249,
  unplug: 252,
  greenDrivingType: 253,
  greenDrivingValue: 254,
  overspeeding: 255,
  vin: 256,
  faultCodes: 281,
} as const;

const toNum = (v: IoValue | undefined): number | undefined =>
  v === undefined
    ? undefined
    : typeof v === 'number'
      ? v
      : typeof v === 'bigint'
        ? Number(v)
        : undefined;

function jsonSafe(v: IoValue): number | string {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  return /^[\x20-\x7e]*$/.test(v.toString('latin1')) ? v.toString('latin1') : v.toString('hex');
}

function tag(v: IoValue | undefined): string | null {
  if (v === undefined) return null;
  if (Buffer.isBuffer(v))
    return /^0*$/.test(v.toString('hex'))
      ? null
      : v.toString('hex').replace(/^0+/, '').toUpperCase();
  const big = typeof v === 'bigint' ? v : BigInt(v);
  return big === 0n ? null : big.toString(16).toUpperCase();
}

export function normalizeTeltonika(r: RawAvlRecord): TelemetryRecord {
  const get = (id: number): number | undefined => toNum(r.io.get(id));
  const gnss = get(IO.gnssStatus);
  const valid =
    gnss !== undefined ? gnss === 1 : r.satellites >= 3 && !(r.lat === 0 && r.lng === 0);
  const odoM = get(IO.canTotalMileage) ?? get(IO.totalOdometer);
  const worktimeMin = get(IO.canEngineWorktime);
  const ignSeconds = get(IO.ignitionOnCounter);
  const fuelL = get(IO.canFuelLitres);
  const gsm = get(IO.gsmSignal);
  const hdop = get(IO.hdop);
  const flag = (id: number): boolean | null => (r.io.has(id) ? get(id) === 1 : null);

  const events: DeviceEvent[] = [];
  const ev = r.eventIoId;
  if (ev === IO.greenDrivingType) {
    const t = get(IO.greenDrivingType);
    const g = get(IO.greenDrivingValue);
    const type =
      t === 1 ? 'harsh_accel' : t === 2 ? 'harsh_brake' : t === 3 ? 'harsh_corner' : null;
    if (type) events.push({ type, ...(g !== undefined ? { value: g / 100 } : {}) });
  }
  if (ev === IO.overspeeding && (get(IO.overspeeding) ?? 0) > 0)
    events.push({ type: 'overspeed', value: get(IO.overspeeding)! });
  if (ev === IO.crash && (get(IO.crash) ?? 0) > 0) events.push({ type: 'crash' });
  if (ev === IO.towing && get(IO.towing) === 1) events.push({ type: 'towing' });
  if (ev === IO.unplug && get(IO.unplug) === 1) events.push({ type: 'power_cut' });
  if (ev === IO.jamming && get(IO.jamming) === 1) events.push({ type: 'tamper' });
  if (ev === IO.alarm && get(IO.alarm) === 1) events.push({ type: 'sos' });

  const faults = r.io.get(IO.faultCodes);
  const dtcCodes = Buffer.isBuffer(faults)
    ? [
        ...new Set(
          faults
            .toString('latin1')
            .toUpperCase()
            .match(/[PCBU][0-9A-F]{4}/g) ?? [],
        ),
      ]
    : [];

  const io: Record<string, number | string> = {};
  for (const [id, v] of r.io) io[String(id)] = jsonSafe(v);

  return {
    recordedAt: r.timestamp,
    lat: r.lat,
    lng: r.lng,
    altitudeM: r.altitude,
    heading: r.angle % 360,
    speedKph: r.speed,
    satellites: r.satellites,
    hdop: hdop !== undefined ? hdop / 10 : null,
    valid,
    ignition: flag(IO.ignition),
    movement: flag(IO.movement),
    odometerKm: odoM !== undefined ? odoM / 1000 : null,
    engineHours:
      worktimeMin !== undefined
        ? worktimeMin / 60
        : ignSeconds !== undefined
          ? ignSeconds / 3600
          : null,
    fuelLevelPct: get(IO.canFuelPct) ?? null,
    fuelLevelL: fuelL !== undefined ? fuelL / 10 : null,
    extVoltageMv: get(IO.extVoltage) ?? null,
    batteryVoltageMv: get(IO.batteryVoltage) ?? null,
    gsmSignalPct: gsm !== undefined ? Math.min(100, gsm * 20) : null,
    driverTag: tag(r.io.get(IO.rfid)) ?? tag(r.io.get(IO.ibutton)),
    events,
    dtcCodes,
    eventCode: ev === 0 ? 'periodic' : `teltonika:${ev}`,
    io,
  };
}
