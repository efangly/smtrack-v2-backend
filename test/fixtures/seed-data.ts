/**
 * Dataset กลางใช้ร่วมกันระหว่าง dev seed (prisma/seed.ts) และ e2e test
 *
 * ⚠️ DATABASE_URL ชี้ไปฐานข้อมูลที่ใช้ร่วมกัน (demo server) — ทุกแถวที่สร้างจากไฟล์นี้
 * ต้องมี serial ขึ้นต้นด้วย prefix เสมอ และการลบต้อง scope ด้วย prefix เท่านั้น
 * ห้าม TRUNCATE / deleteMany({}) เด็ดขาด
 */

export const E2E_PREFIX = 'E2E-';
export const DEV_PREFIX = 'DEV-';

/** interface แคบ ๆ พอสำหรับงาน seed — รับได้ทั้ง PrismaService และ PrismaClient ดิบ */
export interface SeedablePrisma {
  devices: {
    create(args: { data: DeviceSeed }): Promise<unknown>;
    upsert(args: {
      where: { serial: string };
      update: object;
      create: DeviceSeed;
    }): Promise<unknown>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  logDays: {
    createMany(args: { data: LogSeed[] }): Promise<{ count: number }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  notifications: {
    createMany(args: { data: NotificationSeed[] }): Promise<{ count: number }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
}

export interface DeviceSeed {
  serial: string;
  ward: string;
  staticName: string;
  name: string;
  status: boolean;
  seq: number;
  firmware: string;
}

export interface LogSeed {
  serial: string;
  temp: number;
  tempDisplay: number;
  humidity: number;
  humidityDisplay: number;
  sendTime: Date;
  plug: boolean;
  door1: boolean;
  internet: boolean;
  probe: string;
  battery: number;
}

export interface NotificationSeed {
  serial: string;
  message: string;
  detail: string;
}

/** serial ที่ n ของ prefix — ใช้ pad เพื่อให้เรียงลำดับอ่านง่าย */
export const serialFor = (prefix: string, n: number): string =>
  `${prefix}${String(n).padStart(3, '0')}`;

export function buildDevices(prefix: string): DeviceSeed[] {
  return [1, 2, 3].map((n) => ({
    serial: serialFor(prefix, n),
    ward: n === 3 ? 'ICU' : 'OPD',
    staticName: `Fridge ${n}`,
    name: `${prefix}Fridge ${n}`,
    status: true,
    seq: n,
    firmware: '1.0.0',
  }));
}

/**
 * log ย้อนหลังทีละชั่วโมง — ต้องครอบคลุมหลายวันเพื่อให้ time_bucket ของ
 * logday (7 วัน) และ graph (24 ชม.) มีข้อมูลจริงให้ aggregate มากกว่า 1 bucket
 */
export function buildLogs(serial: string, hours: number, now = new Date()): LogSeed[] {
  return Array.from({ length: hours }, (_, i) => {
    const sendTime = new Date(now.getTime() - i * 60 * 60 * 1000);
    // temp เดินเป็นคลื่นในช่วง 2..8 °C ให้ avg/min/max ต่างกันจริง ตรวจสอบได้
    const temp = Number((5 + 3 * Math.sin(i / 3)).toFixed(2));
    return {
      serial,
      temp,
      tempDisplay: temp,
      humidity: Number((50 + 10 * Math.cos(i / 4)).toFixed(2)),
      humidityDisplay: 50,
      sendTime,
      plug: true,
      door1: i % 12 === 0,
      internet: true,
      probe: '1',
      battery: 100 - (i % 40),
    };
  });
}

export function buildNotifications(serial: string): NotificationSeed[] {
  return [
    { serial, message: 'Temperature high', detail: 'temp 8.5C exceeded threshold' },
    { serial, message: 'Door opened', detail: 'door1 opened for 5 minutes' },
    { serial, message: 'Power restored', detail: 'plug reconnected' },
  ];
}

/**
 * ลบเฉพาะแถวที่ serial ขึ้นต้นด้วย prefix ตามลำดับ FK (LogDays/Notifications → Devices)
 * ปลอดภัยกับข้อมูลจริงบน shared DB เพราะ scope ด้วย startsWith เสมอ
 */
export async function cleanupByPrefix(
  prisma: SeedablePrisma,
  prefix: string,
): Promise<{ logs: number; notifications: number; devices: number }> {
  if (!prefix) {
    throw new Error('cleanupByPrefix: prefix ว่างไม่ได้ — จะลบข้อมูลทั้งตาราง');
  }
  const where = { serial: { startsWith: prefix } };
  const logs = await prisma.logDays.deleteMany({ where });
  const notifications = await prisma.notifications.deleteMany({ where });
  const devices = await prisma.devices.deleteMany({ where });
  return { logs: logs.count, notifications: notifications.count, devices: devices.count };
}
