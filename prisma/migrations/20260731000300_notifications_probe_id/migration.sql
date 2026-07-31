-- การแจ้งเตือนเกิดจาก threshold ของ probe (Probes.temp_min/temp_max) โดยธรรมชาติ
-- เมื่อ 1 device มีหลาย probe การแจ้งเตือนที่ไม่บอกว่า probe ไหนใช้งานไม่ได้
--
-- notifications เป็น hypertable บน create_at อยู่แล้ว (20260720150000) แต่ไม่ได้เปิด compression
-- จึงไม่ต้องคลายบีบเหมือน log_day_archive
ALTER TABLE "notifications" ADD COLUMN "probe_id" TEXT;
ALTER TABLE "notifications" ADD COLUMN "probe" TEXT;

-- ไม่ backfill: notification เดิมไม่มี channel เก็บไว้เลย (ไม่มีคอลัมน์ probe มาก่อน)
-- จึงไม่มีข้อมูลให้ match — เดาจาก message ไม่ได้เพราะรูปแบบไม่การันตี
-- แถวเก่าจึงเป็น NULL ทั้งหมดโดยเจตนา ต่างจาก log_days ที่ backfill ได้จาก log_days.probe

-- ON DELETE SET NULL ให้สอดคล้องกับ log_days_probe_id_fkey และ notifications_device_id_fkey
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_probe_id_fkey" FOREIGN KEY ("probe_id")
  REFERENCES "probes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "notifications_probe_id_create_at_idx"
  ON "notifications"("probe_id", "create_at");
