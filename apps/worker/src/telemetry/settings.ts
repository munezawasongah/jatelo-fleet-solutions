import { db } from '../infra.js';

export interface TenantSettings {
  speedLimitKph: number;
  toleranceKph: number;
  minOverspeedS: number;
  idleThresholdS: number;
  timezone: string;
  nightStart: string;
  nightEnd: string;
}
const TTL = 300_000;
const cache = new Map<string, { at: number; value: TenantSettings }>();

export async function tenantSettings(tenantId: string): Promise<TenantSettings> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const r = (
    await db.query<{
      speed_limit_kph: number;
      overspeed_tolerance_kph: number;
      overspeed_min_seconds: number;
      idle_threshold_seconds: number;
      timezone: string;
      night_start: string;
      night_end: string;
    }>(
      `SELECT s.speed_limit_kph, s.overspeed_tolerance_kph, s.overspeed_min_seconds, s.idle_threshold_seconds, t.timezone,
              s.night_start::text, s.night_end::text
       FROM tenant_settings s JOIN tenants t ON t.id = s.tenant_id WHERE s.tenant_id = $1`,
      [tenantId],
    )
  ).rows[0];
  const value: TenantSettings = {
    speedLimitKph: r?.speed_limit_kph ?? 80,
    toleranceKph: r?.overspeed_tolerance_kph ?? 5,
    minOverspeedS: r?.overspeed_min_seconds ?? 10,
    idleThresholdS: r?.idle_threshold_seconds ?? 300,
    timezone: r?.timezone ?? 'Africa/Nairobi',
    nightStart: r?.night_start ?? '22:00',
    nightEnd: r?.night_end ?? '05:00',
  };
  cache.set(tenantId, { at: Date.now(), value });
  return value;
}
