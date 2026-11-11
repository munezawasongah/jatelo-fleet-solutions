import type { Request, Router } from 'express';
import type { PoolClient } from '@jfs/db';
import type { Permission } from '@jfs/shared';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb, type AuthContext } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { AppError, forbidden, notFound, unprocessable } from '../http/errors.js';
import { route } from '../http/route.js';
import { visibleVehicle } from './vehicles.js';

const BASE = '/api/v1';
const TAGS = ['Shifts'];
const STATUSES = ['scheduled', 'in_progress', 'completed', 'missed', 'cancelled'] as const;
const MAX_SHIFT_MS = 24 * 3_600_000;
const EARLY_START_MS = 2 * 3_600_000;
const NIL = '00000000-0000-0000-0000-000000000000';

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const hours = (a: Date | null, b: Date | null): number | null =>
  a && b ? Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 100) / 100 : null;

const SCHEDULERS: Permission[] = ['drivers:write', 'jobs:dispatch'];
const canSchedule = (auth: AuthContext): boolean => SCHEDULERS.some((p) => auth.permissions.has(p));
function requireScheduler(req: Request): AuthContext {
  const auth = requireAuth(req);
  if (!canSchedule(auth))
    throw forbidden('Only dispatchers and fleet managers can schedule shifts');
  return auth;
}

const dt = z.iso.datetime({ offset: true });
const Entry = z.object({
  driver_id: z.uuid(),
  vehicle_id: z.uuid().nullable().optional(),
  starts_at: dt,
  ends_at: dt,
  notes: z.string().trim().max(500).nullable().optional(),
});

