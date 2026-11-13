# Jatelo Fleet Solutions

Multi-tenant fleet management SaaS for Kenya, Tanzania, Uganda and Rwanda — a product of **Jatelo Technologies**.

Live GPS tracking from Teltonika, Concox/GT06 and Queclink trackers (or the driver's phone), trip and stop detection, driver
behaviour scoring, geofences and alerts (SMS, email, push, webhooks), dispatch with route optimisation and proof of delivery,
preventive maintenance, fuel control with sensor-based drain detection, analytics and scheduled reports, per-vehicle billing
with M-Pesa, and a super-admin console — in English and Kiswahili.

## What's in the repository

| Path | What it is |
| --- | --- |
| `apps/api` | REST API (Express 5, OpenAPI at `/api/docs`) + Socket.IO realtime |
| `apps/ingest` | GPS gateway: Teltonika Codec 8/8E/12 (TCP 5027), GT06/Concox (TCP 5023), Queclink ASCII (TCP 5004), phone HTTP (5080) |
| `apps/worker` | Telemetry pipeline (trips, stops, odometer, fuel, geofences, job progress), alert engine, notifications, scheduled jobs (rollups, reminders, reports, billing, device commands) |
| `apps/web` | Manager / admin PWA (React + Vite + Leaflet), installable, works on phones |
| `apps/driver` | Android driver app (Expo / React Native) — standalone npm project |
| `packages/db` | Migrations (PostgreSQL 16 + PostGIS, Row-Level Security), seed, billing logic |
| `packages/protocols` | Tracker protocol decoders/encoders (with tests) |
| `packages/reports` | Report builder + PDF/Excel/CSV renderers, invoice PDF |
| `packages/shared` | Roles and permissions |
| `tools/simulator` | Multi-protocol tracker simulator for demos and load tests |
| `infra` | Local Docker services, production compose + Caddy, Railway service configs |
| `docs` | Architecture, deployment, device set-up, driver app |

## Quick start (local)

Requirements: Node 22+, pnpm (via `corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env              # works as-is for local development
pnpm infra:up                     # Postgres/PostGIS, Redis, S3-compatible storage
pnpm db:migrate                   # schema + login roles
pnpm db:seed                      # demo companies, vehicles, drivers, trackers, rules
pnpm build

# in separate terminals
node --env-file=.env apps/api/dist/server.js         # http://localhost:4000  (docs: /api/docs)
node --env-file=.env apps/ingest/dist/main.js        # tracker ports 5027/5023/5004, phones 5080
node --env-file=.env apps/worker/dist/main.js
pnpm --filter @jfs/web dev                            # http://localhost:5173

# make the fleet move (live), or generate 48 h of history first
cd tools/simulator && node --env-file=../../.env dist/index.js --tenant all
node --env-file=../../.env dist/index.js --tenant all --backfill 48 --duration 1
```

### Demo logins (password `Demo@Fleet2026`)

| Company | Users |
| --- | --- |
| Lakeside Logistics (Kisumu, KE) | `admin@`, `fleet@`, `dispatch@`, `workshop@`, `accounts@lakeside-logistics.test`; drivers `otieno@`, `achieng@`, `kamau@` |
| Bahari Cargo (Dar es Salaam, TZ) | `admin@`, `fleet@`, `dispatch@`, `workshop@`, `accounts@bahari-cargo.test`; drivers `juma@`, `neema@`, `baraka@` |

Company administrators and the super admin must set up two-step verification (TOTP) at first sign-in. The super admin is
created from `SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD`.

## Roles

`super_admin` (Jatelo) · `company_admin` · `fleet_manager` · `dispatcher` · `mechanic` · `accountant` · `driver`.
Users can be limited to vehicle groups (depots/branches); every list, map, report and realtime feed respects that scope.

## Key features by area

- **Tracking** — live map with state colours and heading, follow mode, history playback with speed-coloured tracks and events,
  share-a-link live location (vehicle or job) for customers, remote immobilise/restore and device commands.
- **Trips & behaviour** — automatic trips/stops, idling, overspeed (vehicle, zone and road limits), harsh brake/accel/corner,
  night driving, crash/tamper; daily 0–100 driver scores with coaching workflow.
- **Geofences** — circles, polygons and corridors drawn on the map; entry/exit/dwell alerts; zone speed limits; named places.
- **Alerts** — 28 rule types with conditions, schedules, vehicle/group/geofence targeting and per-rule recipients; delivery by
  in-app, push, SMS (Africa's Talking), email and signed webhooks with retries.
- **Dispatch** — jobs with multi-stop routes, optimisation (VROOM/OSRM or built-in), ETAs, time windows, live deviation and
  lateness detection, auto-arrival, POD photos + signature, customer tracking links, driver messaging.
- **Maintenance** — schedules by km/engine hours/days, reminders, work orders with labour/parts, parts stock ledger,
  inspections and defects from the driver app, engine fault codes from CAN trackers.
- **Fuel** — fill-ups (manual, driver app, card statement import), consumption vs expected, sensor refuel/drain detection, cards.
- **Reports** — trips, stops, mileage, fuel, speeding, geofence, maintenance, driver scorecard, utilisation, idling, alerts and an
  executive summary; on screen, PDF, Excel, CSV; scheduled email delivery in English or Kiswahili.
- **Billing** — per-vehicle monthly plans, VAT by country, invoices with PDF, M-Pesa STK push and Paybill (C2B), suspension
  for long arrears with pay-to-reactivate, manual payment recording for bank/Airtel/MTN.
- **Super admin** — company onboarding with trial, plans and prices per currency, invoices, tracker stock provisioning and
  transfers, platform audit trail.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — services, data flow, multi-tenancy and security
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Railway or a single VPS, domains, secrets, M-Pesa, SMS, push, routing
- [docs/DEVICES.md](docs/DEVICES.md) — configuring Teltonika, Concox and Queclink trackers; SIM/APN settings
- [docs/DRIVER_APP.md](docs/DRIVER_APP.md) — building and distributing the Android app

## Scripts

```bash
pnpm build | pnpm typecheck                 # all workspaces (Turborepo)
pnpm --filter @jfs/protocols test           # decoder tests
pnpm db:migrate | db:status | db:new <name> # migrations
pnpm db:seed | db:seed:base                 # demo data | plans + super admin only
```

© Jatelo Technologies. All rights reserved.
