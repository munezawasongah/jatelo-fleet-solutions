# Deployment

Two supported layouts: **Railway** (managed) or **one VPS** with Docker Compose. Both use the Dockerfiles in `apps/*`.

## Option A — Railway

Create one project with these services (all from this GitHub repo; set *Config file path* per service):

| Service | Config file | Public networking |
| --- | --- | --- |
| Postgres | Railway PostgreSQL plugin, then run `CREATE EXTENSION postgis, pgcrypto, citext, pg_trgm, btree_gist;` (use the PostGIS template if offered) | private |
| Redis | Railway Redis plugin | private |
| api | `infra/railway/api.json` (runs migrations before each deploy) | HTTP domain `api.<domain>` |
| worker | `infra/railway/worker.json` | none |
| ingest-teltonika | `infra/railway/ingest-teltonika.json` — env `TELTONIKA_PORT=5027 GT06_PORT=0 QUECLINK_PORT=0` | **TCP proxy** → 5027 |
| ingest-gt06 | `infra/railway/ingest-gt06.json` — env `GT06_PORT=5023 TELTONIKA_PORT=0 QUECLINK_PORT=0` | TCP proxy → 5023 |
| ingest-queclink | `infra/railway/ingest-queclink.json` — env `QUECLINK_PORT=5004 TELTONIKA_PORT=0 GT06_PORT=0` | TCP proxy → 5004 |
| web | `infra/railway/web.json` — env `API_UPSTREAM=http://api.railway.internal:4000` | HTTP domain `app.<domain>` |

Railway gives each TCP proxy its own host and port (e.g. `roundhouse.proxy.rlwy.net:41234`); configure trackers with those.
One ingest service can also expose the phone endpoint: give **ingest-teltonika** an HTTP domain `gps.<domain>` (port 5080)
and set `INGEST_PUBLIC_URL=https://gps.<domain>` on the api.

### Shared variables (Railway → Project → Shared variables)

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}                       # owner, migrations only (api pre-deploy)
APP_DATABASE_URL=postgres://jfs_api:<strong>@<pg-host>:<port>/<db>        # created by migrate
SYSTEM_DATABASE_URL=postgres://jfs_worker:<strong>@<pg-host>:<port>/<db>  # created by migrate
REDIS_URL=${{Redis.REDIS_URL}}
JWT_ACCESS_SECRET=<48 random bytes, base64>      # openssl rand -base64 48
MFA_ENCRYPTION_KEY=<32 random bytes, base64>     # openssl rand -base64 32
PUBLIC_API_URL=https://api.<domain>
WEB_APP_URL=https://app.<domain>
CORS_ORIGINS=https://app.<domain>
SMTP_URL=smtps://user:pass@smtp.provider:465
MAIL_FROM=Jatelo Fleet Solutions <no-reply@<domain>>
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_PUBLIC_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=jfs-files
S3_ACCESS_KEY_ID=...  S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
TRUST_PROXY=1
```

The web service proxies `/api` and `/socket.io` to the API, so the browser stays on one origin (refresh cookie works with
`SameSite=Strict`). If you serve the web app from a different site, set `VITE_API_URL` at build time and add the origin to
`CORS_ORIGINS`.

### First deploy

1. Deploy `api` once — the pre-deploy step applies migrations and creates the `jfs_api` / `jfs_worker` login roles from the
   two URLs above (the owner role must be allowed to create roles; on Railway it is).
2. Seed plans and the super admin: Railway shell on `api` →
   `SEED_SUPERADMIN_EMAIL=evans.onyango@jatelo-techs.com SEED_SUPERADMIN_PASSWORD='<strong>' node /repo/packages/db/dist/cli/seed.js base`
3. Sign in at `https://app.<domain>`, set up 2FA, then **Plans** (check prices) → **Companies → Onboard company** →
   **Tracker stock → Provision trackers**.

## Option B — one VPS (Ubuntu 22.04+, 4 vCPU / 8 GB handles ~2,000 trackers)

```bash
git clone https://github.com/munezawasongah/jatelo-fleet-solutions.git && cd jatelo-fleet-solutions
cp .env.example .env.production     # edit: production URLs, secrets, POSTGRES_PASSWORD, DOMAIN
#   DATABASE_URL=postgres://jfs:<POSTGRES_PASSWORD>@postgres:5432/jatelo_fleet
#   APP_DATABASE_URL=postgres://jfs_api:<pw>@postgres:5432/jatelo_fleet
#   SYSTEM_DATABASE_URL=postgres://jfs_worker:<pw>@postgres:5432/jatelo_fleet
#   REDIS_URL=redis://redis:6379
docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f infra/docker-compose.prod.yml exec api node /repo/packages/db/dist/cli/seed.js base
```

DNS: `app.`, `api.` and `gps.<domain>` → the server (Caddy issues certificates). Open TCP 5027, 5023, 5004 for trackers.
Back up the `pgdata` volume daily (`pg_dump -Fc`), keep at least 14 days off-site.

## Integrations

### M-Pesa (Daraja)
1. Create an app on developer.safaricom.co.ke; for production, go live with your Paybill/Till.
2. Set `MPESA_ENV=production`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`,
   `MPESA_TRANSACTION_TYPE` (`CustomerPayBillOnline` for Paybill, `CustomerBuyGoodsOnline` for Till) and a long random
   `MPESA_CALLBACK_SECRET`.
3. STK callbacks go to `{PUBLIC_API_URL}/api/v1/public/mpesa/callback/{MPESA_CALLBACK_SECRET}` automatically.
4. For Paybill payments made outside the app, register the C2B confirmation URL
   `{PUBLIC_API_URL}/api/v1/public/mpesa/c2b/{MPESA_CALLBACK_SECRET}/confirmation`; customers use the invoice number as the
   account number.

Without credentials (non-production) payments are simulated end-to-end for demos.

### SMS — Africa's Talking
`AT_USERNAME`, `AT_API_KEY`, optional `AT_SENDER_ID` (worker). Works for KE, TZ, UG and RW numbers.

### Push — Firebase Cloud Messaging
Create a Firebase project, add the Android app `com.jatelotech.fleetdriver`, download `google-services.json` into
`apps/driver/` before building, and give the worker a service account: `FCM_SERVICE_ACCOUNT_JSON` (whole JSON, one line).

### Routing — OSRM / VROOM (optional)
```bash
mkdir -p infra/osrm/data && cd infra/osrm/data
wget https://download.geofabrik.de/africa/kenya-latest.osm.pbf -O region.osm.pbf
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend:v5.27.1 osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend:v5.27.1 osrm-partition /data/region.osrm
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend:v5.27.1 osrm-customize /data/region.osrm
```
Start with `--profile routing` and set `OSRM_URL=http://osrm:5000` on api and worker. VROOM (`VROOM_URL`) is optional.

## Operations

- Health: api `/health` and `/health/ready`, ingest `/health` (includes connection and decode counters).
- Scale: add worker replicas (consumer groups), ingest replicas behind TCP load balancing, api replicas (Socket.IO uses
  Redis pub/sub fan-in so any replica can serve any client).
- Logs are JSON (pino); set `LOG_LEVEL=debug` temporarily for troubleshooting.
