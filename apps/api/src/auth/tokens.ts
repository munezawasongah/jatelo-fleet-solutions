import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { PoolClient } from '@jfs/db';
import { ROLES, type Role } from '@jfs/shared';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';
import { randomToken, sha256 } from './crypto.js';

const KEY = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
const ISSUER = 'jatelo-fleet';
const AUDIENCE = 'jfs-api';
export const MFA_CHALLENGE_TTL_S = 300;

export interface AccessClaims {
  userId: string;
  tenantId: string | null;
  role: Role;
  sessionId: string;
  mfaOk: boolean;
}

export async function signAccess(c: AccessClaims): Promise<string> {
  return new SignJWT({
    tid: c.tenantId,
    role: c.role,
    sid: c.sessionId,
    mfa: c.mfaOk,
    typ: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(KEY);
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, KEY, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
  if (
    payload.typ !== 'access' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.role !== 'string' ||
    !(ROLES as readonly string[]).includes(payload.role)
  ) {
    throw new Error('Invalid access token claims');
  }
  return {
    userId: payload.sub,
    tenantId: typeof payload.tid === 'string' ? payload.tid : null,
    role: payload.role as Role,
    sessionId: payload.sid,
    mfaOk: payload.mfa === true,
  };
}

export async function signMfaChallenge(userId: string): Promise<string> {
  return new SignJWT({ typ: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MFA_CHALLENGE_TTL_S}s`)
    .sign(KEY);
}

export async function verifyMfaChallenge(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, KEY, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
  if (payload.typ !== 'mfa' || typeof payload.sub !== 'string')
    throw new Error('Invalid MFA challenge');
  return payload.sub;
}

export interface SessionUser {
  id: string;
  tenant_id: string | null;
  role: Role;
}
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_expires_at: string;
}

/** Inserts a refresh token (hash only) and signs an access token. familyId = session id. */
export async function createSession(
  db: PoolClient,
  user: SessionUser,
  mfaOk: boolean,
  meta: { ip?: string; userAgent?: string },
  familyId: string = randomUUID(),
): Promise<{ pair: TokenPair; tokenId: string }> {
  const refresh = `jfsr_${randomToken(48)}`;
  const expires = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, tenant_id, family_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      user.id,
      user.tenant_id,
      familyId,
      sha256(refresh),
      meta.userAgent?.slice(0, 300) ?? null,
      meta.ip ?? null,
      expires,
    ],
  );
  const access = await signAccess({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    sessionId: familyId,
    mfaOk,
  });
  return {
    tokenId: rows[0]!.id,
    pair: {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
      refresh_expires_at: expires.toISOString(),
    },
  };
}

const revokedKey = (sid: string): string => `sess:revoked:${sid}`;

export async function markSessionsRevoked(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const multi = redis.multi();
  for (const sid of sessionIds)
    multi.set(revokedKey(sid), '1', 'EX', config.ACCESS_TOKEN_TTL_SECONDS + 60);
  await multi.exec();
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  return (await redis.exists(revokedKey(sessionId))) === 1;
}

/** Revokes active refresh tokens (whole sessions) for a user and blocks their access tokens immediately. */
export async function revokeSessions(
  db: PoolClient,
  opts: { userId: string; familyId?: string; exceptFamilyId?: string },
  reason: string,
): Promise<string[]> {
  const { rows } = await db.query<{ family_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL
       AND ($3::uuid IS NULL OR family_id = $3::uuid)
       AND ($4::uuid IS NULL OR family_id <> $4::uuid)
     RETURNING family_id`,
    [opts.userId, reason, opts.familyId ?? null, opts.exceptFamilyId ?? null],
  );
  const ids = [...new Set(rows.map((r) => r.family_id))];
  await markSessionsRevoked(ids);
  return ids;
}
