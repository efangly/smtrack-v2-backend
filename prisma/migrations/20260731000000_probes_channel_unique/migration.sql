-- (device_id, channel) กลายเป็น business key สำหรับ resolve probe_id ตอน ingest จึงต้อง unique
--
-- ข้อมูลเดิมอาจมีค่าซ้ำอยู่แล้ว เพราะไม่เคยมี constraint กัน และ device.service.ts สร้าง probe
-- default ให้ทุก device ด้วย channel '1' — ถ้ามีใครยิง POST /devices/:id/probes โดยไม่ส่ง channel
-- ก็ได้ '1' ซ้ำอีกตัว จัดการก่อนสร้าง index แบบไม่ทำ config threshold ของใครหาย
-- (แนวเดียวกับที่ 20260726120000 จัดการ static_name ซ้ำ: แก้ค่าให้ไม่ชน ไม่ลบแถวที่มีข้อมูล)

-- 1) แถวที่ซ้ำ "ทุกคอลัมน์" ยกเว้น id/timestamp = ขยะจาก import ซ้ำ เก็บ id เล็กสุดไว้ตัวเดียว
DELETE FROM "probes" p
USING "probes" q
WHERE p."device_id" = q."device_id"
  AND p."channel" = q."channel"
  AND p."id" > q."id"
  AND (to_jsonb(p) - '{id,create_at,update_at}'::text[])
    = (to_jsonb(q) - '{id,create_at,update_at}'::text[]);

-- 2) ที่เหลือ (ซ้ำแต่ค่าต่าง = config คนละชุด ทิ้งไม่ได้) เก็บ "แถวใหม่สุด" ไว้ครองช่อง
--    เพราะแถวที่ถูกสร้าง/แก้ทีหลังคือ config ที่ใช้งานอยู่จริง ส่วนแถวเก่ามักเป็นของที่ import
--    มาจาก legacy แล้วไม่ได้ใช้ต่อ (ตรวจข้อมูลจริงแล้ว: แถวเก่าชื่อ 'SHT-31' = ชื่อ type
--    ซึ่งเป็น pattern ของ legacy import ส่วนแถวใหม่ชื่อ 'P1'/'TEST' = ที่ตั้งผ่าน v2)
--
--    แถวอื่นย้ายไป channel ที่ไม่ชน และตั้งใจให้ "ไม่ตรงกับ log_days.probe ใด ๆ"
--    จึงไม่ถูก backfill ไปผูกกับ log ผิดตัวใน migration ถัดไป — config ยังอ่านย้อนหลังได้ ไม่หาย
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "device_id", "channel" ORDER BY "create_at" DESC, "id" DESC
         ) AS rn
  FROM "probes"
)
UPDATE "probes" p
SET "channel" = p."channel" || '-dup' || r.rn
FROM ranked r
WHERE r."id" = p."id" AND r.rn > 1;

-- 3) ยังชนกันได้ถ้าข้อมูลเดิมมี channel ชื่อ '1-dup2' อยู่แล้ว — ตรวจแล้ว fail เสียงดัง
--    ดีกว่าให้ CREATE UNIQUE INDEX ล้มด้วย error ที่ไม่บอกว่าต้องไปแก้อะไร
DO $$
DECLARE dup_count int;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM "probes" GROUP BY "device_id", "channel" HAVING count(*) > 1
  ) s;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'ยังมี (device_id, channel) ซ้ำ % กลุ่มหลัง dedupe — แก้ด้วยมือก่อน migrate', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "probes_device_id_channel_key" ON "probes"("device_id", "channel");

-- index เดิมเป็น strict prefix ของ unique index ใหม่ → ซ้ำซ้อน ตัดออกเพื่อลดต้นทุนตอนเขียน
DROP INDEX "probes_device_id_idx";
