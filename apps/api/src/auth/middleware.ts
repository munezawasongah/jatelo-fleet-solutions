import type { Request, RequestHandler } from 'express';
import { isAdminRole, ROLE_PERMISSIONS, type Permission, type Role } from '@jfs/shared';
import { withTenant, type PoolClient } from '@jfs/db';
import { AppError, forbidden, unauthorized } from '../http/errors.js';
import { appPool, systemPool } from '../infra/db.js';
import { isSessionRevoked, verifyAccess } from './tokens.js';

export interface AuthContext {
  userId: string;
  tenantId: string | null;
  role: Role;
  sessionId: string;
  mfaOk: boolean;
  permissions: ReadonlySet<Permission>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(unauthorized());
    return;
  }
  let claims;
  try {
    claims = await verifyAccess(header.slice(7).trim());
  } catch {
    next(new AppError(401, 'invalid_token', 'Access token is invalid or has expired'));
    return;
  }
  if (await isSessionRevoked(claims.sessionId)) {
    next(new AppError(401, 'session_revoked', 'This session has been signed out'));
    return;
  }
  req.auth = { ...claims, permissions: new Set(ROLE_PERMISSIONS[claims.role]) };
  next();
};

/** Admins must finish 2FA setup before using anything other than sign-in and 2FA endpoints. */
export const requireMfaReady: RequestHandler = (req, _res, next) => {
  const auth = req.auth;
  if (auth && isAdminRole(auth.role) && !auth.mfaOk) {
    next(
      new AppError(
        403,
        'mfa_setup_required',
        'Two-factor authentication must be enabled for your role first',
      ),
    );
    return;
  }
  next();
};

export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) {
      next(unauthorized());
      return;
    }
    const missing = permissions.filter((p) => !auth.permissions.has(p));
    if (missing.length > 0) {
      next(forbidden());
      return;
    }
    next();
  };
}

const tenantStatus = new Map<string, { at: number; status: string }>();
/** Suspended companies can only reach billing (to pay) and their own profile. Status cached for 30 s per API instance. */
export const requireTenantActive: RequestHandler = async (req, _res, next) => {
  const tid = req.auth?.tenantId;
  if (!tid) return next();
  let hit = tenantStatus.get(tid);
  if (!hit || Date.now() - hit.at > 30_000) {
    try {
      const r = await systemPool.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [tid]);
      hit = { at: Date.now(), status: r.rows[0]?.status ?? 'cancelled' };
      tenantStatus.set(tid, hit);
    } catch (err) {
      return next(err);
    }
  }
  if (hit.status === 'suspended' || hit.status === 'cancelled') {
    const path = req.originalUrl.split('?')[0] ?? '';
    if (hit.status === 'cancelled' || !(path.startsWith('/api/v1/billing') || path.startsWith('/api/v1/auth')))
      return next(new AppError(402, 'tenant_suspended', 'Your company account is suspended for non-payment. Please settle the outstanding invoice under Billing.'));
  }
  next();
};
export const forgetTenantStatus = (tenantId: string): void => void tenantStatus.delete(tenantId);

/** Standard protection for business endpoints: signed in, 2FA-ready, company in good standing, and holding every listed permission. */
export const guard = (...permissions: Permission[]): RequestHandler[] => [
  authenticate,
  requireMfaReady,
  requireTenantActive,
  requirePermission(...permissions),
];

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Runs fn in a transaction scoped to the caller's tenant (Row-Level Security enforced). */
export async function tenantDb<T>(
  req: Request,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const auth = requireAuth(req);
  if (!auth.tenantId)
    throw new AppError(400, 'tenant_required', 'This action needs a company context');
  return withTenant(appPool, auth.tenantId, fn, { userId: auth.userId });
}
