import type { Request, Router } from 'express';
import type { PoolClient } from '@jfs/db';
import type { Permission } from '@jfs/shared';
interface QueryResult<R> {
  rows: R[];
  fields: { name: string; dataTypeID: number }[];
}
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb, type AuthContext } from '../auth/middleware.js';
import { diff, insertSql, orderBy, paged, PageQuery, Pagination, updateSql } from './crud.js';
import { notFound } from './errors.js';
import { route } from './route.js';

export type Row = Record<string, unknown>;
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);

/** Serialises pg rows: numerics/bigints become numbers, dates become ISO strings (via JSON). */
export function rowsOf(r: QueryResult<Row>, opts: { keep?: ('total' | 'tenant_id')[] } = {}): Row[] {
  const numeric = r.fields.filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name);
  return r.rows.map((row) => {
    const out: Row = { ...row };
    for (const k of numeric) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
    if (!opts.keep?.includes('total')) delete out.total;
    if (!opts.keep?.includes('tenant_id')) delete out.tenant_id;
    return out;
  });
}

export const AnyRow = z.record(z.string(), z.unknown());
export const ListOf = z.object({ data: z.array(AnyRow), pagination: Pagination });

export interface ResourceDef<I extends z.ZodObject> {
  /** URL segment, e.g. "pois" -> /api/v1/pois */
  path: string;
  table: string;
  tag: string;
  noun: string;
  read: Permission[];
  write: Permission[];
  input: I;
  /** SELECT ... FROM ... (no WHERE). Must expose the table alias "x" columns via a subquery-friendly form. */
  select: string;
  /** Alias of the main table inside `select`. */
  alias?: string;
  softDelete?: boolean;
  sorts: Record<string, string>;
  defaultSort: string;
  search?: string[];
  filters?: Record<string, { column: string; schema: z.ZodType }>;
  /** Converts validated input into column values (e.g. geometry). Return values may be SQL fragments via {sql}. */
  toColumns?: (body: Partial<z.output<I>>, c: PoolClient, auth: AuthContext) => Promise<Row> | Row;
  validate?: (
    c: PoolClient,
    body: Partial<z.output<I>>,
    auth: AuthContext,
    existing?: Row,
  ) => Promise<void>;
  afterWrite?: (c: PoolClient, id: string, auth: AuthContext, req: Request) => Promise<void>;
  extraCreate?: (auth: AuthContext) => Row;
  ops?: ('list' | 'get' | 'create' | 'update' | 'delete')[];
}

export async function fetchOne(
  c: PoolClient,
  select: string,
  alias: string,
  id: string,
  softDelete: boolean,
): Promise<Row> {
  const r = await c.query<Row>(
    `${select} WHERE ${alias}.id = $1${softDelete ? ` AND ${alias}.deleted_at IS NULL` : ''}`,
    [id],
  );
  const row = rowsOf(r)[0];
  if (!row) throw notFound();
  return row;
}

