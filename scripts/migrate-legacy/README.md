# Migrate legacy smtrack-device → SMtrack v2 backend

One-shot script that copies device metadata from the legacy
[smtrack-device](https://github.com/efangly/smtrack-device) database into this project's
schema. Run it once against an empty/fresh target database.

## What gets migrated

| Legacy table | New table(s) |
|---|---|
| `Devices` | `Hardware` (physical box) + `Devices` (installation point) + `DeviceAssignments` (initial assignment linking them) |
| `Probes` | `Probes` |
| `Configs` | `Configs` |
| `Repairs` | `Repairs` |
| `Warranties` | `Warranties` |

### Why `Devices` becomes three tables

The legacy schema treated "the box" and "the installation point" as the same row. v2 splits
them: `Hardware` is the physical unit (keyed by `serial`), `Devices` is the installation point
(keyed by `staticName`), and `DeviceAssignments` records which box is/was installed where and
when — this is what lets a repaired box get moved to a different installation point later
without losing its telemetry history. See the comments above each model in
`prisma/schema.prisma` for the full rationale.

Every migrated device gets exactly one `DeviceAssignments` row: `startedAt` = the legacy
`installDate` (falling back to `createAt`), `endedAt = null` (still installed), `reason =
"migrated from legacy system"`.

## What is explicitly NOT migrated

- **`hospital`, `hospitalName`, `wardName`** on legacy `Devices` — the new schema only keeps a
  single `ward` ID field, with no place for the hospital/ward display names. These are dropped
  on purpose (confirmed decision) rather than stuffed into `remark`.
- **`LogDays`** (historical time-series telemetry) — out of scope for this script, since it can
  be a very large table and the two `LogDays` schemas are structurally close enough to move
  with a plain SQL copy instead of an app-level script. If you need it:
  1. On the legacy DB, dump just that table: `pg_dump --table='"LogDays"' --data-only <legacy_db> > logdays.sql`
  2. The target's `log_days` table adds one nullable column vs. the legacy one: `device_id`
     (the installation point at ingest time — see schema comment). After loading the raw rows
     into `log_days`, backfill it per serial from the `Devices.serial` pointer:
     ```sql
     UPDATE log_days l SET device_id = d.id
     FROM devices d WHERE d.serial = l.serial AND l.device_id IS NULL;
     ```
     This assumes no box was reassigned during the historical window you're importing — true
     for a first cutover since assignment history didn't exist in the legacy system.
  3. Re-run `SELECT create_hypertable(...)` compatible steps only if importing into a fresh
     table outside the existing hypertable range; otherwise a normal `INSERT`/`COPY` into the
     already-hypertable `log_days` table works as-is.
- **Notifications** — the legacy schema has no `Notifications` table, so there's nothing to
  bring over.

## Prerequisites

1. Target database: run migrations first so the schema exists and is empty of device data:
   ```bash
   npx prisma migrate deploy
   ```
2. Source database: read-only access is enough — the script never writes to it. A read-only
   DB user, or a restored copy of the legacy DB, is recommended so a mistaken run can't touch
   production data.
3. Env vars (e.g. in `.env`, or exported in your shell for this one run):
   ```env
   SOURCE_DATABASE_URL=postgresql://readonly_user:pass@legacy-host:5432/smtrack_device
   DATABASE_URL=postgresql://postgres:postgres@new-host:5432/smtrack   # already in .env for this project
   ```

## Running it

```bash
npx ts-node scripts/migrate-legacy/migrate-legacy-device.ts
```

Optionally add a shortcut to `package.json`:

```json
"migrate:legacy": "ts-node scripts/migrate-legacy/migrate-legacy-device.ts"
```

The script logs a created/skipped count per table as it goes. `skipped` rows are ones whose
legacy foreign key (`sn` for Probes/Configs, `devName` for Repairs/Warranties) didn't match any
migrated device — the row and reason are logged individually so you can decide whether to
investigate or ignore (e.g. leftover rows for a device that was already deleted upstream).

Not idempotent by design — running it twice against a target that already has the migrated
rows will fail on unique constraints (`staticName`, `Hardware.serial`, etc). If you need to
re-run after a failed partial migration, wipe the target's `devices`/`hardware` tables (cascades
handle the rest) and start over.

## Verifying after the run

Row counts should match between source and target (adjusting for skipped rows):

