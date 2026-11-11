import type { Router } from 'express';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { diff, insertSql, updateSql } from '../http/crud.js';
import { forbidden, notFound, unprocessable } from '../http/errors.js';
import { route } from '../http/route.js';

const BASE = '/api/v1';
const TAGS = ['Vehicle groups'];

const GroupInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Colour must be a hex value like #2563EB')
    .nullable()
    .optional(),
  parent_id: z.uuid().nullable().optional(),
});
const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  parent_id: z.string().nullable(),
  vehicle_count: z.number(),
  created_at: z.string(),
});

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  parent_id: string | null;
  vehicle_count: string;
  created_at: Date;
}
const toGroup = (r: GroupRow): z.infer<typeof GroupSchema> => ({
  id: r.id,
  name: r.name,
  description: r.description,
  color: r.color,
  parent_id: r.parent_id,
  vehicle_count: Number(r.vehicle_count),
  created_at: r.created_at.toISOString(),
});
const GROUP_SELECT = `SELECT g.id, g.name, g.description, g.color, g.parent_id, g.created_at,
  (SELECT count(*) FROM vehicles v WHERE v.group_id = g.id AND v.deleted_at IS NULL) AS vehicle_count
  FROM vehicle_groups g WHERE g.deleted_at IS NULL`;

export function registerVehicleGroupRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/vehicle-groups',
    tags: TAGS,
    summary: 'List vehicle groups',
    auth: true,
    middleware: guard('vehicles:read'),
    responses: { 200: { description: 'Groups', schema: z.object({ data: z.array(GroupSchema) }) } },
    handler: async ({ req }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const { rows } = await c.query<GroupRow>(
          `${GROUP_SELECT} ${scope ? 'AND g.id = ANY($1::uuid[])' : ''} ORDER BY g.name`,
          scope ? [scope] : [],
        );
        return { data: rows.map(toGroup) };
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/vehicle-groups',
    tags: TAGS,
    summary: 'Create a vehicle group',
    auth: true,
    body: GroupInput,
    status: 201,
    middleware: guard('vehicles:write'),
    responses: { 201: { description: 'Created', schema: GroupSchema } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        if (await groupScope(c, auth.userId))
          throw forbidden('Group-restricted users cannot create groups');
        if (
          body.parent_id &&
          !(
            await c.query('SELECT 1 FROM vehicle_groups WHERE id = $1 AND deleted_at IS NULL', [
              body.parent_id,
            ])
          ).rowCount
        ) {
          throw unprocessable('Parent group not found');
        }
        const q = insertSql('vehicle_groups', { ...body, tenant_id: auth.tenantId });
        const id = (await c.query<{ id: string }>(q.text, q.values)).rows[0]!.id;
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle_group.created',
          entityType: 'vehicle_group',
          entityId: id,
          changes: body,
          req,
        });
        return toGroup((await c.query<GroupRow>(`${GROUP_SELECT} AND g.id = $1`, [id])).rows[0]!);
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/vehicle-groups/:id',
    tags: TAGS,
    summary: 'Update a vehicle group',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: GroupInput.partial().refine(
      (b) => Object.keys(b).length > 0,
      'Provide at least one field',
    ),
    middleware: guard('vehicles:write'),
    responses: { 200: { description: 'Updated', schema: GroupSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        if (await groupScope(c, auth.userId))
          throw forbidden('Group-restricted users cannot edit groups');
        const before = (
          await c.query('SELECT * FROM vehicle_groups WHERE id = $1 AND deleted_at IS NULL', [
            params.id,
          ])
        ).rows[0];
        if (!before) throw notFound('Vehicle group');
        if (body.parent_id) {
          if (body.parent_id === params.id) throw unprocessable('A group cannot be its own parent');
          const cycle = await c.query(
            `WITH RECURSIVE anc AS (
               SELECT id, parent_id FROM vehicle_groups WHERE id = $1 AND deleted_at IS NULL
               UNION ALL SELECT g.id, g.parent_id FROM vehicle_groups g JOIN anc ON g.id = anc.parent_id
             ) SELECT 1 FROM anc WHERE id = $2`,
            [body.parent_id, params.id],
          );
          if (cycle.rowCount)
            throw unprocessable('That parent is inside this group - it would create a loop');
          if (
            !(
              await c.query('SELECT 1 FROM vehicle_groups WHERE id = $1 AND deleted_at IS NULL', [
                body.parent_id,
              ])
            ).rowCount
          ) {
            throw unprocessable('Parent group not found');
          }
        }
        const q = updateSql('vehicle_groups', params.id, body);
        await c.query(q.text, q.values);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle_group.updated',
          entityType: 'vehicle_group',
          entityId: params.id,
          changes: diff(before, body),
          req,
        });
        return toGroup(
          (await c.query<GroupRow>(`${GROUP_SELECT} AND g.id = $1`, [params.id])).rows[0]!,
        );
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/vehicle-groups/:id',
    tags: TAGS,
    summary: 'Delete a vehicle group',
    description:
      "Sub-groups move up to this group's parent; vehicles in the group become ungrouped.",
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('vehicles:write'),
    responses: { 204: { description: 'Deleted' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      await tenantDb(req, async (c) => {
        if (await groupScope(c, auth.userId))
          throw forbidden('Group-restricted users cannot delete groups');
        const g = (
          await c.query<{ parent_id: string | null; name: string }>(
            'UPDATE vehicle_groups SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING parent_id, name',
            [params.id],
          )
        ).rows[0];
        if (!g) throw notFound('Vehicle group');
        await c.query(
          'UPDATE vehicle_groups SET parent_id = $2 WHERE parent_id = $1 AND deleted_at IS NULL',
          [params.id, g.parent_id],
        );
        await c.query('UPDATE vehicles SET group_id = NULL WHERE group_id = $1', [params.id]);
        await c.query('DELETE FROM user_group_access WHERE group_id = $1', [params.id]);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'vehicle_group.deleted',
          entityType: 'vehicle_group',
          entityId: params.id,
          metadata: { name: g.name },
          req,
        });
      });
      return undefined;
    },
  });
}
