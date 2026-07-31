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
  deviceAudit: {
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  probes: {
    create(args: { data: ProbeSeed & { deviceId: string } }): Promise<{ id: string }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  configs: {
    create(args: { data: ConfigSeed & { deviceId: string } }): Promise<{ id: string }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  repairs: {
    create(args: { data: RepairSeed }): Promise<{ id: string }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  warranties: {
    create(args: { data: WarrantySeed }): Promise<{ id: string }>;
    deleteMany(args: { where: object }): Promise<{ count: number }>;
  };
  userAudit: {
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

export interface ProbeSeed {
  name: string;
  channel: string;
}

export interface ConfigSeed {
  ssid: string;
}

export interface RepairSeed {
  serial: string;
  devName: string;
  detail: string;
}

export interface WarrantySeed {
  serial: string;
  devName: string;
  customerName: string;
}

/** e2e ทั้งหมด auth ด้วย bearerUser() ที่ actorId คงที่ (test/utils/auth.ts DEFAULT_USER.id) */
export const E2E_ACTOR_ID = 'e2e-user';

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
export function buildLogs(
  serial: string,
  hours: number,
  now = new Date(),
  channel = '1',
): LogSeed[] {
  // เลื่อนคลื่นตาม channel ให้ log ของแต่ละ probe มีค่าไม่เหมือนกัน — เทสจึงแยกเส้นออกจากกันได้จริง
  const phase = Number(channel) || 1;
  return Array.from({ length: hours }, (_, i) => {
    const sendTime = new Date(now.getTime() - i * 60 * 60 * 1000);
    // temp เดินเป็นคลื่นในช่วง 2..8 °C ให้ avg/min/max ต่างกันจริง ตรวจสอบได้
    const temp = Number((5 + 3 * Math.sin(i / 3 + phase)).toFixed(2));
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
      probe: channel,
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

/**
 * ประทับ probeId ให้ log ที่ insert ตรง ๆ — ด้วยเหตุผลเดียวกับ withDeviceId
 * ปกติ TelemetryService.ingest resolve channel → probeId ให้ แต่ createMany ข้ามขั้นนั้น
 * ทำให้ probe_id = NULL แล้ว graph จะเหมาโยนทุกแถวเข้า series `unassigned`
 */
export function withProbeId<T extends object>(
  rows: T[],
  probeId: string,
): (T & { probeId: string })[] {
  return rows.map((row) => ({ ...row, probeId }));
}

export function buildNotifications(serial: string): NotificationSeed[] {
  return [
    { serial, message: 'Temperature high', detail: 'temp 8.5C exceeded threshold' },
    { serial, message: 'Door opened', detail: 'door1 opened for 5 minutes' },
    { serial, message: 'Power restored', detail: 'plug reconnected' },
  ];
}

/** สร้าง probe ผูกกับ deviceId ที่ได้จาก seedDevice() */
export function seedProbe(
  prisma: SeedablePrisma,
  deviceId: string,
  seed: ProbeSeed = { name: 'P1', channel: '1' },
): Promise<{ id: string }> {
  return prisma.probes.create({ data: { ...seed, deviceId } });
}

/** สร้าง config ผูกกับ deviceId ที่ได้จาก seedDevice() (deviceId เป็น unique key) */
export function seedConfig(
  prisma: SeedablePrisma,
  deviceId: string,
  seed: ConfigSeed = { ssid: 'RDE3_2.4GHz' },
): Promise<{ id: string }> {
  return prisma.configs.create({ data: { ...seed, deviceId } });
}

/** สร้างรายการซ่อมผูกกับ serial ของกล่อง (ต้องมี hardware แถวนั้นอยู่ก่อน — ผ่าน seedDevice/seedHardware) */
export function seedRepair(prisma: SeedablePrisma, seed: RepairSeed): Promise<{ id: string }> {
  return prisma.repairs.create({ data: seed });
}

/** สร้างรายการประกันผูกกับ serial ของกล่อง (ต้องมี hardware แถวนั้นอยู่ก่อน — ผ่าน seedDevice/seedHardware) */
export function seedWarranty(prisma: SeedablePrisma, seed: WarrantySeed): Promise<{ id: string }> {
  return prisma.warranties.create({ data: seed });
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
  const deviceWhere = {
    OR: [{ serial: { startsWith: prefix } }, { staticName: { startsWith: prefix } }],
  };
  const logs = await prisma.logDays.deleteMany({ where });
  const notifications = await prisma.notifications.deleteMany({ where });
  await prisma.deviceAssignments.deleteMany({ where });
  await prisma.deviceAudit.deleteMany({ where: { staticName: { startsWith: prefix } } });
  // probes/configs ผูก FK กับ devices.id ต้องลบก่อน devices เสมอ
  await prisma.probes.deleteMany({ where: { device: deviceWhere } });
  await prisma.configs.deleteMany({ where: { device: deviceWhere } });
  const devices = await prisma.devices.deleteMany({ where: deviceWhere });
  // repairs/warranties ผูก FK กับ hardware.serial ต้องลบก่อน hardware เสมอ
  await prisma.repairs.deleteMany({ where });
  await prisma.warranties.deleteMany({ where });
  await prisma.hardware.deleteMany({ where });
  // user_audit ไม่มี FK ไป entity ใด ๆ (จงใจ เหมือน device_audit) จึง scope ด้วย actorId คงที่ของ e2e แทน
  await prisma.userAudit.deleteMany({ where: { actorId: E2E_ACTOR_ID } });
  return { logs: logs.count, notifications: notifications.count, devices: devices.count };
}
