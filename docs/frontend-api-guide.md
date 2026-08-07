# Frontend API Guide — SMtrack v2 Backend

This is the single reference for building the frontend against this backend. It covers everything the raw OpenAPI export (`docs/openapi.json`, same content as the live `/docs` Swagger UI) can't express well: the response/error envelope, auth model, SSE contract, pagination, and a per-endpoint index with real field names.

**Read this file first, then consult `docs/openapi.json` for exact query/body parameter names and validation constraints per endpoint.** Response schemas in the OpenAPI export are mostly blank (see "Known gap" below) — use the field tables in this guide instead, or `prisma/schema.prisma` directly.

## Regenerating this pair of docs

- `docs/openapi.json`: run `npm run start:dev` (non-production env so Swagger mounts), then `npm run docs:export`. Re-run and re-commit whenever a controller/DTO changes.
- `docs/frontend-api-guide.md`: hand-maintained. Re-check it against the controllers whenever routes, guards, or response shapes change — search for `@Controller(` across `src/**/*.controller.ts` to enumerate them.

## Known gap: response schemas are blank in the OpenAPI export

Most controllers return raw Prisma model types directly (e.g. `Promise<Devices>`) with no `@ApiOkResponse`/`@ApiProperty`-decorated response DTO. Swagger can't infer a response shape from that, so `docs/openapi.json` has `"200": { "description": "" }` for nearly every endpoint. Request bodies/query params ARE accurate (DTOs are decorated with `class-validator`, which `@nestjs/swagger` can introspect). For response shapes, use the field tables below or read `prisma/schema.prisma` directly — it's the actual source of truth.

---

## 1. Base URL, prefix, and global behavior (`src/main.ts`)

- All REST/SSE routes are mounted under **`/log`** (`app.setGlobalPrefix('log')`). E.g. `@Controller('devices')` + `@Get()` → `GET /log/devices`.
- Swagger UI: `GET /docs` (no `/log` prefix). Raw JSON: `GET /docs-json`. **Only served when `NODE_ENV`/observability environment is not `production`.**
- CORS: `origin: '*'`, no credentials — send `Authorization: Bearer <token>` explicitly, don't rely on cookies.
- Global `ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false })` — unknown body/query fields are silently stripped, not rejected. Don't rely on the API to reject typos in field names.

## 2. Response envelope

Every successful response (unless the endpoint opts out, see below) is wrapped by `ResponseInterceptor`:

```ts
{
  success: true,
  message: string,   // "Request Successfully" | "Resource Created Successfully" | "Resource Updated Successfully" | "Resource Deleted Successfully"
  data: T | null,
  meta?: { page: number, limit: number, total: number, totalPages: number },  // only on paginated endpoints
  timestamp: string, // ISO
  statusCode: number
}
```

- `message` is chosen by HTTP verb: GET→"Request Successfully", POST→"Resource Created Successfully", PUT/PATCH→"Resource Updated Successfully", DELETE→"Resource Deleted Successfully" — it does **not** reflect what actually happened, just the verb.
- If the handler returns a `Paginated<T>`, `data` becomes `T[]` and `meta` is populated. Otherwise `data` is the raw object and `meta` is absent.

**Endpoints that skip this wrapper entirely** (`@SkipInterceptor()`) — their response body is exactly what you'd expect from a plain REST API, not the envelope:
- `GET /log/health` — raw Terminus health-check shape.
- `GET /log/firmware/download/:version` — raw binary stream (`Content-Type: application/octet-stream`, `Content-Disposition: attachment`).
- All 4 SSE endpoints under `sse.controller.ts` — see §5.

## 3. Error envelope

`HttpExceptionFilter` catches everything and responds:

```ts
{
  success: false,
  message: string | object,  // NestJS exception message, or class-validator error array on 400
  data: null,
  traceStack?: string  // only present when NODE_ENV=development
}
```

Prisma errors are mapped automatically: `P2002` (unique constraint) → `409`, `P2003` (FK violation) → `400`, `P2024` (pool timeout) → `500`, `P2025` (not found) → `404`.

