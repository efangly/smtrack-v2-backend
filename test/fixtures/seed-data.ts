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
    create(args: { data: DeviceFields }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: { serial: string } }): Promise<unknown>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  hardware: {
    upsert(args: {
      where: { serial: string };
      update: { firmware?: string };
      create: { serial: string; firmware?: string };
    }): Promise<unknown>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  deviceAssignments: {
    create(args: { data: { deviceId: string; serial: string; reason?: string } }): Promise<unknown>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  logDays: {
    createMany(args: { data: (LogSeed & { deviceId?: string })[] }): Promise<{ count: number }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  notifications: {
    createMany(args: {
      data: (NotificationSeed & { deviceId?: string })[];
    }): Promise<{ count: number }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
}

/** ฟิลด์ของ "จุดติดตั้ง" ล้วน ๆ — ไม่รวม serial/firmware ซึ่งเป็นของกล่อง */
export type DeviceFields = Omit<DeviceSeed, 'serial' | 'firmware'>;

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
    staticName: `${prefix}Fridge ${n}`,
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

/**
 * สร้างจุดติดตั้ง + กล่อง + assignment ให้ครบชุด
 *
 * ตั้งแต่แยก Devices/Hardware การ `devices.create()` เฉย ๆ ไม่พอแล้ว เพราะ LogDays.serial
 * เป็น FK ไป hardware และ ingest ต้อง resolve serial → deviceId ผ่าน assignment ที่เปิดอยู่
 */
export async function seedDevice(
  prisma: SeedablePrisma,
  seed: DeviceSeed,
): Promise<{ deviceId: string }> {
  const { serial, firmware, ...deviceFields } = seed;
  await prisma.hardware.upsert({
    where: { serial },
    update: { firmware },
    create: { serial, firmware },
  });
  const device = await prisma.devices.create({ data: deviceFields });
  await prisma.deviceAssignments.create({
    data: { deviceId: device.id, serial, reason: 'seed' },
  });
  await prisma.devices.update({ where: { id: device.id }, data: { serial } });
  return { deviceId: device.id };
}

/** สร้างกล่องเปล่าที่ยังไม่ถูกติดตั้งที่ไหน (ใช้ทดสอบเคสสลับเครื่อง) */
export async function seedHardware(prisma: SeedablePrisma, serial: string): Promise<void> {
  await prisma.hardware.upsert({
    where: { serial },
    update: {},
    create: { serial, firmware: '1.0.0' },
  });
}

/**
 * ประทับ deviceId ให้ log ที่จะ insert ลง DB ตรง ๆ (ไม่ผ่าน TelemetryService.ingest)
 *
 * ปกติ deviceId ถูกประทับตอน ingest แต่ fixture ที่ยิง createMany เข้า DB ตรง ๆ ข้ามขั้นนั้นไป
 * ถ้าไม่ประทับเอง แถวจะมี device_id = NULL แล้ว graph/logday (ซึ่ง query ด้วย device_id) จะไม่เห็น
 */
export function withDeviceId<T extends object>(
  rows: T[],
  deviceId: string,
): (T & { deviceId: string })[] {
  return rows.map((row) => ({ ...row, deviceId }));
}

export function buildNotifications(serial: string): NotificationSeed[] {
  return [
    { serial, message: 'Temperature high', detail: 'temp 8.5C exceeded threshold' },
    { serial, message: 'Door opened', detail: 'door1 opened for 5 minutes' },
    { serial, message: 'Power restored', detail: 'plug reconnected' },
  ];
}

/**
 * ลบเฉพาะแถวที่ขึ้นต้นด้วย prefix ตามลำดับ FK
 * log/notification → assignment → device → hardware
 *
 * ต้องลบ devices ด้วย staticName ด้วย ไม่ใช่แค่ serial เพราะจุดติดตั้งที่ถูกถอดกล่องออก
 * จะมี serial = null (เกิดขึ้นจริงในเทสสลับเครื่อง) ถ้ากรองด้วย serial อย่างเดียวจะเหลือขยะค้าง
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
  await prisma.deviceAssignments.deleteMany({ where });
  const devices = await prisma.devices.deleteMany({
    where: {
      OR: [{ serial: { startsWith: prefix } }, { staticName: { startsWith: prefix } }],
    },
  });
  await prisma.hardware.deleteMany({ where });
  return { logs: logs.count, notifications: notifications.count, devices: devices.count };
}
