-- log_day_archive เป็นปลายทาง restore ของ log_days จึงต้องมีคอลัมน์ครบเท่ากัน
-- ไม่งั้น COPY ตอน restore ไฟล์ที่ export หลังจากนี้ (ซึ่งมี probe_id) จะล้ม
--
-- ไม่ผูก FK ไป probes ด้วยเหตุผลเดียวกับที่ตารางนี้ไม่ผูก serial/device_id:
-- ข้อมูล archive ต้องอ่านได้ต่อแม้ probe ถูกลบไปแล้ว
ALTER TABLE "log_day_archive" ADD COLUMN "probe_id" TEXT;

-- ⚠️ ตารางนี้เปิด compression ไว้ (compress_segmentby='serial', policy 3 วัน)
-- precedent 20260726130000_archive_device_id ไม่ต้องคลายบีบ เพราะทำแค่ ADD COLUMN + CREATE INDEX
-- ซึ่งถูกกฎบน compressed chunk — แต่รอบนี้ต้อง UPDATE ด้วย จึงต้องคลายบีบก่อน
--
-- ถ้า TimescaleDB < 2.11 บล็อก decompress_chunk ใน transaction block (Prisma ครอบทุกไฟล์
-- migration ไว้) ให้ตัด DO block กับ remove/add policy ออก แล้วรัน backfill ผ่าน
-- scripts/backfill-archive-probe-id.ts (idempotent, commit ต่อ chunk) ภายหลัง
-- อีกทางที่ใช้ได้เสมอ: removeMonth + restoreMonth ซ้ำหลัง export ใหม่มี probe_id แล้ว
SELECT remove_compression_policy('log_day_archive', if_exists => true);

DO $$
DECLARE c regclass;
BEGIN
  -- 1) คลายบีบเฉพาะ chunk ที่ถูกบีบอยู่จริง
  FOR c IN SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
             FROM timescaledb_information.chunks
            WHERE hypertable_name = 'log_day_archive' AND is_compressed LOOP
    PERFORM decompress_chunk(c);
  END LOOP;

  -- 2) backfill ทีละ chunk เหมือน log_days
  FOR c IN SELECT show_chunks('log_day_archive') LOOP
    EXECUTE format(
      'UPDATE %s l SET "probe_id" = p."id"
         FROM "probes" p
        WHERE p."device_id" = l."device_id"
          AND p."channel"   = l."probe"
          AND l."device_id" IS NOT NULL
          AND l."probe_id"  IS NULL', c);
  END LOOP;
END $$;

CREATE INDEX "log_day_archive_device_id_probe_id_send_time_idx"
  ON "log_day_archive"("device_id", "probe_id", "send_time");

-- คืน policy เดิม โดยไม่แตะ compress_segmentby/orderby
-- ไม่เพิ่ม probe_id เข้า segmentby: เป็น UUID จะทำให้ compressed batch แตกเป็น 1-4 เท่าต่อ serial
-- และ compression ratio แย่ลง — segment ด้วย serial + index ใหม่พอสำหรับ query ระดับ report
--
-- ไม่เรียก compress_chunk เองในนี้ ปล่อยให้ background job ทยอยบีบกลับ
-- ไม่งั้น migration จะกินเวลา/ดิสก์เท่ากับ recompress ทั้งตารางใน transaction เดียว
SELECT add_compression_policy('log_day_archive', INTERVAL '3 days');

-- view ต้องเปิด device_id + probe_id ให้ report ที่คร่อม retention boundary ใช้ได้
-- (ของเดิมไม่มี device_id เลย ตกไปตอน 20260726130000 เพิ่มคอลัมน์)
DROP VIEW "log_days_all";
CREATE VIEW "log_days_all" AS
  SELECT "id", "serial", "temp", "temp_display", "humidity", "humidity_display", "send_time",
         "plug", "door1", "door2", "door3", "internet", "probe", "battery", "temp_internal",
         "ext_memory", "device_id", "probe_id", "create_at", "update_at"
  FROM "log_days"
  UNION ALL
  SELECT "id", "serial", "temp", "temp_display", "humidity", "humidity_display", "send_time",
         "plug", "door1", "door2", "door3", "internet", "probe", "battery", "temp_internal",
         "ext_memory", "device_id", "probe_id", "create_at", "update_at"
  FROM "log_day_archive";