## 4. Auth model — **this backend has no login endpoint**

There is no `/log/auth/login` or any token-issuing route here. `src/auth/auth.module.ts` only registers two Passport strategies that *verify* tokens issued elsewhere. Find out from whoever owns the auth/legacy-user service how tokens are actually minted — this backend only checks signatures.

Two independent bearer schemes, both plain JWT (`passport-jwt`), never mix them up:

| Scheme | Header | Signed with | Payload | Used by |
|---|---|---|---|---|
| User JWT (Swagger security name `jwt`) | `Authorization: Bearer <token>` | `JWT_SECRET` | `{ id, name, role, wardId }` | Every human-facing endpoint (dashboard, admin CRUD) |
| Device token (Swagger security name `device`) | `Authorization: Bearer <token>` | `DEVICE_SECRET` | `{ sn }` (hardware serial) | `POST /log/logday`, `POST /log/notifications` only — device-originated ingest |

**Roles** (`role` field, enum): `SUPER, SERVICE, ADMIN, USER, LEGACY_ADMIN, LEGACY_USER, GUEST`.
- `RolesGuard` + `@Roles(...)` gates specific routes to a role allowlist (see per-endpoint tables below) — otherwise 403.
- **Ward scoping**: `USER`, `LEGACY_USER`, `GUEST` only see data for their own `wardId` on notification reads, mobile reads, and SSE streams (`src/common/auth/ward-scope.ts`). `SUPER`/`SERVICE`/`ADMIN`/`LEGACY_ADMIN` see everything.

**⚠️ Currently unauthenticated on purpose or by oversight** — be aware these are wide open right now:
- All 4 `GET /log/backup/*` and mutating `/log/backup/*` routes have **no guard at all** (comment in code flags this as a known gap, not yet fixed).
- `GET /log/devices`, `GET /log/devices/:serial`, `GET /log/devices/by-name/:staticName`, `GET /log/devices/:deviceId/config`, `GET /log/devices/:deviceId/probes`, `GET /log/probes/:id`, `GET /log/telemetry`, `GET /log/firmware/latest`, `GET /log/firmware/download/:version` are all intentionally public reads (explicit code comments — "keep prior smtrack-log behavior").

## 5. SSE streams (`src/sse/sse.controller.ts`)

`EventSource` can't be documented meaningfully by OpenAPI, so read this instead of the spec for these 4 routes.

- **Auth**: `Authorization: Bearer <jwt>` header, OR `?token=<jwt>` query param — the browser `EventSource` API can't set custom headers, so the query param exists specifically for that. User JWT only (no device-token SSE).
- **Endpoints**:
  | Path | Channel |
  |---|---|
  | `GET /log/telemetry/stream` | telemetry only |
  | `GET /log/notifications/stream` | notifications only |
  | `GET /log/devices/stream` | device online/offline/edit/swap events |
  | `GET /log/stream?channels=telemetry,notification,device` | any subset on one connection; omit `channels` = all three; unknown name → `400` |
- A `heartbeat` event (`{ ts: <epoch ms> }`) fires every 30s on every stream regardless of channel — ignore it client-side, it exists only to stop proxies/load balancers from closing an idle-looking connection.
- Events are ward-scoped the same way REST reads are (§4).
- Response is a raw SSE stream (`text/event-stream`), not the JSON envelope — each event's `data` field is the raw payload, `type`/event name is the channel (`telemetry`/`notification`/`device`/`heartbeat`).

## 6. Pagination

Default query shape (`PaginationQueryDto`): `?page=1&limit=20` (`limit` max 100 by default). Response `meta: { page, limit, total, totalPages }`.

Two endpoints override the default `limit` ceiling:
- `GET /log/telemetry` — `limit` up to **1000**, default 100 (time-series volume).

## 7. File uploads / downloads

