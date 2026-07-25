-- แยก "จุดติดตั้งเชิงตรรกะ" (devices) ออกจาก "กล่องฮาร์ดแวร์" (hardware) เพื่อรองรับการสลับเครื่อง
--
-- ปัญหาที่แก้: serial เดินตามกล่อง ไม่ได้เดินตามจุดติดตั้ง เมื่ออุปกรณ์พังแล้วเปลี่ยนกล่องใหม่
-- config/probe/ประวัติ telemetry ของจุดติดตั้งต้องยังอยู่ครบ และเมื่อกล่องเก่าซ่อมเสร็จแล้ว
-- นำไปใช้ที่จุดอื่น log เก่าของมันต้องไม่ถูกนับเป็นของจุดติดตั้งใหม่
--
-- ⚠️ เขียน SQL เองทั้งไฟล์ ไม่ได้ให้ prisma migrate dev generate เพราะ diff อัตโนมัติจะพ่วง
-- statement ทำลายล้าง 6 บรรทัดที่มาจาก divergence ที่ตั้งใจไว้ระหว่าง schema.prisma กับ DB จริง
-- (schema ประกาศ @id เดี่ยว แต่ DB ใช้ composite PK + time-partition index ของ TimescaleDB):
--   DROP INDEX "LogDayArchive_sendTime_idx" / "log_days_send_time_idx" / "notifications_create_at_idx"
--   ALTER TABLE log_day_archive/log_days/notifications DROP CONSTRAINT ..._pkey, ADD PRIMARY KEY ("id")
-- ทั้ง 6 บรรทัดถูกตัดออกโดยตั้งใจ — ถ้ารันจะทำให้ hypertable ทั้งสามพัง

-- ---------------------------------------------------------------------------
-- 1) ตาราง hardware + backfill จาก devices ที่มีอยู่
-- ---------------------------------------------------------------------------
CREATE TABLE "hardware" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "firmware" TEXT NOT NULL DEFAULT '1.0.0',
    "token" TEXT,
    "install_date" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hardware_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hardware_serial_key" ON "hardware"("serial");

-- ทุก device แถวเดิม = 1 กล่องที่ติดตั้งอยู่ ณ ตอนนี้
INSERT INTO "hardware" ("id", "serial", "firmware", "token", "install_date", "create_at", "update_at")
SELECT gen_random_uuid()::text, "serial", "firmware", "token", "install_date", "create_at", "update_at"
FROM "devices";

-- ---------------------------------------------------------------------------
-- 2) ตาราง device_assignments + backfill
-- ---------------------------------------------------------------------------
CREATE TABLE "device_assignments" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "reason" TEXT,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_assignments_pkey" PRIMARY KEY ("id")
);

-- backfill ตรง ๆ ได้เพราะยังไม่เคยมีการสลับเครื่องเกิดขึ้น (แต่ละ device มี assignment เดียว ที่ยังเปิดอยู่)
INSERT INTO "device_assignments" ("id", "device_id", "serial", "started_at", "reason")
SELECT gen_random_uuid()::text, "id", "serial", COALESCE("install_date", "create_at"), 'backfill'
FROM "devices";

CREATE INDEX "device_assignments_serial_started_at_idx" ON "device_assignments"("serial", "started_at");
CREATE INDEX "device_assignments_device_id_started_at_idx" ON "device_assignments"("device_id", "started_at");

-- กันสถานะกำกวม: กล่องหนึ่งติดตั้งอยู่ได้ที่เดียว และจุดติดตั้งหนึ่งมีกล่องเดียว ณ เวลาหนึ่ง
-- Prisma ประกาศ partial index ไม่ได้ จึงต้องอยู่ในไฟล์นี้เท่านั้น
CREATE UNIQUE INDEX "device_assignments_active_serial" ON "device_assignments"("serial") WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "device_assignments_active_device" ON "device_assignments"("device_id") WHERE "ended_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 3) ตัด FK เดิมที่ชี้ devices("serial") ออกก่อนย้ายปลายทาง
-- ---------------------------------------------------------------------------
ALTER TABLE "configs" DROP CONSTRAINT "configs_sn_fkey";
ALTER TABLE "probes" DROP CONSTRAINT "probes_sn_fkey";
ALTER TABLE "repairs" DROP CONSTRAINT "repairs_serial_fkey";
ALTER TABLE "warranties" DROP CONSTRAINT "warranties_serial_fkey";
ALTER TABLE "log_days" DROP CONSTRAINT "log_days_serial_fkey";
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_serial_fkey";

