/*
  Warnings:

  - You are about to drop the column `hospital` on the `Devices` table. All the data in the column will be lost.
  - You are about to drop the `NotificationTokens` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "NotificationTokens" DROP CONSTRAINT "NotificationTokens_serial_fkey";

-- AlterTable
ALTER TABLE "Devices" DROP COLUMN "hospital";

-- DropTable
DROP TABLE "NotificationTokens";
