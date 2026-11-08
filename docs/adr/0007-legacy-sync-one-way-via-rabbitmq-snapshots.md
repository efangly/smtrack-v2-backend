# Legacy sync is one-way over RabbitMQ, with full-row snapshots, not CDC

Until cutover, the legacy system (smtrack-device / smtrack-log) publishes everything to v2 through RabbitMQ: runtime events (`device-log`, `device-notification`, `device-online`/`device-offline`) use the patterns and payloads v2 already consumes, and metadata changes (device, probe, config, repair, warranty, firmware) are sent as `legacy.<entity>.upserted|deleted` carrying the **whole legacy row in the legacy schema**, published to a dedicated topic exchange `legacy.sync` on v2's broker. v2 owns the translation (legacy `Devices` → `Hardware` + `Devices` + `DeviceAssignments`, `hospital` → `tenantId`, `ward` → `departmentId`) in one module that is deleted at cutover. Contract: `docs/legacy-sync-contract.md`.

## Considered Options

- **CDC from the legacy database (logical replication / Debezium).** Rejected: the team wanted everything to arrive through a queue, CDC would couple v2 to legacy table internals and need replication privileges on the legacy production DB, and runtime events would arrive after the legacy system had already transformed them.
- **Deltas instead of snapshots.** Rejected: a lost or reordered delta corrupts the copy permanently; a snapshot is repaired by the next one. Ordering is handled by last-writer-wins on the legacy `updateAt`, so redelivery and out-of-order delivery are harmless.
- **Legacy system translates into v2's shape before publishing.** Rejected: spreads v2's model into a codebase that is about to be retired, and the translation already exists in `scripts/migrate-legacy/`.
- **Two-way sync.** Rejected: v2 has no users before cutover, so there is nothing to send back, and conflict resolution between two writers is the hard part of every sync.

## Consequences

- Telemetry ingest must be idempotent: `log_days` is unique on `(serial, probe, send_time)` and a duplicate is acknowledged without a second `telemetry.created` event, because backfill and live consumption overlap.
- The legacy system must publish Nest's RMQ envelope `{ "pattern": ..., "data": ... }`, and must never consume from v2's queues — sharing a queue would split messages between consumers.
- Proof of completeness comes from daily reconciliation, which needs read-only access to the legacy database; that access is for checking only, never for syncing.
- Deletes of install points and probes are soft deletes, because `log_days` references them.