| Endpoint | Field | Constraints |
|---|---|---|
| `POST /log/devices`, `PUT /log/devices/:id` | `positionPic` (optional, multipart) | image only (`jpe?g|png|webp`), ≤5MB |
| `POST /log/firmware`, `PUT /log/firmware/:id` | `file` (required on create, optional on update) | binary, ≤`FIRMWARE_MAX_FILE_SIZE` env (default 100MB) |
| `GET /log/firmware/download/:version` | — | returns raw binary stream, not JSON — public, no auth |

---

## 8. Endpoint index

All paths below are relative to `/log`. "Guard" column: blank = no auth required.

### Devices (`src/device/device.controller.ts`, `src/audit/audit.controller.ts`)
| Method | Path | Guard | Body/Query | Returns |
|---|---|---|---|---|
| POST | `/devices` | `JwtAuthGuard` | multipart: `CreateDeviceDto` (`serial!, ward!, staticName!, status!(bool), seq!(int), firmware!, name?, remark?, position?, location?, tag?, installDate?`) + `positionPic?` | `Devices` |
| GET | `/devices` | — | `QueryDeviceDto` (pagination + `ward?: string[]`, comma-separated or repeated, + `search?: string` — contains/insensitive OR-match on `staticName`, `serial`, `name`) | `Paginated<Devices>` |
| GET | `/devices/:serial` | — | — | `Devices` |
| GET | `/devices/by-name/:staticName` | — | — | `Devices` (lookup by permanent install-point identity, survives hardware swaps) |
| POST | `/devices/by-name/:staticName/swap` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` | `SwapDeviceDto {serial!, reason?}` | `SwapResult` — replaces the physical hardware box at this install point |
| GET | `/devices/by-name/:staticName/assignments` | `JwtAuthGuard` | — | `DeviceAssignments[]` — install history (which box, which time range) |
| PUT | `/devices/:id` | `JwtAuthGuard` | multipart: `UpdateDeviceDto` (partial of Create) + `positionPic?` | `Devices` |
| GET | `/devices/by-name/:staticName/audit` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` | pagination | `Paginated<DeviceAudit>` — add/edit/swap history, newest first |

### Device config (`src/device-config/device-config.controller.ts`) — network/email settings pushed to a device
| Method | Path | Guard | Body | Returns |
|---|---|---|---|---|
| POST | `/devices/:deviceId/config` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` | `CreateDeviceConfigDto` (all optional: `dhcp, ip, mac, subnet, gateway, dns, dhcpEth, ipEth, macEth, subnetEth, gatewayEth, dnsEth, ssid, password, simSP, email1/2/3, hardReset`) | `Configs` |
| GET | `/devices/:deviceId/config` | — | — | `Configs` |
| PUT | `/devices/:deviceId/config` | same as POST | partial of above | `Configs` |
| DELETE | `/devices/:deviceId/config` | same as POST | — | `Configs` |

### Probes (`src/probe/probe.controller.ts`) — per-sensor-channel thresholds/alarm schedule
| Method | Path | Guard | Body/Query | Returns |
|---|---|---|---|---|
| POST | `/devices/:deviceId/probes` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` | `CreateProbeDto` (all optional: `name, type, channel, tempMin/Max, humiMin/Max, tempAdj, humiAdj, stampTime, doorQty(int), position, muteAlarmDuration, doorSound(bool), doorAlarmTime, muteDoorAlarmDuration, notiDelay(int), notiToNormal(bool), notiMobile(bool), notiRepeat(int), firstDay/secondDay/thirdDay(enum Day: OFF|ALL|MON..SUN), firstTime/secondTime/thirdTime`) | `Probes` |
| GET | `/devices/:deviceId/probes` | — | pagination | `Paginated<Probes>` |
| GET | `/probes/:id` | — | — | `Probes` |
| PUT | `/probes/:id` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` | partial of Create | `Probes` |
| DELETE | `/probes/:id` | same | — | `Probes` |

### Telemetry / logday (`src/telemetry/telemetry.controller.ts`, `src/logday/logday.controller.ts`)
| Method | Path | Guard | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/telemetry` | — | `QueryTelemetryDto`: pagination (`limit` up to 1000, default 100), `serial?, deviceId?, probeId?(UUID), probe?, from?/to?(ISO)` | `Paginated<LogDays>` |
| GET | `/logday/:serialOrName` | — | accepts hardware `serial` OR install-point `staticName` | logday service's `summaryByDevice()` result |
| POST | `/logday` | `DeviceJwtAuthGuard` (device token) | `CreateTelemetryDto \| CreateTelemetryDto[]` (`serial` forced from device token; all sensor fields optional: `temp, tempDisplay, humidity, humidityDisplay, sendTime, plug, door1/2/3, internet, probe, battery(0-100 int), tempInternal, extMemory`) | `LogDays \| LogDays[]`, HTTP 201 |
| PUT | `/logday/:id` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE)` | partial of `CreateTelemetryDto` | `LogDays` |
| DELETE | `/logday/:id` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE)` | — | `LogDays` |

