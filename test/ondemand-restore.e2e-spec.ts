import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { ArchiveExportService } from '../src/backup/archive-export.service';
import { RestoredWindowService } from '../src/backup/restored-window.service';
import { ObjectStorageService } from '../src/backup/object-storage.service';
import { PG_POOL } from '../src/backup/backup.tokens';
import { Pool } from 'pg';
import { archiveObjectKey, metaObjectKey, MonthString } from '../src/backup/archive.util';
import { PrismaService } from '../src/prisma/prisma.service';
import { API_PREFIX, createTestApp, unwrap } from './utils/create-test-app';
import { bearerUser } from './utils/auth';
import {
  buildDevices,
  cleanupByPrefix,
  seedDevice,
  seedProbe,
  serialFor,
} from './fixtures/seed-data';

/**
 * On-demand restore ตลอดสาย (HTTP -> guard/scope -> RestoredWindowService -> object storage จริง
 * -> log_day_archive -> response) บน Postgres/TimescaleDB และ S3 จริงตาม env
 *
 * ใช้เดือน 2020-03 ที่อยู่นอก hot window เสมอ และจำลองการ drop chunk ด้วยการลบแถวออกจาก log_days
 * เองหลัง export (ไม่ต้องรอเวลา ไม่แตะ retention policy)
 */
