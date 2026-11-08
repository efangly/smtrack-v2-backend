---
status: accepted
---

# Devices carry tenant and department; access is scoped by tenant

The auth service replaced Hospital → Ward → User with Tenant + Department (its ADR 0003). A user
belongs to one tenant. ADMIN sees every department of that tenant, an ordinary user sees either
every department or only some of them (3 of 5, say), and SUPER/SERVICE see every tenant. So
each install point stores **both** `tenantId`, which sets the boundary, and `departmentId`,
which subdivides it. A former ward ID is the same value as an auth-service department ID, so
`ward` becomes `departmentId` by a rename. `tenantId` starts empty and is filled in from the
auth-service database by `scripts/backfill-tenant`. Until then an install point is visible to
SUPER/SERVICE only.

Install points that arrive through legacy sync ([ADR-0007](./0007-legacy-sync-one-way-via-rabbitmq-snapshots.md))
take `tenantId` directly from the legacy `hospital` value, which is the same ID as the
auth-service tenant, the same way `ward` is the same ID as the department. They do not wait for
`scripts/backfill-tenant`.

What a user may see is computed once, in `JwtStrategy`, into an `AccessScope`
(`src/common/auth/access-scope.ts`): GLOBAL, the whole tenant, or a list of departments within
it. Nothing else reads `tenantId`/`departmentIds` from the token, so a change to the auth-service
payload is a change to one place. The token does not yet say whether an ordinary user has all
departments or only some. A `departmentScope: 'ALL' | 'SELECTED'` claim is specified for the
auth service (`docs/auth-service-claim-spec.md`). Without it, ordinary users get their
`departmentIds`.

Anything outside a user's scope reads as *not found*, as in the auth service. The read endpoints
that used to be public (devices, config, probes, telemetry, logday) now require a token, because
public reads would cross tenants.

## Considered Options

- **Keep only `tenantId` on devices.** Rejected: it cannot express a user who sees some
  departments of a tenant.
- **Keep only `departmentId`.** Rejected: there would be nothing to scope ADMIN by, and a department ID
  repeated in two tenants would leak.
- **Treat an empty `departmentIds` as "all departments".** Rejected: forgetting to link a user
  would silently open the whole tenant, and the auth service defines "no departments" as
  "sees nothing".
- **Ask the auth service which tenant a department belongs to on every write.** Rejected for
  now: it needs a new RabbitMQ request/reply channel. The frontend picks `tenantId` and
  `departmentId` from auth-service data in the device form instead.

## Consequences

- A device write is checked against the caller's scope: a tenant-scoped caller can place an install
  point only in its own tenant, and in one of its departments. The backend cannot check that the
  department actually belongs to that tenant. It trusts the form.
- Repairs and warranties belong to a box, which has no tenant while in stock or in repair, so
  they are now SUPER/SERVICE only.
- Partner API keys are scoped by tenant (`ListDevicesByTenant`). Existing ward allowlists are
  converted by the backfill script, which widens each key to the whole tenant of its wards.
- An unread count pushed over SSE is recomputed per subscriber scope, because a tenant-wide or
  multi-department user needs their own total, not the count of the department where the event
  happened.
- Out of scope for now: `GET /users/:actorId/audit` is not tenant-scoped for ADMIN.
