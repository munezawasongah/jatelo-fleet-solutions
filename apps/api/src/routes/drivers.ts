import type { Router } from 'express';
import { withTransaction, type PoolClient } from '@jfs/db';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { randomToken, sha256 } from '../auth/crypto.js';
import { guard, requireAuth, tenantDb } from '../auth/middleware.js';
import { groupScope } from '../auth/scope.js';
import { revokeSessions } from '../auth/tokens.js';
import { config } from '../config.js';
import {
  assertFile,
  diff,
  expiryInfo,
  insertSql,
  num,
  orderBy,
  paged,
  PageQuery,
  Pagination,
  updateSql,
} from '../http/crud.js';
import { AppError, notFound, unprocessable } from '../http/errors.js';
import { normalizePhone } from '../http/phone.js';
import { route } from '../http/route.js';
import { systemPool } from '../infra/db.js';
import { inviteEmail } from '../infra/email-templates.js';
import { sendMail } from '../infra/mailer.js';
import { logger } from '../logger.js';
import { visibleVehicle } from './vehicles.js';

const BASE = '/api/v1';
const TAGS = ['Drivers'];
const STATUSES = ['active', 'suspended', 'inactive', 'terminated'] as const;
const LICENCE_TYPES = ['driving', 'psv_badge', 'hazmat', 'defensive_driving', 'other'] as const;
const COUNTRIES = ['KE', 'TZ', 'UG', 'RW'] as const;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
const isoDate = z.iso.date();

function ageOk(dob: string): boolean {
  const age = (Date.now() - Date.parse(dob)) / (365.25 * 86_400_000);
  return age >= 18 && age <= 80;
}

const DriverInput = z.object({
  full_name: z.string().trim().min(2).max(120),
  employee_number: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable().optional(),
  national_id: z.string().trim().max(40).nullable().optional(),
  date_of_birth: isoDate
    .refine(ageOk, 'Driver must be between 18 and 80 years old')
    .nullable()
    .optional(),
  photo_file_id: z.uuid().nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  emergency_contact_name: z.string().trim().max(120).nullable().optional(),
  emergency_contact_phone: z.string().trim().max(30).nullable().optional(),
  hire_date: isoDate.nullable().optional(),
  status: z.enum(STATUSES).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  custom_fields: z
    .record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .refine((o) => Object.keys(o).length <= 50, 'At most 50 custom fields')
    .optional(),
});
const DriverPatch = DriverInput.partial().refine(
  (b) => Object.keys(b).length > 0,
  'Provide at least one field',
);

const LicenceInput = z.object({
  licence_type: z.enum(LICENCE_TYPES),
  licence_number: z.string().trim().min(2).max(40),
  classes: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9]{0,3}$/, 'Licence class like B, C1, CE'),
    )
    .max(12)
    .optional(),
  issuing_country: z.enum(COUNTRIES).nullable().optional(),
  issued_on: isoDate.nullable().optional(),
  expires_on: isoDate.nullable().optional(),
  reminder_days: z.array(z.number().int().min(0).max(365)).max(10).optional(),
  file_id: z.uuid().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const LicencePatch = LicenceInput.partial().refine(
  (b) => Object.keys(b).length > 0,
  'Provide at least one field',
);

