import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { API_PREFIX, createTestApp, unwrap } from './utils/create-test-app';
import {
  E2E_PREFIX,
  buildDevices,
  buildLogs,
  cleanupByPrefix,
  seedDevice,
  serialFor,
  withDeviceId,
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
    const seeded = [];
    for (const d of devices.slice(0, 2)) {
      seeded.push(await seedDevice(prisma, d));
    }

    // ingest ผ่าน service จริง เพื่อให้เดินผ่าน business logic เดียวกับที่ MQTT handler เรียก
    for (const log of buildLogs(serial, 6)) {
      await telemetry.ingest({ ...log, sendTime: log.sendTime.toISOString() });
    }
    await prisma.logDays.createMany({
      data: withDeviceId(buildLogs(otherSerial, 3), seeded[1].deviceId),
    });
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
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/telemetry`).query({ serial });

    expect(res.status).toBe(200);
    const logs = unwrap(res.body);
    expect(logs).toHaveLength(6);
    expect(logs.every((r: { serial: string }) => r.serial === serial)).toBe(true);

    const times = logs.map((r: { sendTime: string }) => new Date(r.sendTime).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('limit จำกัดจำนวนแถวที่คืน', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ serial, limit: 2 });

    expect(res.status).toBe(200);
    expect(unwrap(res.body)).toHaveLength(2);
  });

  it('from/to กรองตามช่วงเวลาได้ถูกต้อง', async () => {
    const from = new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString();

    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ serial, from });

    expect(res.status).toBe(200);
    const logs = unwrap(res.body);
    // buildLogs สร้างทีละชั่วโมงย้อนหลัง — ตัดที่ 3.5 ชม. จึงเหลือ 4 แถว (0,1,2,3 ชม.)
    expect(logs).toHaveLength(4);
    expect(logs.every((r: { sendTime: string }) => new Date(r.sendTime) >= new Date(from))).toBe(
      true,
    );
  });

  it('range=1d กรองเป็นช่วง 1 วันย้อนหลังจากปัจจุบัน', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ serial, range: '1d' });

    expect(res.status).toBe(200);
    const logs = unwrap(res.body);
    // buildLogs สร้างทีละชั่วโมงย้อนหลัง 6 แถว (0-5 ชม.) ทั้งหมดอยู่ใน 1 วัน
    expect(logs).toHaveLength(6);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    expect(
      logs.every((r: { sendTime: string }) => new Date(r.sendTime).getTime() >= oneDayAgo),
    ).toBe(true);
  });

  it('range=custom ต้องส่ง from/to มาด้วย ไม่งั้นปฏิเสธ', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ serial, range: 'custom' });

    expect(res.status).toBe(400);
  });

  it('range=custom ใช้ from/to ที่ส่งมาตรง ๆ', async () => {
    const from = new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();

    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ serial, range: 'custom', from, to });

    expect(res.status).toBe(200);
    // เหมือน test from/to เดิม — ตัดที่ 3.5 ชม. เหลือ 4 แถว (0,1,2,3 ชม.)
    expect(unwrap(res.body)).toHaveLength(4);
  });

  it('ปฏิเสธ range ที่ไม่ใช่ค่าใน enum', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ serial, range: 'invalid' });

    expect(res.status).toBe(400);
  });

  it('ไม่ระบุ serial คืนข้อมูลรวมทุกเครื่อง', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ limit: 1000 });

    expect(res.status).toBe(200);
    const serials = new Set(unwrap(res.body).map((r: { serial: string }) => r.serial));
    expect(serials.has(serial)).toBe(true);
    expect(serials.has(otherSerial)).toBe(true);
  });

  it('ปฏิเสธ limit เกินขอบเขตที่กำหนดไว้ใน DTO', async () => {
    const tooBig = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ limit: 9999 });
    const tooSmall = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ limit: 0 });

    expect(tooBig.status).toBe(400);
    expect(tooSmall.status).toBe(400);
  });

  it('ปฏิเสธ from ที่ไม่ใช่รูปแบบวันที่', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ serial, from: 'ไม่ใช่วันที่' });

    expect(res.status).toBe(400);
  });

  describe('ผูก probe ตอน ingest', () => {
    it('log ที่ ingest ผ่าน service ถูกผูก probe ของ channel นั้น', async () => {
      const logs = await prisma.logDays.findMany({ where: { serial }, take: 1 });

      expect(logs[0].probeId).not.toBeNull();
      expect(logs[0].probe).toBe('1');

      const probe = await prisma.probes.findUnique({ where: { id: logs[0].probeId! } });
      expect(probe!.channel).toBe('1');
    });

    it('channel ที่ยังไม่มี probe → auto-provision probe ใหม่แล้วผูกให้', async () => {
      const before = await prisma.probes.count({ where: { device: { serial } } });

      const log = await telemetry.ingest({ serial, probe: '9', temp: 5 });

      expect(log.probeId).not.toBeNull();
      const after = await prisma.probes.count({ where: { device: { serial } } });
      expect(after).toBe(before + 1);

      const created = await prisma.probes.findUnique({ where: { id: log.probeId! } });
      expect(created).toMatchObject({ channel: '9', name: 'P9' });
    });

    it('ingest ซ้ำ channel เดิม → ใช้ probe เดิม ไม่สร้างเพิ่ม', async () => {
      const first = await telemetry.ingest({ serial, probe: '8', temp: 5 });
      const countAfterFirst = await prisma.probes.count({ where: { device: { serial } } });

      const second = await telemetry.ingest({ serial, probe: '8', temp: 6 });

      expect(second.probeId).toBe(first.probeId);
      expect(await prisma.probes.count({ where: { device: { serial } } })).toBe(countAfterFirst);
    });

    it('GET /telemetry?probeId= คืนเฉพาะ log ของ probe นั้น', async () => {
      const log = await telemetry.ingest({ serial, probe: '7', temp: 5 });

      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/telemetry`)
        .query({ serial, probeId: log.probeId! });

      expect(res.status).toBe(200);
      const rows = unwrap(res.body);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.probeId).toBe(log.probeId);
    });

    it('GET /telemetry?probe= กรองด้วย channel ดิบได้', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/telemetry`)
        .query({ serial, probe: '9' });

      expect(res.status).toBe(200);
      const rows = unwrap(res.body);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.probe).toBe('9');
    });

    it('ปฏิเสธ probeId ที่ไม่ใช่ uuid', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/telemetry`)
        .query({ serial, probeId: 'ไม่ใช่ uuid' });

      expect(res.status).toBe(400);
    });
  });
});
