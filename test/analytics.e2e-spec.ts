import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import {
  E2E_PREFIX,
  buildDevices,
  buildLogs,
  cleanupByPrefix,
  seedDevice,
  seedProbe,
  serialFor,
  withDeviceId,
  withProbeId,
} from './fixtures/seed-data';

/**
 * logday/graph ยิง raw SQL ที่ใช้ time_bucket ของ TimescaleDB โดยตรง
 * เทสชุดนี้จึงเป็นตัวยืนยันว่า LogDays เป็น hypertable จริงและ query ใช้งานได้
 */
describe('Analytics: logday + graph (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const serial = serialFor(E2E_PREFIX, 1);
  let deviceId: string;
  let probe1: string;
  let probe2: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.moduleRef.get(PrismaService);

    await cleanupByPrefix(prisma, E2E_PREFIX);
    ({ deviceId } = await seedDevice(prisma, buildDevices(E2E_PREFIX)[0]));

    // 2 probe บน device เดียว — เคสจริงของตู้ที่มีหลายช่องวัด และเป็นเหตุผลที่กราฟต้องมีหลายเส้น
    ({ id: probe1 } = await seedProbe(prisma, deviceId, { name: 'P1', channel: '1' }));
    ({ id: probe2 } = await seedProbe(prisma, deviceId, { name: 'P2', channel: '2' }));

    // 72 ชม. — ครอบคลุมทั้งช่วง 24 ชม. ของ graph และหลายวันของ logday
    await prisma.logDays.createMany({
      data: withProbeId(withDeviceId(buildLogs(serial, 72, undefined, '1'), deviceId), probe1),
    });
    // probe 2 ส่งถี่ครึ่งเดียว — ยืนยันว่าแต่ละเส้นนับ sample ของตัวเอง ไม่ใช่หารเฉลี่ยรวม
    await prisma.logDays.createMany({
      data: withProbeId(withDeviceId(buildLogs(serial, 36, undefined, '2'), deviceId), probe2),
    });
  });

  afterAll(async () => {
    await cleanupByPrefix(prisma, E2E_PREFIX);
    await app?.close();
  });

  describe('GET /logday/:serial', () => {
    it('คืนสรุปรายวันแบ่งตาม time_bucket (พิสูจน์ว่า hypertable ใช้งานได้)', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);

      expect(res.status).toBe(200);
      const rows = unwrap(res.body);
      expect(Array.isArray(rows)).toBe(true);
      // log 72 ชม. คร่อมอย่างน้อย 3 วัน
      expect(rows.length).toBeGreaterThanOrEqual(3);

      const row = rows[0];
      // rollup ผูกกับจุดติดตั้ง ไม่ใช่ serial ของกล่องอีกต่อไป
      expect(row.deviceId).toBe(deviceId);
      expect(row).toHaveProperty('day');
      expect(row).toHaveProperty('avgTemp');
      expect(row).toHaveProperty('minTemp');
      expect(row).toHaveProperty('maxTemp');
    });

    it('รวมจำนวน samples ของทุก bucket ได้เท่ากับจำนวน log ทั้งหมดของทั้งสอง probe', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);

      const total = unwrap(res.body).reduce(
        (sum: number, r: { samples: number }) => sum + Number(r.samples),
        0,
      );
      expect(total).toBe(72 + 36);
    });

    it('แยก bucket ต่อ probe ไม่เฉลี่ยข้าม probe — แต่ละวันมีแถวของทั้งสอง probe', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);
      const rows = unwrap(res.body);

      // ทุกแถวต้องระบุได้ว่าเป็นของ probe ไหน
      for (const row of rows) {
        expect([probe1, probe2]).toContain(row.probeId);
        expect(['1', '2']).toContain(row.channel);
      }

      // วันที่ทั้งสอง probe ส่งข้อมูลต้องได้ 2 แถวแยกกัน ไม่ใช่ 1 แถวที่รวมกันแล้ว
      const byDay = new Map<string, number>();
      for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + 1);
      expect([...byDay.values()].some((n) => n === 2)).toBe(true);
    });

    it('samples รวมของแต่ละ probe ตรงกับจำนวนที่ seed ไว้ของ probe นั้น', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);

      const sumFor = (probeId: string) =>
        unwrap(res.body)
          .filter((r: { probeId: string }) => r.probeId === probeId)
          .reduce((sum: number, r: { samples: number }) => sum + Number(r.samples), 0);

      expect(sumFor(probe1)).toBe(72);
      expect(sumFor(probe2)).toBe(36);
    });

    it('ชื่อ probe ติดมาจาก join ตาราง probes', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);

      const names = new Set(unwrap(res.body).map((r: { name: string }) => r.name));
      expect(names).toEqual(new Set(['P1', 'P2']));
    });

    it('เรียง bucket จากใหม่ไปเก่า', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);

      const days = unwrap(res.body).map((r: { day: string }) => new Date(r.day).getTime());
      expect(days).toEqual([...days].sort((a, b) => b - a));
    });

    // เดิม endpoint นี้ query ด้วย serial ตรง ๆ จึงคืน [] ให้ serial มั่ว
    // ตอนนี้ต้อง resolve เป็นจุดติดตั้งก่อน serial ที่ไม่มีในระบบจึงเป็น 404 ซึ่งบอกสาเหตุตรงกว่า
    it('คืน 404 เมื่อไม่มีอุปกรณ์ตาม serial นั้น', async () => {
      const res = await request(app.getHttpServer()).get(
        `${API_PREFIX}/logday/${E2E_PREFIX}ไม่มีจริง`,
      );

      expect(res.status).toBe(404);
    });

    /**
     * ตรวจ type ที่ออกทาง JSON จริง
     * temp เป็น Float (double precision) → AVG/MIN/MAX คืน float8 ไม่ใช่ numeric
     * จึงไม่กลายเป็น Decimal/string ตรงกับที่ interface DailyRollup ประกาศไว้เป็น number
     */
    it('ค่าสถิติออกมาเป็น number ตรงกับ type ที่ประกาศไว้', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);

      const { avgTemp, minTemp, maxTemp, samples } = unwrap(res.body)[0];
      for (const v of [avgTemp, minTemp, maxTemp, samples]) {
        expect(typeof v).toBe('number');
      }
    });

    it('avgTemp อยู่ระหว่าง minTemp กับ maxTemp และอยู่ในช่วงที่ seed ไว้', async () => {
      const res = await request(app.getHttpServer()).get(`${API_PREFIX}/logday/${serial}`);

      for (const row of unwrap(res.body)) {
        expect(row.minTemp).toBeLessThanOrEqual(row.avgTemp);
        expect(row.avgTemp).toBeLessThanOrEqual(row.maxTemp);
        // buildLogs สร้าง temp เป็นคลื่นในช่วง 2..8 °C
        expect(row.minTemp).toBeGreaterThanOrEqual(2);
        expect(row.maxTemp).toBeLessThanOrEqual(8);
      }
    });
  });

  describe('GET /graph/:serial', () => {
    /** series ของ probe ที่ระบุ จากผลลัพธ์ที่เป็น array ของ series */
    const seriesFor = (body: { data: any }, probeId: string) =>
      unwrap(body).find((s: { probeId: string }) => s.probeId === probeId);

    it('คืน 1 series ต่อ 1 probe พร้อม threshold ของ probe นั้น', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      const series = unwrap(res.body);
      expect(Array.isArray(series)).toBe(true);
      expect(series).toHaveLength(2);

      expect(series.map((s: { channel: string }) => s.channel)).toEqual(['1', '2']);
      for (const s of series) {
        expect(s).toHaveProperty('tempMin');
        expect(s).toHaveProperty('tempMax');
        expect(s).toHaveProperty('humiMin');
        expect(s).toHaveProperty('humiMax');
        expect(Array.isArray(s.points)).toBe(true);
      }
    });

    it('คืนค่าดิบ (ไม่ average) ของ log ในช่วง 24 ชม. ล่าสุด (default range=1d)', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .set('Authorization', bearerUser());

      const { points } = seriesFor(res.body, probe1);
      // log ทุกชั่วโมง ย้อนหลัง 72 ชม. → 24 ชม.ล่าสุดมีประมาณ 24-25 แถว
      expect(points.length).toBeGreaterThanOrEqual(20);
      expect(points.length).toBeLessThanOrEqual(25);

      expect(points[0]).toHaveProperty('sendTime');
      expect(points[0]).toHaveProperty('temp');
      expect(points[0]).toHaveProperty('humidity');
      expect(points[0].deviceId).toBe(deviceId);
    });

    it('ข้อมูลของแต่ละ probe ไม่ปนกัน — ทุก point อยู่ในเส้นของ probe ตัวเอง', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ range: '7d' })
        .set('Authorization', bearerUser());

      for (const s of unwrap(res.body)) {
        for (const p of s.points) {
          expect(p.probeId).toBe(s.probeId);
          expect(p.probe).toBe(s.channel);
        }
      }
    });

    it('probe ที่ส่งถี่น้อยกว่าได้ point น้อยกว่า (นับแยกเส้น ไม่ใช่กองเดียว)', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ range: '7d' })
        .set('Authorization', bearerUser());

      expect(seriesFor(res.body, probe1).points).toHaveLength(72);
      expect(seriesFor(res.body, probe2).points).toHaveLength(36);
    });

    it('ไม่มี series unassigned เมื่อทุก log ถูกผูก probe ครบ', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ range: '7d' })
        .set('Authorization', bearerUser());

      expect(unwrap(res.body).every((s: { probeId: string | null }) => s.probeId !== null)).toBe(
        true,
      );
    });

    it('probeId ที่ระบุ → ได้เส้นเดียว', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ range: '7d', probeId: probe2 })
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      const series = unwrap(res.body);
      expect(series).toHaveLength(1);
      expect(series[0].probeId).toBe(probe2);
      expect(series[0].points).toHaveLength(36);
    });

    it('probeId ที่ไม่ใช่ uuid → 400', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ probeId: 'not-a-uuid' })
        .set('Authorization', bearerUser());

      expect(res.status).toBe(400);
    });

    it('เรียงจาก sendTime เก่าไปใหม่ในแต่ละเส้น (ตรงข้ามกับ logday)', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .set('Authorization', bearerUser());

      for (const s of unwrap(res.body)) {
        const times = s.points.map((r: { sendTime: string }) => new Date(r.sendTime).getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b));
      }
    });

    it('range=7d คืน point มากกว่า range=1d (default) เพราะครอบคลุมช่วงเวลานานกว่า', async () => {
      const resDay = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .set('Authorization', bearerUser());
      const resWeek = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ range: '7d' })
        .set('Authorization', bearerUser());

      const dayPoints = seriesFor(resDay.body, probe1).points.length;
      const weekPoints = seriesFor(resWeek.body, probe1).points.length;
      expect(weekPoints).toBeGreaterThan(dayPoints);
      // seed มีแค่ 72 ชม. ย้อนหลัง แม้ range=7d ก็ไม่เกินจำนวน log ที่มีจริง
      expect(weekPoints).toBeLessThanOrEqual(72);
    });

    it('range=custom ใช้ from/to ที่ระบุ', async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 3 * 60 * 60 * 1000);
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ range: 'custom', from: from.toISOString(), to: to.toISOString() })
        .set('Authorization', bearerUser());

      expect(res.status).toBe(200);
      for (const s of unwrap(res.body)) {
        for (const p of s.points) {
          const t = new Date(p.sendTime).getTime();
          expect(t).toBeGreaterThanOrEqual(from.getTime());
          expect(t).toBeLessThanOrEqual(to.getTime());
        }
      }
    });

    it('range=custom ไม่ระบุ from/to → 400', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${serial}`)
        .query({ range: 'custom' })
        .set('Authorization', bearerUser());

      expect(res.status).toBe(400);
    });

    it('คืน 404 เมื่อไม่มีอุปกรณ์ตาม serial นั้น', async () => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/graph/${E2E_PREFIX}ไม่มีจริง`)
        .set('Authorization', bearerUser());

      expect(res.status).toBe(404);
    });
  });
});
