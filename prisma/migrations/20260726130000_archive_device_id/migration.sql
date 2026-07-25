-- log_day_archive เป็นปลายทาง restore ของ log_days จึงต้องมีคอลัมน์ครบเท่ากัน
-- ไม่งั้น COPY ตอน restore ไฟล์ที่ export หลังจากนี้ (ซึ่งมี device_id) จะล้ม
--
-- ไม่ผูก FK ไป devices ด้วยเหตุผลเดียวกับที่ตารางนี้ไม่ผูก serial:
-- ข้อมูล archive ต้องอ่านได้ต่อแม้จุดติดตั้งถูกลบไปแล้ว
ALTER TABLE "log_day_archive" ADD COLUMN "device_id" TEXT;

CREATE INDEX "log_day_archive_device_id_send_time_idx" ON "log_day_archive"("device_id", "send_time");
