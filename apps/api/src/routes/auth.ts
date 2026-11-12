import { randomBytes } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { withTransaction } from '@jfs/db';
import { isAdminRole, ROLE_PERMISSIONS, type Role } from '@jfs/shared';
import { audit } from '../auth/audit.js';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from '../auth/crypto.js';
import { authenticate, requireAuth, requireMfaReady } from '../auth/middleware.js';
import {
  burnPasswordCheck,
  hashPassword,
  PasswordPolicy,
  verifyPassword,
} from '../auth/passwords.js';
import {
  createSession,
  MFA_CHALLENGE_TTL_S,
  revokeSessions,
  signMfaChallenge,
  verifyMfaChallenge,
  type TokenPair,
} from '../auth/tokens.js';
import { generateSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import { config, isProduction } from '../config.js';
import { AppError, notFound } from '../http/errors.js';
import { rateLimit } from '../http/rate-limit.js';
import { route } from '../http/route.js';
import { systemPool } from '../infra/db.js';
import { passwordResetEmail } from '../infra/email-templates.js';
import { sendMail } from '../infra/mailer.js';
import { logger } from '../logger.js';

const BASE = '/api/v1';
const TAGS = ['Auth'];
const COOKIE = 'jfs_rt';
const COOKIE_PATH = '/api/v1/auth';

// ---------------------------------------------------------------- schemas
const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) });
const MfaLoginBody = z.object({
  mfa_token: z.string().min(20).max(1000),
  code: z.string().trim().min(6).max(20),
});
const RefreshBody = z.object({ refresh_token: z.string().min(20).max(200).optional() });
const CodeBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
});

const TokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
  refresh_expires_at: z.string(),
  mfa_setup_required: z.boolean().optional(),
});
const MfaChallengeSchema = z.object({
  mfa_required: z.literal(true),
  mfa_token: z.string(),
  expires_in: z.number(),
});
const MeSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    full_name: z.string(),
    role: z.string(),
    locale: z.string(),
    phone: z.string().nullable(),
    avatar_url: z.string().nullable(),
    mfa_enabled: z.boolean(),
    last_login_at: z.string().nullable(),
  }),
  tenant: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      country_code: z.string(),
      currency: z.string(),
      timezone: z.string(),
      locale: z.string(),
      status: z.string(),
      trial_ends_at: z.string().nullable(),
    })
    .nullable(),
  permissions: z.array(z.string()),
  mfa_setup_required: z.boolean(),
});
const SessionsSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      current: z.boolean(),
      started_at: z.string(),
      last_refreshed_at: z.string(),
      user_agent: z.string().nullable(),
      ip: z.string().nullable(),
    }),
  ),
});

// ---------------------------------------------------------------- helpers
interface UserRow {
  id: string;
  tenant_id: string | null;
  email: string;
  full_name: string;
  role: Role;
  status: string;
  locale: 'en' | 'sw';
  password_hash: string | null;
  failed_login_count: number;
  locked_until: Date | null;
  tenant_status: string | null;
  mfa_enabled_at: Date | null;
}

const USER_SQL = `SELECT u.id, u.tenant_id, u.email, u.full_name, u.role, u.status, u.locale, u.password_hash,
  u.failed_login_count, u.locked_until, t.status AS tenant_status, m.enabled_at AS mfa_enabled_at
  FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id LEFT JOIN user_mfa m ON m.user_id = u.id
  WHERE u.deleted_at IS NULL AND `;

const invalidCredentials = (): AppError =>
  new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
const locked = (until: Date): AppError =>
  new AppError(423, 'account_locked', 'Too many failed attempts. Please try again later.', {
    retry_after_s: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)),
  });
const invalidMfa = (): AppError =>
  new AppError(401, 'invalid_mfa_code', 'The verification code is not valid');

function assertCanSignIn(u: UserRow): void {
  if (u.status === 'invited')
    throw new AppError(403, 'account_not_activated', 'Accept your invitation before signing in');
  if (u.status !== 'active')
    throw new AppError(403, 'account_disabled', 'This account has been disabled');
  // company admins may still sign in to a suspended account to settle invoices (everything except billing is blocked)
  if (u.tenant_id && (u.tenant_status === 'cancelled' || (u.tenant_status === 'suspended' && u.role !== 'company_admin'))) {
    throw new AppError(
      403,
      'tenant_suspended',
      'Your company account is suspended. Please contact your administrator.',
    );
  }
}

