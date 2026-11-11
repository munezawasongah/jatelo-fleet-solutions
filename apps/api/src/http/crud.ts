import type { PoolClient } from '@jfs/db';
import { z } from 'zod';
import { unprocessable } from './errors.js';

export const PageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
};

export const Pagination = z.object({ page: z.number(), page_size: z.number(), total: z.number() });

export function paged<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number,
): {
  data: T[];
  pagination: z.infer<typeof Pagination>;
} {
  return { data, pagination: { page, page_size: pageSize, total } };
}

/** Turns "-created_at" into "created_at DESC" using a whitelist of column expressions. */
export function orderBy(
  sort: string | undefined,
  allowed: Record<string, string>,
  fallback: string,
): string {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const col = allowed[desc ? sort.slice(1) : sort];
  if (!col) throw unprocessable(`Cannot sort by "${sort}"`, { allowed: Object.keys(allowed) });
  return `${col} ${desc ? 'DESC' : 'ASC'} NULLS LAST`;
}

const defined = (data: Record<string, unknown>): string[] =>
  Object.keys(data).filter((k) => data[k] !== undefined);

export function insertSql(
  table: string,
  data: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const cols = defined(data);
  return {
    text: `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    values: cols.map((c) => data[c]),
  };
}

export function updateSql(
  table: string,
  id: string,
  data: Record<string, unknown>,
  softDelete = true,
): { text: string; values: unknown[] } {
  const cols = defined(data);
  return {
    text: `UPDATE ${table} SET ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE id = $1${softDelete ? ' AND deleted_at IS NULL' : ''} RETURNING id`,
    values: [id, ...cols.map((c) => data[c])],
  };
}

/** Field-level before/after for the audit log (only keys present in the patch, only when changed). */
export function diff(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of defined(patch)) {
    const a = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k];
    const b = patch[k];
    if (JSON.stringify(a) !== JSON.stringify(b) && String(a ?? '') !== String(b ?? ''))
      out[k] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

export const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** A referenced upload must exist in this tenant, be completed, and have one of the expected purposes. */
export async function assertFile(
  c: PoolClient,
  fileId: string | null | undefined,
  purposes: string[],
): Promise<void> {
  if (!fileId) return;
  const f = (
    await c.query<{ purpose: string; status: string }>(
      'SELECT purpose, status FROM files WHERE id = $1',
      [fileId],
    )
  ).rows[0];
  if (!f || f.status !== 'ready' || !purposes.includes(f.purpose)) {
    throw unprocessable('The attached file is missing, not fully uploaded, or of the wrong kind', {
      file_id: fileId,
      expected: purposes,
    });
  }
}
