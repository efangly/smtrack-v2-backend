-- Legacy sync (ADR-0007): map legacy row id → v2 row id + last applied legacy updateAt
-- ชั่วคราว — drop ทั้งตารางหลัง cutover
-- เขียนมือด้วยเหตุผลเดียวกับ migration ก่อนหน้า (diff อัตโนมัติพ่วง DDL ทำลาย hypertable)

CREATE TABLE "legacy_sync_map" (
    "entity" TEXT NOT NULL,
    "legacy_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "legacy_updated_at" TIMESTAMP(3) NOT NULL,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_sync_map_pkey" PRIMARY KEY ("entity", "legacy_id")
);

CREATE INDEX "legacy_sync_map_entity_target_id_idx" ON "legacy_sync_map"("entity", "target_id");