/** Registers standard list/get/create/update/delete endpoints for a tenant-owned table. */
export function resource<I extends z.ZodObject>(v1: Router, def: ResourceDef<I>): void {
  const BASE = '/api/v1';
  const a = def.alias ?? 'x';
  const soft = def.softDelete ?? true;
  const ops = def.ops ?? ['list', 'get', 'create', 'update', 'delete'];
  const one = (c: PoolClient, id: string): Promise<Row> =>
    fetchOne(c, def.select, a, id, soft).catch((e: unknown) => {
      throw e instanceof Error && 'status' in e ? notFound(def.noun) : e;
    });
  const columns = async (
    body: Partial<z.output<I>>,
    c: PoolClient,
    auth: AuthContext,
  ): Promise<Row> => (def.toColumns ? def.toColumns(body, c, auth) : (body as Row));

  if (ops.includes('list')) {
    const filterShape: Record<string, z.ZodType> = {};
    for (const [k, f] of Object.entries(def.filters ?? {})) filterShape[k] = f.schema.optional();
    route(v1, BASE, {
      method: 'get',
      path: `/${def.path}`,
      tags: [def.tag],
      summary: `List ${def.noun.toLowerCase()}s`,
      auth: true,
      query: z.object({
        ...PageQuery,
        ...(def.search ? { search: z.string().trim().max(80).optional() } : {}),
        sort: z
          .string()
          .max(40)
          .optional()
          .describe(`One of ${Object.keys(def.sorts).join(', ')}; prefix - for descending`),
        ...filterShape,
      }),
      middleware: guard(...def.read),
      responses: { 200: { description: 'Page', schema: ListOf } },
      handler: async ({ req, query }) =>
        tenantDb(req, async (c) => {
          const q = query as Row & {
            page: number;
            page_size: number;
            sort?: string;
            search?: string;
          };
          const where: string[] = soft ? [`${a}.deleted_at IS NULL`] : [];
          const params: unknown[] = [];
          for (const [k, f] of Object.entries(def.filters ?? {})) {
            if (q[k] === undefined) continue;
            params.push(q[k]);
            where.push(`${f.column} = $${params.length}`);
          }
          if (q.search && def.search) {
            params.push(q.search);
            where.push(
              `(${def.search.map((s) => `${s}::text ILIKE '%' || $${params.length} || '%'`).join(' OR ')})`,
            );
          }
          const order = orderBy(q.sort, def.sorts, def.defaultSort);
          params.push(q.page_size, (q.page - 1) * q.page_size);
          const r = await c.query<Row>(
            `SELECT * FROM (SELECT y.*, count(*) OVER() AS total FROM (${def.select} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}) y) x
             ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          );
          return paged(rowsOf(r), Number(r.rows[0]?.total ?? 0), q.page, q.page_size);
        }),
    });
  }

  if (ops.includes('get')) {
    route(v1, BASE, {
      method: 'get',
      path: `/${def.path}/:id`,
      tags: [def.tag],
      summary: `Get one ${def.noun.toLowerCase()}`,
      auth: true,
      params: z.object({ id: z.uuid() }),
      middleware: guard(...def.read),
      responses: { 200: { description: def.noun, schema: AnyRow } },
      handler: async ({ req, params }) => tenantDb(req, (c) => one(c, params.id)),
    });
  }

  if (ops.includes('create')) {
    route(v1, BASE, {
      method: 'post',
      path: `/${def.path}`,
      tags: [def.tag],
      summary: `Create a ${def.noun.toLowerCase()}`,
      auth: true,
      body: def.input,
      status: 201,
      middleware: guard(...def.write),
      responses: { 201: { description: 'Created', schema: AnyRow } },
      handler: async ({ req, body }) => {
        const auth = requireAuth(req);
        return tenantDb(req, async (c) => {
          const b = body as Partial<z.output<I>>;
          await def.validate?.(c, b, auth);
          const cols = {
            ...(await columns(b, c, auth)),
            ...(def.extraCreate?.(auth) ?? {}),
            tenant_id: auth.tenantId,
          };
          const q = insertSql(def.table, cols);
          const id = (await c.query<{ id: string }>(q.text, q.values)).rows[0]!.id;
          await def.afterWrite?.(c, id, auth, req);
          await audit({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            action: `${def.table}.created`,
            entityType: def.table,
            entityId: id,
            req,
          });
          return one(c, id);
        });
      },
    });
  }

  if (ops.includes('update')) {
    route(v1, BASE, {
      method: 'patch',
      path: `/${def.path}/:id`,
      tags: [def.tag],
      summary: `Update a ${def.noun.toLowerCase()}`,
      auth: true,
      params: z.object({ id: z.uuid() }),
      body: def.input
        .partial()
        .refine((b) => Object.keys(b).length > 0, 'Provide at least one field'),
      middleware: guard(...def.write),
      responses: { 200: { description: 'Updated', schema: AnyRow } },
      handler: async ({ req, params, body }) => {
        const auth = requireAuth(req);
        return tenantDb(req, async (c) => {
          const before = (
            await c.query<Row>(
              `SELECT * FROM ${def.table} WHERE id = $1${soft ? ' AND deleted_at IS NULL' : ''}`,
              [params.id],
            )
          ).rows[0];
          if (!before) throw notFound(def.noun);
          const b = body as Partial<z.output<I>>;
          await def.validate?.(c, b, auth, before);
          const cols = await columns(b, c, auth);
          if (Object.keys(cols).length) {
            const q = updateSql(def.table, params.id, cols, soft);
            await c.query(q.text, q.values);
          }
          await def.afterWrite?.(c, params.id, auth, req);
          await audit({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            action: `${def.table}.updated`,
            entityType: def.table,
            entityId: params.id,
            changes: diff(before, cols),
            req,
          });
          return one(c, params.id);
        });
      },
    });
  }

  if (ops.includes('delete')) {
    route(v1, BASE, {
      method: 'delete',
      path: `/${def.path}/:id`,
      tags: [def.tag],
      summary: `Delete a ${def.noun.toLowerCase()}`,
      auth: true,
      params: z.object({ id: z.uuid() }),
      middleware: guard(...def.write),
      responses: { 204: { description: 'Deleted' } },
      handler: async ({ req, params }) => {
        const auth = requireAuth(req);
        await tenantDb(req, async (c) => {
          const r = soft
            ? await c.query(
                `UPDATE ${def.table} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
                [params.id],
              )
            : await c.query(`DELETE FROM ${def.table} WHERE id = $1`, [params.id]);
          if (!r.rowCount) throw notFound(def.noun);
        });
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: `${def.table}.deleted`,
          entityType: def.table,
          entityId: params.id,
          req,
        });
        return undefined;
      },
    });
  }
}

/** Shared list query helper for custom endpoints. */
export async function listRows(c: PoolClient, sql: string, params: unknown[]): Promise<Row[]> {
  return rowsOf(await c.query<Row>(sql, params));
}
