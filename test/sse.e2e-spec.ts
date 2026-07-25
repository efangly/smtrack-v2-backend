import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AddressInfo } from 'net';
import { DeviceService } from '../src/device/device.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { API_PREFIX, createTestApp } from './utils/create-test-app';
import { bearerDevice, bearerUser, tokenUser } from './utils/auth';
import { SseClient } from './utils/sse-client';
import {
  E2E_PREFIX,
  buildDevices,
  buildLogs,
  cleanupByPrefix,
  seedDevice,
  serialFor,
} from './fixtures/seed-data';

/**
 * พิสูจน์ทางเดินจริง: HTTP/MQTT → service → DB → EventEmitter2 → SseService → @Sse() endpoint
 * เป็นจุดเดียวที่ยืนยันว่า real-time push ถึง client ได้จริง ไม่ใช่แค่ Subject ทำงานใน unit test
 */
describe('SSE streams (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let telemetry: TelemetryService;
  let devices: DeviceService;
  let port: number;
  const clients: SseClient[] = [];

  // device ตัวที่ 1 อยู่ ward OPD ตรงกับ ward ของ token default ใน test/utils/auth
  const serial = serialFor(E2E_PREFIX, 1);

  /** stream ทุกเส้นต้องมี token — default ใช้ header ของ user SUPER (เห็นทุก ward) */
  const openStream = async (
    path: string,
    headers: Record<string, string> = { Authorization: bearerUser() },
  ): Promise<SseClient> => {
    const client = new SseClient();
    clients.push(client);
    await client.connect(port, `${API_PREFIX}${path}`, headers);
    return client;
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    telemetry = ctx.moduleRef.get(TelemetryService);
    devices = ctx.moduleRef.get(DeviceService);

    await cleanupByPrefix(prisma, E2E_PREFIX);
    await seedDevice(prisma, buildDevices(E2E_PREFIX)[0]);

    // ต้อง listen จริงเพราะ SSE ต้องมี socket ค้างไว้ ใช้ port 0 ให้ OS เลือกให้
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(() => {
    // ปิดทุก connection ไม่งั้น Jest ค้างเพราะ socket ยังเปิดอยู่
    clients.splice(0).forEach((c) => c.close());
  });

  afterAll(async () => {
    clients.splice(0).forEach((c) => c.close());
    await cleanupByPrefix(prisma, E2E_PREFIX);
    await app?.close();
  });

  it('GET /telemetry/stream ตอบ header ของ SSE และค้าง connection ไว้', async () => {
    const client = await openStream('/telemetry/stream');
    expect(client).toBeDefined();
  });

  it('push telemetry ที่ ingest ใหม่ไปยัง client ที่เปิด stream ค้างอยู่', async () => {
    const client = await openStream('/telemetry/stream');

    const log = buildLogs(serial, 1)[0];
    await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString(), temp: 7.77 });

    const event = await client.waitFor((e) => e.event === 'telemetry');

    expect(event.event).toBe('telemetry');
    const data = event.data as { serial: string; temp: number };
    expect(data.serial).toBe(serial);
    expect(Number(data.temp)).toBeCloseTo(7.77, 2);
  });

  it('push notification ที่สร้างผ่าน REST ไปยัง /notifications/stream', async () => {
    const client = await openStream('/notifications/stream');

    await request(app.getHttpServer())
      .post(`${API_PREFIX}/notifications`)
      .set('Authorization', bearerDevice(serial))
      .send({ serial, message: 'SSE ทดสอบ', detail: 'ต้องเด้งเข้า stream' })
      .expect(201);

    const event = await client.waitFor((e) => e.event === 'notification');

    const data = event.data as { serial: string; message: string };
    expect(data.serial).toBe(serial);
    expect(data.message).toBe('SSE ทดสอบ');
  });

  it('client หลายตัวได้รับ event เดียวกันทุกตัว (multicast)', async () => {
    const a = await openStream('/telemetry/stream');
    const b = await openStream('/telemetry/stream');

    const log = buildLogs(serial, 1)[0];
    await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString(), temp: 3.21 });

    const [ea, eb] = await Promise.all([
      a.waitFor((e) => e.event === 'telemetry'),
      b.waitFor((e) => e.event === 'telemetry'),
    ]);

    expect((ea.data as { serial: string }).serial).toBe(serial);
    expect((eb.data as { serial: string }).serial).toBe(serial);
  });

  it('แยก channel ถูกต้อง — telemetry ไม่รั่วเข้า notification stream', async () => {
    const notifStream = await openStream('/notifications/stream');
    const telemetryStream = await openStream('/telemetry/stream');

    const log = buildLogs(serial, 1)[0];
    await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString() });

    // รอให้ telemetry มาถึงก่อน แล้วค่อยยืนยันว่า notification stream ยังเงียบ
    await telemetryStream.waitFor((e) => e.event === 'telemetry');

    expect(notifStream.events.filter((e) => e.event === 'telemetry')).toHaveLength(0);
  });

  it('push การเปลี่ยนสถานะ online ของ device ไปยัง /devices/stream', async () => {
    const client = await openStream('/devices/stream');

    await devices.setOnline(serial, true);

    const event = await client.waitFor((e) => e.event === 'device');

    const data = event.data as { action: string; serial: string; device: { online: boolean } };
    expect(data.action).toBe('online');
    expect(data.serial).toBe(serial);
    expect(data.device.online).toBe(true);
  });

  it('GET /stream?channels=... รับได้ทั้ง device และ telemetry บน connection เดียว', async () => {
    const client = await openStream('/stream?channels=device,telemetry');

    await devices.setOnline(serial, false);
    const deviceEvent = await client.waitFor((e) => e.event === 'device');
    expect((deviceEvent.data as { action: string }).action).toBe('offline');

    // รอทีละ event — SseClient เก็บ waiter ได้ทีละตัว รอพร้อมกันจะทับกัน
    const log = buildLogs(serial, 1)[0];
    await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString(), temp: 1.23 });
    const telemetryEvent = await client.waitFor((e) => e.event === 'telemetry');
    expect((telemetryEvent.data as { serial: string }).serial).toBe(serial);

    // channel ที่ไม่ได้ขอต้องไม่รั่วเข้ามา
    expect(client.events.filter((e) => e.event === 'notification')).toHaveLength(0);
  });

  it('GET /stream?channels=<ชื่อที่ไม่รู้จัก> ตอบ 400 ไม่ใช่เปิด stream เงียบ ๆ', async () => {
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/stream?channels=bogus`)
      .set('Authorization', bearerUser())
      .expect(400);
  });

  it('ไม่มี token → 401 ไม่เปิด stream ค้างไว้', async () => {
    const client = await openStream('/telemetry/stream', {});
    expect(client.statusCode).toBe(401);
  });

  it('token ปลอม → 401', async () => {
    const client = await openStream('/devices/stream', { Authorization: 'Bearer not.a.jwt' });
    expect(client.statusCode).toBe(401);
  });

  it('รับ token ทาง ?token= ได้ เพราะ EventSource ตั้ง header ไม่ได้', async () => {
    const client = await openStream(`/telemetry/stream?token=${tokenUser()}`, {});
    expect(client.statusCode).toBe(200);

    const log = buildLogs(serial, 1)[0];
    await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString(), temp: 9.99 });

    const event = await client.waitFor((e) => e.event === 'telemetry');
    expect((event.data as { serial: string }).serial).toBe(serial);
  });

  it('USER เห็นเฉพาะ telemetry ของ ward ตัวเอง', async () => {
    const opd = await openStream('/telemetry/stream', {
      Authorization: bearerUser({ role: 'USER', wardId: 'OPD' }),
    });
    const icu = await openStream('/telemetry/stream', {
      Authorization: bearerUser({ role: 'USER', wardId: 'ICU' }),
    });

    const log = buildLogs(serial, 1)[0];
    await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString(), temp: 4.44 });

    // event เดินผ่าน Subject เดียวกัน ถ้ารั่วก็ต้องถึง icu พร้อมกับ opd
    const event = await opd.waitFor((e) => e.event === 'telemetry');
    expect((event.data as { serial: string }).serial).toBe(serial);
    expect(icu.events.filter((e) => e.event === 'telemetry')).toHaveLength(0);
  });

  it('USER ต่าง ward ไม่เห็น device event ของ ward OPD แต่ SUPER เห็น', async () => {
    const icu = await openStream('/devices/stream', {
      Authorization: bearerUser({ role: 'USER', wardId: 'ICU' }),
    });
    const superUser = await openStream('/devices/stream');

    await devices.setOnline(serial, true);

    const event = await superUser.waitFor((e) => e.event === 'device');
    expect((event.data as { action: string }).action).toBe('online');
    expect(icu.events.filter((e) => e.event === 'device')).toHaveLength(0);
  });
});
