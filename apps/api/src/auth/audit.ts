import type { Request } from 'express';
import { systemPool } from '../infra/db.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  tenantId: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'device';
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  req?: Request;
}

/** Writes an audit record. Never throws: auditing must not break the request. */
export async function audit(e: AuditEntry): Promise<void> {
  try {
    await systemPool.query(
      `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, metadata, ip, user_agent, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        e.tenantId,
        e.actorType ?? 'user',
        e.actorId ?? null,
        e.action,
        e.entityType ?? null,
        e.entityId ?? null,
        e.changes ? JSON.stringify(e.changes) : null,
        JSON.stringify(e.metadata ?? {}),
        e.req?.ip ?? null,
        e.req?.get('user-agent')?.slice(0, 300) ?? null,
        e.req ? String(e.req.id) : null,
      ],
    );
  } catch (err) {
    logger.error({ err, action: e.action }, 'audit write failed');
  }
}
