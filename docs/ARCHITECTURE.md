# SMtrack v2 Backend — Tech Stack & System Architecture

> This document summarizes the **actual current state of the code** (based on `package.json`, `prisma/schema.prisma` + migrations, `src/app.module.ts`, `src/main.ts`, `docker-compose.yml`) rather than paraphrasing `CLAUDE.md`. Where the real code diverges from the original `CLAUDE.md` description, it is called out explicitly in each section.

## 1. System Overview

A backend for ingesting, processing, and storing IoT telemetry/log data (medical refrigerators/freezers with temperature/humidity/door probes) and raising alerts when readings go out of range. MQTT is the primary ingestion channel; a REST API + SSE stream serve the dashboard, and FCM delivers push notifications to mobile.

## 2. Tech Stack

| Category | Actual technology in use |
|---|---|
| Framework | NestJS **v11** (`@nestjs/core`, `common`, `platform-express`, `microservices`, `config`, `event-emitter`, `schedule`, `swagger`, `terminus`, `passport`) — hybrid app: HTTP + MQTT microservice + RabbitMQ microservice ×2 |
| ORM / DB | Prisma **v7.8** (new `prisma-client` generator, output to `src/generated/prisma`) + `@prisma/adapter-pg` (driver adapter) + raw `pg` v8 for specific tasks (e.g. `pg-copy-streams` for bulk export) on PostgreSQL + **TimescaleDB extension** |
| MQTT | `mqtt` v5.10 |
| Message queue | RabbitMQ via `amqplib` + `amqp-connection-manager` (used through `@nestjs/microservices` RMQ transport) — split into **2 microservices on separate queues** (general events vs. high-volume log/telemetry) |
| Cache | Redis via `ioredis` |
| Push notification | `firebase-admin` v13 (FCM) |
| Auth | `passport` + `passport-jwt` — **two separate schemes**: `jwt` (user login) and `device` (device token) |
| Object storage | `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` — S3-compatible (MinIO in local dev), 3 independent configs (archive, device image, firmware) |
| Observability | Full OpenTelemetry SDK (`sdk-node`, auto-instrumentations, OTLP HTTP exporter for both trace and metrics) + `nestjs-pino`/`pino`/`pino-http` for structured logging |
| Validation | `class-validator` + `class-transformer` |
| Testing | Jest v29 + `ts-jest` + `supertest` + `@nestjs/testing` |
| Other | `mongodb` v7.5 present in devDependencies (no actual usage found elsewhere in the code) |

> **Diverges from `CLAUDE.md`:** Prisma is now on v7 (generator provider changed to `prisma-client`, not the original `prisma-client-js`); object storage (S3/MinIO) and a full OpenTelemetry observability stack exist and are not mentioned in `CLAUDE.md` at all.

## 3. Module Structure (`src/`)

From `app.module.ts`, grouped into 3 categories:

**Infrastructure**
`Prisma`, `Redis`, `Rabbitmq`, `Auth`, `Cache` (common), `Observability`

**Core vertical slice**
`Sse`, `Telemetry`, `Mqtt`, `Fcm`, `Notification`, `Device`, `Audit`, `Probe`, `DeviceConfig`, `DeviceRepair`, `Warranties`, `Firmware`, `UserAudit`

**Supporting**
`Logday`, `Graph`, `Backup`, `Health`, `Consumer` (event consumer), `LogConsumer` (log/telemetry consumer on a separate queue), `Mobile`

> **Diverges from `CLAUDE.md`:** modules not mentioned in `CLAUDE.md` but present in the code — `audit`, `device-config`, `device-repair`, `warranties`, `firmware`, `user-audit`, `observability` — plus `consumer`/`log-consumer` being two separate modules (not a single combined `consumer/` as originally described). The `mobile` module exists as originally described.

## 4. Data Model (Prisma schema)

The most significant design divergence from `CLAUDE.md`: the real schema splits **`Devices`** (a logical install point, e.g. "ICU bed 3 refrigerator") from **`Hardware`** (the physical box, keyed by `serial`) instead of combining them into one model, and there is **no `Users`/hospital table** — every actor is derived purely from the JWT payload.

