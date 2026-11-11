import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

interface PgLikeError {
  code?: string;
  constraint?: string;
}

const CONSTRAINT_MESSAGES: Record<string, string> = {
  vehicles_plate_unique: 'A vehicle with this plate number already exists',
  vehicles_vin_unique: 'A vehicle with this VIN already exists',
  vehicle_groups_name_unique: 'A group with this name already exists',
  drivers_employee_number_unique: 'A driver with this employee number already exists',
  drivers_national_id_unique: 'A driver with this national ID already exists',
  driver_identifiers_unique: 'This RFID/iButton tag is already assigned to a driver',
  users_email_unique: 'A user with this email already exists',
  devices_identifier_key: 'A device with this IMEI/identifier already exists',
  parts_number_unique: 'A part with this number already exists',
  pois_external_ref_unique: 'A place with this reference already exists',
  work_orders_number_unique: 'This work order number is already used',
  jobs_reference_unique: 'This job reference is already used',
  service_tasks_name_unique: 'A service task with this name already exists',
  device_assignments_device_no_overlap:
    'This tracker is already installed on another vehicle for that period',
  device_assignments_vehicle_no_overlap: 'This vehicle already has a tracker for that period',
  dva_driver_no_overlap: 'This driver is already assigned to another vehicle for that period',
  dva_vehicle_no_overlap: 'This vehicle already has a driver for that period',
};

function fromPostgres(err: PgLikeError): AppError | null {
  const details = err.constraint ? { constraint: err.constraint } : undefined;
  const friendly = err.constraint ? CONSTRAINT_MESSAGES[err.constraint] : undefined;
  switch (err.code) {
    case '23505':
      return new AppError(
        409,
        'duplicate',
        friendly ?? 'A record with these details already exists',
        details,
      );
    case '23503':
      return new AppError(
        409,
        'invalid_reference',
        'A referenced record does not exist or is not accessible',
        details,
      );
    case '23514':
      return new AppError(
        422,
        'rule_violation',
        friendly ?? 'The data breaks a business rule',
        details,
      );
    case '23P01':
      return new AppError(
        409,
        'overlap',
        friendly ?? 'This overlaps an existing assignment for the same period',
        details,
      );
    case '22P02':
    case '22007':
    case '22008':
      return new AppError(400, 'invalid_input', 'One of the values has an invalid format');
    case '42501':
      return new AppError(403, 'forbidden', 'You do not have permission to perform this action');
    default:
      return null;
  }
}

const UNAVAILABLE_CODES =
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/;

/** True when a dependency (database, Redis, storage, provider) could not be reached. Searches wrapped and aggregate errors. */
export function isUnavailable(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 5) return false;
  const e = err as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof e.code === 'string' && UNAVAILABLE_CODES.test(e.code)) return true;
  if (e.name === 'TimeoutError' || e.name === 'NetworkingError') return true;
  if (typeof e.message === 'string' && UNAVAILABLE_CODES.test(e.message)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isUnavailable(x, depth + 1))) return true;
  return isUnavailable(e.cause, depth + 1);
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'route_not_found', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (err instanceof ZodError)
    e = new AppError(
      422,
      'validation_failed',
      'Request validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    );
  else if (err?.type === 'entity.parse.failed')
    e = new AppError(400, 'invalid_json', 'Request body is not valid JSON');
  else if (err?.type === 'entity.too.large')
    e = new AppError(413, 'payload_too_large', 'Request body is too large');
  else if (isUnavailable(err))
    e = new AppError(
      503,
      'service_unavailable',
      'A required service is temporarily unavailable. Please try again shortly.',
    );
  else
    e =
      fromPostgres(err as PgLikeError) ??
      new AppError(500, 'internal_error', 'Something went wrong on our side');

  if (e.status >= 500) req.log.error({ err }, 'request failed');
  else req.log.warn({ code: e.code, status: e.status }, e.message);

  if (res.headersSent) return;
  if (e.status === 503) res.setHeader('Retry-After', '10');
  res.status(e.status).json({
    error: {
      code: e.code,
      message: e.message,
      ...(e.details !== undefined ? { details: e.details } : {}),
      requestId: String(req.id),
    },
  });
};
