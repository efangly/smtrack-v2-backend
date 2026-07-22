-- CreateTable
CREATE TABLE "LogDayArchive" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "temp" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "tempDisplay" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "humidity" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "humidityDisplay" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "sendTime" TIMESTAMP(3) NOT NULL,
    "plug" BOOLEAN NOT NULL DEFAULT false,
    "door1" BOOLEAN NOT NULL DEFAULT false,
    "door2" BOOLEAN NOT NULL DEFAULT false,
    "door3" BOOLEAN NOT NULL DEFAULT false,
    "internet" BOOLEAN NOT NULL DEFAULT false,
    "probe" TEXT NOT NULL DEFAULT '1',
    "battery" INTEGER NOT NULL DEFAULT 0,
    "tempInternal" DOUBLE PRECISION DEFAULT 0.00,
    "extMemory" BOOLEAN NOT NULL DEFAULT false,
    "createAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogDayArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchiveExport" (
    "month" DATE NOT NULL,
    "rowCount" BIGINT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchiveExport_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "ArchiveRestore" (
    "month" DATE NOT NULL,
    "rowCount" BIGINT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "restoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchiveRestore_pkey" PRIMARY KEY ("month")
);

-- Convert LogDayArchive into a TimescaleDB hypertable chunked by month.
-- Restore/removal operate one whole month at a time, so a 1-month chunk means
-- "remove a restored month" is a single, cheap chunk drop.
-- Primary key must include the partitioning column for hypertables.
ALTER TABLE "LogDayArchive" DROP CONSTRAINT "LogDayArchive_pkey";
ALTER TABLE "LogDayArchive" ADD CONSTRAINT "LogDayArchive_pkey" PRIMARY KEY ("id", "sendTime");
SELECT create_hypertable('"LogDayArchive"', 'sendTime', chunk_time_interval => INTERVAL '1 month');

-- Archived data is permanent (no retention policy) but compress it shortly
-- after restore since it's rarely written to once loaded back in.
ALTER TABLE "LogDayArchive" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'serial',
  timescaledb.compress_orderby = '"sendTime" DESC'
);
SELECT add_compression_policy('"LogDayArchive"', INTERVAL '3 days');

-- Align LogDays' chunk interval with the monthly export/drop cadence.
-- It was created with TimescaleDB's default (7 days) in the init migration.
SELECT set_chunk_time_interval('"LogDays"', INTERVAL '1 month');

-- Drop chunks of LogDays automatically once ArchiveExportService has had a
-- chance to export them (cron exports the month that turns
-- ARCHIVE_RETENTION_MONTHS - 1 months old, leaving a 1-month buffer here).
SELECT add_retention_policy('"LogDays"', INTERVAL '6 months');

-- View for reports that span the retention boundary: recent data lives in
-- LogDays, anything older has to be restored into LogDayArchive first.
CREATE VIEW "LogDaysAll" AS
  SELECT "id", "serial", "temp", "tempDisplay", "humidity", "humidityDisplay", "sendTime",
         "plug", "door1", "door2", "door3", "internet", "probe", "battery", "tempInternal",
         "extMemory", "createAt", "updateAt"
  FROM "LogDays"
  UNION ALL
  SELECT "id", "serial", "temp", "tempDisplay", "humidity", "humidityDisplay", "sendTime",
         "plug", "door1", "door2", "door3", "internet", "probe", "battery", "tempInternal",
         "extMemory", "createAt", "updateAt"
  FROM "LogDayArchive";
