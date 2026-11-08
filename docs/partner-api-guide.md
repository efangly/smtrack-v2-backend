# Partner API Guide — Third-Party Device Data Access (gRPC)

This is the integration guide for third-party applications reading device metadata and
telemetry from SMtrack. It is self-contained — you do not need access to the internal
frontend/admin API guide to use this API.

**This surface is gRPC, not REST.** It's the only gRPC endpoint in this backend — everything
else (including admin key management, see §7) is REST/MQTT/RabbitMQ. If you don't have an
API key yet, contact your SMtrack admin — there is no self-service sign-up, keys are issued
manually.

> **Breaking change (tenant scope):** `ListDevicesByWard(ward)` was replaced by
> `ListDevicesByTenant(tenant_id)` — keys are now scoped to whole organisations (tenants)
> instead of wards. An existing key was converted to the tenant(s) its wards belong to, so it
> now sees every device of those tenants. Ask your admin for your tenant ID(s). A client still
> calling the old RPC gets `UNIMPLEMENTED` — regenerate your stubs from the current proto.

## 1. Connection

```
host:port   <your-smtrack-host>:50051   (GRPC_URL — ask your admin for the real value)
TLS         plaintext for now — not yet configured; treat this as a known gap, not a
            deliberate choice, and expect it to change
```

