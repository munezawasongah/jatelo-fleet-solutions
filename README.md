# Jatelo Fleet Solutions

Multi-tenant fleet management SaaS for Kenya, Tanzania, Uganda and Rwanda.
A product of Jatelo Technologies.

## Structure
- apps/api       REST API + Socket.IO
- apps/ingest    GPS tracker TCP gateway (Teltonika, GT06, Queclink)
- apps/worker    Background jobs (trips, alerts, fuel, reports, billing)
- apps/web       Manager/admin PWA
- apps/driver    Driver mobile app
- packages/*     Shared code (db, shared, protocols, i18n)
- tools/simulator  GPS device simulator
- infra          Local Docker services and deployment config
- docs           API and device documentation