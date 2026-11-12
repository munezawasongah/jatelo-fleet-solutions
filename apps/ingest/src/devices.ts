import { db, redis } from './infra.js';

export type Protocol = 'teltonika' | 'gt06' | 'queclink' | 'http_json';
export interface DeviceInfo {
  id: string;
  tenantId: string;
  identifier: string;
  protocol: Protocol;
  tokenHash: string | null;
}
export type Resolution =
  | { ok: true; device: DeviceInfo }
  | { ok: false; reason: 'unknown' | 'inactive' | 'unassigned' | 'wrong_protocol' };

const TTL_S = 300;
const key = (identifier: string): string => `dev:${identifier}`;

/** Looks a device up by IMEI/identifier (Redis-cached for 5 minutes) and checks it may connect on this protocol. */
export async function resolveDevice(identifier: string, protocol: Protocol): Promise<Resolution> {
  let raw = await redis.get(key(identifier));
  if (raw === null) {
    const row = (
      await db.query<{
        id: string;
        tenant_id: string | null;
        protocol: Protocol;
        status: string;
        auth_token_hash: string | null;
      }>(
        'SELECT id, tenant_id, protocol, status, auth_token_hash FROM devices WHERE identifier = $1 AND deleted_at IS NULL',
        [identifier],
      )
    ).rows[0];
    raw = JSON.stringify(row ?? null);
    await redis.set(key(identifier), raw, 'EX', row ? TTL_S : 60);
  }
  const row = JSON.parse(raw) as {
    id: string;
    tenant_id: string | null;
    protocol: Protocol;
    status: string;
    auth_token_hash: string | null;
  } | null;
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.status !== 'active') return { ok: false, reason: 'inactive' };
  if (!row.tenant_id) return { ok: false, reason: 'unassigned' };
  if (row.protocol !== protocol) return { ok: false, reason: 'wrong_protocol' };
  return {
    ok: true,
    device: {
      id: row.id,
      tenantId: row.tenant_id,
      identifier,
      protocol,
      tokenHash: row.auth_token_hash,
    },
  };
}

/** Called by the API (later) when a device changes so the gateway picks it up immediately. */
export const forgetDevice = (identifier: string): Promise<number> => redis.del(key(identifier));
