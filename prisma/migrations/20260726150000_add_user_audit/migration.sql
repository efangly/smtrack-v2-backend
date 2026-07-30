-- Audit log รวมทุก action ของ user ข้าม entity (device/probe/config/repair)
--
-- เขียนมือเหมือน device_audit migration เพราะต้องต่อท้ายด้วย TimescaleDB DDL
-- (create_hypertable / add_retention_policy) ที่ prisma migrate diff มองไม่เห็น
--
-- ไม่ผูก FK ไป entity ใด ๆ ด้วยเหตุผลเดียวกับ device_audit: แถว audit ต้องอ่านได้ต่อ
-- แม้ entity นั้นถูกลบไปในอนาคต

-- CreateTable
CREATE TABLE "user_audit" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "actor_role" TEXT,
    "snapshot" JSONB NOT NULL,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_audit_actor_id_create_at_idx" ON "user_audit"("actor_id", "create_at");

CREATE INDEX "user_audit_entity_type_entity_id_create_at_idx" ON "user_audit"("entity_type", "entity_id", "create_at");

-- Convert to a TimescaleDB hypertable on create_at, same retention window as device_audit (6 months).
-- Primary key must include the partitioning column for hypertables.
ALTER TABLE "user_audit" DROP CONSTRAINT "user_audit_pkey";
ALTER TABLE "user_audit" ADD CONSTRAINT "user_audit_pkey" PRIMARY KEY ("id", "create_at");
SELECT create_hypertable('"user_audit"', 'create_at');

SELECT add_retention_policy('"user_audit"', INTERVAL '6 months');
