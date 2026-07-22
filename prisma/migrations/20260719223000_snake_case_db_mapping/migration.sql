-- Hand-written rename-based migration.
-- Prisma's default diff engine would DROP + CREATE every table for this @map/@@map change,
-- which would destroy existing data (Devices, LogDays, Notifications are non-empty) and break
-- the LogDays TimescaleDB hypertable. RENAME statements preserve data, hypertable config,
-- and chunk catalog entries instead.

-- Rename tables to snake_case
ALTER TABLE "Devices" RENAME TO "devices";
ALTER TABLE "LogDays" RENAME TO "log_days";
ALTER TABLE "Notifications" RENAME TO "notifications";
ALTER TABLE "LogDayArchive" RENAME TO "log_day_archive";
ALTER TABLE "ArchiveExport" RENAME TO "archive_export";
ALTER TABLE "ArchiveRestore" RENAME TO "archive_restore";

-- Rename columns: devices
ALTER TABLE "devices" RENAME COLUMN "staticName" TO "static_name";
ALTER TABLE "devices" RENAME COLUMN "positionPic" TO "position_pic";
ALTER TABLE "devices" RENAME COLUMN "createAt" TO "create_at";
ALTER TABLE "devices" RENAME COLUMN "updateAt" TO "update_at";

-- Rename columns: log_days
ALTER TABLE "log_days" RENAME COLUMN "tempDisplay" TO "temp_display";
ALTER TABLE "log_days" RENAME COLUMN "humidityDisplay" TO "humidity_display";
ALTER TABLE "log_days" RENAME COLUMN "sendTime" TO "send_time";
ALTER TABLE "log_days" RENAME COLUMN "tempInternal" TO "temp_internal";
ALTER TABLE "log_days" RENAME COLUMN "extMemory" TO "ext_memory";
ALTER TABLE "log_days" RENAME COLUMN "createAt" TO "create_at";
ALTER TABLE "log_days" RENAME COLUMN "updateAt" TO "update_at";

-- Rename columns: notifications
ALTER TABLE "notifications" RENAME COLUMN "deliveredSse" TO "delivered_sse";
ALTER TABLE "notifications" RENAME COLUMN "deliveredFcm" TO "delivered_fcm";
ALTER TABLE "notifications" RENAME COLUMN "createAt" TO "create_at";
ALTER TABLE "notifications" RENAME COLUMN "updateAt" TO "update_at";

-- Rename columns: log_day_archive
ALTER TABLE "log_day_archive" RENAME COLUMN "tempDisplay" TO "temp_display";
ALTER TABLE "log_day_archive" RENAME COLUMN "humidityDisplay" TO "humidity_display";
ALTER TABLE "log_day_archive" RENAME COLUMN "sendTime" TO "send_time";
ALTER TABLE "log_day_archive" RENAME COLUMN "tempInternal" TO "temp_internal";
ALTER TABLE "log_day_archive" RENAME COLUMN "extMemory" TO "ext_memory";
ALTER TABLE "log_day_archive" RENAME COLUMN "createAt" TO "create_at";
ALTER TABLE "log_day_archive" RENAME COLUMN "updateAt" TO "update_at";

-- Rename columns: archive_export
ALTER TABLE "archive_export" RENAME COLUMN "rowCount" TO "row_count";
ALTER TABLE "archive_export" RENAME COLUMN "objectKey" TO "object_key";
ALTER TABLE "archive_export" RENAME COLUMN "exportedAt" TO "exported_at";

-- Rename columns: archive_restore
ALTER TABLE "archive_restore" RENAME COLUMN "rowCount" TO "row_count";
ALTER TABLE "archive_restore" RENAME COLUMN "objectKey" TO "object_key";
ALTER TABLE "archive_restore" RENAME COLUMN "restoredAt" TO "restored_at";

-- Rename primary key constraints
ALTER TABLE "devices" RENAME CONSTRAINT "Devices_pkey" TO "devices_pkey";
ALTER TABLE "log_days" RENAME CONSTRAINT "LogDays_pkey" TO "log_days_pkey";
ALTER TABLE "notifications" RENAME CONSTRAINT "Notifications_pkey" TO "notifications_pkey";
ALTER TABLE "log_day_archive" RENAME CONSTRAINT "LogDayArchive_pkey" TO "log_day_archive_pkey";
ALTER TABLE "archive_export" RENAME CONSTRAINT "ArchiveExport_pkey" TO "archive_export_pkey";
ALTER TABLE "archive_restore" RENAME CONSTRAINT "ArchiveRestore_pkey" TO "archive_restore_pkey";

-- Rename foreign key constraints
ALTER TABLE "log_days" RENAME CONSTRAINT "LogDays_serial_fkey" TO "log_days_serial_fkey";
ALTER TABLE "notifications" RENAME CONSTRAINT "Notifications_serial_fkey" TO "notifications_serial_fkey";

-- Rename indexes (includes the hypertable time-partition index TimescaleDB created on log_days.send_time)
ALTER INDEX "Devices_serial_key" RENAME TO "devices_serial_key";
ALTER INDEX "LogDays_serial_sendTime_idx" RENAME TO "log_days_serial_send_time_idx";
ALTER INDEX "LogDays_sendTime_idx" RENAME TO "log_days_send_time_idx";
ALTER INDEX "Notifications_serial_createAt_idx" RENAME TO "notifications_serial_create_at_idx";
