import { db } from '../infra.js';
import { logger } from '../logger.js';

/** Keeps 7 days of future partitions and drops partitions older than the longest retention any tenant uses. */
export async function maintainPartitions(): Promise<{ created: number; dropped: number }> {
  const r = (
    await db.query<{ created: number; dropped: number }>(
      `SELECT
         app.ensure_daily_partitions('gps_points', current_date - 1, current_date + 7)
           + app.ensure_daily_partitions('raw_packets', current_date - 1, current_date + 7) AS created,
         app.drop_daily_partitions_before('gps_points', current_date - (SELECT coalesce(max(gps_retention_days), 180) FROM tenant_settings))
           + app.drop_daily_partitions_before('raw_packets', current_date - (SELECT coalesce(max(raw_packet_retention_days), 7) FROM tenant_settings)) AS dropped`,
    )
  ).rows[0]!;
  logger.info(r, 'partition maintenance done');
  return r;
}
