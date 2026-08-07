-- dashboard ต้องการ unread count ที่ persistent (ตอนนี้เป็นแค่ตัวนับใน session ฝั่ง frontend)
-- และ category/severity แบบ structured แทนการ parse message string ซ้ำทุกที่ (backend + frontend)
--
-- notifications เป็น hypertable บน create_at อยู่แล้ว (20260720150000) ไม่ได้เปิด compression
-- จึงเพิ่มคอลัมน์ตรง ๆ ได้เหมือน 20260731000300_notifications_probe_id

ALTER TABLE "notifications" ADD COLUMN "is_read" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notifications" ADD COLUMN "read_at" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'OTHER';
ALTER TABLE "notifications" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info';

CREATE INDEX "notifications_device_id_is_read_idx" ON "notifications"("device_id", "is_read");

-- backfill category/severity ของแถวเก่าด้วย logic เดียวกับ notification-classifier.util.ts
-- (มิเช่นนั้นข้อมูลเก่าทั้งหมดจะค้างเป็น OTHER/info)
UPDATE "notifications" SET
  "category" = CASE
    WHEN split_part("message", '/', 1) = 'SD' AND split_part("message", '/', 2) = 'OFF' THEN 'SDCARD'
    WHEN split_part("message", '/', 1) = 'AC' AND split_part("message", '/', 2) = 'OFF' THEN 'PLUG'
    WHEN split_part("message", '/', 1) = 'INTERNET' AND split_part("message", '/', 2) = 'OFF' THEN 'INTERNET'
    WHEN split_part("message", '/', 2) = 'TEMP' AND split_part("message", '/', 3) IN ('OVER', 'LOWER') THEN 'TEMP'
    WHEN split_part("message", '/', 3) = 'ON' THEN 'DOOR'
    WHEN "message" LIKE '%REPORT%' THEN 'REPORT'
    ELSE 'OTHER'
  END,
  "severity" = CASE
    WHEN split_part("message", '/', 2) = 'TEMP' AND split_part("message", '/', 3) IN ('OVER', 'LOWER') THEN 'critical'
    WHEN split_part("message", '/', 1) IN ('SD', 'AC', 'INTERNET') AND split_part("message", '/', 2) = 'OFF' THEN 'warning'
    WHEN split_part("message", '/', 3) = 'ON' THEN 'warning'
    ELSE 'info'
  END;