const meta = (req: Request): { ip?: string; userAgent?: string } => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}
const clearRefreshCookie = (res: Response): void => {
  res.clearCookie(COOKIE, { path: COOKIE_PATH });
};

function readRefresh(req: Request, fromBody?: string): string | undefined {
  if (fromBody) return fromBody;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalizeBackup = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () => {
    let s = '';
    for (const b of randomBytes(10)) s += BACKUP_ALPHABET.charAt(b % 32);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(normalizeBackup(c))) };
}

async function startSession(
  user: UserRow,
  mfaOk: boolean,
  req: Request,
  res: Response,
): Promise<TokenPair> {
  const pair = await withTransaction(systemPool, async (c) => {
    const s = await createSession(c, user, mfaOk, meta(req));
    await c.query(
      'UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1',
      [user.id],
    );
    return s.pair;
  });
  setRefreshCookie(res, pair.refresh_token);
  return pair;
}

async function loadMfa(userId: string): Promise<{
  secret: string | null;
  enabled: boolean;
  lastStep: number | null;
  backup: string[];
} | null> {
  const row = (
    await systemPool.query<{
      totp_secret_enc: string;
      enabled_at: Date | null;
      last_used_step: string | null;
      backup_code_hashes: string[];
    }>(
      'SELECT totp_secret_enc, enabled_at, last_used_step, backup_code_hashes FROM user_mfa WHERE user_id = $1',
      [userId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    secret: decrypt(row.totp_secret_enc),
    enabled: row.enabled_at !== null,
    lastStep: row.last_used_step === null ? null : Number(row.last_used_step),
    backup: row.backup_code_hashes,
  };
}

/** Verifies a TOTP code and records its step atomically so it cannot be replayed. */
async function consumeTotp(
  userId: string,
  secret: string,
  lastStep: number | null,
  code: string,
): Promise<boolean> {
  const step = verifyTotp(secret, code, lastStep);
  if (step === null) return false;
  const r = await systemPool.query(
    'UPDATE user_mfa SET last_used_step = $2 WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2)',
    [userId, step],
  );
  return (r.rowCount ?? 0) === 1;
}

// ---------------------------------------------------------------- rate limiters
const emailKey = (req: Request): string =>
  `${req.ip}:${String((req.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase()}`;
const loginLimiter = rateLimit({
  keyPrefix: 'auth-login',
  points: 10,
  durationSec: 900,
  key: emailKey,
});
const mfaLimiter = rateLimit({ keyPrefix: 'auth-mfa', points: 10, durationSec: 300 });
const forgotLimiter = rateLimit({
  keyPrefix: 'auth-forgot',
  points: 5,
  durationSec: 3600,
  key: emailKey,
});
const tokenLimiter = rateLimit({ keyPrefix: 'auth-token', points: 20, durationSec: 900 });

// ---------------------------------------------------------------- routes
export function registerAuthRoutes(v1: Router): void {
  route(v1, BASE, {
    method: 'post',
    path: '/auth/login',
    tags: TAGS,
    summary: 'Sign in with email and password',
    description:
      'Returns tokens, or a 2FA challenge when the account has 2FA enabled. Admin roles without 2FA receive mfa_setup_required=true ' +
      'and can only use /auth endpoints until 2FA is enabled. Five wrong passwords lock the account for 15 minutes.',
    body: LoginBody,
    middleware: [loginLimiter],
    responses: {
      200: {
        description: 'Signed in, or 2FA challenge',
        schema: z.union([TokenPairSchema, MfaChallengeSchema]),
      },
    },
    handler: async ({ req, res, body }) => {
      const user = (await systemPool.query<UserRow>(`${USER_SQL} u.email = $1`, [body.email]))
        .rows[0];
      if (!user || !user.password_hash) {
        await burnPasswordCheck(body.password);
        await audit({
          tenantId: user?.tenant_id ?? null,
          actorId: user?.id ?? null,
          action: 'auth.login_failed',
          metadata: { email: body.email, reason: user ? 'no_password_set' : 'unknown_email' },
          req,
        });
        throw invalidCredentials();
      }
      if (user.locked_until) {
        if (user.locked_until > new Date()) throw locked(user.locked_until);
        await systemPool.query(
          'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
          [user.id],
        );
      }
      if (!(await verifyPassword(user.password_hash, body.password))) {
        const f = (
          await systemPool.query<{ failed_login_count: number; locked_until: Date | null }>(
            `UPDATE users SET failed_login_count = failed_login_count + 1,
               locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
             WHERE id = $1 RETURNING failed_login_count, locked_until`,
            [user.id],
          )
        ).rows[0]!;
        await audit({
          tenantId: user.tenant_id,
          actorId: user.id,
          action: f.locked_until ? 'auth.account_locked' : 'auth.login_failed',
          metadata: { reason: 'bad_password', attempts: f.failed_login_count },
          req,
        });
        if (f.locked_until) throw locked(f.locked_until);
        throw invalidCredentials();
      }
      assertCanSignIn(user);
      if (user.mfa_enabled_at) {
        await systemPool.query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [user.id]);
        return {
          mfa_required: true as const,
          mfa_token: await signMfaChallenge(user.id),
          expires_in: MFA_CHALLENGE_TTL_S,
        };
      }
      const pair = await startSession(user, !isAdminRole(user.role), req, res);
      await audit({
        tenantId: user.tenant_id,
        actorId: user.id,
        action: 'auth.login',
        metadata: { mfa: false },
        req,
      });
      return isAdminRole(user.role) ? { ...pair, mfa_setup_required: true } : pair;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/login/mfa',
    tags: TAGS,
    summary: 'Complete sign-in with a 2FA code or a backup code',
    body: MfaLoginBody,
    middleware: [mfaLimiter],
    responses: {
      200: {
        description: 'Signed in',
        schema: TokenPairSchema.extend({ backup_codes_remaining: z.number() }),
      },
    },
    handler: async ({ req, res, body }) => {
      let userId: string;
      try {
        userId = await verifyMfaChallenge(body.mfa_token);
      } catch {
        throw new AppError(
          401,
          'invalid_mfa_token',
          'The sign-in step has expired. Please sign in again.',
        );
      }
      const user = (await systemPool.query<UserRow>(`${USER_SQL} u.id = $1`, [userId])).rows[0];
      if (!user)
        throw new AppError(
          401,
          'invalid_mfa_token',
          'The sign-in step has expired. Please sign in again.',
        );
      assertCanSignIn(user);
      const mfa = await loadMfa(user.id);
      if (!mfa?.enabled || !mfa.secret)
        throw new AppError(400, 'mfa_not_enabled', '2FA is not enabled for this account');

      let ok = false;
      let usedBackup = false;
      if (/^\d{6}$/.test(body.code)) {
        ok = await consumeTotp(user.id, mfa.secret, mfa.lastStep, body.code);
      } else {
        const h = sha256(normalizeBackup(body.code));
        const match = mfa.backup.find((x) => safeEqual(x, h));
        if (match) {
          const r = await systemPool.query(
            'UPDATE user_mfa SET backup_code_hashes = array_remove(backup_code_hashes, $2) WHERE user_id = $1 AND $2 = ANY(backup_code_hashes)',
            [user.id, match],
          );
          ok = (r.rowCount ?? 0) === 1;
          usedBackup = ok;
        }
      }
      if (!ok) {
        await audit({ tenantId: user.tenant_id, actorId: user.id, action: 'auth.mfa_failed', req });
        throw invalidMfa();
      }
      const pair = await startSession(user, true, req, res);
      await audit({
        tenantId: user.tenant_id,
        actorId: user.id,
        action: 'auth.login',
        metadata: { mfa: true, backup_code: usedBackup },
        req,
      });
      return { ...pair, backup_codes_remaining: mfa.backup.length - (usedBackup ? 1 : 0) };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/refresh',
    tags: TAGS,
    summary: 'Rotate the refresh token and get a new access token',
    description:
      'Send refresh_token in the body (mobile) or rely on the httpOnly cookie (web). Reusing an old token signs out that session.',
    body: RefreshBody,
    middleware: [tokenLimiter],
    responses: { 200: { description: 'New token pair', schema: TokenPairSchema } },
    handler: async ({ req, res, body }) => {
      const token = readRefresh(req, body.refresh_token);
      if (!token) throw new AppError(401, 'invalid_refresh', 'Refresh token is missing');

      interface RefreshRow {
        id: string;
        family_id: string;
        user_id: string;
        revoked_at: Date | null;
        revoked_reason: string | null;
        expires_at: Date;
        tenant_id: string | null;
        role: Role;
        status: string;
        deleted_at: Date | null;
        tenant_status: string | null;
        mfa_enabled_at: Date | null;
      }
      const outcome = await withTransaction(systemPool, async (c) => {
        const row = (
          await c.query<RefreshRow>(
            `SELECT rt.id, rt.family_id, rt.user_id, rt.revoked_at, rt.revoked_reason, rt.expires_at,
                    u.tenant_id, u.role, u.status, u.deleted_at, t.status AS tenant_status, m.enabled_at AS mfa_enabled_at
             FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
             LEFT JOIN tenants t ON t.id = u.tenant_id LEFT JOIN user_mfa m ON m.user_id = u.id
             WHERE rt.token_hash = $1 FOR UPDATE OF rt`,
            [sha256(token)],
          )
        ).rows[0];
        if (!row)
          return { error: new AppError(401, 'invalid_refresh', 'Refresh token is not valid') };
        if (row.revoked_at) {
          if (row.revoked_reason === 'rotated') {
            if (Date.now() - row.revoked_at.getTime() < 10_000) {
              return {
                error: new AppError(
                  409,
                  'refresh_race',
                  'This token was just rotated by another request; use the newest token',
                ),
              };
            }
            await revokeSessions(
              c,
              { userId: row.user_id, familyId: row.family_id },
              'reuse_detected',
            );
            return {
              error: new AppError(
                401,
                'refresh_reused',
                'Token reuse detected - this session was signed out for safety',
              ),
              reused: row,
            };
          }
          return {
            error: new AppError(401, 'session_revoked', 'This session has been signed out'),
          };
        }
        if (row.expires_at <= new Date())
          return {
            error: new AppError(401, 'refresh_expired', 'Session expired. Please sign in again.'),
          };
        if (
          row.deleted_at ||
          row.status !== 'active' ||
          (row.tenant_id &&
            (row.tenant_status === 'cancelled' || (row.tenant_status === 'suspended' && row.role !== 'company_admin')))
        ) {
          await revokeSessions(
            c,
            { userId: row.user_id, familyId: row.family_id },
            'account_inactive',
          );
          return {
            error: new AppError(401, 'account_inactive', 'This account can no longer sign in'),
          };
        }
        const mfaOk = !isAdminRole(row.role) || row.mfa_enabled_at !== null;
        const s = await createSession(
          c,
          { id: row.user_id, tenant_id: row.tenant_id, role: row.role },
          mfaOk,
          meta(req),
          row.family_id,
        );
        await c.query(
          `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = $2 WHERE id = $1`,
          [row.id, s.tokenId],
        );
        return { pair: s.pair, setupRequired: !mfaOk };
      });

      if ('error' in outcome && outcome.error) {
        if ('reused' in outcome && outcome.reused) {
          await audit({
            tenantId: outcome.reused.tenant_id,
            actorId: outcome.reused.user_id,
            action: 'auth.refresh_reuse_detected',
            entityType: 'session',
            entityId: outcome.reused.family_id,
            req,
          });
        }
        if (outcome.error.code !== 'refresh_race') clearRefreshCookie(res);
        throw outcome.error;
      }
      setRefreshCookie(res, outcome.pair.refresh_token);
      return outcome.setupRequired ? { ...outcome.pair, mfa_setup_required: true } : outcome.pair;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/logout',
    tags: TAGS,
    summary: 'Sign out this session',
    body: RefreshBody,
    responses: { 204: { description: 'Signed out' } },
    handler: async ({ req, res, body }) => {
      const token = readRefresh(req, body.refresh_token);
      clearRefreshCookie(res);
      if (!token) return undefined;
      const row = (
        await systemPool.query<{ user_id: string; family_id: string; tenant_id: string | null }>(
          'SELECT user_id, family_id, tenant_id FROM refresh_tokens WHERE token_hash = $1',
          [sha256(token)],
        )
      ).rows[0];
      if (!row) return undefined;
      await withTransaction(systemPool, (c) =>
        revokeSessions(c, { userId: row.user_id, familyId: row.family_id }, 'logout'),
      );
      await audit({
        tenantId: row.tenant_id,
        actorId: row.user_id,
        action: 'auth.logout',
        entityType: 'session',
        entityId: row.family_id,
        req,
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/logout-all',
    tags: TAGS,
    summary: 'Sign out every session of the current user',
    auth: true,
    middleware: [authenticate],
    responses: { 204: { description: 'All sessions signed out' } },
    handler: async ({ req, res }) => {
      const auth = requireAuth(req);
      const ids = await withTransaction(systemPool, (c) =>
        revokeSessions(c, { userId: auth.userId }, 'logout_all'),
      );
      clearRefreshCookie(res);
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'auth.logout_all',
        metadata: { sessions: ids.length },
        req,
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/auth/me',
    tags: TAGS,
    summary: 'Current user, company and permissions',
    auth: true,
    middleware: [authenticate],
    responses: { 200: { description: 'Profile', schema: MeSchema } },
    handler: async ({ req }) => {
      const auth = requireAuth(req);
      const r = (
        await systemPool.query<{
          id: string;
          email: string;
          full_name: string;
          role: Role;
          locale: string;
          phone: string | null;
          avatar_url: string | null;
          last_login_at: Date | null;
          mfa_enabled_at: Date | null;
          t_id: string | null;
          t_name: string;
          t_slug: string;
          country_code: string;
          currency: string;
          timezone: string;
          t_locale: string;
          t_status: string;
          trial_ends_at: Date | null;
        }>(
          `SELECT u.id, u.email, u.full_name, u.role, u.locale, u.phone, u.avatar_url, u.last_login_at, m.enabled_at AS mfa_enabled_at,
                  t.id AS t_id, t.name AS t_name, t.slug AS t_slug, t.country_code, t.currency, t.timezone, t.locale AS t_locale,
                  t.status AS t_status, t.trial_ends_at
           FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id LEFT JOIN user_mfa m ON m.user_id = u.id
           WHERE u.id = $1 AND u.deleted_at IS NULL`,
          [auth.userId],
        )
      ).rows[0];
      if (!r) throw notFound('User');
      const mfaEnabled = r.mfa_enabled_at !== null;
      return {
        user: {
          id: r.id,
          email: r.email,
          full_name: r.full_name,
          role: r.role,
          locale: r.locale,
          phone: r.phone,
          avatar_url: r.avatar_url,
          mfa_enabled: mfaEnabled,
          last_login_at: r.last_login_at?.toISOString() ?? null,
        },
        tenant: r.t_id
          ? {
              id: r.t_id,
              name: r.t_name,
              slug: r.t_slug,
              country_code: r.country_code.trim(),
              currency: r.currency.trim(),
              timezone: r.timezone,
              locale: r.t_locale,
              status: r.t_status,
              trial_ends_at: r.trial_ends_at?.toISOString() ?? null,
            }
          : null,
        permissions: [...ROLE_PERMISSIONS[r.role]],
        mfa_setup_required: isAdminRole(r.role) && !mfaEnabled,
      };
    },
  });

  route(v1, BASE, {
    method: 'get',
    path: '/auth/sessions',
    tags: TAGS,
    summary: 'List my active sessions (devices)',
    auth: true,
    middleware: [authenticate, requireMfaReady],
    responses: { 200: { description: 'Active sessions', schema: SessionsSchema } },
    handler: async ({ req }) => {
      const auth = requireAuth(req);
      const { rows } = await systemPool.query<{
        id: string;
        started_at: Date;
        last_refreshed_at: Date;
        user_agent: string | null;
        ip: string | null;
      }>(
        `SELECT family_id AS id, min(created_at) AS started_at, max(created_at) AS last_refreshed_at,
                (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent,
                (array_agg(host(ip) ORDER BY created_at DESC))[1] AS ip
         FROM refresh_tokens WHERE user_id = $1
         GROUP BY family_id HAVING bool_or(revoked_at IS NULL AND expires_at > now())
         ORDER BY max(created_at) DESC`,
        [auth.userId],
      );
      return {
        sessions: rows.map((s) => ({
          id: s.id,
          current: s.id === auth.sessionId,
          started_at: s.started_at.toISOString(),
          last_refreshed_at: s.last_refreshed_at.toISOString(),
          user_agent: s.user_agent,
          ip: s.ip,
        })),
      };
    },
  });

  route(v1, BASE, {
    method: 'delete',
    path: '/auth/sessions/:id',
    tags: TAGS,
    summary: 'Sign out one of my sessions',
    auth: true,
    params: z.object({ id: z.uuid() }),
    middleware: [authenticate, requireMfaReady],
    responses: { 204: { description: 'Session signed out' } },
    handler: async ({ req, params }) => {
      const auth = requireAuth(req);
      const ids = await withTransaction(systemPool, (c) =>
        revokeSessions(c, { userId: auth.userId, familyId: params.id }, 'revoked_by_user'),
      );
      if (ids.length === 0) throw notFound('Session');
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'auth.session_revoked',
        entityType: 'session',
        entityId: params.id,
        req,
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/password/forgot',
    tags: TAGS,
    summary: 'Email a password reset link',
    description:
      'Always returns 202, whether or not the email exists, so accounts cannot be discovered.',
    body: z.object({ email: Email }),
    status: 202,
    middleware: [forgotLimiter],
    responses: { 202: { description: 'Accepted', schema: z.object({ message: z.string() }) } },
    handler: async ({ req, body }) => {
      const u = (
        await systemPool.query<{
          id: string;
          tenant_id: string | null;
          full_name: string;
          locale: 'en' | 'sw';
        }>(
          `SELECT id, tenant_id, full_name, locale FROM users WHERE email = $1 AND deleted_at IS NULL AND status = 'active'`,
          [body.email],
        )
      ).rows[0];
      if (u) {
        const token = randomToken(32);
        await withTransaction(systemPool, async (c) => {
          await c.query(
            `UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
            [u.id],
          );
          await c.query(
            `INSERT INTO user_tokens (user_id, tenant_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'password_reset', $3, now() + interval '60 minutes')`,
            [u.id, u.tenant_id, sha256(token)],
          );
        });
        try {
          await sendMail({
            to: body.email,
            ...passwordResetEmail(
              u.locale,
              u.full_name,
              `${config.WEB_APP_URL}/reset-password?token=${token}`,
            ),
          });
        } catch (err) {
          logger.error({ err }, 'password reset email failed');
        }
        await audit({
          tenantId: u.tenant_id,
          actorId: u.id,
          action: 'auth.password_reset_requested',
          req,
        });
      }
      return { message: 'If that email belongs to an active account, a reset link has been sent.' };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/password/reset',
    tags: TAGS,
    summary: 'Set a new password using a reset link token',
    body: z.object({ token: z.string().min(20).max(200), password: PasswordPolicy }),
    middleware: [tokenLimiter],
    responses: { 204: { description: 'Password changed; all sessions signed out' } },
    handler: async ({ req, body }) => {
      const newHash = await hashPassword(body.password);
      const row = await withTransaction(systemPool, async (c) => {
        const r = (
          await c.query<{ id: string; user_id: string; tenant_id: string | null; status: string }>(
            `SELECT ut.id, ut.user_id, ut.tenant_id, u.status FROM user_tokens ut JOIN users u ON u.id = ut.user_id
           WHERE ut.token_hash = $1 AND ut.purpose = 'password_reset' AND ut.used_at IS NULL AND ut.expires_at > now()
             AND u.deleted_at IS NULL FOR UPDATE OF ut`,
            [sha256(body.token)],
          )
        ).rows[0];
        if (!r || r.status !== 'active')
          throw new AppError(400, 'invalid_token', 'This reset link is invalid or has expired');
        await c.query(
          `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
          [r.user_id, newHash],
        );
        await c.query('UPDATE user_tokens SET used_at = now() WHERE id = $1', [r.id]);
        await revokeSessions(c, { userId: r.user_id }, 'password_reset');
        return r;
      });
      await audit({
        tenantId: row.tenant_id,
        actorId: row.user_id,
        action: 'auth.password_reset',
        req,
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/password/change',
    tags: TAGS,
    summary: 'Change my password (signs out my other sessions)',
    auth: true,
    body: z.object({ current_password: z.string().min(1).max(256), new_password: PasswordPolicy }),
    middleware: [authenticate],
    responses: { 204: { description: 'Password changed' } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const u = (
        await systemPool.query<{ password_hash: string | null }>(
          'SELECT password_hash FROM users WHERE id = $1',
          [auth.userId],
        )
      ).rows[0];
      if (!u?.password_hash || !(await verifyPassword(u.password_hash, body.current_password))) {
        throw new AppError(400, 'wrong_password', 'Your current password is incorrect');
      }
      const newHash = await hashPassword(body.new_password);
      await withTransaction(systemPool, async (c) => {
        await c.query(
          'UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1',
          [auth.userId, newHash],
        );
        await revokeSessions(
          c,
          { userId: auth.userId, exceptFamilyId: auth.sessionId },
          'password_changed',
        );
      });
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'auth.password_changed',
        req,
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/invite/accept',
    tags: TAGS,
    summary: 'Accept an invitation and set a password',
    body: z.object({ token: z.string().min(20).max(200), password: PasswordPolicy }),
    middleware: [tokenLimiter],
    responses: { 204: { description: 'Account activated - sign in with the new password' } },
    handler: async ({ req, body }) => {
      const newHash = await hashPassword(body.password);
      const row = await withTransaction(systemPool, async (c) => {
        const r = (
          await c.query<{ id: string; user_id: string; tenant_id: string | null }>(
            `SELECT ut.id, ut.user_id, ut.tenant_id FROM user_tokens ut JOIN users u ON u.id = ut.user_id
           WHERE ut.token_hash = $1 AND ut.purpose = 'invite' AND ut.used_at IS NULL AND ut.expires_at > now()
             AND u.status = 'invited' AND u.deleted_at IS NULL FOR UPDATE OF ut`,
            [sha256(body.token)],
          )
        ).rows[0];
        if (!r)
          throw new AppError(400, 'invalid_token', 'This invitation is invalid or has expired');
        await c.query(
          `UPDATE users SET password_hash = $2, password_changed_at = now(), status = 'active', email_verified_at = now() WHERE id = $1`,
          [r.user_id, newHash],
        );
        await c.query('UPDATE user_tokens SET used_at = now() WHERE id = $1', [r.id]);
        return r;
      });
      await audit({
        tenantId: row.tenant_id,
        actorId: row.user_id,
        action: 'auth.invite_accepted',
        req,
      });
      return undefined;
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/mfa/setup',
    tags: TAGS,
    summary: 'Start 2FA setup - returns the secret and a QR code',
    auth: true,
    middleware: [authenticate],
    responses: {
      200: {
        description: 'Scan the QR code, then confirm with /auth/mfa/enable',
        schema: z.object({ secret: z.string(), otpauth_url: z.string(), qr_data_url: z.string() }),
      },
    },
    handler: async ({ req }) => {
      const auth = requireAuth(req);
      const existing = await loadMfa(auth.userId);
      if (existing?.enabled)
        throw new AppError(409, 'mfa_already_enabled', '2FA is already enabled');
      const email = (
        await systemPool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
          auth.userId,
        ])
      ).rows[0]!.email;
      const secret = generateSecret();
      await systemPool.query(
        `INSERT INTO user_mfa (user_id, tenant_id, totp_secret_enc) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc, enabled_at = NULL,
           backup_code_hashes = '{}', last_used_step = NULL`,
        [auth.userId, auth.tenantId, encrypt(secret)],
      );
      const url = otpauthUri(secret, email);
      return {
        secret,
        otpauth_url: url,
        qr_data_url: await QRCode.toDataURL(url, { margin: 1, width: 240 }),
      };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/mfa/enable',
    tags: TAGS,
    summary: 'Confirm 2FA with a code - returns backup codes and a fresh session',
    description: 'All other sessions are signed out. The backup codes are shown only once.',
    auth: true,
    body: CodeBody,
    middleware: [authenticate, mfaLimiter],
    responses: {
      200: {
        description: '2FA enabled',
        schema: TokenPairSchema.extend({ backup_codes: z.array(z.string()) }),
      },
    },
    handler: async ({ req, res, body }) => {
      const auth = requireAuth(req);
      const mfa = await loadMfa(auth.userId);
      if (!mfa?.secret) throw new AppError(400, 'mfa_not_set_up', 'Start 2FA setup first');
      if (mfa.enabled) throw new AppError(409, 'mfa_already_enabled', '2FA is already enabled');
      const step = verifyTotp(mfa.secret, body.code, null);
      if (step === null) throw invalidMfa();
      const { codes, hashes } = generateBackupCodes();
      const pair = await withTransaction(systemPool, async (c) => {
        await c.query(
          'UPDATE user_mfa SET enabled_at = now(), last_used_step = $2, backup_code_hashes = $3 WHERE user_id = $1',
          [auth.userId, step, hashes],
        );
        await revokeSessions(c, { userId: auth.userId }, 'mfa_enabled');
        return (
          await createSession(
            c,
            { id: auth.userId, tenant_id: auth.tenantId, role: auth.role },
            true,
            meta(req),
          )
        ).pair;
      });
      setRefreshCookie(res, pair.refresh_token);
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'auth.mfa_enabled',
        req,
      });
      return { ...pair, backup_codes: codes };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/mfa/backup-codes',
    tags: TAGS,
    summary: 'Replace my backup codes (old ones stop working)',
    auth: true,
    body: CodeBody,
    middleware: [authenticate, requireMfaReady, mfaLimiter],
    responses: {
      200: {
        description: 'New backup codes',
        schema: z.object({ backup_codes: z.array(z.string()) }),
      },
    },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      const mfa = await loadMfa(auth.userId);
      if (!mfa?.enabled || !mfa.secret)
        throw new AppError(400, 'mfa_not_enabled', '2FA is not enabled');
      if (!(await consumeTotp(auth.userId, mfa.secret, mfa.lastStep, body.code)))
        throw invalidMfa();
      const { codes, hashes } = generateBackupCodes();
      await systemPool.query('UPDATE user_mfa SET backup_code_hashes = $2 WHERE user_id = $1', [
        auth.userId,
        hashes,
      ]);
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'auth.backup_codes_regenerated',
        req,
      });
      return { backup_codes: codes };
    },
  });

  route(v1, BASE, {
    method: 'post',
    path: '/auth/mfa/disable',
    tags: TAGS,
    summary: 'Turn off 2FA (not allowed for admin roles)',
    auth: true,
    body: z.object({
      password: z.string().min(1).max(256),
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/),
    }),
    middleware: [authenticate, requireMfaReady, mfaLimiter],
    responses: { 204: { description: '2FA disabled; other sessions signed out' } },
    handler: async ({ req, body }) => {
      const auth = requireAuth(req);
      if (isAdminRole(auth.role))
        throw new AppError(403, 'mfa_required_for_role', '2FA is mandatory for administrators');
      const u = (
        await systemPool.query<{ password_hash: string | null }>(
          'SELECT password_hash FROM users WHERE id = $1',
          [auth.userId],
        )
      ).rows[0];
      if (!u?.password_hash || !(await verifyPassword(u.password_hash, body.password))) {
        throw new AppError(400, 'wrong_password', 'Your password is incorrect');
      }
      const mfa = await loadMfa(auth.userId);
      if (!mfa?.enabled || !mfa.secret)
        throw new AppError(400, 'mfa_not_enabled', '2FA is not enabled');
      if (!(await consumeTotp(auth.userId, mfa.secret, mfa.lastStep, body.code)))
        throw invalidMfa();
      await withTransaction(systemPool, async (c) => {
        await c.query('DELETE FROM user_mfa WHERE user_id = $1', [auth.userId]);
        await revokeSessions(
          c,
          { userId: auth.userId, exceptFamilyId: auth.sessionId },
          'mfa_disabled',
        );
      });
      await audit({
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'auth.mfa_disabled',
        req,
      });
      return undefined;
    },
  });
}