describe('On-demand restore (e2e, real Postgres + object storage)', () => {
  const MONTH = '2020-03' as MonthString;
  const MONTH_START = new Date('2020-03-01T00:00:00.000Z');
  const PREFIX = 'E2E-ODR-';
  const serial = serialFor(PREFIX, 1);
  const ROWS = 30;
  const FROM = '2020-03-05T00:00:00.000Z';
  const TO = '2020-03-14T23:59:59.000Z';
  /** 1 แถวต่อวัน เที่ยงวัน — วันที่ 5..14 = 10 แถวอยู่ในช่วง FROM..TO */
  const IN_RANGE = 10;

  let app: INestApplication;
  let prisma: PrismaService;
  let exporter: ArchiveExportService;
  let restored: RestoredWindowService;
  let storage: ObjectStorageService;
  let deviceId: string;
  let probeId: string;
  let staticName: string;

  async function cleanupAll() {
    await prisma.restoredWindow.deleteMany({ where: { month: MONTH_START } });
    await prisma.logDayArchive.deleteMany({ where: { serial } });
    await cleanupByPrefix(prisma, PREFIX);
    await prisma.archiveExport.deleteMany({ where: { month: MONTH_START } });
    for (const key of [archiveObjectKey(MONTH), metaObjectKey(MONTH)]) {
      if (await storage.exists(key)) await storage.delete(key);
    }
  }

  beforeAll(async () => {
    ({ app } = await createTestApp({ realObjectStorage: true }));
    prisma = app.get(PrismaService);
    exporter = app.get(ArchiveExportService);
    restored = app.get(RestoredWindowService);
    storage = app.get(ObjectStorageService);

    // กันเขียนทับ archive จริง
    const existing = await prisma.archiveExport.findFirst({ where: { month: MONTH_START } });
    if (existing) throw new Error(`พบ archive_export ของ ${MONTH} อยู่แล้ว — เปลี่ยนเดือนทดสอบ`);
    await cleanupAll();

    const [device] = buildDevices(PREFIX);
    staticName = device.staticName;
    ({ deviceId } = await seedDevice(prisma, device));
    ({ id: probeId } = await seedProbe(prisma, deviceId, { name: 'P1', channel: '1' }));
    await prisma.logDays.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({
        serial,
        deviceId,
        probeId,
        probe: '1',
        temp: 4 + (i % 5),
        tempDisplay: 4 + (i % 5),
        sendTime: new Date(Date.UTC(2020, 2, 1 + i, 12, 0, 0)),
        createAt: new Date(Date.UTC(2020, 2, 1 + i, 12, 0, 0)),
      })),
    });

    // archive เดือนนี้ แล้วจำลอง chunk drop: log_days ไม่เหลือแถวของเดือนนั้นเลย
    await exporter.exportMonth(MONTH);
    await prisma.logDays.deleteMany({ where: { serial } });
  }, 60_000);

  afterAll(async () => {
    await cleanupAll();
    // PG_POOL เป็น raw pg.Pool ไม่มี OnModuleDestroy — ต้องปิดเองไม่งั้น jest process ค้าง
    await app.get<Pool>(PG_POOL).end();
    await app.close();
  });

  const graphUrl = (id = staticName) =>
    `${API_PREFIX}/graph/${encodeURIComponent(id)}?range=custom&from=${FROM}&to=${TO}`;

  it('ก่อน restore: log_days ว่างและยังไม่มีข้อมูลใน log_day_archive', async () => {
    await expect(prisma.logDays.count({ where: { serial } })).resolves.toBe(0);
    await expect(prisma.logDayArchive.count({ where: { serial } })).resolves.toBe(0);
  });

  it('ไม่มี token → 401 / ไม่ใช่ SUPER-SERVICE → 403 ที่ /backup/months', async () => {
    await request(app.getHttpServer()).get(`${API_PREFIX}/backup/months`).expect(401);
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/backup/months`)
      .set('Authorization', bearerUser({ role: 'USER' }))
      .expect(403);
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/backup/months`)
      .set('Authorization', bearerUser({ role: 'SERVICE' }))
      .expect(200);
  });

  it('ผู้ใช้ต่าง tenant ขอ graph ย้อนหลัง → ไม่เห็นอุปกรณ์ และไม่เกิดการ restore เลย', async () => {
    await request(app.getHttpServer())
      .get(graphUrl())
      .set('Authorization', bearerUser({ tenantId: 'other-tenant', role: 'ADMIN' }))
      .expect(404);
    await expect(prisma.restoredWindow.count({ where: { deviceId } })).resolves.toBe(0);
  });

  it('GET /graph ช่วงเก่า: restore อัตโนมัติจาก archive แล้วคืนข้อมูลครบ (ไม่ใช่ 202)', async () => {
    const res = await request(app.getHttpServer())
      .get(graphUrl())
      .set('Authorization', bearerUser())
      .expect(200);

    const series = unwrap<{ probeId: string; points: { sendTime: string }[] }[]>(res.body);
    const points = series.find((s) => s.probeId === probeId)!.points;
    expect(points).toHaveLength(IN_RANGE);
    // เรียงตามเวลาและอยู่ในช่วงที่ขอ
    const times = points.map((p) => new Date(p.sendTime).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[0]).toBeGreaterThanOrEqual(new Date(FROM).getTime());
    expect(times[times.length - 1]).toBeLessThanOrEqual(new Date(TO).getTime());

    const win = await prisma.restoredWindow.findUniqueOrThrow({
      where: {
        sourceTable_deviceId_month: { sourceTable: 'log_days', deviceId, month: MONTH_START },
      },
    });
    expect(win.status).toBe('done');
    expect(Number(win.rowCount)).toBe(ROWS);
    await expect(prisma.logDayArchive.count({ where: { deviceId } })).resolves.toBe(ROWS);
    // แถวที่ restore ผูก device/probe ครบ (ไม่ใช่ NULL)
    await expect(prisma.logDayArchive.count({ where: { deviceId, probeId } })).resolves.toBe(ROWS);
  });

  it('GET /graph ซ้ำ: ไม่ restore ซ้ำ (ข้อมูลไม่ซ้ำ) และต่ออายุ TTL', async () => {
    const before = await prisma.restoredWindow.findFirstOrThrow({ where: { deviceId } });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app.getHttpServer())
      .get(graphUrl())
      .set('Authorization', bearerUser())
      .expect(200);

    const series = unwrap<{ probeId: string; points: unknown[] }[]>(res.body);
    expect(series.find((s) => s.probeId === probeId)!.points).toHaveLength(IN_RANGE);
    await expect(prisma.logDayArchive.count({ where: { deviceId } })).resolves.toBe(ROWS);
    const after = await prisma.restoredWindow.findFirstOrThrow({ where: { deviceId } });
    expect(after.lastReadAt.getTime()).toBeGreaterThan(before.lastReadAt.getTime());
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it('GET /telemetry ช่วงเก่า: อ่านจาก archive ที่ restore ไว้ พร้อมแบ่งหน้า', async () => {
    const page = async (n: number) =>
      request(app.getHttpServer())
        .get(`${API_PREFIX}/telemetry`)
        .query({ deviceId, from: FROM, to: TO, limit: 4, page: n })
        .set('Authorization', bearerUser())
        .expect(200);

    const p1 = await page(1);
    expect(p1.body.meta.total).toBe(IN_RANGE);
    expect(unwrap<unknown[]>(p1.body)).toHaveLength(4);
    const p3 = await page(3);
    expect(unwrap<unknown[]>(p3.body)).toHaveLength(2); // 10 = 4 + 4 + 2

    const ids = new Set<string>();
    for (const n of [1, 2, 3]) {
      for (const row of unwrap<{ id: string }[]>((await page(n)).body)) ids.add(row.id);
    }
    expect(ids.size).toBe(IN_RANGE); // ไม่ซ้ำ ไม่ตกหล่นข้ามหน้า
  });

  it('GET /telemetry ที่ to เก่าแต่ไม่ระบุ from → 400', async () => {
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/telemetry`)
      .query({ deviceId, to: TO })
      .set('Authorization', bearerUser())
      .expect(400);
  });

  it('ขอย้อนหลังเกิน 6 เดือน → 400', async () => {
    await request(app.getHttpServer())
      .get(
        `${API_PREFIX}/graph/${encodeURIComponent(staticName)}?range=custom&from=2019-01-01T00:00:00.000Z&to=2020-03-14T00:00:00.000Z`,
      )
      .set('Authorization', bearerUser())
      .expect(400);
  });

  it('admin restore ทั้งเดือนถูกปฏิเสธ (409) ขณะมีข้อมูลรายอุปกรณ์ค้างอยู่ — กันชน PK', async () => {
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/backup/restores/${MONTH}`)
      .set('Authorization', bearerUser())
      .expect(409);
  });

  it('cleanup ไม่ลบข้อมูลที่ยังไม่หมดอายุ', async () => {
    const res = await restored.cleanupExpired();
    expect(res.removedWindows).toBe(0);
    await expect(prisma.logDayArchive.count({ where: { deviceId } })).resolves.toBe(ROWS);
  });

  it('หมดอายุแล้ว cleanup ลบทั้งข้อมูลและแถวสถานะ แล้ว request ถัดไป restore ใหม่ได้', async () => {
    await prisma.restoredWindow.updateMany({
      where: { deviceId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await restored.cleanupExpired();

    expect(res).toEqual({ removedWindows: 1, removedRows: ROWS });
    await expect(prisma.logDayArchive.count({ where: { deviceId } })).resolves.toBe(0);
    await expect(prisma.restoredWindow.count({ where: { deviceId } })).resolves.toBe(0);

    // ขอใหม่ → restore ใหม่ ได้ข้อมูลครบอีกครั้ง
    const again = await request(app.getHttpServer())
      .get(graphUrl())
      .set('Authorization', bearerUser())
      .expect(200);
    const series = unwrap<{ probeId: string; points: unknown[] }[]>(again.body);
    expect(series.find((s) => s.probeId === probeId)!.points).toHaveLength(IN_RANGE);
  });

  it('มีอีกกระบวนการกำลัง restore อยู่นานเกิน 10 วินาที → 202 + Retry-After (ไม่ restore ซ้ำ)', async () => {
    await restored.cleanupExpired(new Date(Date.now() + 48 * 3600 * 1000));
    await prisma.restoredWindow.deleteMany({ where: { deviceId } });
    await prisma.logDayArchive.deleteMany({ where: { deviceId } });
    // แถว running ที่เพิ่งเริ่ม (ไม่ stale) = มี pod อื่นถืองานอยู่
    await prisma.restoredWindow.create({
      data: {
        sourceTable: 'log_days',
        deviceId,
        month: MONTH_START,
        status: 'running',
        expiresAt: new Date(Date.now() + 3600 * 1000),
      },
    });

    const res = await request(app.getHttpServer())
      .get(graphUrl())
      .set('Authorization', bearerUser())
      .expect(202);

    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toMatchObject({ success: true, data: null, retryAfterSeconds: 5 });
    await expect(prisma.logDayArchive.count({ where: { deviceId } })).resolves.toBe(0);
  }, 30_000);

  describe('ไฟล์ archive รุ่นเก่า (ก่อนมีคอลัมน์ device_id/probe_id และไม่มี meta.columns)', () => {
    const LEGACY = '2020-04' as MonthString;
    const LEGACY_START = new Date('2020-04-01T00:00:00.000Z');

    afterAll(async () => {
      await prisma.restoredWindow.deleteMany({ where: { month: LEGACY_START } });
      await prisma.archiveExport.deleteMany({ where: { month: LEGACY_START } });
      for (const key of [archiveObjectKey(LEGACY), metaObjectKey(LEGACY)]) {
        if (await storage.exists(key)) await storage.delete(key);
      }
    });

    it('ผูกแถวกับจุดติดตั้งผ่านประวัติการติดตั้งกล่อง (device_assignments) ไม่ปน serial ของจุดอื่น', async () => {
      // 18 คอลัมน์ legacy: id..update_at  — 5 แถวของกล่องนี้ + 3 แถวของกล่องที่ไม่เคยติดตั้งที่จุดนี้
      const header =
        'id,serial,temp,temp_display,humidity,humidity_display,send_time,plug,door1,door2,door3,internet,probe,battery,temp_internal,ext_memory,create_at,update_at';
      const row = (id: string, sn: string, day: number) =>
        `${id},${sn},5,5,50,50,2020-04-${String(day).padStart(2, '0')} 12:00:00,t,f,f,f,t,1,90,,f,2020-04-${String(day).padStart(2, '0')} 12:00:00,2020-04-${String(day).padStart(2, '0')} 12:00:00`;
      const rows = [
        ...[6, 7, 8, 9, 10].map((d) => row(`legacy-mine-${d}`, serial, d)),
        ...[6, 7, 8].map((d) => row(`legacy-other-${d}`, 'SOMEONE-ELSE', d)),
      ];
      const csv = [header, ...rows].join('\n') + '\n';

      const body = new PassThrough();
      const done = storage.uploadStream(archiveObjectKey(LEGACY), body, 'application/gzip');
      body.end(gzipSync(Buffer.from(csv)));
      await done;
      await storage.putJson(metaObjectKey(LEGACY), { month: LEGACY, rowCount: rows.length });
      await prisma.archiveExport.create({
        data: {
          sourceTable: 'log_days',
          month: LEGACY_START,
          rowCount: BigInt(rows.length),
          objectKey: archiveObjectKey(LEGACY),
          sha256: 'legacy-test',
        },
      });

      const res = await request(app.getHttpServer())
        .get(
          `${API_PREFIX}/graph/${encodeURIComponent(staticName)}?range=custom&from=2020-04-01T00:00:00.000Z&to=2020-04-30T00:00:00.000Z`,
        )
        .set('Authorization', bearerUser())
        .expect(200);

      const points = unwrap<
        { points: { id: string; deviceId: string; probeId: string | null }[] }[]
      >(res.body).flatMap((s) => s.points);
      expect(points.map((p) => p.id).sort()).toEqual(
        [6, 7, 8, 9, 10].map((d) => `legacy-mine-${d}`).sort(),
      );
      expect(points.every((p) => p.deviceId === deviceId)).toBe(true);
      // ไฟล์รุ่นเก่าไม่มี probe_id → ขึ้นเป็น series "unassigned" ตามพฤติกรรมเดิมของ graph
      expect(points.every((p) => p.probeId === null)).toBe(true);
    });
  });

  describe('ข้อมูลมาช้าเข้าเดือนที่ archive และ drop ไปแล้ว (ผสานแทนการเขียนทับ)', () => {
    const LATE = '2020-05' as MonthString;
    const LATE_START = new Date('2020-05-01T00:00:00.000Z');
    const row = (id: string, day: number) => ({
      id,
      serial,
      deviceId,
      probeId,
      probe: '1',
      temp: 5,
      tempDisplay: 5,
      sendTime: new Date(Date.UTC(2020, 4, day, 12, 0, 0)),
      createAt: new Date(Date.UTC(2020, 4, day, 12, 0, 0)),
    });

    afterAll(async () => {
      await prisma.restoredWindow.deleteMany({ where: { month: LATE_START } });
      await prisma.logDayArchive.deleteMany({ where: { serial } });
      await prisma.archiveExport.deleteMany({ where: { month: LATE_START } });
      for (const key of [
        archiveObjectKey(LATE),
        metaObjectKey(LATE),
        `${archiveObjectKey(LATE)}.staging`,
      ]) {
        if (await storage.exists(key)) await storage.delete(key);
      }
    });

    it('archive ครบ 10 แถว → chunk ถูก drop → แถวใหม่ 2 แถวมาถึงช้า: ผสานเป็น 12 ไม่ทับเหลือ 2', async () => {
      await prisma.logDays.createMany({
        data: Array.from({ length: 10 }, (_, i) => row(`late-old-${i}`, i + 1)),
      });
      await exporter.exportMonth(LATE);
      await prisma.logDays.deleteMany({ where: { serial } }); // จำลอง drop chunk

      // อุปกรณ์ offline ส่งย้อนหลัง: แถวเก่าเข้ามาใหม่ (create_at = ตอนนี้)
      await prisma.logDays.createMany({
        data: [row('late-new-1', 20), row('late-new-2', 21)].map((r) => ({
          ...r,
          createAt: new Date(),
        })),
      });

      // ระบบมองว่าเดือนนี้ค้าง (มีแถวเขียนหลัง export) แม้ใน DB จะมีแค่ 2 < 10
      await expect(exporter.findPendingMonths('log_days')).resolves.toContain(LATE);

      const meta = await exporter.exportMonth(LATE);

      expect(meta.rowCount).toBe(12);
      const rec = await prisma.archiveExport.findUniqueOrThrow({
        where: { sourceTable_month: { sourceTable: 'log_days', month: LATE_START } },
      });
      expect(Number(rec.rowCount)).toBe(12);
      // ไม่มีไฟล์ staging ค้าง และไฟล์จริงถูกแทนที่ครบ
      await expect(storage.exists(`${archiveObjectKey(LATE)}.staging`)).resolves.toBe(false);
      await expect(storage.exists(archiveObjectKey(LATE))).resolves.toBe(true);

      // restore กลับมาต้องได้ครบ 12 (ทั้งของเก่าจากไฟล์เดิมและแถวมาช้า) ไม่ซ้ำ
      await prisma.logDays.deleteMany({ where: { serial } });
      await restored.ensureRange(
        deviceId,
        new Date('2020-05-01T00:00:00.000Z'),
        new Date('2020-05-31T00:00:00.000Z'),
      );
      await expect(prisma.logDayArchive.count({ where: { deviceId, probeId } })).resolves.toBe(12);
    });

    it('หลังผสาน ไม่ถือว่าค้างอีก (ไม่ผสานซ้ำวนไปเรื่อย ๆ)', async () => {
      // แถวมาช้า 2 แถวยังอยู่ใน DB ชุดเดิม แต่ create_at ของมันเก่ากว่าเวลา export ใหม่ → ไม่ pending
      await prisma.logDays.createMany({
        data: [row('late-new-1', 20), row('late-new-2', 21)].map((r) => ({
          ...r,
          createAt: new Date(Date.now() - 60_000),
        })),
      });
      await expect(exporter.findPendingMonths('log_days')).resolves.not.toContain(LATE);
    });
  });

  it('GET /health/archive ตอบ JSON สถานะ archive (200 ok หรือ 503 degraded) โดยไม่ต้องมี token', async () => {
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/health/archive`);
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toMatchObject({ status: 'ok', tables: expect.any(Array) });
      expect(res.body.tables.map((t: { table: string }) => t.table)).toEqual([
        'log_days',
        'notifications',
        'device_audit',
        'user_audit',
      ]);
    } else {
      expect(res.body.message).toMatch(/archive degraded/);
    }
  });
});
