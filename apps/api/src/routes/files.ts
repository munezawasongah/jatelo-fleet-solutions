import { randomUUID } from 'node:crypto';
import type { Router } from 'express';
import { z } from 'zod';
import type { Permission } from '@jfs/shared';
import { audit } from '../auth/audit.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { AppError, forbidden, notFound, unprocessable } from '../http/errors.js';
import { route } from '../http/route.js';
import {
  deleteObject,
  DOWNLOAD_URL_TTL_S,
  headObject,
  presignDownload,
  presignUpload,
  UPLOAD_URL_TTL_S,
} from '../infra/storage.js';

const BASE = '/api/v1';
const TAGS = ['Files'];
const MB = 1024 * 1024;

const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const DOCS = [...IMAGES, 'application/pdf'];
const SHEETS = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
const REPORTS = ['application/pdf', ...SHEETS];

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

interface PurposeSpec {
  upload: Permission[]; // any one is enough
  read: Permission[];
  types: string[];
  maxBytes: number;
}

const PURPOSES = {
  vehicle_document: {
    upload: ['vehicles:write'],
    read: ['vehicles:read'],
    types: DOCS,
    maxBytes: 20 * MB,
  },
  vehicle_photo: {
    upload: ['vehicles:write'],
    read: ['vehicles:read'],
    types: IMAGES,
    maxBytes: 10 * MB,
  },
  driver_licence: {
    upload: ['drivers:write'],
    read: ['drivers:read'],
    types: DOCS,
    maxBytes: 20 * MB,
  },
  driver_photo: {
    upload: ['drivers:write'],
    read: ['drivers:read'],
    types: IMAGES,
    maxBytes: 10 * MB,
  },
  inspection: {
    upload: ['inspections:submit', 'maintenance:write'],
    read: ['inspections:read'],
    types: IMAGES,
    maxBytes: 10 * MB,
  },
  fuel_receipt: {
    upload: ['fuel:submit', 'fuel:write'],
    read: ['fuel:read'],
    types: DOCS,
    maxBytes: 10 * MB,
  },
  proof_of_delivery: {
    upload: ['jobs:read'],
    read: ['jobs:read'],
    types: IMAGES,
    maxBytes: 10 * MB,
  },
  work_order: {
    upload: ['maintenance:write'],
    read: ['maintenance:read'],
    types: DOCS,
    maxBytes: 20 * MB,
  },
  tenant_logo: {
    upload: ['tenant:settings'],
    read: [],
    types: ['image/png', 'image/jpeg', 'image/webp'],
    maxBytes: 2 * MB,
  },
  import: {
    upload: ['fuel:import', 'vehicles:write', 'drivers:write'],
    read: ['fuel:import', 'vehicles:write', 'drivers:write'],
    types: SHEETS,
    maxBytes: 20 * MB,
  },
  report: { upload: ['reports:read'], read: ['reports:read'], types: REPORTS, maxBytes: 50 * MB },
  other: { upload: ['vehicles:write'], read: ['vehicles:read'], types: DOCS, maxBytes: 20 * MB },
} satisfies Record<string, PurposeSpec>;
type Purpose = keyof typeof PURPOSES;
const PURPOSE_KEYS = Object.keys(PURPOSES) as [Purpose, ...Purpose[]];

interface FileRow {
  id: string;
  storage_key: string;
  purpose: Purpose;
  original_name: string;
  content_type: string;
  size_bytes: string;
  status: 'pending' | 'ready';
  uploaded_by: string | null;
  created_at: Date;
}

const FileSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  original_name: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  status: z.string(),
  created_at: z.string(),
});
const toFile = (r: FileRow): z.infer<typeof FileSchema> => ({
  id: r.id,
  purpose: r.purpose,
  original_name: r.original_name,
  content_type: r.content_type,
  size_bytes: Number(r.size_bytes),
  status: r.status,
  created_at: r.created_at.toISOString(),
});

const cleanName = (name: string): string =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200) || 'file';

const hasAny = (perms: ReadonlySet<Permission>, needed: readonly Permission[]): boolean =>
  needed.length === 0 || needed.some((p) => perms.has(p));

const FILE_SELECT =
  'SELECT id, storage_key, purpose, original_name, content_type, size_bytes, status, uploaded_by, created_at FROM files';