The full contract lives in [`src/partner/partner.proto`](../src/partner/partner.proto) in
this repo — copy it into your client project rather than hand-transcribing the messages
below (they're shown here for reference, but the `.proto` file is the source of truth).

```proto
syntax = "proto3";
package partner;

service PartnerService {
  rpc GetDeviceSnapshot(GetDeviceSnapshotRequest) returns (GetDeviceSnapshotResponse);
  rpc ListDevicesByTenant(ListDevicesByTenantRequest) returns (ListDevicesByTenantResponse);
  rpc GetDeviceHistory(GetDeviceHistoryRequest) returns (GetDeviceHistoryResponse);
  rpc ListDeviceTelemetry(ListDeviceTelemetryRequest) returns (ListDeviceTelemetryResponse);
}
```

There is no version segment in the package/service name yet. Breaking changes will be
announced to partners ahead of time rather than shipped silently.

## 2. Authentication

Every call must carry your API key as gRPC **metadata** (not a message field):

```
x-api-key: pk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- Your key only grants access to a specific, pre-approved list of **tenants** (customer
  organisations — see §3). It does not grant access to every device in the system, and it is
  not scoped by individual device — any device that belongs to (or is later moved into) an
  allowed tenant becomes visible automatically.
- Keys don't expire automatically. If a key needs rotating or revoking, contact your admin
  — a revoked key stops working immediately.
- **Keep your key secret.** Anyone with it can read data for every device in every
  tenant it's scoped to, within your rate limit.

## 3. What "tenant" means here, and what "serial" means in `GetDeviceSnapshot`

A **tenant** is the customer organisation a device belongs to (a hospital, laboratory,
factory, …). Your key lists the tenant IDs it can see. `ListDevicesByTenant` takes a tenant
ID directly; `GetDeviceSnapshot` takes a device **serial** — access is checked by resolving that
device's tenant and confirming it's one of yours, not by the serial itself being on any list.

The `serial` identifies the **physical hardware unit** (the box), not a room/location. If a
unit is ever physically swapped out for a different one at the same install location, its
serial number changes — you're not responsible for tracking that yourself here (unlike the
old per-serial model), since access is tenant-based; the new box just needs to be in a
tenant your key already covers.

## 4. Rate limiting

Each API key is limited to **60 requests per minute**, across all RPCs combined. Going
over the limit returns:

```
grpc.status.RESOURCE_EXHAUSTED (8)
```

There is currently no per-key custom limit — all keys share the same fixed budget.

## 5. Error codes

Every failure comes back as a standard gRPC error with one of these codes (no separate
envelope/wrapper — this is not the REST API, there's no `{success, message, data}` shape
here):

| gRPC status | Code | Meaning | Common cause |
|---|---|---|---|
| `UNAUTHENTICATED` | 16 | Missing, invalid, or revoked `x-api-key` metadata |
| `NOT_FOUND` | 5 | The serial/tenant doesn't exist, **or** it exists but isn't in your key's allowed tenants — deliberately indistinguishable so a wrong/guessed serial can't be used to probe what exists |
| `INVALID_ARGUMENT` | 3 | Empty `serial`/`tenant_id`, or a bad `page`/`limit` |
| `RESOURCE_EXHAUSTED` | 8 | Over 60 requests/minute for this key |

## 6. RPCs

### `GetDeviceSnapshot(serial)` — metadata + trailing 1-hour telemetry

Returns a curated device snapshot plus **the last hour** of telemetry, always — there is no
way to request a different or wider window; this RPC is intentionally fixed-window, not
paginated history. Internal/location fields (which tenant/department, physical position, etc.) are
excluded from `DeviceMetadata` on purpose — this call never tells you *where* a device is,
only its own state.

**Request** (`GetDeviceSnapshotRequest`): `serial` (string, required).

**Response** (`GetDeviceSnapshotResponse`):

| Field | Type | Notes |
|---|---|---|
| `device.serial` | string | the serial you requested |
| `device.name` | string | human-readable device name |
| `device.status` | bool | device enabled/active flag |
| `device.firmware` | string | current firmware version |
| `device.online` | bool | currently connected |
| `timeseries` | repeated `TelemetryPoint` | last 1h, newest first — empty if no readings in that window |

`TelemetryPoint`: `send_time` (ISO 8601 UTC string), `temp`, `temp_display`, `humidity`,
`humidity_display`, `temp_internal`, `battery` (int), `plug`, `door1`, `door2`, `door3`,
`internet`, `ext_memory` (all bool), `probe` (string channel id).

**Example** (Node, `@grpc/grpc-js` + `@grpc/proto-loader`):

```js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const pkgDef = protoLoader.loadSync('partner.proto');
const proto = grpc.loadPackageDefinition(pkgDef);
const client = new proto.partner.PartnerService(
  'smtrack-host:50051',
  grpc.credentials.createInsecure(),
);

const metadata = new grpc.Metadata();
metadata.set('x-api-key', process.env.PARTNER_API_KEY);

client.GetDeviceSnapshot({ serial: 'SN-00042' }, metadata, (err, res) => {
  if (err) throw err; // err.code is the grpc.status enum value — see §5
  console.log(res.device, res.timeseries);
});
```

Equivalent with `grpcurl`:

```bash
grpcurl -plaintext \
  -H "x-api-key: $PARTNER_API_KEY" \
  -d '{"serial": "SN-00042"}' \
  smtrack-host:50051 partner.PartnerService/GetDeviceSnapshot
```

---

### `ListDevicesByTenant(tenant_id, page, limit)` — every device of a tenant + its latest reading

Returns every device of `tenant_id` (paginated), each with its metadata plus its **single most
recent** telemetry reading — not the full history. If you need history for a specific
device, follow up with `GetDeviceSnapshot`.

**Request** (`ListDevicesByTenantRequest`): `tenant_id` (string, required), `page` (int, default
1), `limit` (int, default 20, max 100).

**Response** (`ListDevicesByTenantResponse`):

| Field | Type | Notes |
|---|---|---|
| `devices` | repeated `DeviceWithLatestReading` | |
| `devices[].device` | `DeviceMetadata` | same shape as above |
| `devices[].latest` | `TelemetryPoint`, optional | **absent** (not a zero value) if the device has no telemetry yet |
| `total` | int | total devices of the tenant, for pagination |
| `page` / `limit` | int | echoes back what was applied |

**Example**:

```bash
grpcurl -plaintext \
  -H "x-api-key: $PARTNER_API_KEY" \
  -d '{"tenant_id": "<your-tenant-id>", "page": 1, "limit": 20}' \
  smtrack-host:50051 partner.PartnerService/ListDevicesByTenant
```

### `GetDeviceHistory(serial, range)` — 1 / 7 / 30 day downsampled telemetry

Returns telemetry aggregated into time buckets (per probe) for the last 1, 7 or 30 days. This
is **aggregated, not raw**: the range is an enum counted back from now (there is no free
`from`/`to`), and each bucket carries avg/min/max instead of individual readings. Raw
points are only available via `GetDeviceSnapshot` (last 1 hour). Same auth/tenant rules as
`GetDeviceSnapshot` — a serial outside your tenants is `NOT_FOUND`.

**Request** (`GetDeviceHistoryRequest`): `serial` (string, required), `range` (enum, required —
`HISTORY_RANGE_UNSPECIFIED` or omitting it → `INVALID_ARGUMENT`).

| `range` | Window | Bucket size (fixed) | Max buckets per probe* |
|---|---|---|---|
| `DAY_1` | last 24 h | 15 minutes | 97 |
| `DAY_7` | last 7 days | 1 hour | 169 |
| `DAY_30` | last 30 days | 3 hours | 241 |

\* the window start rarely lands on a bucket boundary, so the oldest bucket is partial and
counts as one extra (window ÷ bucket size, plus 1).

**Response** (`GetDeviceHistoryResponse`): `device` (`DeviceMetadata`), `range`,
`bucket_interval` (string, e.g. `"1 hour"` — the resolution you actually got), and
`buckets` (oldest → newest; empty buckets are omitted, not zero-filled).

`HistoryBucket`: `bucket_start` (ISO 8601 UTC), `probe` (channel id — one bucket per probe per
interval), `temp_avg/min/max`, `humidity_avg/min/max`, `battery_min`, `door_open` (any of
door1/2/3 open at any point in the bucket), `samples` (readings aggregated into the bucket).

**Enum names:** load your proto with enums-as-strings so you can send/receive `"DAY_7"`
instead of the number `2` — Node: `protoLoader.loadSync('partner.proto', { enums: String })`.
The server is configured the same way.

```bash
grpcurl -plaintext \
  -H "x-api-key: $PARTNER_API_KEY" \
  -d '{"serial": "SN-00042", "range": "DAY_7"}' \
  smtrack-host:50051 partner.PartnerService/GetDeviceHistory
```

Results are cached server-side for 60 seconds per (serial, range), so polling faster than
that returns the same buckets.

### `ListDeviceTelemetry(serial, range, page, limit)` — raw rows for a table view

Raw telemetry rows for the last 1, 7 or 30 days, **newest first, paginated** — meant for table
views. Use `GetDeviceHistory` (downsampled buckets) for charts. Same auth/tenant rules and the
same `range` enum as `GetDeviceHistory`; no free `from`/`to`.

**Request** (`ListDeviceTelemetryRequest`): `serial` (required), `range` (enum, required),
`page` (int, default 1), `limit` (int, default 50, max 200).

**Response** (`ListDeviceTelemetryResponse`): `device` (`DeviceMetadata`), `range`, `points`
(repeated `TelemetryPoint`, same fields as `GetDeviceSnapshot`, newest first), `total` (rows in
the whole range, for computing page count), `page`, `limit` (echoes what was applied).

Rows that share a `send_time` (e.g. several probes) are ordered deterministically, so paging
through never repeats or skips a row while no new data arrives. New readings arriving between
page requests shift later pages — page 1 first, then walk forward.

```bash
grpcurl -plaintext \
  -H "x-api-key: $PARTNER_API_KEY" \
  -d '{"serial": "SN-00042", "range": "DAY_7", "page": 1, "limit": 50}' \
  smtrack-host:50051 partner.PartnerService/ListDeviceTelemetry
```

## 7. Getting/rotating a key

Key management stays REST (internal, admin-only — not part of this gRPC surface):

1. Tell your SMtrack admin which **tenants** (organisations) you need access to.
2. They issue a key scoped to exactly those tenants (`POST /admin/partner-keys` with
   `{ "name": "...", "tenantIds": ["<tenant-id>"] }`) and hand you the plaintext value **once** —
   it is never shown again, so store it securely on your side immediately.
3. If you lose it or suspect it's leaked, ask your admin to revoke it and issue a new one.
