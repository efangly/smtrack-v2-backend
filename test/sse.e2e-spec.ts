import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AddressInfo } from 'net';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { createTestApp } from './utils/create-test-app';
import { SseClient } from './utils/sse-client';
import {
  E2E_PREFIX,
  buildDevices,
  buildLogs,
  cleanupByPrefix,
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
  let port: number;
  const clients: SseClient[] = [];

  const serial = serialFor(E2E_PREFIX, 1);

  const openStream = async (path: string): Promise<SseClient> => {
    const client = new SseClient();
    clients.push(client);
    await client.connect(port, path);
    return client;
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    telemetry = ctx.moduleRef.get(TelemetryService);

    await cleanupByPrefix(prisma, E2E_PREFIX);
    await prisma.devices.create({ data: buildDevices(E2E_PREFIX)[0] });

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
      .post('/notifications')
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
});
