-- ผูก log แต่ละแถวกับ probe เชิงตรรกะ (device -> probe -> logdays) ไม่ใช่แค่สตริง channel
--
-- ก่อนหน้านี้ log_days.probe เป็น String ลอย ๆ ไม่มี relation ทำให้ query แยกเส้นกราฟต่อ probe
-- และ rollup ต่อ probe ทำไม่ได้ (avg เฉลี่ยข้ามทุก probe ของ device ซึ่งไม่มีความหมาย)
--
-- nullable โดยเจตนา ด้วยเหตุผลเดียวกับ device_id: กล่องที่ยังไม่ถูกติดตั้งที่จุดไหน
-- (เพิ่งซ่อมเสร็จ/อยู่ในคลัง) ไม่มี Probes ให้ผูก แต่ยังต้องเก็บ log ได้ ไม่ reject
ALTER TABLE "log_days" ADD COLUMN "probe_id" TEXT;

-- backfill ทีละ chunk (chunk = 1 เดือน) ไม่ยิง UPDATE ก้อนเดียวทั้ง hypertable
-- เพื่อไม่ให้ plan เดียวไป lock ทุก chunk พร้อมกันและ WAL พุ่งทีเดียว
DO $$
DECLARE c regclass;
BEGIN
  FOR c IN SELECT show_chunks('log_days') LOOP
    EXECUTE format(
      'UPDATE %s l SET "probe_id" = p."id"
         FROM "probes" p
        WHERE p."device_id" = l."device_id"
          AND p."channel"   = l."probe"
          AND l."device_id" IS NOT NULL
          AND l."probe_id"  IS NULL', c);
  END LOOP;
END $$;

-- ON DELETE SET NULL (ไม่ใช่ RESTRICT) — probes cascade-delete จาก devices อยู่แล้ว
-- ถ้าเป็น RESTRICT การลบ device ที่มี telemetry จะล้มทันที (พังทั้ง prod และ cleanupByPrefix ใน e2e)
-- ⚠️ แลกมาด้วย write amplification: ลบ probe 1 ตัว = rewrite ทุกแถวที่อ้างถึงข้ามทุก chunk
--    ยอมรับได้ที่ retention 6 เดือน แต่อย่าลบ probe เป็นชุดใหญ่ตอน peak
ALTER TABLE "log_days"
  ADD CONSTRAINT "log_days_probe_id_fkey" FOREIGN KEY ("probe_id")
  REFERENCES "probes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- กราฟหลายเส้น: filter device_id + ช่วงเวลา แล้วแยกเส้นตาม probe
CREATE INDEX "log_days_device_id_probe_id_send_time_idx"
  ON "log_days"("device_id", "probe_id", "send_time");

-- ไม่ drop log_days_device_id_send_time_idx: index ใหม่มี probe_id คั่นกลาง
-- จึง serve query "device_id + ช่วงเวลา" เดิมไม่ได้ (Postgres ไม่มี btree skip scan)
