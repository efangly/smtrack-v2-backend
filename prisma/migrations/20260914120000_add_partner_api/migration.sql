-- Partner API (third-party read access to device metadata + time series by Box serial)
-- ดู docs/adr/0002-partner-api-keys-scope-by-box-serial.md สำหรับเหตุผลที่ scope ด้วย serial
-- ไม่ใช่ staticName
--
-- เขียนมือ (ไม่ใช้ prisma migrate diff) เพราะ dev DB นี้มี drift จาก TimescaleDB DDL
-- (hypertable composite PK) ที่ prisma diff มองไม่เห็นอยู่แล้ว จึงต่อท้ายรูปแบบเดียวกับ
-- migration อื่น ๆ ในโปรเจคที่เขียนมือ (เช่น device_audit)

-- CreateTable
CREATE TABLE "partner_api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "partner_api_keys_key_hash_key" ON "partner_api_keys"("key_hash");

-- CreateTable
CREATE TABLE "partner_api_key_devices" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_api_key_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "partner_api_key_devices_key_id_serial_key" ON "partner_api_key_devices"("key_id", "serial");

CREATE INDEX "partner_api_key_devices_key_id_idx" ON "partner_api_key_devices"("key_id");

ALTER TABLE "partner_api_key_devices" ADD CONSTRAINT "partner_api_key_devices_key_id_fkey"
    FOREIGN KEY ("key_id") REFERENCES "partner_api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "partner_api_request_logs" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "serial" TEXT,
    "path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_api_request_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "partner_api_request_logs_key_id_create_at_idx" ON "partner_api_request_logs"("key_id", "create_at");

ALTER TABLE "partner_api_request_logs" ADD CONSTRAINT "partner_api_request_logs_key_id_fkey"
    FOREIGN KEY ("key_id") REFERENCES "partner_api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