Note: `POST /logday` is one of 3 parallel ingest paths (HTTP here, MQTT `devices/+/log`, RabbitMQ `log_queue`) — all three call the same `TelemetryService.ingest()`. Frontend only needs the HTTP one, if ever (this is normally device firmware, not frontend).

### Notifications (`src/notification/notification.controller.ts`)
| Method | Path | Guard | Body/Query | Returns |
|---|---|---|---|---|
| POST | `/notifications` | `DeviceJwtAuthGuard` (device token) | `CreateNotificationDto {serial!(overwritten from token), message!, detail?, probe?}` | `Notifications` (now also carries `category`/`severity`, computed server-side — see §9) |
| GET | `/notifications` | `JwtAuthGuard` | `NotificationQueryDto` (pagination + `filter?`(legacy, message-contains) OR `category?`/`severity?`(preferred, indexed exact-match)) | `Paginated<Notifications>`, ward-scoped |
| GET | `/notifications/dashboard/count` | `JwtAuthGuard` | — (declared before `:serial` to avoid route shadowing) | `NotificationDashboardCount` |
| GET | `/notifications/unread-count` | `JwtAuthGuard` | — (declared before `:serial`) | `{ count: number }` — persistent, ward-scoped like `dashboard/count` |
| POST | `/notifications/read-all` | `JwtAuthGuard` | — | `{ count: number }` — marks all of the caller's ward-scoped unread notifications as read |
| PATCH | `/notifications/:id/read` | `JwtAuthGuard` | — | `Notifications` — marks one notification read, sets `readAt` |
| GET | `/notifications/:serial` | `JwtAuthGuard` | — | `Notifications[]` |
| PUT | `/notifications/:id` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE)` | `UpdateNotificationDto` | `Notifications` |
| DELETE | `/notifications/:id` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE)` | — | `Notifications` |

**Live unread count over SSE** (extends §5, doesn't require a separate connection): the `notification` channel now carries two shapes distinguished by whether `action` is present —
- **New notification** (unchanged shape, plus one added field): the full `Notifications` row **with an extra `unreadCount` field** merged in (ward-scoped count at the moment of creation). No `action` field, same as before — existing consumers that only read known `Notifications` fields are unaffected.
- **Read-state change** (new): `{ action: 'read', notificationId: string, unreadCount: number }` or `{ action: 'read-all', unreadCount: number }`. A consumer should branch on `'action' in event` — if present, it's a read-state update (don't toast it as a new alert), otherwise treat it as a new notification as before.