- **`Devices`** — install point; `staticName` is the permanent identity, `serial` is just a pointer to whichever box is currently installed (denormalized from the active assignment). Must never be written directly — only through `DeviceSwapService`.
- **`Hardware`** — the physical box, keyed by `serial`; carries firmware/token/repair history/warranty, which always follow the box.
- **`DeviceAssignments`** — history of which box was installed at which install point during which time range (source of truth for hardware swaps; overlapping ranges prevented via a partial unique index in the migration).
- **`Probes`**, **`Configs`** — tied to `Devices.id` (site-specific settings; swapping in a new box at the same install point restores these immediately).
- **`Repairs`**, **`Warranties`** — tied to `Hardware.serial` (follow the box, not the install point).
- **`LogDays`** — telemetry, **TimescaleDB hypertable on `sendTime`**, with nullable `deviceId`/`probeId` (fallback for a box not yet installed anywhere).
- **`Notifications`** — **TimescaleDB hypertable on `createAt`**, with `deliveredSse`/`deliveredFcm` as described in `CLAUDE.md`, **plus** `isRead`/`readAt` (user-side read state, distinct from delivery status) and `category`/`severity` (computed at creation by a classifier: `TEMP|DOOR|INTERNET|PLUG|SDCARD|REPORT|OTHER`, `critical|warning|info`).
- **`LogDayArchive`** + **`ArchiveExport`**/**`ArchiveRestore`**/**`RestoredWindow`**/**`ArchiveJobRun`** — rows older than the hot window are exported to S3/MinIO (4 tables, keyed `source_table + month` in `ArchiveExport`) and then removed; `RestoredWindow` tracks per-install-point on-demand restores (lock + 24h sliding TTL); `ArchiveJobRun` records every CronJob step.
- **`DeviceAudit`**/**`UserAudit`** — audit trail, also hypertables, with no FK to any entity (so audit rows survive even if the entity is deleted).
- **`Firmwares`** — OTA file metadata; actual files live in a dedicated S3 bucket.

**Actual TimescaleDB hypertables/retention** (from `prisma/migrations/*/migration.sql` — the *current* state is mid-migration, see below):

| Table | Hypertable on | Hot-window removal today | Target (ADR-0005) |
|---|---|---|---|
| `log_days` | `send_time`, 1-month chunks | `add_retention_policy` 6 months | archive CronJob drops chunks only after a verified export |
| `notifications` | `create_at` | none (grows unbounded) | same as `log_days` |
| `device_audit` | `create_at` | `add_retention_policy` 6 months (**no archive copy**) | same as `log_days` |
| `user_audit` | `create_at` | `add_retention_policy` 6 months (**no archive copy**) | same as `log_days` |
| `log_day_archive` | `send_time`, 1-month chunks | none — holds only on-demand restored rows, cleaned after 24h unread | unchanged |

The time-based `add_retention_policy` calls are removed **last**, by the cut-over migration, after every month older than the hot window has a verified archive — see `docs/archive-operations.md`. Until then the old policies and the new job coexist; the job never deletes anything the old policy would not.

**Archive** (CONTEXT.md: *Hot window*, *Archive*, *On-demand restore*, *Restored window*): the hot window is the previous + current calendar month (`hotWindowStart()` also guarantees the last 30 days, so `range=30d` never needs a restore). Older rows live as monthly `.csv.gz` per table on S3/MinIO for 5 years (bucket lifecycle, infra-owned). Export/drop and restored-window cleanup run as Kubernetes CronJobs executing `node dist/cli/archive-job` ([ADR-0006](adr/0006-archive-jobs-run-as-k8s-cronjobs.md)); requests for `log_days` beyond the hot window (`/graph` custom range, `/telemetry` with `deviceId` + `from`/`to`) trigger an on-demand restore of that install point's rows (HTTP 202 + `Retry-After` if not finished within 10 s).

No continuous aggregates exist in the current system (no TimescaleDB continuous-aggregate rollups have been set up yet).

## 5. Bootstrap / Runtime Architecture

From `src/main.ts` — hybrid application:

