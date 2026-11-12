import type { PoolClient } from '@jfs/db';
import type { Role } from '@jfs/shared';
import { config } from '../config.js';
import { inviteEmail } from '../infra/email-templates.js';
import { sendMail } from '../infra/mailer.js';
import { logger } from '../logger.js';
import { randomToken, sha256 } from './crypto.js';

export const INVITE_TTL_DAYS = 7;

/** Creates a fresh 7-day invite token for an invited user (previous unused invites are burned). Returns the raw token. */
export async function issueInvite(c: PoolClient, userId: string, tenantId: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  await c.query(`UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'invite' AND used_at IS NULL`, [userId]);
  const r = await c.query<{ expires_at: Date }>(
    `INSERT INTO user_tokens (user_id, tenant_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'invite', $3, now() + make_interval(days => $4)) RETURNING expires_at`,
    [userId, tenantId, sha256(token), INVITE_TTL_DAYS],
  );
  return { token, expiresAt: r.rows[0]!.expires_at };
}

/** Emails the invitation (never throws; failures are logged so the API call still succeeds). */
export async function sendInvite(opts: { email: string; name: string; company: string; locale: 'en' | 'sw'; token: string }): Promise<void> {
  try {
    await sendMail({ to: opts.email, ...inviteEmail(opts.locale, opts.name, opts.company, `${config.WEB_APP_URL}/accept-invite?token=${opts.token}`) });
  } catch (err) {
    logger.error({ err, email: opts.email }, 'invite email failed');
  }
}

export const INVITABLE_ROLES: Role[] = ['company_admin', 'fleet_manager', 'dispatcher', 'mechanic', 'accountant'];
