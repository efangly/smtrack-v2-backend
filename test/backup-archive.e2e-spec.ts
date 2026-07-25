import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import configuration from '../src/config/configuration';
import { BackupModule, PG_POOL } from '../src/backup/backup.module';
import { ArchiveExportService } from '../src/backup/archive-export.service';
import { ArchiveRestoreService } from '../src/backup/archive-restore.service';
import { ObjectStorageService } from '../src/backup/object-storage.service';
import { archiveObjectKey, metaObjectKey, MonthString } from '../src/backup/archive.util';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildDevices, cleanupByPrefix, seedDevice, serialFor } from './fixtures/seed-data';

/**
 * เทสนี้คุย MinIO/Postgres จริงตาม .env — BackupModule ไม่ถูก stub เลย (ต่างจาก
 * createTestApp() ที่ override ObjectStorageService) เพื่อพิสูจน์ flow
 * export -> upload -> list -> restore -> report -> remove ทำงานจริงบน object storage
 *
 * ใช้เดือน 2020-01 ซึ่งอยู่นอกระยะที่ cron จริง (exportDueMonth มองย้อนหลังแค่ ~6
 * เดือนจาก "วันนี้" เสมอ) จะมีวันแตะถึง กันไม่ให้เทสไปเขียนทับ backup จริงในอนาคต
 */
describe('Backup archive export/restore (e2e, real MinIO + Postgres)', () => {
  const MONTH = '2020-01' as MonthString;
  const MONTH_START = new Date('2020-01-01T00:00:00.000Z');
  const PREFIX = 'E2E-ARCH-';
  const serial = serialFor(PREFIX, 1);
  const rowCount = 30;

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let exporter: ArchiveExportService;
  let restorer: ArchiveRestoreService;
  let storage: ObjectStorageService;

  function buildArchiveLogs() {
    return Array.from({ length: rowCount }, (_, i) => {
      const sendTime = new Date(Date.UTC(2020, 0, 1 + i, 12, 0, 0));
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

  async function cleanupAll() {
    await cleanupByPrefix(prisma, PREFIX);
    await prisma.logDayArchive.deleteMany({ where: { serial } });
    await prisma.archiveExport.deleteMany({ where: { month: MONTH_START } });
    await prisma.archiveRestore.deleteMany({ where: { month: MONTH_START } });
    for (const key of [archiveObjectKey(MONTH), metaObjectKey(MONTH)]) {
      if (await storage.exists(key)) await storage.delete(key);
    }
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
        BackupModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    exporter = moduleRef.get(ArchiveExportService);
    restorer = moduleRef.get(ArchiveRestoreService);
    storage = moduleRef.get(ObjectStorageService);

    // ป้องกันเขียนทับ backup จริง: ต้องไม่มี export ของเดือนนี้อยู่ก่อนแล้ว
    const existing = await prisma.archiveExport.findUnique({ where: { month: MONTH_START } });
    if (existing) {
      throw new Error(
        `พบ archive_export ของเดือน ${MONTH} อยู่แล้ว (rowCount=${existing.rowCount}) — ` +
          `หยุดเทสทันทีเพื่อไม่ให้เขียนทับ backup จริง กรุณาเปลี่ยนเดือนทดสอบ`,
      );
    }

    await cleanupAll();

    const [device] = buildDevices(PREFIX);
    await seedDevice(prisma, device);
    await prisma.logDays.createMany({ data: buildArchiveLogs() });
  });

  afterAll(async () => {
    await cleanupAll();
    // PG_POOL เป็น raw pg.Pool ไม่มี OnModuleDestroy — ต้องปิดเองไม่งั้น jest process ค้าง
    await moduleRef.get<Pool>(PG_POOL).end();
    await moduleRef.close();
  });

  it('exportMonth: COPY -> gzip -> upload ขึ้น MinIO จริง แล้วบันทึก audit row', async () => {
    const meta = await exporter.exportMonth(MONTH);

    expect(meta.rowCount).toBe(rowCount);
    expect(meta.month).toBe(MONTH);

    await expect(storage.exists(archiveObjectKey(MONTH))).resolves.toBe(true);
    await expect(storage.exists(metaObjectKey(MONTH))).resolves.toBe(true);

    const record = await prisma.archiveExport.findUnique({ where: { month: MONTH_START } });
    expect(record).not.toBeNull();
    expect(Number(record!.rowCount)).toBe(rowCount);
    expect(record!.sha256).toBe(meta.sha256);
    expect(record!.objectKey).toBe(archiveObjectKey(MONTH));
  });

  it('listAvailable: เห็น object ที่เพิ่ง upload จริงบน MinIO ว่ายังไม่ถูก restore', async () => {
    const available = await restorer.listAvailable();
    const entry = available.find((a) => a.month === MONTH);

    expect(entry).toBeDefined();
    expect(entry!.restored).toBe(false);
    expect(entry!.sizeBytes).toBeGreaterThan(0);
  });

  it('restoreMonth: download -> gunzip -> COPY เข้า LogDayArchive และข้อมูลตรงกับต้นฉบับ (สำหรับทำ report)', async () => {
    const result = await restorer.restoreMonth(MONTH);

    expect(result.rowCount).toBe(rowCount);

    const restoredRows = await prisma.logDayArchive.findMany({
      where: { serial },
      orderBy: { sendTime: 'asc' },
    });
    expect(restoredRows).toHaveLength(rowCount);

    const original = buildArchiveLogs();
    restoredRows.forEach((row, i) => {
      expect(row.sendTime.toISOString()).toBe(original[i].sendTime.toISOString());
      expect(row.temp).toBeCloseTo(original[i].temp, 5);
      expect(row.humidity).toBeCloseTo(original[i].humidity, 5);
      expect(row.battery).toBe(original[i].battery);
    });
  });

  it('restoreMonth ซ้ำ: ปฏิเสธด้วย ConflictException กันโดน restore ซ้ำ', async () => {
    await expect(restorer.restoreMonth(MONTH)).rejects.toThrow(ConflictException);
  });

  it('listAvailable: หลัง restore แล้วสถานะต้องเปลี่ยนเป็น restored=true', async () => {
    const available = await restorer.listAvailable();
    const entry = available.find((a) => a.month === MONTH);

    expect(entry?.restored).toBe(true);
  });

  it('removeMonth: เคลียร์ LogDayArchive + audit row ออก แต่ไฟล์บน MinIO ต้องยังอยู่', async () => {
    const result = await restorer.removeMonth(MONTH);

    expect(result.removedRows).toBe(rowCount);

    await expect(prisma.logDayArchive.count({ where: { serial } })).resolves.toBe(0);
    await expect(
      prisma.archiveRestore.findUnique({ where: { month: MONTH_START } }),
    ).resolves.toBeNull();

    await expect(storage.exists(archiveObjectKey(MONTH))).resolves.toBe(true);
  });
});
