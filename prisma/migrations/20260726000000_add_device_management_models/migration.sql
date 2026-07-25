-- นำ model ฝั่ง device management จาก smtrack-device เข้ามา: Probes, Configs, Repairs, Warranties + enum Day
-- และเพิ่มฟิลด์ใหม่ของ Devices (location, install_date, tag, token) พร้อม default ตาม upstream
--
-- migration นี้เขียนมือ ไม่ได้ให้ `prisma migrate dev` generate ให้ เพราะ diff อัตโนมัติจะพ่วง
-- statement ทำลายล้างมาด้วย 6 บรรทัด ซึ่งมาจาก divergence ที่ตั้งใจไว้ระหว่าง schema.prisma กับ DB จริง
-- (schema ประกาศ @id เดี่ยว แต่ DB ใช้ composite PK + time-partition index ของ TimescaleDB):
--   DROP INDEX "LogDayArchive_sendTime_idx" / "log_days_send_time_idx" / "notifications_create_at_idx"
--   ALTER TABLE log_day_archive/log_days/notifications DROP CONSTRAINT ..._pkey, ADD PRIMARY KEY ("id")
-- ทั้ง 6 บรรทัดถูกตัดออกโดยตั้งใจ — ถ้ารันจะทำให้ hypertable ทั้งสามพัง
-- migration นี้จึงมีแต่ CREATE TYPE / CREATE TABLE / ADD COLUMN / SET DEFAULT ซึ่งเป็น additive ล้วน

-- CreateEnum
CREATE TYPE "Day" AS ENUM ('OFF', 'ALL', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN');

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "install_date" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "tag" TEXT,
ADD COLUMN     "token" TEXT,
ALTER COLUMN "ward" SET DEFAULT 'WID-DEVELOPMENT',
ALTER COLUMN "status" SET DEFAULT false,
ALTER COLUMN "firmware" SET DEFAULT '1.0.0';

-- CreateTable
CREATE TABLE "probes" (
    "id" TEXT NOT NULL,
    "sn" TEXT NOT NULL,
    "name" TEXT DEFAULT 'P1',
    "type" TEXT DEFAULT 'SHT-31',
    "channel" TEXT NOT NULL DEFAULT '1',
    "temp_min" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "temp_max" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "humi_min" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "humi_max" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "temp_adj" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "humi_adj" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "stamp_time" TEXT DEFAULT '5',
    "door_qty" INTEGER NOT NULL DEFAULT 1,
    "position" TEXT,
    "mute_alarm_duration" TEXT,
    "door_sound" BOOLEAN NOT NULL DEFAULT true,
    "door_alarm_time" TEXT,
    "mute_door_alarm_duration" TEXT,
    "noti_delay" INTEGER NOT NULL DEFAULT 0,
    "noti_to_normal" BOOLEAN NOT NULL DEFAULT true,
    "noti_mobile" BOOLEAN NOT NULL DEFAULT true,
    "noti_repeat" INTEGER NOT NULL DEFAULT 1,
    "first_day" "Day" NOT NULL DEFAULT 'OFF',
    "second_day" "Day" NOT NULL DEFAULT 'OFF',
    "third_day" "Day" NOT NULL DEFAULT 'OFF',
    "first_time" TEXT DEFAULT '0000',
    "second_time" TEXT DEFAULT '0000',
    "third_time" TEXT DEFAULT '0000',
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "probes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configs" (
    "id" TEXT NOT NULL,
    "sn" TEXT NOT NULL,
    "dhcp" BOOLEAN NOT NULL DEFAULT true,
    "ip" TEXT,
    "mac" TEXT,
    "subnet" TEXT,
    "gateway" TEXT,
    "dns" TEXT,
    "dhcp_eth" BOOLEAN DEFAULT true,
    "ip_eth" TEXT,
    "mac_eth" TEXT,
    "subnet_eth" TEXT,
    "gateway_eth" TEXT,
    "dns_eth" TEXT,
    "ssid" TEXT DEFAULT 'RDE3_2.4GHz',
    "password" TEXT,
    "sim_sp" TEXT,
    "email1" TEXT,
    "email2" TEXT,
    "email3" TEXT,
    "hard_reset" TEXT DEFAULT '0200',
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repairs" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "serial" TEXT NOT NULL,
    "dev_name" TEXT,
    "info" TEXT,
    "info1" TEXT,
    "info2" TEXT,
    "address" TEXT,
    "ward" TEXT,
    "detail" TEXT,
    "phone" TEXT,
    "status" TEXT,
    "warranty_status" TEXT,
    "remark" TEXT,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranties" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "dev_name" TEXT,
    "product" TEXT,
    "model" TEXT,
    "install_date" TEXT,
    "customer_name" TEXT,
    "customer_address" TEXT,
    "sale_department" TEXT,
    "invoice" TEXT,
    "expire" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "create_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warranties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "probes_sn_idx" ON "probes"("sn");

-- CreateIndex
CREATE UNIQUE INDEX "configs_sn_key" ON "configs"("sn");

-- CreateIndex
CREATE UNIQUE INDEX "repairs_seq_key" ON "repairs"("seq");

-- CreateIndex
CREATE INDEX "repairs_serial_idx" ON "repairs"("serial");

-- CreateIndex
CREATE INDEX "warranties_serial_idx" ON "warranties"("serial");

-- AddForeignKey
ALTER TABLE "probes" ADD CONSTRAINT "probes_sn_fkey" FOREIGN KEY ("sn") REFERENCES "devices"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configs" ADD CONSTRAINT "configs_sn_fkey" FOREIGN KEY ("sn") REFERENCES "devices"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_serial_fkey" FOREIGN KEY ("serial") REFERENCES "devices"("serial") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_serial_fkey" FOREIGN KEY ("serial") REFERENCES "devices"("serial") ON DELETE CASCADE ON UPDATE CASCADE;