const ShiftSchema = z.object({
  id: z.string(),
  status: z.string(),
  driver: z.object({ id: z.string(), name: z.string() }),
  vehicle: z.object({ id: z.string(), plate_number: z.string() }).nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
  planned_hours: z.number(),
  actual_start: z.string().nullable(),
  actual_end: z.string().nullable(),
  worked_hours: z.number().nullable(),
  late_minutes: z.number().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

const SHIFT_SELECT = `SELECT s.*, dr.full_name AS driver_name, dr.user_id AS driver_user_id, v.plate_number
  FROM shifts s JOIN drivers dr ON dr.id = s.driver_id LEFT JOIN vehicles v ON v.id = s.vehicle_id`;

function toShift(r: Row): z.infer<typeof ShiftSchema> {
  const start = r.starts_at as Date;
  const actualStart = (r.actual_start as Date | null) ?? null;
  return {
    id: String(r.id),
    status: String(r.status),
    driver: { id: String(r.driver_id), name: String(r.driver_name) },
    vehicle: r.vehicle_id
      ? { id: String(r.vehicle_id), plate_number: String(r.plate_number) }
      : null,
    starts_at: start.toISOString(),
    ends_at: (r.ends_at as Date).toISOString(),
    planned_hours: hours(start, r.ends_at as Date)!,
    actual_start: iso(r.actual_start),
    actual_end: iso(r.actual_end),
    worked_hours: hours(actualStart, (r.actual_end as Date | null) ?? null),
    late_minutes: actualStart
      ? Math.max(0, Math.round((actualStart.getTime() - start.getTime()) / 60_000))
      : null,
    notes: str(r.notes),
    created_at: iso(r.created_at)!,
  };
}

/** Validates one shift and returns clash messages (empty = OK). Overlap = any shared moment with a non-cancelled shift. */
async function check(
  c: PoolClient,
  scope: string[] | null,
  e: { driver_id: string; vehicle_id?: string | null; starts_at: string; ends_at: string },
  ignoreId = NIL,
): Promise<{ code: string; message: string }[]> {
  const s = new Date(e.starts_at);
  const en = new Date(e.ends_at);
  if (en <= s) throw unprocessable('Shift end must be after its start');
  if (en.getTime() - s.getTime() > MAX_SHIFT_MS)
    throw unprocessable('A shift cannot be longer than 24 hours');
  const d = (
    await c.query<{ full_name: string; status: string }>(
      'SELECT full_name, status FROM drivers WHERE id = $1 AND deleted_at IS NULL',
      [e.driver_id],
    )
  ).rows[0];
  if (!d) throw unprocessable('Driver not found', { driver_id: e.driver_id });
  if (d.status !== 'active') throw unprocessable(`${d.full_name} is not an active driver`);
  const clashes: { code: string; message: string }[] = [];
  const own = (
    await c.query<{ starts_at: Date; ends_at: Date }>(
      `SELECT starts_at, ends_at FROM shifts WHERE driver_id = $1 AND status <> 'cancelled' AND id <> $4
       AND tstzrange(starts_at, ends_at) && tstzrange($2, $3) LIMIT 1`,
      [e.driver_id, s, en, ignoreId],
    )
  ).rows[0];
  if (own)
    clashes.push({
      code: 'shift_overlap',
      message: `${d.full_name} already has a shift ${own.starts_at.toISOString()} - ${own.ends_at.toISOString()}`,
    });
  if (e.vehicle_id) {
    const v = await visibleVehicle(c, e.vehicle_id, scope);
    const booked = (
      await c.query<{ full_name: string }>(
        `SELECT dr.full_name FROM shifts s JOIN drivers dr ON dr.id = s.driver_id
       WHERE s.vehicle_id = $1 AND s.status <> 'cancelled' AND s.id <> $4 AND s.driver_id <> $5
         AND tstzrange(s.starts_at, s.ends_at) && tstzrange($2, $3) LIMIT 1`,
        [e.vehicle_id, s, en, ignoreId, e.driver_id],
      )
    ).rows[0];
    if (booked)
      clashes.push({
        code: 'vehicle_booked',
        message: `${String(v.plate_number)} is already booked for ${booked.full_name} at that time`,
      });
  }
  return clashes;
}

function clashError(clashes: { code: string; message: string }[]): AppError {
  const code = clashes.every((x) => x.code === clashes[0]!.code)
    ? clashes[0]!.code
    : 'schedule_conflict';
  return new AppError(
    409,
    code,
    clashes.length === 1 ? clashes[0]!.message : 'Some shifts clash with existing ones',
    clashes,
  );
}

async function getShift(c: PoolClient, id: string): Promise<Row> {
  const r = (await c.query<Row>(`${SHIFT_SELECT} WHERE s.id = $1`, [id])).rows[0];
  if (!r) throw notFound('Shift');
  return r;
}

/** Drivers may clock in/out of their own shifts; schedulers may do it for anyone. */
function assertCanClock(auth: AuthContext, shift: Row): void {
  if (canSchedule(auth)) return;
  if (auth.permissions.has('driver_app:use') && shift.driver_user_id === auth.userId) return;
  throw forbidden('You can only clock in or out of your own shifts');
}

const RangeQuery = {
  from: dt.describe('Start of the period (ISO 8601 with offset)'),
  to: dt.describe('End of the period; at most 62 days after from'),
};
function range(q: { from: string; to: string }): [Date, Date] {
  const a = new Date(q.from);
  const b = new Date(q.to);
  if (b <= a) throw unprocessable('"to" must be after "from"');
  if (b.getTime() - a.getTime() > 62 * 86_400_000)
    throw unprocessable('The period can be at most 62 days');
  return [a, b];
}

export function registerShiftRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/shifts/my',
    tags: TAGS,
    summary: 'My shifts (driver app)',
    auth: true,
    query: z.object(RangeQuery),
    middleware: guard('driver_app:use'),
    responses: { 200: { description: 'Shifts', schema: z.object({ data: z.array(ShiftSchema) }) } },
    handler: async ({ req, query }) => {
      const auth = requireAuth(req);
      const [a, b] = range(query);
      return tenantDb(req, async (c) => {
        const { rows } = await c.query<Row>(
          `${SHIFT_SELECT} WHERE dr.user_id = $1 AND tstzrange(s.starts_at, s.ends_at) && tstzrange($2, $3) ORDER BY s.starts_at`,
          [auth.userId, a, b],
        );
        return { data: rows.map(toShift) };
      });
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/shifts',
    tags: TAGS,
    summary: 'List shifts in a period',
    auth: true,
    query: z.object({
      ...RangeQuery,
      driver_id: z.uuid().optional(),
      vehicle_id: z.uuid().optional(),
      status: z.enum(STATUSES).optional(),
    }),
    middleware: guard('drivers:read'),
    responses: { 200: { description: 'Shifts', schema: z.object({ data: z.array(ShiftSchema) }) } },
    handler: async ({ req, query }) => {
      const [a, b] = range(query);
      return tenantDb(req, async (c) => {
        const params: unknown[] = [a, b];
        const where = ['tstzrange(s.starts_at, s.ends_at) && tstzrange($1, $2)'];
        for (const [col, val] of [
          ['s.driver_id', query.driver_id],
          ['s.vehicle_id', query.vehicle_id],
          ['s.status', query.status],
        ] as const) {
          if (val) {
            params.push(val);
            where.push(`${col} = $${params.length}`);
          }
        }
        const { rows } = await c.query<Row>(
          `${SHIFT_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.starts_at, dr.full_name LIMIT 5000`,
          params,
        );
        return { data: rows.map(toShift) };
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/shifts',
    tags: TAGS,
    summary: 'Schedule a shift',
    auth: true,
    description:
      'Fails with 409 shift_overlap (driver double-booked) or vehicle_booked (vehicle double-booked).',
    body: Entry,
    status: 201,
    middleware: guard(),
    responses: { 201: { description: 'Scheduled', schema: ShiftSchema } },
    handler: async ({ req, body }) => {
      const auth = requireScheduler(req);
      return tenantDb(req, async (c) => {
        const clashes = await check(c, await groupScope(c, auth.userId), body);
        if (clashes.length) throw clashError(clashes);
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO shifts (tenant_id, driver_id, vehicle_id, starts_at, ends_at, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              auth.tenantId,
              body.driver_id,
              body.vehicle_id ?? null,
              body.starts_at,
              body.ends_at,
              body.notes ?? null,
              auth.userId,
            ],
          )
        ).rows[0]!.id;
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'shift.created',
          entityType: 'shift',
          entityId: id,
          req,
        });
        return toShift(await getShift(c, id));
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/shifts/roster',
    tags: TAGS,
    summary: 'Schedule many shifts at once (all or nothing)',
    auth: true,
    description:
      'Up to 200 shifts. If any entry clashes, nothing is saved and every clash is returned (409 schedule_conflict).',
    body: z.object({ entries: z.array(Entry).min(1).max(200) }),
    status: 201,
    middleware: guard(),
    responses: {
      201: {
        description: 'Scheduled',
        schema: z.object({ created: z.number(), data: z.array(ShiftSchema) }),
      },
    },
    handler: async ({ req, body }) => {
      const auth = requireScheduler(req);
      return tenantDb(req, async (c) => {
        const scope = await groupScope(c, auth.userId);
        const clashes: { code: string; message: string; entry: number }[] = [];
        const ids: string[] = [];
        for (const [i, e] of body.entries.entries()) {
          const found = await check(c, scope, e);
          if (found.length) {
            clashes.push(...found.map((x) => ({ ...x, entry: i })));
            continue;
          }
          ids.push(
            (
              await c.query<{ id: string }>(
                `INSERT INTO shifts (tenant_id, driver_id, vehicle_id, starts_at, ends_at, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [
                  auth.tenantId,
                  e.driver_id,
                  e.vehicle_id ?? null,
                  e.starts_at,
                  e.ends_at,
                  e.notes ?? null,
                  auth.userId,
                ],
              )
            ).rows[0]!.id,
          );
        }
        if (clashes.length)
          throw new AppError(
            409,
            'schedule_conflict',
            `${clashes.length} clash(es) found - nothing was saved`,
            clashes,
          );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'shift.roster_created',
          entityType: 'shift',
          metadata: { count: ids.length },
          req,
        });
        const { rows } = await c.query<Row>(
          `${SHIFT_SELECT} WHERE s.id = ANY($1::uuid[]) ORDER BY s.starts_at, dr.full_name`,
          [ids],
        );
        return { created: ids.length, data: rows.map(toShift) };
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/shifts/:id',
    tags: TAGS,
    summary: 'Reschedule or edit a shift',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z
      .object({
        vehicle_id: z.uuid().nullable().optional(),
        starts_at: dt.optional(),
        ends_at: dt.optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      })
      .refine((b) => Object.keys(b).length > 0, 'Provide at least one field'),
    middleware: guard(),
    responses: { 200: { description: 'Updated', schema: ShiftSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireScheduler(req);
      return tenantDb(req, async (c) => {
        const cur = await getShift(c, params.id);
        if (cur.status !== 'scheduled')
          throw new AppError(409, 'shift_locked', 'Only scheduled shifts can be changed');
        const next = {
          driver_id: String(cur.driver_id),
          vehicle_id: body.vehicle_id !== undefined ? body.vehicle_id : str(cur.vehicle_id),
          starts_at: body.starts_at ?? (cur.starts_at as Date).toISOString(),
          ends_at: body.ends_at ?? (cur.ends_at as Date).toISOString(),
        };
        const clashes = await check(c, await groupScope(c, auth.userId), next, params.id);
        if (clashes.length) throw clashError(clashes);
        await c.query(
          'UPDATE shifts SET vehicle_id = $2, starts_at = $3, ends_at = $4, notes = coalesce($5, notes) WHERE id = $1',
          [
            params.id,
            next.vehicle_id,
            next.starts_at,
            next.ends_at,
            body.notes === undefined ? null : body.notes,
          ],
        );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'shift.updated',
          entityType: 'shift',
          entityId: params.id,
          changes: body,
          req,
        });
        return toShift(await getShift(c, params.id));
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/shifts/:id',
    tags: TAGS,
    summary: 'Cancel a shift',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard(),
    responses: { 204: { description: 'Cancelled' } },
    handler: async ({ req, params }) => {
      const auth = requireScheduler(req);
      await tenantDb(req, async (c) => {
        const cur = await getShift(c, params.id);
        if (cur.status !== 'scheduled')
          throw new AppError(409, 'shift_locked', 'Started or finished shifts cannot be cancelled');
        await c.query(`UPDATE shifts SET status = 'cancelled' WHERE id = $1`, [params.id]);
      });
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'shift.cancelled',
        entityType: 'shift',
        entityId: params.id,
        req,
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/shifts/:id/start',
    tags: TAGS,
    summary: 'Clock in',
    auth: true,
    description: 'Allowed from 2 hours before the planned start until the planned end.',
    params: z.object({ id: z.uuid() }),
    middleware: guard(),
    responses: { 200: { description: 'Started', schema: ShiftSchema } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const s = await getShift(c, params.id);
        assertCanClock(auth, s);
        if (s.status !== 'scheduled')
          throw new AppError(409, 'shift_not_scheduled', `This shift is ${String(s.status)}`);
        const now = Date.now();
        if (now < (s.starts_at as Date).getTime() - EARLY_START_MS)
          throw new AppError(
            409,
            'too_early',
            'You can clock in at most 2 hours before the shift starts',
          );
        if (now > (s.ends_at as Date).getTime())
          throw new AppError(409, 'shift_over', 'This shift has already ended');
        await c.query(
          `UPDATE shifts SET status = 'in_progress', actual_start = now() WHERE id = $1`,
          [params.id],
        );
        return toShift(await getShift(c, params.id));
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/shifts/:id/end',
    tags: TAGS,
    summary: 'Clock out',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard(),
    responses: { 200: { description: 'Completed', schema: ShiftSchema } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const s = await getShift(c, params.id);
        assertCanClock(auth, s);
        if (s.status !== 'in_progress')
          throw new AppError(409, 'shift_not_started', 'Clock in before clocking out');
        await c.query(
          `UPDATE shifts SET status = 'completed', actual_end = greatest(now(), actual_start + interval '1 second') WHERE id = $1`,
          [params.id],
        );
        return toShift(await getShift(c, params.id));
      });
    },
  });
}