```sql
-- legacy
SELECT count(*) FROM "Devices";
SELECT count(*) FROM "Probes";
SELECT count(*) FROM "Configs";
SELECT count(*) FROM "Repairs";
SELECT count(*) FROM "Warranties";

-- new
SELECT count(*) FROM devices;
SELECT count(*) FROM hardware;
SELECT count(*) FROM device_assignments WHERE ended_at IS NULL;
SELECT count(*) FROM probes;
SELECT count(*) FROM configs;
SELECT count(*) FROM repairs;
SELECT count(*) FROM warranties;
```

Spot-check one device end-to-end:

```sql
SELECT d.static_name, d.serial, h.serial AS hardware_serial, h.firmware, a.started_at, a.ended_at
FROM devices d
JOIN hardware h ON h.serial = d.serial
JOIN device_assignments a ON a.device_id = d.id AND a.ended_at IS NULL
WHERE d.static_name = '<some legacy staticName>';
```

## Migrate legacy MongoDB backup (`migrate-legacy-backup.ts`)

Second script, run **after** `migrate-legacy-device.ts` (it depends on `Devices.serial` already
being populated). Source is the MongoDB used by
[smtrack-backup](https://github.com/efangly/smtrack-backup) — a write-only shadow copy of three
legacy Postgres tables (`LogDays`, `Notifications`, `TempLogs`), mirrored into Mongo collections
`logdays`, `notifications`, `templogs` via RabbitMQ events. There is no restore/list API in that
repo, just raw collections to read.

| Mongo collection | Destination |
|---|---|
| `notifications` | live `notifications` table (direct insert) |
| `logdays` | **S3 archive pipeline** (`src/backup`) — one CSV.gz + `ArchiveExport` row per month, same shape as a normal monthly export, not the live `LogDays` table |
| `templogs` | **skipped** — no target model exists for the `mcuId`-keyed legacy `TempLogs` entity |

### Notifications

- Drops the Mongo-only denormalized `staticName` field; `deviceId` is resolved by joining the
  doc's `serial` against `Devices.serial` (populated by the device migration).
- Sets `deliveredSse`/`deliveredFcm` to `true` — these notifications were already delivered by the
  legacy system, so they shouldn't look pending in the new one.
- Skips (with a `console.warn`) any doc whose `serial` doesn't match a migrated device.
- **Not idempotent**: the Mongo schema doesn't declare `id` as a stored field, so re-running
  creates duplicate rows. Don't run twice against the same target.

### LogDays → archive

- Groups Mongo `logdays` by month (`sendTime`), and for each month streams a CSV in the same
  column order (`LOG_DAYS_COLUMNS` from `src/backup/archive-export.service.ts`) as a normal
  monthly export, gzips it, uploads to the same S3/MinIO bucket, writes the matching
  `.meta.json`, and upserts an `ArchiveExport` row — so migrated months are indistinguishable from
  normal exports to the rest of the app (`GET /backup/months`, restore, etc.).
- **`id` caveat**: the legacy Mongo schema doesn't declare `id` as a `@Prop`, though the DTO
  accepted one — inspect a few real documents before running for real to see whether the original
  Postgres UUID survived. The script uses `doc.id` when it's a valid UUID, otherwise mints a new
  one with `randomUUID()`.
- **Guarded, not idempotent-by-overwrite**: before writing a month, the script checks whether that
  month's archive object already exists in S3 and skips it (logs a warning) unless you pass
  `--force`. This is to stop a rerun (or a mistaken run against a target that already has live
  exports) from silently clobbering a real monthly export.
- Verifies the uploaded row count against the Mongo count for that month before committing the
  `ArchiveExport` row; deletes the partial object and throws on mismatch.

### Prerequisites

- `ARCHIVE_S3_*` env vars must already be configured — this script uploads to the exact same
  bucket the app's `src/backup` module uses for normal monthly exports.
- `MONGO_BACKUP_URL` — connection string to the legacy Mongo instance (read-only access is enough).
- Run `migrate-legacy-device.ts` first so `Devices.serial` is populated for the join.

### Running it

```bash
npx ts-node scripts/migrate-legacy/migrate-legacy-backup.ts
# or, to overwrite months that already have an archive object in S3:
npx ts-node scripts/migrate-legacy/migrate-legacy-backup.ts --force
```

### Verifying after the run

```sql
-- notifications
SELECT count(*) FROM notifications;

-- logdays: compare against summed rowCount across the newly-created ArchiveExport rows
SELECT sum(row_count) FROM archive_export;
```

In Mongo, for comparison: `db.notifications.countDocuments()` and `db.logdays.countDocuments()`
(adjusting for skipped rows logged during the run).
