# Archive operations (runbook)

Vocabulary: see `CONTEXT.md` (**Hot window**, **Archive**, **On-demand restore**, **Restored window**).
Decisions: [ADR-0005](adr/0005-drop-hot-window-chunks-only-after-verified-export.md) (drop only after a verified export),
[ADR-0006](adr/0006-archive-jobs-run-as-k8s-cronjobs.md) (k8s CronJobs).
This is **not** disaster recovery: nothing here protects the database itself.

## What runs where

| Piece | Where | Schedule |
|---|---|---|
| `export-and-drop` | k8s CronJob `backend-archive-export` | `0 3 1-3 * *` UTC (day 1 does the work; days 2–3 retry a failed day 1) |
| `cleanup-restored` | k8s CronJob `backend-archive-cleanup` | `15 * * * *` UTC |
| On-demand restore | inside the API pod, per request | — |
| Gauges + `GET /health/archive` | API pods | computed from the DB every ≥60 s |

Manifests live in the gitops repo: `gitopts/backend/archive-export-cronjob.yaml`, `archive-cleanup-cronjob.yaml`.

## The CLI contract (what a CronJob must provide)

```
node dist/cli/archive-job export-and-drop [--dry-run] [--table=log_days,notifications,device_audit,user_audit]
node dist/cli/archive-job cleanup-restored [--dry-run]
node dist/cli/archive-job backfill [--dry-run] [--table=...] [--from=YYYY-MM] [--to=YYYY-MM]   # cut-over: archive, never drops
node dist/cli/archive-job verify [--table=...] [--from=YYYY-MM] [--to=YYYY-MM]                 # cut-over: ready to remove retention?
```

- **Image:** the same image as the API (`runner` target). `npm run archive-job -- <args>` does the same locally after `npm run build`.
- **Env (export):** `DATABASE_URL`, `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_ACCESS_KEY`, `ARCHIVE_S3_SECRET_KEY`, `ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_FORCE_PATH_STYLE`, `ARCHIVE_S3_REGION`. **Env (cleanup):** `DATABASE_URL` only.
- **Exit code:** `0` success or skipped (another instance holds the advisory lock), `1` at least one month/table failed, `2` bad usage. A non-zero exit makes the Job `Failed`.
- **Concurrency:** `concurrencyPolicy: Forbid` *and* a Postgres advisory lock per job name, so a manual run cannot overlap a scheduled one.
- **Timezone:** everything is UTC (`monthRange`, `hotWindowStart`); the CronJob sets `timeZone: Etc/UTC`.
- **Idempotent / self-healing:** each run exports *every* complete month that has no usable archive (never exported, or rows written after the export — late-arriving telemetry) and then drops only chunks older than `min(hot window start, oldest month still pending)`. A missed run is repaired by the next one.
- **Safety:** `exportMonth` refuses to overwrite an archive that has more rows than the database currently holds (a month whose chunk was partially dropped), so a re-export can never replace a complete file with a partial one.
- **Every step** writes a row to `archive_job_run` (`running` → `succeeded|failed|skipped`), so history survives the Job's own history limit.

## Monitoring

- `GET /health/archive` — 200 `ok` or 503 `degraded` with reasons. Deliberately **separate** from `GET /health` so a stuck archive can never fail a liveness/readiness probe and restart healthy pods.
- Gauges (OTLP, from API pods): `smtrack_archive_overdue_months{table}`, `smtrack_archive_pending_months{table}`, `smtrack_archive_last_success_timestamp`.
- Alerts (`observability/docker/prometheus/alert-rules.yml`, group `smtrack-archive`): `SmtrackArchiveOverdue` (critical, >0 for 1 h), `SmtrackArchiveNeverSucceeded`, `SmtrackArchiveMetricsStopped`.
- *Overdue* = a month ended more than 3 days ago and is still not archived. Because it is derived from the DB, it fires whether the Job failed, was suspended, or was never created.
- If the cluster has kube-state-metrics, also alert on `kube_job_status_failed{namespace="smtrack", job_name=~"backend-archive-.*"} > 0`. Not added to the repo's rule file because this stack cannot confirm that metric exists.

## Failure behaviour

