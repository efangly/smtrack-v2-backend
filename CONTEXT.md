# SMtrack v2 Backend

IoT telemetry/log ingestion, real-time push, and notification system for medical device monitoring (see project README/CLAUDE.md for the full architecture).

## Language

**Audit diff**:
The set of fields that changed between one `DeviceAudit` snapshot and the immediately preceding snapshot for the same device, shown as `{ field: { from, to } }`. Computed on read, not stored — see [ADR-0001](./docs/adr/0001-compute-device-audit-diff-at-read-time.md).
_Avoid_: change log, delta (when referring to this specific computed value)

**Department**:
A subdivision of a tenant where install points live (a ward, a production line, a lab bench), defined by the auth service. An ordinary user sees either every department of their tenant or only the ones granted to them.
_Avoid_: ward (the former name — still used only for the free-text address on repairs and warranties), unit, room

**Tenant**:
A customer organisation using SMtrack (a hospital, laboratory, factory, …) as defined by the auth service. Every user and every install point belongs to one tenant, and nobody outside it sees its data except SUPER/SERVICE.
_Avoid_: hospital (as the general term), organisation, customer

**Access scope**:
What a signed-in user may see: every tenant, the whole of their own tenant, or only some departments of it.
_Avoid_: permissions, visibility, ward scope

**Install point**:
A logical, permanently-named location a monitoring box lives at (e.g. "ICU bed 3 fridge") — the `Devices` row, identified by `staticName`. Distinct from the physical box installed there.
_Avoid_: device (ambiguous with the physical box), location

**Box / Hardware**:
The physical device that reports telemetry via MQTT/JWT, identified by `serial`. Can be swapped between install points; its own history (firmware, repairs, warranty) follows the box, not the install point.
_Avoid_: device (ambiguous with the install point), unit

**Swap**:
Replacing the box currently occupying an install point with a different one, recorded as a new `DeviceAssignments` row with a closed predecessor. The only path allowed to change `Devices.serial`.
_Avoid_: move device, reassign (when referring specifically to a serial change — "move" is ambiguous between this and changing `department`/`position`)

**Partner**:
An external third-party organization consuming device metadata and time series through the Partner API, authenticated by a Partner API Key rather than user or device credentials.
_Avoid_: third party, client (ambiguous with other uses in this codebase)

**Partner API Key**:
A credential issued to a Partner, scoped to an explicit allowlist of tenants (not per-Box `serial` — that was the original design in [ADR-0002](./docs/adr/0002-partner-api-keys-scope-by-box-serial.md), superseded by [ADR-0003](./docs/adr/0003-partner-api-keys-scope-by-ward.md), now scoped by tenant per [ADR-0004](./docs/adr/0004-device-tenant-scope.md)). Presented as the gRPC metadata key `x-api-key`; only its hash is stored.
_Avoid_: token, access key

## Archive

**Hot window**:
The most recent calendar month of log, notification and audit rows, which stay in the main database. In practice 1–2 months, because rows are dropped a whole monthly chunk at a time.
_Avoid_: retention period, live data

**Archive**:
The permanent (5-year) monthly copy of one table's rows on object storage, written before those rows leave the hot window. Not a disaster-recovery backup of the database.
_Avoid_: backup (ambiguous with disaster recovery), export (that is the act of producing it)

**On-demand restore**:
Bringing one install point's rows for a requested period back from the Archive into the database, triggered automatically by a request that falls outside the hot window.
_Avoid_: backup restore, rehydrate

**Restored window**:
Rows brought back by an on-demand restore. They disappear again once unread for 24 hours.
_Avoid_: cache, restored data

## Legacy sync

**Legacy system**:
The SMtrack v1 services (smtrack-device, smtrack-log) still running in production while v2 is prepared. It remains the source of truth until cutover.
_Avoid_: old system, v1 (in code and docs)

**Legacy sync**:
The temporary, one-way flow by which the legacy system publishes every change and every new log, notification and online/offline event to v2, so v2 holds a complete copy before cutover. Never flows from v2 back to the legacy system.
_Avoid_: replication, migration (migration is the one-off backfill that precedes it)

**Backfill**:
The one-off copy of everything the legacy system held before legacy sync started.
_Avoid_: migration (when meaning the continuous part), import

**Cutover**:
The single moment when every box and app is pointed at v2, the legacy system stops, and legacy sync ends. Happens once for all tenants, not per tenant.
_Avoid_: go-live, switch-over, migration

**Reconciliation**:
The daily comparison of what the legacy system holds against what v2 received through legacy sync, to prove nothing was lost. Reads the legacy database for checking only; it never writes to v2.
_Avoid_: sync check, audit (audit means device/user audit here)