// ---------------------------------------------------------------- responses
const LicenceSchema = z.object({
  id: z.string(),
  licence_type: z.string(),
  licence_number: z.string(),
  classes: z.array(z.string()),
  issuing_country: z.string().nullable(),
  issued_on: z.string().nullable(),
  expires_on: z.string().nullable(),
  reminder_days: z.array(z.number()),
  file_id: z.string().nullable(),
  notes: z.string().nullable(),
  expiry_status: z.string(),
  days_to_expiry: z.number().nullable(),
});
const IdentifierSchema = z.object({
  id: z.string(),
  kind: z.string(),
  value: z.string(),
  is_active: z.boolean(),
  created_at: z.string(),
});
const DriverSchema = z.object({
  id: z.string(),
  employee_number: z.string().nullable(),
  full_name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  national_id: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  hire_date: z.string().nullable(),
  status: z.string(),
  photo_file_id: z.string().nullable(),
  address: z.string().nullable(),
  emergency_contact: z.object({ name: z.string().nullable(), phone: z.string().nullable() }),
  notes: z.string().nullable(),
  custom_fields: z.record(z.string(), z.unknown()),
  app_access: z
    .object({
      user_id: z.string(),
      email: z.string(),
      status: z.string(),
      last_login_at: z.string().nullable(),
    })
    .nullable(),
  vehicle: z
    .object({
      id: z.string(),
      plate_number: z.string(),
      since: z.string(),
      assignment_type: z.string(),
    })
    .nullable(),
  licence: z
    .object({
      number: z.string(),
      classes: z.array(z.string()),
      expires_on: z.string().nullable(),
      expiry_status: z.string(),
      days_to_expiry: z.number().nullable(),
    })
    .nullable(),
  psv_badge: z
    .object({
      expires_on: z.string().nullable(),
      expiry_status: z.string(),
      days_to_expiry: z.number().nullable(),
    })
    .nullable(),
  rfid_tags: z.number(),
  score_30d: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const DRIVER_SELECT = `
SELECT dr.*, u.email AS user_email, u.status AS user_status, u.last_login_at,
  v.id AS vehicle_id, v.plate_number, v.group_id AS vehicle_group_id, dva.starts_at AS assigned_since, dva.assignment_type,
  lic.licence_number, lic.classes, lic.expires_on AS licence_expires_on,
  psv.id AS psv_id, psv.expires_on AS psv_expires_on,
  (SELECT count(*) FROM driver_identifiers di WHERE di.driver_id = dr.id AND di.is_active) AS rfid_tags,
  (SELECT round(sum(s.score * s.distance_km) / nullif(sum(s.distance_km), 0), 1)
     FROM driver_daily_scores s WHERE s.driver_id = dr.id AND s.day >= current_date - 30) AS score_30d
FROM drivers dr
LEFT JOIN users u ON u.id = dr.user_id AND u.deleted_at IS NULL
LEFT JOIN driver_vehicle_assignments dva ON dva.driver_id = dr.id AND dva.ends_at IS NULL AND dva.starts_at <= now()
LEFT JOIN vehicles v ON v.id = dva.vehicle_id AND v.deleted_at IS NULL
LEFT JOIN LATERAL (SELECT licence_number, classes, expires_on FROM driver_licences
  WHERE driver_id = dr.id AND licence_type = 'driving' AND deleted_at IS NULL ORDER BY expires_on DESC NULLS LAST LIMIT 1) lic ON true
LEFT JOIN LATERAL (SELECT id, expires_on FROM driver_licences
  WHERE driver_id = dr.id AND licence_type = 'psv_badge' AND deleted_at IS NULL ORDER BY expires_on DESC NULLS LAST LIMIT 1) psv ON true
WHERE dr.deleted_at IS NULL`;

function toDriver(r: Row): z.infer<typeof DriverSchema> {
  return {
    id: String(r.id),
    employee_number: str(r.employee_number),
    full_name: String(r.full_name),
    phone: str(r.phone),
    email: str(r.email),
    national_id: str(r.national_id),
    date_of_birth: str(r.date_of_birth),
    hire_date: str(r.hire_date),
    status: String(r.status),
    photo_file_id: str(r.photo_file_id),
    address: str(r.address),
    emergency_contact: {
      name: str(r.emergency_contact_name),
      phone: str(r.emergency_contact_phone),
    },
    notes: str(r.notes),
    custom_fields: (r.custom_fields as Record<string, unknown>) ?? {},
    app_access:
      r.user_id && r.user_email
        ? {
            user_id: String(r.user_id),
            email: String(r.user_email),
            status: String(r.user_status),
            last_login_at: iso(r.last_login_at),
          }
        : null,
    vehicle: r.vehicle_id
      ? {
          id: String(r.vehicle_id),
          plate_number: String(r.plate_number),
          since: iso(r.assigned_since)!,
          assignment_type: String(r.assignment_type),
        }
      : null,
    licence: r.licence_number
      ? {
          number: String(r.licence_number),
          classes: (r.classes as string[]) ?? [],
          expires_on: str(r.licence_expires_on),
          ...expiryInfo(str(r.licence_expires_on)),
        }
      : null,
    psv_badge: r.psv_id
      ? { expires_on: str(r.psv_expires_on), ...expiryInfo(str(r.psv_expires_on)) }
      : null,
    rfid_tags: Number(r.rfid_tags ?? 0),
    score_30d: num(r.score_30d),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}
const toLicence = (r: Row): z.infer<typeof LicenceSchema> => ({
  id: String(r.id),
  licence_type: String(r.licence_type),
  licence_number: String(r.licence_number),
  classes: (r.classes as string[]) ?? [],
  issuing_country: str(r.issuing_country)?.trim() ?? null,
  issued_on: str(r.issued_on),
  expires_on: str(r.expires_on),
  reminder_days: (r.reminder_days as number[]) ?? [],
  file_id: str(r.file_id),
  notes: str(r.notes),
  ...expiryInfo(str(r.expires_on)),
});
const toIdentifier = (r: Row): z.infer<typeof IdentifierSchema> => ({
  id: String(r.id),
  kind: String(r.kind),
  value: String(r.value),
  is_active: Boolean(r.is_active),
  created_at: iso(r.created_at)!,
});

const SORTS: Record<string, string> = {
  full_name: 'x.full_name',
  employee_number: 'x.employee_number',
  hire_date: 'x.hire_date',
  created_at: 'x.created_at',
  licence_expires_on: 'x.licence_expires_on',
  status: 'x.status',
};

async function tenantInfo(
  c: PoolClient,
  tenantId: string,
): Promise<{ country: string; locale: 'en' | 'sw'; name: string }> {
  const t = (
    await c.query<{ country_code: string; locale: 'en' | 'sw'; name: string }>(
      'SELECT country_code, locale, name FROM tenants WHERE id = $1',
      [tenantId],
    )
  ).rows[0]!;
  return { country: t.country_code.trim(), locale: t.locale, name: t.name };
}

async function getDriverRow(c: PoolClient, id: string): Promise<Row> {
  const r = (await c.query<Row>(`${DRIVER_SELECT} AND dr.id = $1`, [id])).rows[0];
  if (!r) throw notFound('Driver');
  return r;
}

function driverColumns(
  b: Partial<z.infer<typeof DriverInput>>,
  country: string,
): Record<string, unknown> {
  const { custom_fields, phone, emergency_contact_phone, ...rest } = b;
  return {
    ...rest,
    phone: normalizePhone(phone, country),
    emergency_contact_phone: normalizePhone(emergency_contact_phone, country),
    ...(custom_fields !== undefined ? { custom_fields: JSON.stringify(custom_fields) } : {}),
  };
}

async function endAssignments(c: PoolClient, driverId: string): Promise<void> {
  await c.query(
    `UPDATE driver_vehicle_assignments SET ends_at = greatest(now(), starts_at + interval '1 second')
     WHERE driver_id = $1 AND ends_at IS NULL`,
    [driverId],
  );
}

async function disableLogin(userId: string, reason: string): Promise<void> {
  await withTransaction(systemPool, async (c) => {
    await c.query(`UPDATE users SET status = 'disabled' WHERE id = $1 AND role = 'driver'`, [
      userId,
    ]);
    await c.query(`UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [
      userId,
    ]);
    await revokeSessions(c, { userId }, reason);
  });
}

export function registerDriverRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'get',
    path: '/drivers',
    tags: TAGS,
    summary: 'List drivers',
    auth: true,
    query: z.object({
      ...PageQuery,
      search: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe('Name, phone, employee number, national ID or licence number'),
      status: z.enum(STATUSES).optional(),
      assigned: z.enum(['true', 'false']).optional(),
      licence_status: z
        .enum(['expired', 'expiring', 'valid', 'missing'])
        .optional()
        .describe('Driving licence: expiring = within 30 days'),
      sort: z
        .string()
        .max(40)
        .optional()
        .describe(`One of ${Object.keys(SORTS).join(', ')}; prefix - for descending`),
    }),
    middleware: guard('drivers:read'),
    responses: {
      200: {
        description: 'Page of drivers',
        schema: z.object({ data: z.array(DriverSchema), pagination: Pagination }),
      },
    },
    handler: async ({ req, query }) =>
      tenantDb(req, async (c) => {
        const where: string[] = [];
        const params: unknown[] = [];
        if (query.status) {
          params.push(query.status);
          where.push(`x.status = $${params.length}`);
        }
        if (query.assigned)
          where.push(
            query.assigned === 'true' ? 'x.vehicle_id IS NOT NULL' : 'x.vehicle_id IS NULL',
          );
        if (query.licence_status === 'expired') where.push('x.licence_expires_on < current_date');
        if (query.licence_status === 'expiring')
          where.push(`x.licence_expires_on BETWEEN current_date AND current_date + 30`);
        if (query.licence_status === 'valid')
          where.push(`x.licence_expires_on > current_date + 30`);
        if (query.licence_status === 'missing') where.push('x.licence_number IS NULL');
        if (query.search) {
          params.push(query.search);
          const n = `$${params.length}`;
          where.push(`(x.full_name ILIKE '%' || ${n} || '%' OR x.phone ILIKE '%' || regexp_replace(${n}, '^0', '') || '%'
            OR x.employee_number ILIKE '%' || ${n} || '%' OR x.national_id ILIKE '%' || ${n} || '%' OR x.licence_number ILIKE '%' || ${n} || '%')`);
        }
        const order = orderBy(query.sort, SORTS, 'x.full_name ASC');
        params.push(query.page_size, (query.page - 1) * query.page_size);
        const { rows } = await c.query<Row>(
          `SELECT x.*, count(*) OVER() AS total FROM (${DRIVER_SELECT}) x ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return paged(rows.map(toDriver), Number(rows[0]?.total ?? 0), query.page, query.page_size);
      }),
  });

  route(v1, BASE, {
    method: 'get',
    path: '/drivers/:id',
    tags: TAGS,
    summary: 'Driver details with licences, tags and assignment history',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('drivers:read'),
    responses: {
      200: {
        description: 'Driver',
        schema: DriverSchema.extend({
          licences: z.array(LicenceSchema),
          identifiers: z.array(IdentifierSchema),
          assignments: z.array(
            z.object({
              vehicle_id: z.string(),
              plate_number: z.string(),
              starts_at: z.string(),
              ends_at: z.string().nullable(),
              assignment_type: z.string(),
              source: z.string(),
            }),
          ),
        }),
      },
    },
    handler: async ({ req, params }) =>
      tenantDb(req, async (c) => {
        const d = await getDriverRow(c, params.id);
        const [lic, ids, hist] = await Promise.all([
          c.query<Row>(
            'SELECT * FROM driver_licences WHERE driver_id = $1 AND deleted_at IS NULL ORDER BY licence_type, expires_on DESC NULLS LAST',
            [params.id],
          ),
          c.query<Row>(
            'SELECT * FROM driver_identifiers WHERE driver_id = $1 ORDER BY created_at',
            [params.id],
          ),
          c.query<Row>(
            `SELECT dva.vehicle_id, v.plate_number, dva.starts_at, dva.ends_at, dva.assignment_type, dva.source
             FROM driver_vehicle_assignments dva JOIN vehicles v ON v.id = dva.vehicle_id
             WHERE dva.driver_id = $1 ORDER BY dva.starts_at DESC LIMIT 20`,
            [params.id],
          ),
        ]);
        return {
          ...toDriver(d),
          licences: lic.rows.map(toLicence),
          identifiers: ids.rows.map(toIdentifier),
          assignments: hist.rows.map((h) => ({
            vehicle_id: String(h.vehicle_id),
            plate_number: String(h.plate_number),
            starts_at: iso(h.starts_at)!,
            ends_at: iso(h.ends_at),
            assignment_type: String(h.assignment_type),
            source: String(h.source),
          })),
        };
      }),
  });

  route(v1, BASE, {
    method: 'post',
    path: '/drivers',
    tags: TAGS,
    summary: 'Add a driver',
    auth: true,
    description:
      'Phone numbers may be entered in local form (0722 123 456) and are stored in international form.',
    body: DriverInput,
    status: 201,
    middleware: guard('drivers:write'),
    responses: { 201: { description: 'Created', schema: DriverSchema } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const t = await tenantInfo(c, auth.tenantId!);
        await assertFile(c, body.photo_file_id, ['driver_photo']);
        const q = insertSql('drivers', {
          ...driverColumns(body, t.country),
          tenant_id: auth.tenantId,
        });
        const id = (await c.query<{ id: string }>(q.text, q.values)).rows[0]!.id;
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'driver.created',
          entityType: 'driver',
          entityId: id,
          metadata: { full_name: body.full_name },
          req,
        });
        return toDriver(await getDriverRow(c, id));
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/drivers/:id',
    tags: TAGS,
    summary: 'Update a driver',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: DriverPatch,
    middleware: guard('drivers:write'),
    responses: { 200: { description: 'Updated', schema: DriverSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const before = (
          await c.query<Row>('SELECT * FROM drivers WHERE id = $1 AND deleted_at IS NULL', [
            params.id,
          ])
        ).rows[0];
        if (!before) throw notFound('Driver');
        const t = await tenantInfo(c, auth.tenantId!);
        await assertFile(c, body.photo_file_id, ['driver_photo']);
        const cols = driverColumns(body, t.country);
        const q = updateSql('drivers', params.id, cols);
        await c.query(q.text, q.values);
        const changes = diff(before, { ...cols, custom_fields: body.custom_fields });
        if (Object.keys(changes).length) {
          await audit({
            tenantId: auth.tenantId,
            actorId: auth.userId,
            action: 'driver.updated',
            entityType: 'driver',
            entityId: params.id,
            changes,
            req,
          });
        }
        return toDriver(await getDriverRow(c, params.id));
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/drivers/:id',
    tags: TAGS,
    summary: 'Remove a driver',
    description: 'Soft delete: ends the vehicle assignment and disables the driver app login.',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('drivers:write'),
    responses: { 204: { description: 'Removed' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      const d = await tenantDb(req, async (c) => {
        const row = (
          await c.query<Row>(
            'SELECT id, full_name, user_id FROM drivers WHERE id = $1 AND deleted_at IS NULL',
            [params.id],
          )
        ).rows[0];
        if (!row) throw notFound('Driver');
        await endAssignments(c, params.id);
        await c.query('UPDATE driver_identifiers SET is_active = false WHERE driver_id = $1', [
          params.id,
        ]);
        await c.query('UPDATE drivers SET deleted_at = now(), status = $2 WHERE id = $1', [
          params.id,
          'terminated',
        ]);
        return row;
      });
      if (d.user_id) await disableLogin(String(d.user_id), 'driver_removed');
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'driver.deleted',
        entityType: 'driver',
        entityId: params.id,
        metadata: { full_name: d.full_name },
        req,
      });
      return undefined;
    },
  });

  // ---------------------------------------------------------------- licences
  route(v1, BASE, {
    method: 'post',
    path: '/drivers/:id/licences',
    tags: TAGS,
    summary: 'Add a licence or badge',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: LicenceInput,
    status: 201,
    middleware: guard('drivers:write'),
    responses: { 201: { description: 'Created', schema: LicenceSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await getDriverRow(c, params.id);
        await assertFile(c, body.file_id, ['driver_licence']);
        if (body.issued_on && body.expires_on && body.expires_on < body.issued_on)
          throw unprocessable('Expiry date is before the issue date');
        const q = insertSql('driver_licences', {
          ...body,
          driver_id: params.id,
          tenant_id: auth.tenantId,
        });
        const id = (await c.query<{ id: string }>(q.text, q.values)).rows[0]!.id;
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'driver_licence.created',
          entityType: 'driver_licence',
          entityId: id,
          metadata: { driver_id: params.id, licence_type: body.licence_type },
          req,
        });
        return toLicence(
          (await c.query<Row>('SELECT * FROM driver_licences WHERE id = $1', [id])).rows[0]!,
        );
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/driver-licences/:id',
    tags: TAGS,
    summary: 'Update a licence or badge',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: LicencePatch,
    middleware: guard('drivers:write'),
    responses: { 200: { description: 'Updated', schema: LicenceSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const before = (
          await c.query<Row>('SELECT * FROM driver_licences WHERE id = $1 AND deleted_at IS NULL', [
            params.id,
          ])
        ).rows[0];
        if (!before) throw notFound('Licence');
        await assertFile(c, body.file_id, ['driver_licence']);
        const issued = body.issued_on !== undefined ? body.issued_on : str(before.issued_on);
        const expires = body.expires_on !== undefined ? body.expires_on : str(before.expires_on);
        if (issued && expires && expires < issued)
          throw unprocessable('Expiry date is before the issue date');
        const q = updateSql('driver_licences', params.id, body);
        await c.query(q.text, q.values);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'driver_licence.updated',
          entityType: 'driver_licence',
          entityId: params.id,
          changes: diff(before, body),
          req,
        });
        return toLicence(
          (await c.query<Row>('SELECT * FROM driver_licences WHERE id = $1', [params.id])).rows[0]!,
        );
      });
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/driver-licences/:id',
    tags: TAGS,
    summary: 'Delete a licence or badge',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('drivers:write'),
    responses: { 204: { description: 'Deleted' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      await tenantDb(req, async (c) => {
        const r = await c.query(
          'UPDATE driver_licences SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING driver_id',
          [params.id],
        );
        if (!r.rowCount) throw notFound('Licence');
      });
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'driver_licence.deleted',
        entityType: 'driver_licence',
        entityId: params.id,
        req,
      });
      return undefined;
    },
  });

  // ---------------------------------------------------------------- RFID / iButton
  route(v1, BASE, {
    method: 'post',
    path: '/drivers/:id/identifiers',
    tags: TAGS,
    summary: 'Register an RFID card or iButton',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({
      kind: z.enum(['rfid', 'ibutton']),
      value: z
        .string()
        .trim()
        .regex(/^[A-Fa-f0-9]{4,32}$/, 'Tag ID must be 4-32 hex characters'),
    }),
    status: 201,
    middleware: guard('drivers:write'),
    responses: { 201: { description: 'Registered', schema: IdentifierSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        await getDriverRow(c, params.id);
        const r = (
          await c.query<Row>(
            'INSERT INTO driver_identifiers (tenant_id, driver_id, kind, value) VALUES ($1, $2, $3, $4) RETURNING *',
            [auth.tenantId, params.id, body.kind, body.value.toUpperCase()],
          )
        ).rows[0]!;
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'driver_identifier.created',
          entityType: 'driver',
          entityId: params.id,
          metadata: { kind: body.kind, value: body.value.toUpperCase() },
          req,
        });
        return toIdentifier(r);
      });
    },
  });

  route(v1, BASE, {
    method: 'patch',
    path: '/driver-identifiers/:id',
    tags: TAGS,
    summary: 'Activate or deactivate a tag',
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({ is_active: z.boolean() }),
    middleware: guard('drivers:write'),
    responses: { 200: { description: 'Updated', schema: IdentifierSchema } },
    handler: async ({ req, params, body }) =>
      tenantDb(req, async (c) => {
        const r = (
          await c.query<Row>(
            'UPDATE driver_identifiers SET is_active = $2 WHERE id = $1 RETURNING *',
            [params.id, body.is_active],
          )
        ).rows[0];
        if (!r) throw notFound('Tag');
        return toIdentifier(r);
      }),
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/driver-identifiers/:id',
    tags: TAGS,
    summary: 'Delete a tag',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('drivers:write'),
    responses: { 204: { description: 'Deleted' } },
    handler: async ({ req, params }) => {
      await tenantDb(req, async (c) => {
        if (!(await c.query('DELETE FROM driver_identifiers WHERE id = $1', [params.id])).rowCount)
          throw notFound('Tag');
      });
      return undefined;
    },
  });

  // ---------------------------------------------------------------- vehicle assignment
  route(v1, BASE, {
    method: 'post',
    path: '/drivers/:id/assign',
    tags: TAGS,
    summary: 'Assign the driver to a vehicle',
    auth: true,
    description:
      'Fails with 409 assignment_conflict if the driver or the vehicle is already paired, unless replace=true.',
    params: z.object({ id: z.uuid() }),
    body: z.object({
      vehicle_id: z.uuid(),
      starts_at: z.iso
        .datetime({ offset: true })
        .optional()
        .describe('Defaults to now; cannot be in the future'),
      assignment_type: z.enum(['primary', 'temporary']).default('primary'),
      replace: z.boolean().default(false),
    }),
    middleware: guard('drivers:write'),
    responses: { 200: { description: 'Assigned', schema: DriverSchema } },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      const at = body.starts_at ? new Date(body.starts_at) : new Date();
      if (at.getTime() > Date.now() + 60_000)
        throw unprocessable('Start time cannot be in the future');
      return tenantDb(req, async (c) => {
        const driver = await getDriverRow(c, params.id);
        if (driver.status !== 'active')
          throw new AppError(409, 'driver_not_active', 'Only active drivers can be assigned');
        const vehicle = await visibleVehicle(c, body.vehicle_id, await groupScope(c, auth.userId));
        const onDriver = (
          await c.query<{ id: string; vehicle_id: string; plate_number: string; starts_at: Date }>(
            `SELECT dva.id, dva.vehicle_id, v.plate_number, dva.starts_at FROM driver_vehicle_assignments dva JOIN vehicles v ON v.id = dva.vehicle_id
           WHERE dva.driver_id = $1 AND dva.ends_at IS NULL`,
            [params.id],
          )
        ).rows[0];
        if (onDriver?.vehicle_id === body.vehicle_id) return toDriver(driver);
        const onVehicle = (
          await c.query<{ id: string; full_name: string; starts_at: Date }>(
            `SELECT dva.id, dr.full_name, dva.starts_at FROM driver_vehicle_assignments dva JOIN drivers dr ON dr.id = dva.driver_id
           WHERE dva.vehicle_id = $1 AND dva.ends_at IS NULL`,
            [body.vehicle_id],
          )
        ).rows[0];
        const conflicts = [
          ...(onDriver
            ? [
                {
                  type: 'driver_assigned',
                  message: `${String(driver.full_name)} is assigned to ${onDriver.plate_number}`,
                },
              ]
            : []),
          ...(onVehicle
            ? [
                {
                  type: 'vehicle_has_driver',
                  message: `${String(vehicle.plate_number)} is assigned to ${onVehicle.full_name}`,
                },
              ]
            : []),
        ];
        if (conflicts.length && !body.replace) {
          throw new AppError(
            409,
            'assignment_conflict',
            'This change would replace an existing assignment. Send replace=true to confirm.',
            conflicts,
          );
        }
        for (const cur of [onDriver, onVehicle]) {
          if (!cur) continue;
          if (at <= cur.starts_at)
            throw unprocessable('The new start time must be after the current assignment started');
          await c.query('UPDATE driver_vehicle_assignments SET ends_at = $2 WHERE id = $1', [
            cur.id,
            at,
          ]);
        }
        await c.query(
          `INSERT INTO driver_vehicle_assignments (tenant_id, driver_id, vehicle_id, starts_at, assignment_type, source, created_by)
           VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
          [auth.tenantId, params.id, body.vehicle_id, at, body.assignment_type, auth.userId],
        );
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'driver.assigned',
          entityType: 'driver',
          entityId: params.id,
          metadata: {
            vehicle_id: body.vehicle_id,
            plate_number: vehicle.plate_number,
            replaced: conflicts.map((x) => x.type),
          },
          req,
        });
        return toDriver(await getDriverRow(c, params.id));
      });
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/drivers/:id/unassign',
    tags: TAGS,
    summary: "End the driver's current vehicle assignment",
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: guard('drivers:write'),
    responses: { 200: { description: 'Unassigned', schema: DriverSchema } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      return tenantDb(req, async (c) => {
        const d = await getDriverRow(c, params.id);
        if (!d.vehicle_id)
          throw new AppError(409, 'not_assigned', 'This driver is not assigned to a vehicle');
        await endAssignments(c, params.id);
        await audit({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          action: 'driver.unassigned',
          entityType: 'driver',
          entityId: params.id,
          metadata: { vehicle_id: d.vehicle_id, plate_number: d.plate_number },
          req,
        });
        return toDriver(await getDriverRow(c, params.id));
      });
    },
  });

  // ---------------------------------------------------------------- driver app access
  route(v1, BASE, {
    method: 'post',
    path: '/drivers/:id/app-access',
    tags: TAGS,
    summary: 'Invite the driver to the driver app',
    auth: true,
    description:
      'Creates (or re-invites) the driver login and emails a 7-day invitation in the company language.',
    params: z.object({ id: z.uuid() }),
    body: z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional() }),
    status: 201,
    middleware: guard('drivers:write'),
    responses: {
      201: {
        description: 'Invitation sent',
        schema: z.object({
          user_id: z.string(),
          email: z.string(),
          status: z.string(),
          invite_expires_at: z.string(),
        }),
      },
    },
    handler: async ({ req, params, body }) => {
      const auth = requireAuth(req);
      const token = randomToken(32);
      const result = await tenantDb(req, async (c) => {
        const d = (
          await c.query<Row>(
            'SELECT id, full_name, phone, email, user_id, status FROM drivers WHERE id = $1 AND deleted_at IS NULL',
            [params.id],
          )
        ).rows[0];
        if (!d) throw notFound('Driver');
        if (d.status !== 'active')
          throw new AppError(
            409,
            'driver_not_active',
            'Only active drivers can be given app access',
          );
        const t = await tenantInfo(c, auth.tenantId!);
        let userId = str(d.user_id);
        let email = body.email ?? str(d.email);
        if (userId) {
          const u = (
            await c.query<{ status: string; email: string }>(
              'SELECT status, email FROM users WHERE id = $1',
              [userId],
            )
          ).rows[0];
          if (u?.status === 'active')
            throw new AppError(409, 'already_has_access', 'This driver already has app access');
          email = u?.email ?? email;
          if (u?.status === 'disabled')
            await c.query(`UPDATE users SET status = 'invited' WHERE id = $1`, [userId]);
        }
        if (!email)
          throw unprocessable('Add an email address for the driver first (or pass one here)');
        if (!userId) {
          userId = (
            await c.query<{ id: string }>(
              `INSERT INTO users (tenant_id, email, full_name, phone, role, locale, status) VALUES ($1, $2, $3, $4, 'driver', $5, 'invited') RETURNING id`,
              [auth.tenantId, email, d.full_name, d.phone, t.locale],
            )
          ).rows[0]!.id;
          await c.query(
            'UPDATE drivers SET user_id = $2, email = coalesce(email, $3) WHERE id = $1',
            [params.id, userId, email],
          );
        }
        await c.query(
          `UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'invite' AND used_at IS NULL`,
          [userId],
        );
        const exp = (
          await c.query<{ expires_at: Date }>(
            `INSERT INTO user_tokens (user_id, tenant_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'invite', $3, now() + interval '7 days') RETURNING expires_at`,
            [userId, auth.tenantId, sha256(token)],
          )
        ).rows[0]!.expires_at;
        return { userId, email, name: String(d.full_name), tenant: t, expires: exp };
      });
      try {
        await sendMail({
          to: result.email,
          ...inviteEmail(
            result.tenant.locale,
            result.name,
            result.tenant.name,
            `${config.WEB_APP_URL}/accept-invite?token=${token}`,
          ),
        });
      } catch (err) {
        logger.error({ err }, 'driver invite email failed');
      }
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'driver.app_invited',
        entityType: 'driver',
        entityId: params.id,
        metadata: { user_id: result.userId, email: result.email },
        req,
      });
      return {
        user_id: result.userId,
        email: result.email,
        status: 'invited',
        invite_expires_at: result.expires.toISOString(),
      };
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/drivers/:id/app-access',
    tags: TAGS,
    summary: 'Remove driver app access',
    auth: true,
    description: 'Disables the login and signs out every device immediately.',
    params: z.object({ id: z.uuid() }),
    middleware: guard('drivers:write'),
    responses: { 204: { description: 'Access removed' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      const userId = await tenantDb(req, async (c) => {
        const d = (
          await c.query<{ user_id: string | null }>(
            'SELECT user_id FROM drivers WHERE id = $1 AND deleted_at IS NULL',
            [params.id],
          )
        ).rows[0];
        if (!d) throw notFound('Driver');
        if (!d.user_id) throw new AppError(409, 'no_access', 'This driver has no app access');
        return d.user_id;
      });
      await disableLogin(userId, 'access_removed');
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'driver.app_access_removed',
        entityType: 'driver',
        entityId: params.id,
        req,
      });
      return undefined;
    },
  });
}