| Situation | Effect |
|---|---|
| Export fails (S3 down, row-count mismatch) | Month stays *pending*, its chunk is **not** dropped (database grows instead of losing data), Job `Failed`, alert after 3 days |
| CronJob never runs | Same as above — `Overdue` fires from the DB |
| Late rows arrive for an archived month | Month becomes pending again and is re-exported before any further drop |
| On-demand restore fails | `restored_window.status = failed`; retried after 30 s; clients get 503 meanwhile |
| API pod dies mid-restore | Row stuck `running` → another pod takes it over after 10 min |

## Manual operations

```bash
# What would the next run do? (no export, no drop, no archive_job_run rows)
# locally, against the target DB/S3 env:
npm run build && npm run archive-job -- export-and-drop --dry-run
# in the cluster: create a Job from the CronJob and override args to ["export-and-drop","--dry-run"]

# Run now
kubectl -n smtrack create job --from=cronjob/backend-archive-export archive-manual-$(date +%s)

# Inspect
psql -c "SELECT job, source_table, month, status, row_count, error, started_at FROM archive_job_run ORDER BY started_at DESC LIMIT 30"
curl -s $API/health/archive
```

Admin endpoints `/backup/*` (SUPER/SERVICE only) still export or restore a whole month by hand; they refuse to restore a month that has per-device restored windows.

## Cut-over from the 6-month `add_retention_policy` (order matters — data loss otherwise)

Everything below uses the same image and CLI as the CronJobs; for a cluster run create a one-off Job from
`gitopts/backend/archive-backfill-job.yaml` and change its `args`.

1. Deploy the migration `20261101000000_archive_multi_table_and_jobs` and this code. **The old 6-month retention policies stay.**
2. Deploy the two CronJobs (optionally `suspend: true` until step 5 so nothing drops chunks early — it is safe either way, because a chunk is only dropped after its months are verified).
3. **Preview:** `archive-job backfill --dry-run` — lists every month still in the database with its row count, per table.
4. **Archive:** `archive-job backfill` — exports every complete month that has no usable archive. It **never drops anything**, uses the same lock as the CronJob (cannot overlap it), and goes through the same `exportMonth` (row-count check, staging then promote, `archive_export` record). Safe to re-run; scope it with `--table`, `--from`, `--to`. Any failure exits 1 and names the month.
5. **Verify:** `archive-job verify` — reads every archive back from object storage and re-computes record count and sha256 against `archive_export`, and checks that no month older than the hot window is still in the database without a usable archive. It prints `CUT-OVER READY` and exits 0 only if all of that holds. Also check `GET /health/archive` is `ok`.
6. Only then add a migration that removes `add_retention_policy` from `log_days`, `device_audit`, `user_audit` (never edit an applied migration). From that moment the CronJob is the only thing that removes chunks.
7. Infra: set a 5-year lifecycle rule on the archive bucket, and re-run `verify` after any bucket-level change.

Limits to know before you start:
- `device_audit` and `user_audit` rows older than 6 months are already gone (the old policy dropped them with no copy) and cannot be recovered; backfill only archives what is still in the database.
- `backfill` archives a whole calendar month at a time. A month whose chunk was already partly dropped by the old policy is archived from the rows that remain; `verify` cannot know it was once larger.
- Legacy archive files (written before `device_id`) are verified by content hash like any other, but are restored through `device_assignments` (see `RestoredWindowService`).

## Known limits

- Verified against real TimescaleDB 17 and an S3-compatible store (adobe/s3mock) by `bash scripts/test-backup.sh` (28 checks + 22 e2e). Not yet run against the production MinIO/S3 or a multi-replica deployment. The `minio/minio:RELEASE.2025-04-22T22-12-26Z` image pinned in `docker-compose.yml` can no longer be pulled (removed from Docker Hub and quay.io), so the compose stack's object storage needs a replacement image.
- On-demand restore covers `log_days` only. `notifications`, `device_audit`, `user_audit` are archived as evidence and have no read-back path.
- No per-user rate limit on requests that trigger a restore (there is no throttler in the project). Abuse is bounded by one restore per (install point, month), 2 concurrent restores per pod and a 6-month cap per request.
- `partner-api-key-cleanup` still uses in-process `@Cron` and runs on every replica.
