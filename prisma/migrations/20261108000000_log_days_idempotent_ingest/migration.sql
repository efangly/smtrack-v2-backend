-- ทำให้ ingest log เป็น idempotent: (serial, probe, send_time) ซ้ำได้ไม่เกินหนึ่งแถว
-- เหตุผล: MQTT QoS 1 redeliver ได้ และ legacy sync (ADR-0007) จะมีช่วงที่ backfill กับ consume ทับกัน
--
-- เขียนมือ ไม่ได้ generate ด้วย `prisma migrate dev` เพราะ diff อัตโนมัติจะพ่วงคำสั่ง
-- DROP/ADD PRIMARY KEY ของ hypertable มาด้วย (ดูหมายเหตุใน 20260726000000_add_device_management_models)
--
-- unique index ของ hypertable ต้องมี partition column (send_time) อยู่ใน key — เงื่อนไขนี้ผ่าน

-- 1) ลบแถวซ้ำที่อาจมีอยู่แล้ว เก็บแถวที่ถูกบันทึกก่อนสุดไว้ (create_at, id น้อยสุด)
DELETE FROM "log_days" l
USING (
  SELECT "id", "send_time"
  FROM (
    SELECT "id", "send_time",
           row_number() OVER (
             PARTITION BY "serial", "probe", "send_time"
             ORDER BY "create_at", "id"
           ) AS rn
    FROM "log_days"
  ) ranked
  WHERE ranked.rn > 1
) dup
WHERE l."id" = dup."id" AND l."send_time" = dup."send_time";

-- 2) unique index
CREATE UNIQUE INDEX "log_days_serial_probe_send_time_key"
  ON "log_days" ("serial", "probe", "send_time");