### Graph (`src/graph/graph.controller.ts`) — dashboard chart data, class-level `JwtAuthGuard`
| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/graph/:serialOrName` | `QueryGraphDto {range?: '1d'\|'7d'\|'30d'\|'custom'(default '1d'), from?/to?(ISO), probeId?(UUID)}` | `ProbeSeries[]` — one series per probe on this install point (accepts hardware serial or staticName, resolved to a continuous device history across hardware swaps) |

### Repairs (`src/device-repair/device-repair.controller.ts`) — class-level `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` on ALL routes incl. GET
| Method | Path | Body/Query | Returns |
|---|---|---|---|
| POST | `/repairs` | `CreateRepairDto {serial!, devName?, info?, info1?, info2?, address?, ward?, detail?, phone?, status?, warrantyStatus?, remark?}` | `Repairs` |
| GET | `/repairs` | pagination | `Paginated<Repairs>` |
| GET | `/repairs/by-serial/:serial` | — | `Repairs[]` |
| GET | `/repairs/:id` | — | `Repairs` |
| PUT | `/repairs/:id` | partial of Create | `Repairs` |
| DELETE | `/repairs/:id` | — | `Repairs` |

### Warranties (`src/warranties/warranties.controller.ts`) — class-level `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` on ALL routes incl. GET
| Method | Path | Body/Query | Returns |
|---|---|---|---|
| POST | `/warranties` | `CreateWarrantyDto {serial!, devName?, product?, model?, installDate?, customerName?, customerAddress?, saleDepartment?, invoice?, expire?(ISO date), status?(bool), note?}` | `Warranties` |
| GET | `/warranties` | pagination + `search?: string`(contains/insensitive OR-match on `devName`, `customerName`, `product`, `model`) + `expiringSoon?: boolean`(only `status=true` AND `expire` within the next 30 days) | `Paginated<Warranties>` |
| GET | `/warranties/by-serial/:serial` | — | `Warranties[]` |
| GET | `/warranties/:id` | — | `Warranties` |
| PUT | `/warranties/:id` | partial of Create | `Warranties` |

### Firmware / OTA (`src/firmware/firmware.controller.ts`)
| Method | Path | Guard | Body | Returns |
|---|---|---|---|---|
| POST | `/firmware` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` | multipart: `CreateFirmwareDto {version!, name!, description?}` + `file!` | `Firmwares` |
| GET | `/firmware` | same roles | pagination | `Paginated<Firmwares>` |
| GET | `/firmware/latest` | — (public, devices check for OTA) | — | `Firmwares` |
| GET | `/firmware/:id` | guarded | — | `Firmwares` |
| GET | `/firmware/download/:version` | — (public) | — | raw binary stream, not JSON |
| PUT | `/firmware/:id` | guarded | multipart: partial of Create + `file?` | `Firmwares` |
| DELETE | `/firmware/:id` | guarded | — | `Firmwares` |

### Backup / archive (`src/backup/archive.controller.ts`) — ⚠️ **no auth guard on any route currently**
| Method | Path | Purpose |
|---|---|---|
| GET | `/backup/months` | list months with backup + whether currently restored |
| POST | `/backup/exports/:month` (`YYYY-MM`) | manually trigger export of a month's `LogDays` to object storage |
| POST | `/backup/restores/:month` | restore an archived month back into `LogDayArchive` for reporting |
| DELETE | `/backup/restores/:month` | clear a restored month from the DB (object storage files untouched) |

### Mobile (`src/mobile/mobile.controller.ts`) — class-level `JwtAuthGuard`
| Method | Path | Returns |
|---|---|---|
| GET | `/mobile` | `mobileService.findNotification(req.user)` |
| GET | `/mobile/:ward` | `mobileService.findWard(ward)` |

Note: there is **no FCM token registration endpoint** here despite the architecture doc mentioning one — `src/fcm/` has a service only, no controller. If mobile push registration is needed, it doesn't exist in this backend yet; check with backend team before assuming it exists.

### User audit (`src/user-audit/user-audit.controller.ts`)
| Method | Path | Guard | Query | Returns |
|---|---|---|---|---|
| GET | `/users/:actorId/audit` | `JwtAuthGuard`+`RolesGuard(SUPER,SERVICE,ADMIN)` | pagination | `Paginated<UserAudit>` — one user's actions across all entity types, newest first |

### Health
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Not wrapped in envelope. Raw `@nestjs/terminus` shape, DB ping only. |