export function registerFileRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'post',
    path: '/files/uploads',
    tags: TAGS,
    summary: 'Request a signed upload URL',
    description:
      `Upload the file with an HTTP PUT to upload_url (sending the returned headers) within ${UPLOAD_URL_TTL_S / 60} minutes, ` +
      'then call POST /files/{id}/complete. Each purpose has its own permissions, allowed types and size limit.',
    auth: true,
    body: z.object({
      purpose: z.enum(PURPOSE_KEYS),
      file_name: z.string().trim().min(1).max(255),
      content_type: z.string().trim().toLowerCase().max(120),
      size_bytes: z.number().int().positive(),
    }),
    status: 201,
    middleware: guard(),
    responses: {
      201: {
        description: 'Upload slot created',
        schema: z.object({
          file_id: z.string(),
          upload_url: z.string(),
          method: z.literal('PUT'),
          headers: z.record(z.string(), z.string()),
          expires_in: z.number(),
        }),
      },
    },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const spec: PurposeSpec = PURPOSES[body.purpose];
      if (!hasAny(auth.permissions, spec.upload)) throw forbidden();
      if (!spec.types.includes(body.content_type)) {
        throw unprocessable('This file type is not allowed here', { allowed_types: spec.types });
      }
      if (body.size_bytes > spec.maxBytes) {
        throw unprocessable(`File is too large (maximum ${spec.maxBytes / MB} MB)`, {
          max_bytes: spec.maxBytes,
        });
      }
      const id = randomUUID();
      const now = new Date();
      const key = `t/${auth.tenantId}/${body.purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}${EXT[body.content_type] ?? ''}`;
      await tenantDb(req, (c) =>
        c.query(
          `INSERT INTO files (id, tenant_id, storage_key, purpose, original_name, content_type, size_bytes, status, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
          [
            id,
            auth.tenantId,
            key,
            body.purpose,
            cleanName(body.file_name),
            body.content_type,
            body.size_bytes,
            auth.userId,
          ],
        ),
      );
      return {
        file_id: id,
        upload_url: await presignUpload(key, body.content_type),
        method: 'PUT' as const,
        headers: { 'Content-Type': body.content_type },
        expires_in: UPLOAD_URL_TTL_S,
      };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/files/:id/complete',
    tags: TAGS,
    summary: 'Confirm an upload (verifies size and type)',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard(),
    responses: { 200: { description: 'File is ready', schema: FileSchema } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      const row = (
        await tenantDb(req, (c) => c.query<FileRow>(`${FILE_SELECT} WHERE id = $1`, [params.id]))
      ).rows[0];
      if (!row) throw notFound('File');
      if (row.uploaded_by !== auth.userId)
        throw forbidden('Only the uploader can confirm this file');
      if (row.status === 'ready') return toFile(row);

      const stored = await headObject(row.storage_key);
      if (!stored) throw new AppError(409, 'upload_missing', 'The file has not been uploaded yet');
      if (stored.size !== Number(row.size_bytes) || stored.contentType !== row.content_type) {
        await deleteObject(row.storage_key);
        await tenantDb(req, (c) => c.query('DELETE FROM files WHERE id = $1', [row.id]));
        throw new AppError(
          422,
          'upload_mismatch',
          'The uploaded file does not match the declared size or type',
          {
            declared: { size_bytes: Number(row.size_bytes), content_type: row.content_type },
            received: { size_bytes: stored.size, content_type: stored.contentType },
          },
        );
      }
      const updated = (
        await tenantDb(req, (c) =>
          c.query<FileRow>(
            `UPDATE files SET status = 'ready' WHERE id = $1 RETURNING id, storage_key, purpose, original_name, content_type, size_bytes, status, uploaded_by, created_at`,
            [row.id],
          ),
        )
      ).rows[0]!;
      return toFile(updated);
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/files/:id',
    tags: TAGS,
    summary: 'File details with a short-lived download URL',
    auth: true,
    params: z.object({ id: z.uuid() }),
    query: z.object({
      download: z
        .enum(['true', 'false'])
        .optional()
        .describe('true = force download instead of inline view'),
    }),
    middleware: guard(),
    responses: {
      200: {
        description: 'File',
        schema: FileSchema.extend({ download_url: z.string(), expires_in: z.number() }),
      },
    },
    handler: async ({ req, params, query }) => {
      const auth = requireAuth(req);
      const row = (
        await tenantDb(req, (c) => c.query<FileRow>(`${FILE_SELECT} WHERE id = $1`, [params.id]))
      ).rows[0];
      if (!row) throw notFound('File');
      const spec: PurposeSpec = PURPOSES[row.purpose];
      if (row.uploaded_by !== auth.userId && !hasAny(auth.permissions, spec.read))
        throw forbidden();
      if (row.status !== 'ready')
        throw new AppError(409, 'upload_incomplete', 'This upload has not been completed');
      return {
        ...toFile(row),
        download_url: await presignDownload(
          row.storage_key,
          row.original_name,
          query.download === 'true' ? 'attachment' : 'inline',
        ),
        expires_in: DOWNLOAD_URL_TTL_S,
      };
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/files/:id',
    tags: TAGS,
    summary: 'Delete a file',
    description:
      'Allowed for the uploader, or anyone with upload rights for that purpose. Records that used it keep working without the file.',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard(),
    responses: { 204: { description: 'Deleted' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      const row = (
        await tenantDb(req, (c) => c.query<FileRow>(`${FILE_SELECT} WHERE id = $1`, [params.id]))
      ).rows[0];
      if (!row) throw notFound('File');
      const spec: PurposeSpec = PURPOSES[row.purpose];
      if (row.uploaded_by !== auth.userId && !hasAny(auth.permissions, spec.upload))
        throw forbidden();
      await deleteObject(row.storage_key);
      await tenantDb(req, (c) => c.query('DELETE FROM files WHERE id = $1', [row.id]));
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'file.deleted',
        entityType: 'file',
        entityId: row.id,
        metadata: { purpose: row.purpose, name: row.original_name },
        req,
      });
      return undefined;
    },
  });
}
