# Drop hot-window chunks only after a verified export, not on a timer

`log_days`, `device_audit`, `user_audit` and `notifications` leave the hot window (1 calendar month) by a job that drops a monthly chunk only when an `ArchiveExport` row exists whose row count and sha256 were verified. We replace TimescaleDB `add_retention_policy`, which dropped chunks on a timer (6 months) with no knowledge of whether the export had succeeded — a failed or skipped export, or an env value (`ARCHIVE_RETENTION_MONTHS`) out of step with the SQL interval, silently lost data.

The trade-off: if exports keep failing, the database grows instead of losing data. We judged disk growth recoverable and data loss not, and it makes the window defined in one place. Consequence for rollout: the old retention policies must be removed only after every month older than the new window has a verified archive.
