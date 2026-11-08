# Run archive jobs as Kubernetes CronJobs, not in-process `@Cron`

Archive export, chunk drop and restored-window cleanup run as Kubernetes CronJobs executing a standalone CLI from the same image as the API, instead of `@Cron` inside `ArchiveExportService`. An in-process `@Cron` runs on every API replica (no leader election), leaves no record when a pod restarts at the scheduled minute, and cannot be alerted on.

Each run records itself in `archive_job_run`, exits non-zero on failure so the Job shows `Failed`, uses `concurrencyPolicy: Forbid` plus a Postgres advisory lock, and exports every unexported month older than the window rather than one month computed from the date, so a missed run heals itself. Manifests live in the gitops repo, not this one. `partner-api-key-cleanup` still uses `@Cron` and has the same flaw; it is out of scope here.
