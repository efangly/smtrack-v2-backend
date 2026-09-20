---
status: supersedes ADR-0002 (allowlist shape only)
---

# Partner API keys scope by ward, not per-serial allowlist; public surface is gRPC

ADR-0002 deliberately chose an explicit per-serial allowlist for Partner API keys —
least-privilege, small blast radius per key. That reasoning still holds for *why* a key
should be scoped narrowly, but the product decision now is to scope by **ward** instead:
a key lists the wards it can see, and any device in one of those wards (present now or
added later) is visible to it, with no need to re-issue the key as devices come and go.
`GetDeviceSnapshot(serial)` authorizes by resolving the device's ward and checking it
against the key's allowed wards; `ListDevicesByWard(ward)` requires the ward itself to be
allowed. Both still answer `NOT_FOUND` (not `403`) on denial — the anti-enumeration stance
from ADR-0002/grill Q16 is unchanged, only the allowlist's shape changed. Choosing Box
`serial` as the identifier `GetDeviceSnapshot` takes is also unchanged and unaffected by
this — this ADR only supersedes the allowlist-shape part of ADR-0002.

At the same time, the public surface (`GetDeviceSnapshot`, `ListDevicesByWard`) moved from
REST to **gRPC** — the only gRPC usage in this codebase; everything else stays MQTT/
RabbitMQ/REST/SSE per CLAUDE.md. Admin key management (`/admin/partner-keys`) stays REST —
gRPC is scoped to the third-party-facing surface only, not a project-wide transport change.
Auth travels as gRPC metadata (`x-api-key`) instead of an HTTP header; rate limiting
(60 req/min/key) is a small custom guard on `RedisService` since `@nestjs/throttler` only
integrates with the HTTP adapter.

**Gotcha worth recording**: this app is a hybrid (HTTP + microservices) Nest application,
and `app.useGlobalInterceptors(new ResponseInterceptor(...))` in `main.ts` applies to
`@GrpcMethod` handlers too, not just HTTP — `ExecutionContext.switchToHttp()` is
transport-agnostic at the framework level and happily returns garbage-but-not-throwing
values for a gRPC context. Left unguarded, it silently wraps the real proto response in
`{ success, message, data, ... }`, which then fails to match any field on the actual
response message and gRPC serializes an **empty** message with no error — a "successful"
call that looks fine until you look at what's actually in the payload. Both `@GrpcMethod`
handlers in `PartnerController` carry `@SkipInterceptor()` for exactly this reason; any
future gRPC handler in this app needs it too.

**Addendum — history (`GetDeviceHistory`)**: longer look-back (1/7/30 days) is served
*downsampled* (per-probe avg/min/max buckets, fixed bucket size per range) and only via an
enum range — deliberately not raw rows and not free `from`/`to`. 30 days of raw data is
~8-10k rows/device (too big for one gRPC message) and arbitrary windows would let a partner
drive arbitrary TimescaleDB scans; the enum keeps cost per call bounded and cacheable. The
server's proto-loader is configured with `enums: String` so handlers see `"DAY_7"`, not `2`.