1. `NestFactory.create(AppModule, { bufferLogs: true })` (guarded by a 30-second timeout to prevent hanging if DB/MQTT connection fails without rejecting).
2. Global setup: `ValidationPipe` (`transform`, `whitelist`), `HttpExceptionFilter`, `ResponseInterceptor` (wraps every response as `{ success, message, data, timestamp, statusCode }`), global prefix `log`, permissive CORS (`origin: '*'`, no cookies — clients send fetch/EventSource with an Authorization header).
3. Swagger is enabled only outside production, mounted at `/docs`, with 2 bearer schemes (`jwt`, `device`).
4. `connectMicroservice` attaches MQTT, RabbitMQ (general events), RabbitMQ (log/telemetry on a separate queue so high volume doesn't block the other queue), gRPC (partner API), and — only when `LEGACY_SYNC_ENABLED=true` — RabbitMQ `legacy_sync_queue`.
5. `startAllMicroservices()` (same timeout guard), then `listen()`.

## 6. Ingestion Paths

Log/telemetry data can enter through 3 paths, as described in `CLAUDE.md` and confirmed in `src/consumer/` (which has a `log-consumer` separate from `notification-consumer`):

- **MQTT** (primary) — subscribes to device topics.
- **HTTP** — `POST /logday` as a fallback.
- **RabbitMQ consume** — a separate queue for other upstream gateways/services.

All 3 paths funnel into a single entry point (`TelemetryService.ingest()`) — no duplicated insert logic.

`ingest()` is idempotent on `(serial, probe, sendTime)`: a duplicate (MQTT QoS 1 redelivery, legacy sync overlapping backfill) returns the existing row without a second `telemetry.created` event. The MQTT log subscription is a shared subscription (`$share/<MQTT_SHARED_GROUP>/devices/+/log`) and each replica gets a unique client ID, so several replicas split the load instead of each storing every message.

> **Running more than one replica:** SSE fan-out is still in-process (`EventEmitter2` → `SseService`). With a shared subscription only the replica that received a log emits it, so SSE clients connected to another replica miss it. Before scaling beyond one replica, move SSE fan-out onto Redis pub/sub (or similar).

### Legacy sync (temporary, until cutover)

While the legacy system still runs, it publishes everything to the topic exchange `legacy.sync`; v2 consumes it from `legacy_sync_queue` (single active consumer, prefetch 1, dead-letter `legacy_sync_dlq`) when `LEGACY_SYNC_ENABLED=true`. Runtime events reuse the consumers above; metadata snapshots go to `src/legacy-sync/`. See [ADR-0007](./adr/0007-legacy-sync-one-way-via-rabbitmq-snapshots.md) and [`legacy-sync-contract.md`](./legacy-sync-contract.md).

## 6a. Why this is not split into microservices (yet)

Reviewed 2026-11: about 1,000 boxes reporting every 5 minutes is about 3.3 messages/s, well under 1% of what one process and TimescaleDB can take. The real coupling is the shared database (`log_days`, `probes` and `devices` are used by 5–7 modules each, and every tenant filter joins `devices`), so splitting now would produce a distributed monolith. Revisit when any of these is true:

- load grows by roughly 50–100× (about 10,000 boxes or more, or reporting every few seconds);
- several teams need to deploy independently and keep colliding;
- one part needs a very different SLA or exposure (e.g. the partner API, or ingest uptime guarantees).

The cheap first step is **role-based deployment**: the same image, with env flags choosing which transports a deployment starts (`ingest`: MQTT + RabbitMQ consumers; `api`: REST + SSE; `partner`: gRPC; `worker`: the existing CLI jobs). That needs cross-process SSE fan-out first (see above).

## 7. Notification Fan-out

When a new notification is created, it fans out through 2 independent channels (a failure in one never blocks the other), as designed in `CLAUDE.md`:

- **SSE** — broadcast to any client/dashboard with an open stream.
- **FCM** — a single broadcast to topic `device_{serial}` (never looped per-token).

The outcome of each channel is recorded back onto `deliveredSse`/`deliveredFcm` on the `Notifications` row itself, alongside `category`/`severity` computed by the classifier at creation time — a detail not covered in `CLAUDE.md`.

## 8. Infrastructure (`docker-compose.yml`)

Local full stack (`docker compose up -d --build`):

| Service | Image |
|---|---|
| `timescaledb` | `timescale/timescaledb:latest-pg17` |
| `redis` | `redis:7-alpine` |
| `rabbitmq` | `rabbitmq:3-management-alpine` |
| `mosquitto` | `eclipse-mosquitto:2` |
| `minio` | `minio/minio:RELEASE.2025-04-22...` (S3-compatible object storage, standing in for real S3 in dev) |

The full observability stack (`otel-collector`, `tempo`, `loki`, `prometheus`, `alertmanager`, `alloy`, `grafana`) is pulled in via `include:` from a separate `observability/docker-compose.yml` file, not duplicated here. Grafana runs on port 3001 (to avoid colliding with the app on 3000).

`migrate` and `minio-init` are one-shot jobs that run before `app` starts (schema migration + required bucket creation).

> **Entirely absent from the original `CLAUDE.md`:** MinIO/S3 object storage and the whole observability stack — both were added after the original description was written.

## 9. Auth

Two JWT schemes, separated by audience:

- **`jwt`** — user login (dashboard).
- **`device`** — device token (for endpoints called directly by devices, e.g. HTTP fallback ingestion).

There is no `Users` model in the database — actor fields (`actorId`/`actorName`/`actorRole`) recorded in the audit tables come entirely from the JWT payload.
