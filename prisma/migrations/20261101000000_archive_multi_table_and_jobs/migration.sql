-- Archive policy change (ADR-0005 / ADR-0006): archive 4 tables, track on-demand restores
-- and job runs. ไม่แตะ retention policy เดิมของ log_days / device_audit / user_audit —
-- ต้องถอดทีหลังสุด หลังตรวจว่าทุกเดือนที่เก่ากว่า hot window มี archive_export ที่ผ่านแล้ว

-- archive_export: PK เดิม = month อย่างเดียว → (source_table, month)
-- แถวเดิมทั้งหมดคือ log_days (DEFAULT ทำให้ backfill ให้เอง)
ALTER TABLE "archive_export" ADD COLUMN "source_table" TEXT NOT NULL DEFAULT 'log_days';
ALTER TABLE "archive_export" DROP CONSTRAINT "archive_export_pkey";
ALTER TABLE "archive_export" ADD CONSTRAINT "archive_export_pkey" PRIMARY KEY ("source_table", "month");

-- CreateTable
CREATE TABLE "restored_window" (
    "id" TEXT NOT NULL,
    "source_table" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "row_count" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored_at" TIMESTAMP(3),
    "last_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restored_window_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_job_run" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "source_table" TEXT,
    "month" DATE,
    "status" TEXT NOT NULL DEFAULT 'running',
    "row_count" BIGINT,
    "sha256" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "archive_job_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restored_window_source_table_device_id_month_key" ON "restored_window"("source_table", "device_id", "month");
CREATE INDEX "restored_window_status_expires_at_idx" ON "restored_window"("status", "expires_at");
CREATE INDEX "archive_job_run_job_started_at_idx" ON "archive_job_run"("job", "started_at");
CREATE INDEX "archive_job_run_status_started_at_idx" ON "archive_job_run"("status", "started_at");
