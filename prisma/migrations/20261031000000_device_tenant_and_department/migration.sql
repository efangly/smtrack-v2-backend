-- devices มีทั้ง tenant (ขอบเขตการเห็นข้อมูล) และ department (แบ่งย่อยใน tenant) ตาม auth-service
-- รุ่น tenant/department — ดู ADR-0004 (เขียนเองเป็น RENAME — ที่ Prisma gen ให้คือ DROP + ADD ซึ่งข้อมูลหาย)

-- devices: ID ward เดิมคือ departmentId ของ auth-service จึงแค่เปลี่ยนชื่อ
-- tenant_id เป็น null จนกว่าจะรัน scripts/backfill-tenant (ระหว่างนั้นเห็นได้เฉพาะ SUPER/SERVICE)
ALTER TABLE "devices" RENAME COLUMN "ward" TO "department_id";
ALTER TABLE "devices" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "devices_tenant_id_department_id_idx" ON "devices"("tenant_id", "department_id");

-- partner allowlist แบบ ward เก็บไว้ให้สคริปต์ backfill แปลงเป็น tenant แล้วค่อยลบใน migration ถัดไป
ALTER TABLE "partner_api_key_wards" RENAME TO "partner_api_key_departments_legacy";
ALTER TABLE "partner_api_key_departments_legacy" RENAME COLUMN "ward" TO "department_id";
ALTER TABLE "partner_api_key_departments_legacy" RENAME CONSTRAINT "partner_api_key_wards_pkey" TO "partner_api_key_departments_legacy_pkey";
ALTER TABLE "partner_api_key_departments_legacy" RENAME CONSTRAINT "partner_api_key_wards_key_id_fkey" TO "partner_api_key_departments_legacy_key_id_fkey";
ALTER INDEX "partner_api_key_wards_key_id_ward_key" RENAME TO "partner_api_key_departments_legacy_key_id_department_id_key";
ALTER INDEX "partner_api_key_wards_key_id_idx" RENAME TO "partner_api_key_departments_legacy_key_id_idx";

CREATE TABLE "partner_api_key_tenants" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_api_key_tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "partner_api_key_tenants_key_id_tenant_id_key" ON "partner_api_key_tenants"("key_id", "tenant_id");

CREATE INDEX "partner_api_key_tenants_key_id_idx" ON "partner_api_key_tenants"("key_id");

ALTER TABLE "partner_api_key_tenants" ADD CONSTRAINT "partner_api_key_tenants_key_id_fkey"
    FOREIGN KEY ("key_id") REFERENCES "partner_api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- request log เก่าเก็บ ward ซึ่งไม่ใช่ tenant — ไม่ย้ายค่า (เป็นแค่ประวัติ) แต่ไม่ทิ้งคอลัมน์เดิมเงียบ ๆ
ALTER TABLE "partner_api_request_logs" RENAME COLUMN "ward" TO "legacy_ward";
ALTER TABLE "partner_api_request_logs" ADD COLUMN "tenant_id" TEXT;

-- snapshot ของ device ที่เก็บไว้ก่อนหน้า (JSONB) ยังใช้ key "ward" — diff คำนวณตอนอ่าน (ADR-0001)
-- ถ้าไม่แปลง แถวแรกหลัง migrate จะโชว์ว่า ward ถูกลบและ departmentId ถูกเพิ่ม ทั้งที่ไม่มีใครแก้
-- user_audit แปลงเฉพาะ entity_type = 'device' — snapshot ของ repair/warranty มี "ward" ที่เป็น
-- ข้อความที่อยู่ลูกค้า ไม่ใช่ ID department
UPDATE "device_audit"
SET "snapshot" = ("snapshot" - 'ward') || jsonb_build_object('departmentId', "snapshot" -> 'ward')
WHERE "snapshot" ? 'ward';

UPDATE "user_audit"
SET "snapshot" = ("snapshot" - 'ward') || jsonb_build_object('departmentId', "snapshot" -> 'ward')
WHERE "entity_type" = 'device' AND "snapshot" ? 'ward';
