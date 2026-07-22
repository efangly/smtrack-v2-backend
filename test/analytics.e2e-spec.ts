import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/create-test-app';
import {
  E2E_PREFIX,
  buildDevices,
  buildLogs,
  cleanupByPrefix,
  serialFor,
} from './fixtures/seed-data';

/**
 * logday/graph ยิง raw SQL ที่ใช้ time_bucket ของ TimescaleDB โดยตรง
 * เทสชุดนี้จึงเป็นตัวยืนยันว่า LogDays เป็น hypertable จริงและ query ใช้งานได้
 */
describe('Analytics: logday + graph (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const serial = serialFor(E2E_PREFIX, 1);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);

    await cleanupByPrefix(prisma, E2E_PREFIX);
    await prisma.devices.create({ data: buildDevices(E2E_PREFIX)[0] });

    // 72 ชม. — ครอบคลุมทั้งช่วง 24 ชม. ของ graph และหลายวันของ logday
    await prisma.logDays.createMany({ data: buildLogs(serial, 72) });
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, E2E_PREFIX);
    await app?.close();
  });

  describe('GET /logday/:serial', () => {
    it('คืนสรุปรายวันแบ่งตาม time_bucket (พิสูจน์ว่า hypertable ใช้งานได้)', async () => {
      const res = await request(app.getHttpServer()).get(`/logday/${serial}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // log 72 ชม. คร่อมอย่างน้อย 3 วัน
      expect(res.body.length).toBeGreaterThanOrEqual(3);

      const row = res.body[0];
      expect(row.serial).toBe(serial);
      expect(row).toHaveProperty('day');
      expect(row).toHaveProperty('avgTemp');
      expect(row).toHaveProperty('minTemp');
      expect(row).toHaveProperty('maxTemp');
    });

    it('รวมจำนวน samples ของทุก bucket ได้เท่ากับจำนวน log ทั้งหมด', async () => {
      const res = await request(app.getHttpServer()).get(`/logday/${serial}`);

      const total = res.body.reduce(
        (sum: number, r: { samples: number }) => sum + Number(r.samples),
        0,
      );
      expect(total).toBe(72);
    });

    it('เรียง bucket จากใหม่ไปเก่า', async () => {
      const res = await request(app.getHttpServer()).get(`/logday/${serial}`);

      const days = res.body.map((r: { day: string }) => new Date(r.day).getTime());
      expect(days).toEqual([...days].sort((a, b) => b - a));
    });

    it('คืน array ว่างเมื่อ serial ไม่มีข้อมูล', async () => {
      const res = await request(app.getHttpServer()).get(`/logday/${E2E_PREFIX}ไม่มีจริง`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    /**
     * ตรวจ type ที่ออกทาง JSON จริง
     * temp เป็น Float (double precision) → AVG/MIN/MAX คืน float8 ไม่ใช่ numeric
     * จึงไม่กลายเป็น Decimal/string ตรงกับที่ interface DailyRollup ประกาศไว้เป็น number
     */
    it('ค่าสถิติออกมาเป็น number ตรงกับ type ที่ประกาศไว้', async () => {
      const res = await request(app.getHttpServer()).get(`/logday/${serial}`);

      const { avgTemp, minTemp, maxTemp, samples } = res.body[0];
      for (const v of [avgTemp, minTemp, maxTemp, samples]) {
        expect(typeof v).toBe('number');
      }
    });

    it('avgTemp อยู่ระหว่าง minTemp กับ maxTemp และอยู่ในช่วงที่ seed ไว้', async () => {
      const res = await request(app.getHttpServer()).get(`/logday/${serial}`);

      for (const row of res.body) {
        expect(row.minTemp).toBeLessThanOrEqual(row.avgTemp);
        expect(row.avgTemp).toBeLessThanOrEqual(row.maxTemp);
        // buildLogs สร้าง temp เป็นคลื่นในช่วง 2..8 °C
        expect(row.minTemp).toBeGreaterThanOrEqual(2);
        expect(row.maxTemp).toBeLessThanOrEqual(8);
      }
    });
  });

  describe('GET /graph/:serial', () => {
    it('คืน time series แบ่งเป็นราย 1 ชั่วโมงในช่วง 24 ชม.', async () => {
      const res = await request(app.getHttpServer()).get(`/graph/${serial}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(20);
      expect(res.body.length).toBeLessThanOrEqual(25);

      expect(res.body[0]).toHaveProperty('bucket');
      expect(res.body[0]).toHaveProperty('avgTemp');
      expect(res.body[0]).toHaveProperty('avgHumidity');
    });

    it('เรียง bucket จากเก่าไปใหม่ (ตรงข้ามกับ logday)', async () => {
      const res = await request(app.getHttpServer()).get(`/graph/${serial}`);

      const buckets = res.body.map((r: { bucket: string }) => new Date(r.bucket).getTime());
      expect(buckets).toEqual([...buckets].sort((a, b) => a - b));
    });

    it('คืน array ว่างเมื่อ serial ไม่มีข้อมูล', async () => {
      const res = await request(app.getHttpServer()).get(`/graph/${E2E_PREFIX}ไม่มีจริง`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
