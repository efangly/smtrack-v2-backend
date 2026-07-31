import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { DeviceAssignmentService } from '../src/device/device-assignment.service';
import { API_PREFIX, createTestApp, unwrap } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import { buildDevices, buildLogs, cleanupByPrefix, seedDevice } from './fixtures/seed-data';

/**
 * เคสจริงที่เป็นต้นเหตุของการแยก Devices/Hardware:
 *
 * 1. อุปกรณ์พัง → เอากล่องใหม่มาแทน → config/probe เดิมต้องกลับมา
 *    และ telemetry ย้อนหลังของ "จุดติดตั้ง" ต้องยังต่อเนื่อง
 * 2. กล่องเก่าถูกส่งไปซ่อมแล้วนำไปใช้ที่จุดติดตั้งอื่น → log เก่าของกล่องนั้น
 *    ต้องไม่ถูกนับเป็นของจุดติดตั้งใหม่
 *
 * ข้อ 2 คือข้อที่พังถ้า resolve ประวัติด้วย serial เฉย ๆ จึงเป็นหัวใจของเทสชุดนี้
 */
const PREFIX = 'E2E-SWAP-';

describe('Device swap: แยกจุดติดตั้งออกจากกล่องฮาร์ดแวร์ (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let telemetry: TelemetryService;
  let assignments: DeviceAssignmentService;

  const oldBox = `${PREFIX}BOX-A`;
  const newBox = `${PREFIX}BOX-B`;

  let fridge: { deviceId: string; staticName: string };
  let spare: { deviceId: string; staticName: string };

  /** ingest ผ่าน service จริง เพื่อให้เดินผ่านขั้นตอน resolve+ประทับ deviceId เหมือน MQTT */
  const ingest = async (serial: string, temp: number): Promise<void> => {
    const log = buildLogs(serial, 1)[0];
    await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString(), temp });
  };

  const logCountFor = (deviceId: string): Promise<number> =>
    prisma.logDays.count({ where: { deviceId } });

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    telemetry = ctx.moduleRef.get(TelemetryService);
    assignments = ctx.moduleRef.get(DeviceAssignmentService);

    await cleanupByPrefix(prisma, PREFIX);

    const [first, second] = buildDevices(PREFIX);
    const a = await seedDevice(prisma, { ...first, serial: oldBox });
    fridge = { deviceId: a.deviceId, staticName: `${PREFIX}Fridge 1` };
    const b = await seedDevice(prisma, { ...second, serial: `${PREFIX}BOX-C` });
    spare = { deviceId: b.deviceId, staticName: `${PREFIX}Fridge 2` };
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, PREFIX);
    await app?.close();
  });

  it('ประทับ deviceId ให้ log ตอน ingest — ไม่ปล่อยเป็น NULL', async () => {
    await ingest(oldBox, 4.5);

    const log = await prisma.logDays.findFirst({
      where: { serial: oldBox },
      orderBy: { createAt: 'desc' },
    });
    expect(log!.deviceId).toBe(fridge.deviceId);
  });

  it('สลับกล่องแล้ว config/probe ของจุดติดตั้งยังอยู่ครบ (ความต้องการข้อ 1)', async () => {
    await prisma.configs.create({ data: { deviceId: fridge.deviceId, ip: '10.0.0.9' } });
    // probe channel '1' ถูก auto-provision ไปแล้วตอน ingest ของเทสก่อนหน้า จึงตั้ง threshold
    // ทับลงไปแทนการสร้างใหม่ (สร้างซ้ำจะชน unique (deviceId, channel))
    await prisma.probes.update({
      where: { deviceId_channel: { deviceId: fridge.deviceId, channel: '1' } },
      data: { name: 'P1', tempMin: 2, tempMax: 8 },
    });

    await ingest(oldBox, 5.5); // รวมเป็น 2 แถวก่อนสลับ
    await assignments.swapByStaticName(fridge.staticName, newBox, 'เครื่องเดิมพัง');

    const config = await prisma.configs.findUnique({ where: { deviceId: fridge.deviceId } });
    const probes = await prisma.probes.findMany({ where: { deviceId: fridge.deviceId } });
    expect(config!.ip).toBe('10.0.0.9');
    expect(probes).toHaveLength(1);
    expect(probes[0].tempMax).toBe(8);

    // pointer ของจุดติดตั้งชี้กล่องใหม่แล้ว
    const device = await prisma.devices.findUnique({ where: { id: fridge.deviceId } });
    expect(device!.serial).toBe(newBox);
  });

  it('telemetry ย้อนหลังต่อเนื่องข้ามการสลับเครื่อง (ความต้องการข้อ 1)', async () => {
    await ingest(newBox, 6.5);
    await ingest(newBox, 7.5);

    // 2 แถวจากกล่องเก่า + 2 แถวจากกล่องใหม่ = ประวัติของ "จุดติดตั้ง" ต้องเห็นครบ
    expect(await logCountFor(fridge.deviceId)).toBe(4);

    // และแยกตามกล่างได้ด้วยว่าแต่ละกล่องยิงมากี่แถว
    expect(await prisma.logDays.count({ where: { serial: oldBox } })).toBe(2);
    expect(await prisma.logDays.count({ where: { serial: newBox } })).toBe(2);
  });

  it('ปิด assignment เดิมและเปิดอันใหม่ ทำให้ประวัติการติดตั้งอ่านย้อนหลังได้', async () => {
    const history = await assignments.history(fridge.deviceId);

    expect(history).toHaveLength(2);
    expect(history[0].serial).toBe(newBox);
    expect(history[0].endedAt).toBeNull();
    expect(history[1].serial).toBe(oldBox);
    expect(history[1].endedAt).not.toBeNull();
  });

  /**
   * หัวใจของงานนี้ — เคสที่พังถ้าใช้ serial เป็น business key
   * กล่อง A ซ่อมเสร็จแล้วถูกนำไปติดตั้งที่จุดที่สอง จุดที่สองต้องเห็นเฉพาะ log ที่ยิงมา
   * "หลัง" ถูกติดตั้งที่นั่นเท่านั้น ไม่ใช่ 2 แถวเก่าที่กล่องนี้เคยยิงตอนอยู่จุดแรก
   */
  it('กล่องที่ซ่อมเสร็จแล้วย้ายไปจุดอื่น ไม่ลากประวัติเก่าติดไปด้วย (ความต้องการข้อ 2)', async () => {
    await assignments.swapByStaticName(spare.staticName, oldBox, 'ซ่อมเสร็จ นำไปใช้ที่จุดใหม่');
    await ingest(oldBox, 3.3);

    // จุดติดตั้งใหม่เห็นแค่แถวเดียวที่ยิงหลังย้ายมา
    expect(await logCountFor(spare.deviceId)).toBe(1);
    // จุดติดตั้งเดิมยังเก็บ 2 แถวเก่าของกล่อง A ไว้เหมือนเดิม รวมเป็น 4 เท่าเดิม
    expect(await logCountFor(fridge.deviceId)).toBe(4);
    // กล่อง A ยิงมาทั้งหมด 3 แถวตลอดอายุการใช้งาน แต่กระจายอยู่คนละจุดติดตั้ง
    expect(await prisma.logDays.count({ where: { serial: oldBox } })).toBe(3);
  });

  it('cache ของ serial ถูก invalidate ตอน swap — ไม่ประทับ deviceId เก่าต่อ', async () => {
    // ถ้า DeviceAssignmentService ลืมล้าง cache แถวนี้จะยังถูกประทับเป็น fridge
    const resolved = await assignments.resolveDeviceId(oldBox);
    expect(resolved).toBe(spare.deviceId);
  });

  it('GET /logday และ /graph รับ staticName ได้ และคืนประวัติของจุดติดตั้ง', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/logday/${encodeURIComponent(fridge.staticName)}`)
      .set('Authorization', bearerUser());

    expect(res.status).toBe(200);
    const total = unwrap(res.body).reduce(
      (sum: number, r: { samples: number }) => sum + Number(r.samples),
      0,
    );
    expect(total).toBe(4);
  });

  it('กล่องที่ยังไม่ถูกติดตั้งที่ไหน ยิง log เข้ามาได้ แต่ไม่ผูกกับจุดติดตั้งใด', async () => {
    const orphan = `${PREFIX}BOX-ORPHAN`;
    await prisma.hardware.create({ data: { serial: orphan } });

    await ingest(orphan, 9.9);

    const log = await prisma.logDays.findFirst({ where: { serial: orphan } });
    expect(log).not.toBeNull();
    expect(log!.deviceId).toBeNull();
    // ไม่มีจุดติดตั้ง = ไม่มี Probes ให้ผูก แต่ channel ดิบยังถูกเก็บไว้
    expect(log!.probeId).toBeNull();
    expect(log!.probe).toBe('1');
  });

  /**
   * probe ผูกกับ Devices.id (จุดติดตั้ง) ไม่ใช่ serial ของกล่อง — สลับกล่องแล้ว log ใหม่
   * จึงต้องผูก probe แถวเดิม ไม่ใช่ probe ใหม่ ไม่งั้นกราฟจะขาดเป็นสองเส้นตรงจุดที่สลับเครื่อง
   */
  it('สลับกล่องแล้ว log ใหม่ยังผูก probe แถวเดิมของจุดติดตั้ง', async () => {
    const probe = await prisma.probes.findUniqueOrThrow({
      where: { deviceId_channel: { deviceId: fridge.deviceId, channel: '1' } },
    });

    const logs = await prisma.logDays.findMany({
      where: { deviceId: fridge.deviceId },
      select: { serial: true, probeId: true },
    });

    // ทั้ง 4 แถว (2 จากกล่องเก่า + 2 จากกล่องใหม่) ชี้ probe เดียวกัน
    expect(logs).toHaveLength(4);
    expect(new Set(logs.map((l) => l.probeId))).toEqual(new Set([probe.id]));
    expect(new Set(logs.map((l) => l.serial))).toEqual(new Set([oldBox, newBox]));
  });
});
