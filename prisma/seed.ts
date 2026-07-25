import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  DEV_PREFIX,
  buildDevices,
  buildLogs,
  buildNotifications,
  cleanupByPrefix,
  seedDevice,
  withDeviceId,
} from '../test/fixtures/seed-data';

/**
 * Dev seed — ใส่ข้อมูลตัวอย่างให้หน้าเว็บ/กราฟมีของดู
 *
 * ใช้ prefix DEV- แยกจาก E2E- ที่เทสใช้ เพื่อไม่ให้ cleanup ของ e2e ลบข้อมูล dev ทิ้ง
 * เป็น idempotent: รันซ้ำได้ ล้างของ prefix ตัวเองก่อนแล้วใส่ใหม่
 */
async function main(): Promise<void> {
  // Prisma 7 เป็น Rust-free — ต้องต่อผ่าน driver adapter เหมือน PrismaService
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const removed = await cleanupByPrefix(prisma, DEV_PREFIX);
    console.log(
      `ล้างข้อมูล ${DEV_PREFIX} เดิม: logs=${removed.logs} notifications=${removed.notifications} devices=${removed.devices}`,
    );

    const devices = buildDevices(DEV_PREFIX);
    const deviceIds: string[] = [];
    for (const device of devices) {
      const { deviceId } = await seedDevice(prisma, device);
      deviceIds.push(deviceId);
    }
    console.log(`สร้าง devices: ${devices.map((d) => d.serial).join(', ')}`);

    // device ตัวแรกมี log ย้อนหลัง 7 วัน (กราฟ/logday มีของดู), ตัวที่สองย้อนหลัง 24 ชม.
    const logPlan: Array<[string, string, number]> = [
      [devices[0].serial, deviceIds[0], 24 * 7],
      [devices[1].serial, deviceIds[1], 24],
    ];
    for (const [serial, deviceId, hours] of logPlan) {
      const { count } = await prisma.logDays.createMany({
        data: withDeviceId(buildLogs(serial, hours), deviceId),
      });
      console.log(`สร้าง logs ${serial}: ${count} แถว`);
    }

    const { count } = await prisma.notifications.createMany({
      data: withDeviceId(buildNotifications(devices[0].serial), deviceIds[0]),
    });
    console.log(`สร้าง notifications ${devices[0].serial}: ${count} แถว`);
    console.log('seed เสร็จเรียบร้อย');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('seed ล้มเหลว:', err);
  process.exit(1);
});