### Not directly callable by frontend (included for completeness)
- `src/mqtt/mqtt.controller.ts` — `@EventPattern('devices/+/log')`, MQTT ingest, same `TelemetryService.ingest()` as `POST /logday`.
- `src/consumer/*.controller.ts` — RabbitMQ `@EventPattern` consumers (`device-online`/`device-offline`, `device-log`, `device-notification`), feed the same services as the REST routes above. No HTTP surface.

---

## 9. Response field reference (Prisma models)

Swagger can't show these (see §0). Field names below use the TypeScript/Prisma property name (not the `@map`'d snake_case DB column) — that's what JSON responses actually use.

**Devices**: `id, serial(nullable — pointer to currently-installed Hardware), staticName(permanent identity), ward, name?, status(bool), seq(int), location?, position?, positionPic?, remark?, online(bool), tag?, createAt, updateAt`

**Hardware** (the physical box, separate from `Devices` the install point): `id, serial, firmware, token?, installDate?, createAt, updateAt`

**DeviceAssignments** (install history): `id, deviceId, serial, startedAt, endedAt?(null = currently installed), reason?, createAt, updateAt`

**Probes**: `id, deviceId, name?, type?, channel, tempMin, tempMax, humiMin, humiMax, tempAdj, humiAdj, stampTime?, doorQty(int), position?, muteAlarmDuration?, doorSound(bool), doorAlarmTime?, muteDoorAlarmDuration?, notiDelay(int), notiToNormal(bool), notiMobile(bool), notiRepeat(int), firstDay/secondDay/thirdDay(Day enum), firstTime/secondTime/thirdTime, createAt, updateAt`

**Configs**: `id, deviceId, dhcp(bool), ip?, mac?, subnet?, gateway?, dns?, dhcpEth?(bool), ipEth?, macEth?, subnetEth?, gatewayEth?, dnsEth?, ssid?, password?, simSP?, email1/2/3?, hardReset?, createAt, updateAt`

**Repairs**: `id, seq(int, autoincrement), serial, devName?, info?, info1?, info2?, address?, ward?, detail?, phone?, status?, warrantyStatus?, remark?, createAt, updateAt`

**Warranties**: `id, serial, devName?, product?, model?, installDate?, customerName?, customerAddress?, saleDepartment?, invoice?, expire, status(bool), note?, createAt, updateAt`

**LogDays** (telemetry row): `id, serial, temp, tempDisplay, humidity, humidityDisplay, sendTime, plug(bool), door1/2/3(bool), internet(bool), probe(raw channel string from device), battery(int), tempInternal?, extMemory(bool), deviceId?, probeId?, createAt, updateAt`

**Notifications**: `id, serial, message, detail, status(bool), deliveredSse(bool), deliveredFcm(bool), isRead(bool, default false), readAt?, category(string: TEMP|DOOR|INTERNET|PLUG|SDCARD|REPORT|OTHER, computed server-side from `message` at create time), severity(string: critical|warning|info), deviceId?, probeId?, probe?, createAt, updateAt`

`category`/`severity` are computed once by `notification-classifier.util.ts` at creation time (and used consistently by `GET /notifications/dashboard/count`) — frontend should read these fields directly instead of re-parsing `message`. `isRead`/`readAt` back the new `unread-count`/`read`/`read-all` endpoints above; existing rows from before this field existed default to `isRead=false`.

**DeviceAudit**: `id, deviceId, staticName, action, actorId?, actorName?, actorRole?, snapshot(json), createAt`

**UserAudit**: `id, entityType, entityId, action, actorId?, actorName?, actorRole?, snapshot(json), createAt`

**Firmwares**: `id, version, name, description?, fileKey, fileName, fileSize(int), checksum?, createAt, updateAt`

**ArchiveExport** / **ArchiveRestore**: `month(date, PK), rowCount(bigint), objectKey, sha256(export only), exportedAt|restoredAt`

Full authoritative definitions (relations, defaults, indexes): `prisma/schema.prisma`.
