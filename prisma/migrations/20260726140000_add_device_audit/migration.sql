-- Audit trail ของการเพิ่ม/แก้ไข/สลับข้อมูลอุปกรณ์ (device create/update/swap)
--
-- เขียนมือเหมือน log_day_archive migration เพราะต้องต่อท้ายด้วย TimescaleDB DDL
-- (create_hypertable / add_retention_policy) ที่ prisma migrate diff มองไม่เห็น
--
-- ไม่ผูก FK ไป devices ด้วยเหตุผลเดียวกับ log_day_archive: แถว audit ต้องอ่านได้ต่อ
-- แม้จุดติดตั้งถูกลบไปในอนาคต

-- CreateTable
CREATE TABLE "device_audit" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "static_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "actor_role" TEXT,
    "snapshot" JSONB NOT NULL,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "device_audit_device_id_create_at_idx" ON "device_audit"("device_id", "create_at");

CREATE INDEX "device_audit_actor_id_create_at_idx" ON "device_audit"("actor_id", "create_at");

-- Convert to a TimescaleDB hypertable on create_at, same retention window as log_days (6 months).
-- Primary key must include the partitioning column for hypertables.
ALTER TABLE "device_audit" DROP CONSTRAINT "device_audit_pkey";
ALTER TABLE "device_audit" ADD CONSTRAINT "device_audit_pkey" PRIMARY KEY ("id", "create_at");
SELECT create_hypertable('"device_audit"', 'create_at');

SELECT add_retention_policy('"device_audit"', INTERVAL '6 months');