DROP INDEX "configs_sn_key";
DROP INDEX "probes_sn_idx";

-- ---------------------------------------------------------------------------
-- 4) configs/probes ย้ายไปผูกกับจุดติดตั้ง (devices.id)
--    ทั้งสองตารางยังว่าง (เพิ่งสร้างใน migration ก่อนหน้าและยังไม่มีโค้ดเขียนลงไป)
--    จึง DROP/ADD คอลัมน์ได้ตรง ๆ โดยไม่ต้อง backfill
-- ---------------------------------------------------------------------------
ALTER TABLE "configs" DROP COLUMN "sn", ADD COLUMN "device_id" TEXT NOT NULL;
ALTER TABLE "probes" DROP COLUMN "sn", ADD COLUMN "device_id" TEXT NOT NULL;

CREATE UNIQUE INDEX "configs_device_id_key" ON "configs"("device_id");
CREATE INDEX "probes_device_id_idx" ON "probes"("device_id");

-- ---------------------------------------------------------------------------
-- 5) log_days / notifications — ประทับ device_id
--    nullable โดยตั้งใจ: กล่องที่ยังไม่ถูกติดตั้งที่ไหนต้องยิง log เข้ามาเก็บได้
-- ---------------------------------------------------------------------------
ALTER TABLE "log_days" ADD COLUMN "device_id" TEXT;
ALTER TABLE "notifications" ADD COLUMN "device_id" TEXT;

-- backfill ตรง ๆ ผ่าน serial ได้เพราะยังไม่เคยสลับเครื่อง
UPDATE "log_days" l SET "device_id" = d."id" FROM "devices" d WHERE d."serial" = l."serial";
UPDATE "notifications" n SET "device_id" = d."id" FROM "devices" d WHERE d."serial" = n."serial";

CREATE INDEX "log_days_device_id_send_time_idx" ON "log_days"("device_id", "send_time");
CREATE INDEX "notifications_device_id_create_at_idx" ON "notifications"("device_id", "create_at");

-- ---------------------------------------------------------------------------
-- 6) devices — ย้ายฟิลด์ของกล่องออก, serial กลายเป็น pointer (nullable)
-- ---------------------------------------------------------------------------
ALTER TABLE "devices" DROP COLUMN "firmware", DROP COLUMN "install_date", DROP COLUMN "token";
ALTER TABLE "devices" ALTER COLUMN "serial" DROP NOT NULL;

-- static_name กลายเป็น identity ถาวรจึงต้อง unique — แต่ข้อมูลเดิมมีค่าซ้ำจาก fixtures
-- (DEV-001 กับ E2E-001 ต่างก็ชื่อ 'Fridge 1') เติม serial ต่อท้ายให้เฉพาะกลุ่มที่ซ้ำ
-- เพื่อให้สร้าง unique index ได้โดยไม่ต้องลบข้อมูล — deterministic เพราะ serial unique อยู่แล้ว
UPDATE "devices" d
SET "static_name" = d."static_name" || ' (' || d."serial" || ')'
WHERE EXISTS (
  SELECT 1 FROM "devices" o WHERE o."static_name" = d."static_name" AND o."id" <> d."id"
);

CREATE UNIQUE INDEX "devices_static_name_key" ON "devices"("static_name");

-- ---------------------------------------------------------------------------
-- 7) FK ปลายทางใหม่
-- ---------------------------------------------------------------------------
ALTER TABLE "devices" ADD CONSTRAINT "devices_serial_fkey" FOREIGN KEY ("serial") REFERENCES "hardware"("serial") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_serial_fkey" FOREIGN KEY ("serial") REFERENCES "hardware"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "configs" ADD CONSTRAINT "configs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "probes" ADD CONSTRAINT "probes_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repairs" ADD CONSTRAINT "repairs_serial_fkey" FOREIGN KEY ("serial") REFERENCES "hardware"("serial") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_serial_fkey" FOREIGN KEY ("serial") REFERENCES "hardware"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "log_days" ADD CONSTRAINT "log_days_serial_fkey" FOREIGN KEY ("serial") REFERENCES "hardware"("serial") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "log_days" ADD CONSTRAINT "log_days_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_serial_fkey" FOREIGN KEY ("serial") REFERENCES "hardware"("serial") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
