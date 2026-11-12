import type { Server as HttpServer } from 'node:http';
import { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { withTenant } from '@jfs/db';
import { ROLE_PERMISSIONS } from '@jfs/shared';
import { groupScope } from './auth/scope.js';
import { isSessionRevoked, verifyAccess, type AccessClaims } from './auth/tokens.js';
import { config } from './config.js';
import { appPool } from './infra/db.js';
import { logger } from './logger.js';
import { resolveShare } from './routes/tracking.js';

/**
 * Real-time channel for the dashboard, driver app and customer share links.
 *
 * Connect with `io(API_URL, { auth: { token: <access JWT> } })` or `{ auth: { share: <share token> } }`.
 * Server events: "position", "status", "alert", "notification", "message", "job".
 */
interface SocketData {
  claims?: AccessClaims;
  vehicles?: Set<string> | null; // null = all vehicles in the tenant
  shareVehicle?: string;
}

const tenantRoom = (t: string): string => `tenant:${t}`;
const userRoom = (u: string): string => `user:${u}`;
const shareRoom = (v: string): string => `share:${v}`;

export function attachRealtime(server: HttpServer): { close(): Promise<void> } {
  const io = new Server<
    Record<string, never>,
    Record<string, (...a: unknown[]) => void>,
    Record<string, never>,
    SocketData
  >(server, {
    path: '/socket.io',
    cors: { origin: config.CORS_ORIGINS, credentials: true },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as { token?: string; share?: string };
      if (auth.share) {
        const s = await resolveShare(auth.share, false);
        if (!s.vehicle_id) return next(new Error('link_has_no_vehicle'));
        socket.data.shareVehicle = s.vehicle_id;
        return next();
      }
      if (!auth.token) return next(new Error('unauthorized'));
      const claims = await verifyAccess(auth.token);
      if (await isSessionRevoked(claims.sessionId)) return next(new Error('session_revoked'));
      if (!claims.tenantId) return next(new Error('tenant_required'));
      socket.data.claims = claims;
      const scope = await withTenant(
        appPool,
        claims.tenantId,
        (c) => groupScope(c, claims.userId),
        { userId: claims.userId },
      );
      if (scope) {
        const v = await withTenant(appPool, claims.tenantId, (c) =>
          c.query<{ id: string }>(
            'SELECT id FROM vehicles WHERE group_id = ANY($1::uuid[]) AND deleted_at IS NULL',
            [scope],
          ),
        );
        socket.data.vehicles = new Set(v.rows.map((r) => r.id));
      } else socket.data.vehicles = null;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const d = socket.data as SocketData;
    if (d.shareVehicle) {
      void socket.join(shareRoom(d.shareVehicle));
      return;
    }
    const c = d.claims!;
    void socket.join(userRoom(c.userId));
    const perms = ROLE_PERMISSIONS[c.role];
    if (perms.includes('tracking:read') || perms.includes('alerts:read'))
      void socket.join(tenantRoom(c.tenantId!));
  });

  // Redis fan-in: worker publishes live:tenant:<id>; API publishes rt:user:<id> for per-user messages.
  const sub = new Redis(config.REDIS_URL, { connectionName: 'jfs-api-realtime' });
  sub.on('error', (err) => logger.error({ err }, 'realtime redis error'));
  void sub.psubscribe('live:tenant:*', 'rt:user:*', 'rt:tenant:*');
  sub.on('pmessage', (_pattern, channel, message) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(payload.type ?? 'position');
    if (channel.startsWith('rt:user:')) {
      io.to(userRoom(channel.slice(8))).emit(type, payload);
      return;
    }
    const tenantId = channel.startsWith('live:tenant:') ? channel.slice(12) : channel.slice(10);
    const vehicleId = typeof payload.vehicle_id === 'string' ? payload.vehicle_id : null;
    // tenant-wide sockets, filtered per user group scope
    for (const s of io.sockets.adapter.rooms.get(tenantRoom(tenantId)) ?? []) {
      const sock = io.sockets.sockets.get(s);
      const allowed = (sock?.data as SocketData | undefined)?.vehicles;
      if (!sock || (allowed && vehicleId && !allowed.has(vehicleId))) continue;
      sock.emit(type, payload);
    }
    if (vehicleId && (type === 'position' || type === 'status')) {
      const { lat, lng, speed_kph, heading, state, recorded_at } = payload;
      io.to(shareRoom(vehicleId)).emit(type, { lat, lng, speed_kph, heading, state, recorded_at });
    }
  });

  return {
    async close() {
      io.disconnectSockets(true);
      sub.disconnect();
    },
  };
}
