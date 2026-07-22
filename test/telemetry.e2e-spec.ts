import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { createTestApp } from './utils/create-test-app';
import {
  E2E_PREFIX,
  buildDevices,
  buildLogs,
  cleanupByPrefix,
  serialFor,
} from './fixtures/seed-data';

describe('Telemetry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let telemetry: TelemetryService;

  const serial = serialFor(E2E_PREFIX, 1);
  const otherSerial = serialFor(E2E_PREFIX, 2);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);
    telemetry = ctx.moduleRef.get(TelemetryService);

    await cleanupByPrefix(prisma, E2E_PREFIX);

    // ต้องมี device ก่อนเพราะ LogDays.serial เป็น FK ไป Devices.serial
    const devices = buildDevices(E2E_PREFIX);
    for (const d of devices.slice(0, 2)) {
      await prisma.devices.create({ data: d });
    }

    // ingest ผ่าน service จริง เพื่อให้เดินผ่าน business logic เดียวกับที่ MQTT handler เรียก
    for (const log of buildLogs(serial, 6)) {
      await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString() });
    }
    await prisma.logDays.createMany({ data: buildLogs(otherSerial, 3) });
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, E2E_PREFIX);
    await app?.close();
  });

  it('TelemetryService.ingest เขียนลง LogDays hypertable จริง', async () => {
    const count = await prisma.logDays.count({ where: { serial } });
    expect(count).toBe(6);
  });

  it('GET /telemetry?serial=… คืนเฉพาะ serial นั้น เรียงตาม sendTime จากใหม่ไปเก่า', async () => {
    const res = await request(app.getHttpServer()).get('/telemetry').query({ serial });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    expect(res.body.every((r: { serial: string }) => r.serial === serial)).toBe(true);

    const times = res.body.map((r: { sendTime: string }) => new Date(r.sendTime).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('limit จำกัดจำนวนแถวที่คืน', async () => {
    const res = await request(app.getHttpServer()).get('/telemetry').query({ serial, limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('from/to กรองตามช่วงเวลาได้ถูกต้อง', async () => {
    const from = new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString();

    const res = await request(app.getHttpServer()).get('/telemetry').query({ serial, from });

    expect(res.status).toBe(200);
    // buildLogs สร้างทีละชั่วโมงย้อนหลัง — ตัดที่ 3.5 ชม. จึงเหลือ 4 แถว (0,1,2,3 ชม.)
    expect(res.body).toHaveLength(4);
    expect(
      res.body.every((r: { sendTime: string }) => new Date(r.sendTime) >= new Date(from)),
    ).toBe(true);
  });

  it('ไม่ระบุ serial คืนข้อมูลรวมทุกเครื่อง', async () => {
    const res = await request(app.getHttpServer()).get('/telemetry').query({ limit: 1000 });

    expect(res.status).toBe(200);
    const serials = new Set(res.body.map((r: { serial: string }) => r.serial));
    expect(serials.has(serial)).toBe(true);
    expect(serials.has(otherSerial)).toBe(true);
  });

  it('ปฏิเสธ limit เกินขอบเขตที่กำหนดไว้ใน DTO', async () => {
    const tooBig = await request(app.getHttpServer()).get('/telemetry').query({ limit: 9999 });
    const tooSmall = await request(app.getHttpServer()).get('/telemetry').query({ limit: 0 });

    expect(tooBig.status).toBe(400);
    expect(tooSmall.status).toBe(400);
  });

  it('ปฏิเสธ from ที่ไม่ใช่รูปแบบวันที่', async () => {
    const res = await request(app.getHttpServer())
      .get('/telemetry')
      .query({ serial, from: 'ไม่ใช่วันที่' });

    expect(res.status).toBe(400);
  });
});
