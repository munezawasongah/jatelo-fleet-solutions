import type { Request, RequestHandler } from 'express';
import { isAdminRole, ROLE_PERMISSIONS, type Permission, type Role } from '@jfs/shared';
import { withTenant, type PoolClient } from '@jfs/db';
import { AppError, forbidden, unauthorized } from '../http/errors.js';
import { appPool } from '../infra/db.js';
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

/** Standard protection for business endpoints: signed in, 2FA-ready, and holding every listed permission. */
export const guard = (...permissions: Permission[]): RequestHandler[] => [
  authenticate,
  requireMfaReady,
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
