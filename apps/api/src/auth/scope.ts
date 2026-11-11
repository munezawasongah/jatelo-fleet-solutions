import type { PoolClient } from '@jfs/db';

/**
 * Vehicle groups a user is limited to (including all sub-groups), or null when the user may access every group.
 * Users with no rows in user_group_access are unrestricted.
 */
export async function groupScope(c: PoolClient, userId: string): Promise<string[] | null> {
  const { rows } = await c.query<{ id: string }>(
    `WITH RECURSIVE g AS (
       SELECT group_id AS id FROM user_group_access WHERE user_id = $1
       UNION
       SELECT vg.id FROM vehicle_groups vg JOIN g ON vg.parent_id = g.id WHERE vg.deleted_at IS NULL
     ) SELECT id FROM g`,
    [userId],
  );
  return rows.length > 0 ? rows.map((r) => r.id) : null;
}
