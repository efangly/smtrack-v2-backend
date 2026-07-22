import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  DEV_PREFIX,
  buildDevices,
  buildLogs,
  buildNotifications,
  cleanupByPrefix,
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
    for (const device of devices) {
      await prisma.devices.upsert({
        where: { serial: device.serial },
        update: device,
        create: device,
      });
    }
    console.log(`สร้าง devices: ${devices.map((d) => d.serial).join(', ')}`);

    // device ตัวแรกมี log ย้อนหลัง 7 วัน (กราฟ/logday มีของดู), ตัวที่สองย้อนหลัง 24 ชม.
    const logPlan: Array<[string, number]> = [
      [devices[0].serial, 24 * 7],
      [devices[1].serial, 24],
    ];
    for (const [serial, hours] of logPlan) {
      const { count } = await prisma.logDays.createMany({ data: buildLogs(serial, hours) });
      console.log(`สร้าง logs ${serial}: ${count} แถว`);
    }

    const { count } = await prisma.notifications.createMany({
      data: buildNotifications(devices[0].serial),
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
