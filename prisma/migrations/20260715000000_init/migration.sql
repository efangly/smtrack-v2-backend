-- Enable TimescaleDB extension (must be installed in the PostgreSQL server)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- CreateTable
CREATE TABLE "Devices" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "ward" TEXT NOT NULL,
    "hospital" TEXT NOT NULL,
    "staticName" TEXT NOT NULL,
    "name" TEXT,
    "status" BOOLEAN NOT NULL,
    "seq" INTEGER NOT NULL,
    "firmware" TEXT NOT NULL,
    "remark" TEXT,
    "position" TEXT,
    "positionPic" TEXT,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "createAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogDays" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "temp" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "tempDisplay" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "humidity" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "humidityDisplay" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "sendTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plug" BOOLEAN NOT NULL DEFAULT false,
    "door1" BOOLEAN NOT NULL DEFAULT false,
    "door2" BOOLEAN NOT NULL DEFAULT false,
    "door3" BOOLEAN NOT NULL DEFAULT false,
    "internet" BOOLEAN NOT NULL DEFAULT false,
    "probe" TEXT NOT NULL DEFAULT '1',
    "battery" INTEGER NOT NULL DEFAULT 0,
    "tempInternal" DOUBLE PRECISION DEFAULT 0.00,
    "extMemory" BOOLEAN NOT NULL DEFAULT false,
    "createAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogDays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notifications" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" BOOLEAN NOT NULL DEFAULT false,
    "deliveredSse" BOOLEAN NOT NULL DEFAULT false,
    "deliveredFcm" BOOLEAN NOT NULL DEFAULT false,
    "createAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTokens" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fcmToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationTokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Devices_serial_key" ON "Devices"("serial");

-- CreateIndex
CREATE INDEX "LogDays_serial_sendTime_idx" ON "LogDays"("serial", "sendTime");

-- CreateIndex
CREATE INDEX "Notifications_serial_createAt_idx" ON "Notifications"("serial", "createAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTokens_fcmToken_key" ON "NotificationTokens"("fcmToken");

-- CreateIndex
CREATE INDEX "NotificationTokens_serial_idx" ON "NotificationTokens"("serial");

-- AddForeignKey
ALTER TABLE "LogDays" ADD CONSTRAINT "LogDays_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Devices"("serial") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Devices"("serial") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTokens" ADD CONSTRAINT "NotificationTokens_serial_fkey" FOREIGN KEY ("serial") REFERENCES "Devices"("serial") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Convert LogDays into a TimescaleDB hypertable on sendTime.
-- NOTE: the primary key must include the partitioning column for hypertables,
-- so we replace the single-column PK with a composite (id, sendTime) PK.
ALTER TABLE "LogDays" DROP CONSTRAINT "LogDays_pkey";
ALTER TABLE "LogDays" ADD CONSTRAINT "LogDays_pkey" PRIMARY KEY ("id", "sendTime");
SELECT create_hypertable('"LogDays"', 'sendTime', migrate_data => true);
