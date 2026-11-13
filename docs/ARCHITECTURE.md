# Architecture

```
 Trackers (TCP)          Phones (HTTPS)                 Managers (PWA)          Drivers (Android)
 Teltonika/GT06/Queclink      │                              │                        │
        │                     │                              ▼                        ▼
        ▼                     ▼                     ┌──────────────────┐   REST + Socket.IO
 ┌──────────────────────────────────┐   commands    │   apps/api        │◄───────────────────┘
 │ apps/ingest  (one or more)        │◄──────────────│ REST, OpenAPI,    │
 │ decode → normalise → XADD         │  ingest:cmd:* │ Socket.IO, M-Pesa │
 └──────────────┬───────────────────┘               └───▲────────┬──────┘
                │ Redis stream `telemetry`               │        │ rt:user / rt:tenant (pub/sub)
                ▼                                         │        ▼
 ┌──────────────────────────────────────────────────────┴───────────────┐
 │ apps/worker                                                          │
 │  telemetry consumer: dedupe/order, gps_points (daily partitions),    │
 │  device_status, trips & stops, odometer/engine hours, fuel level      │
 │  smoothing + refuel/drain, geofences, overspeed/harsh/idle, job       │
 │  arrival/deviation/ETA → `vehicle_events` stream + live:tenant:*      │
 │  alert engine: rules → alerts → notify queue (SMS/email/push/webhook) │
 │  scheduler (BullMQ): rollups, reminders, reports, billing, commands   │
 └──────────────────────────────────┬───────────────────────────────────┘
                                    ▼
                    PostgreSQL 16 + PostGIS  ·  Redis 7  ·  S3 (Cloudflare R2)
```

## Multi-tenancy and security

- Every tenant table carries `tenant_id` and has **Row-Level Security**. The API connects as a login role in `jfs_app`
  (RLS enforced) and sets `app.tenant_id` / `app.user_id` per transaction (`withTenant`). Cross-tenant references are blocked
  by triggers. The worker, ingest and super-admin routes use a `jfs_system` login (BYPASSRLS) and always filter explicitly.
- Users limited to vehicle groups see only those vehicles in lists, maps, reports and realtime events.
- Auth: short-lived JWT access tokens (15 min) + rotating refresh tokens (httpOnly cookie on web, secure storage on
  Android) with reuse detection; TOTP 2FA mandatory for administrators; per-session revocation; rate limiting; audit log.
- Webhooks are signed (HMAC-SHA256); M-Pesa callbacks are authenticated by an unguessable path secret and are idempotent.
- Files go straight to object storage via presigned URLs, checked by purpose (type and size) and tenant.

## Data flow details

- **Ingest** keeps the TCP session per device, ACKs per protocol, and pushes normalised records (`TelemetryRecord`) to the
  `telemetry` stream. The device's live connection is registered as `conn:<deviceId>` so commands reach the right instance.
- **Worker** consumes in a consumer group (horizontal scaling by adding replicas), keeps per-device state in Redis, writes
  positions in batches, and publishes `position` events for the live map.
- **Realtime**: the API subscribes to `live:tenant:*`, `rt:tenant:*`, `rt:user:*` and forwards to Socket.IO rooms
  (tenant, user, share link), filtering by each user's vehicle-group scope.
- **Jobs**: plans come from VROOM/OSRM when configured; otherwise a nearest-neighbour + 2-opt optimiser with a 1.3 road
  factor. The worker auto-detects arrival/departure, off-route (60 s beyond the threshold) and ETA breaches.
- **Billing**: hourly cycle rolls subscription periods, issues invoices (`max(plan minimum, active vehicles) × price + VAT`),
  marks overdue, suspends after 30 days overdue. Payments (STK, C2B, manual) settle invoices and reactivate the tenant.

## Retention

Per-tenant settings control GPS history (default 180 days, daily partitions dropped by the worker), raw packets (7 days) and
audit logs (365 days).
