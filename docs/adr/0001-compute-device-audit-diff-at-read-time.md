# Compute device audit diff at read time, not write time

**Status:** accepted

`DeviceAudit` already stores a full JSON `snapshot` of the `Devices` row on every
`created`/`updated`/`swapped` event, with the actor who triggered it. But
`GET /devices/by-name/:staticName/audit` returned those snapshots raw — nobody
could tell which fields actually changed (e.g. which `serial` replaced which
on a hardware swap) without diffing two rows by hand outside the system.

We considered two ways to surface a diff:

1. **Persist the diff at write time** — fetch the device row before every
   `update`/`swap`, compute the diff there, and store it as a new column.
2. **Compute the diff at read time** — in `AuditService.findByDevice()`,
   compare each row's `snapshot` against the previous (older) row's `snapshot`
   for the same `deviceId`.

We chose (2). Every `DeviceAudit` row already carries the full state, so the
previous row's snapshot *is* the "before" — there's nothing to persist that
isn't already there. This needs no schema migration, no new fetch-before-write
plumbing beyond what's needed for no-op detection, and it applies retroactively
to every `DeviceAudit` row already in the database, including audits from
device moves tested before this change shipped.

The trade-off: diffing is done on every read instead of once on write, and a
row with no predecessor (`action: 'created'`) has no diff to show (`diff:
null`) — there's no "before" for the very first snapshot of a device. Diff
excludes `id`/`createAt`/`updateAt` (mutate on every write regardless of real
change) and otherwise compares fields as-is, including the nested `hardware`
sub-object.

As part of this, `GET .../audit` drops the raw `snapshot` field from its
response in favor of `diff` — a breaking response-shape change, judged
acceptable because the endpoint is already role-gated to
`SUPER`/`SERVICE`/`ADMIN`.
