import type { StatusUpdate, TelemetryRecord } from '@jfs/protocols';
import { COMMAND_RESULTS_STREAM, config, STREAM } from './config.js';
import type { DeviceInfo } from './devices.js';
import { db, redis } from './infra.js';
import { logger } from './logger.js';
import { stats } from './stats.js';

export interface TelemetryMessage {
  v: 1;
  kind: 'records' | 'status';
  device_id: string;
  tenant_id: string;
  identifier: string;
  protocol: string;
  received_at: string;
  records?: TelemetryRecord[];
  status?: StatusUpdate;
}

async function xadd(msg: TelemetryMessage): Promise<void> {
  await redis.xadd(
    STREAM,
    'MAXLEN',
    '~',
    String(config.TELEMETRY_STREAM_MAXLEN),
    '*',
    'data',
    JSON.stringify(msg),
  );
}

/** Persists records to the telemetry stream. Resolve = durable; only then may the device be acknowledged. */
export async function publishRecords(
  device: DeviceInfo,
  records: TelemetryRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await xadd({
    v: 1,
    kind: 'records',
    device_id: device.id,
    tenant_id: device.tenantId,
    identifier: device.identifier,
    protocol: device.protocol,
    received_at: new Date().toISOString(),
    records,
  });
  stats.records += records.length;
}

export async function publishStatus(device: DeviceInfo, status: StatusUpdate): Promise<void> {
  await xadd({
    v: 1,
    kind: 'status',
    device_id: device.id,
    tenant_id: device.tenantId,
    identifier: device.identifier,
    protocol: device.protocol,
    received_at: new Date().toISOString(),
    status,
  });
  stats.statuses++;
}

export async function publishCommandResult(
  device: DeviceInfo,
  commandId: string | null,
  text: string,
): Promise<void> {
  await redis.xadd(
    COMMAND_RESULTS_STREAM,
    'MAXLEN',
    '~',
    '100000',
    '*',
    'data',
    JSON.stringify({
      command_id: commandId,
      device_id: device.id,
      tenant_id: device.tenantId,
      text,
      at: new Date().toISOString(),
    }),
  );
}

// Raw packets for Super Admin debugging: at most one row per source per minute.
const recent = new Map<string, number>();
export function logRaw(entry: {
  identifier?: string | null;
  deviceId?: string | null;
  tenantId?: string | null;
  protocol: string;
  remote: string;
  payload: Buffer;
  error: string;
}): void {
  const k = `${entry.identifier ?? entry.remote}:${entry.error}`;
  const now = Date.now();
  if ((recent.get(k) ?? 0) > now - 60_000) return;
  recent.set(k, now);
  if (recent.size > 10_000) recent.clear();
  db.query(
    `INSERT INTO raw_packets (tenant_id, device_id, identifier, protocol, remote_addr, payload, decode_error) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.tenantId ?? null,
      entry.deviceId ?? null,
      entry.identifier ?? null,
      entry.protocol,
      entry.remote.replace(/^::ffff:/, '') || null,
      entry.payload.subarray(0, 4096),
      entry.error.slice(0, 500),
    ],
  ).catch((err: unknown) => logger.warn({ err }, 'raw packet log failed'));
}
