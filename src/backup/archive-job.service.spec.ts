import { ConfigService } from '@nestjs/config';
import { ArchiveJobService } from './archive-job.service';
import { ArchiveExportService } from './archive-export.service';
import { RestoredWindowService } from './restored-window.service';
import { ObjectStorageService } from './object-storage.service';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/configuration';

describe('ArchiveJobService', () => {
  let exporter: {
    findPendingMonths: jest.Mock;
    exportMonth: jest.Mock;
    dropVerifiedChunks: jest.Mock;
    planDrop: jest.Mock;
    countMonth: jest.Mock;
  };
  let prisma: {
    archiveJobRun: { create: jest.Mock; update: jest.Mock };
    archiveExport: { findMany: jest.Mock };
  };
  let lockQuery: jest.Mock;
  let lockClient: { connect: jest.Mock; query: jest.Mock; end: jest.Mock };
  let restored: { cleanupExpired: jest.Mock };
  let storage: { exists: jest.Mock; getStream: jest.Mock };
  let service: ArchiveJobService;
  let runCounter: number;

  const setLock = (locked: boolean) =>
    lockQuery.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('pg_try_advisory_lock') ? { rows: [{ locked }] } : { rows: [] }),
    );

  beforeEach(() => {
    runCounter = 0;
    exporter = {
      findPendingMonths: jest.fn().mockResolvedValue([]),
      exportMonth: jest.fn().mockResolvedValue({ rowCount: 7, sha256: 'abc' }),
      dropVerifiedChunks: jest.fn().mockResolvedValue({ droppedChunks: 2 }),
      planDrop: jest.fn().mockResolvedValue({ cutoff: new Date('2026-06-01Z'), pending: [] }),
      countMonth: jest.fn().mockResolvedValue(42),
    };
    storage = { exists: jest.fn().mockResolvedValue(true), getStream: jest.fn() };
    restored = {
      cleanupExpired: jest.fn().mockResolvedValue({ removedWindows: 3, removedRows: 90 }),
    };
    prisma = {
      archiveExport: { findMany: jest.fn().mockResolvedValue([]) },
      archiveJobRun: {
        create: jest.fn().mockImplementation(() => Promise.resolve({ id: `run-${++runCounter}` })),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    lockQuery = jest.fn();
    setLock(true);
    lockClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: lockQuery,
      end: jest.fn(),
    };

    service = new ArchiveJobService(
      exporter as unknown as ArchiveExportService,
      restored as unknown as RestoredWindowService,
      storage as unknown as ObjectStorageService,
      prisma as unknown as PrismaService,
      { get: jest.fn().mockReturnValue('postgres://x') } as unknown as ConfigService<AppConfig>,
    );
    jest.spyOn(service as any, 'createLockClient').mockReturnValue(lockClient);
  });

  const statusUpdates = () =>
    prisma.archiveJobRun.update.mock.calls.map(([arg]) => arg.data.status);

  it('export ทุกเดือนที่ค้างของทุกตาราง แล้ว drop ต่อตาราง และบันทึกทุกขั้นลง archive_job_run', async () => {
    exporter.findPendingMonths.mockImplementation((table: string) =>
      Promise.resolve(table === 'log_days' ? ['2026-04', '2026-05'] : []),
    );

    const outcome = await service.runExportAndDrop();

    expect(outcome).toEqual({ ok: true, skipped: false, failures: [] });
    expect(exporter.exportMonth).toHaveBeenCalledWith('2026-04', 'log_days');
    expect(exporter.exportMonth).toHaveBeenCalledWith('2026-05', 'log_days');
    expect(exporter.dropVerifiedChunks).toHaveBeenCalledTimes(4);
    // export 2 เดือน + drop 4 ตาราง
    expect(prisma.archiveJobRun.create).toHaveBeenCalledTimes(6);
    expect(statusUpdates().every((s: string) => s === 'succeeded')).toBe(true);
    expect(prisma.archiveJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ rowCount: BigInt(7), sha256: 'abc' }),
      }),
    );
  });

  it('export เดือนหนึ่งล้มเหลว: บันทึก failed, ไปต่อเดือนอื่น, ยัง drop, และ ok=false', async () => {
    exporter.findPendingMonths.mockResolvedValueOnce(['2026-04', '2026-05']).mockResolvedValue([]);
    exporter.exportMonth.mockRejectedValueOnce(new Error('storage down'));

    const outcome = await service.runExportAndDrop({ tables: ['log_days'] });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toEqual(['export log_days 2026-04: storage down']);
    expect(exporter.exportMonth).toHaveBeenCalledTimes(2);
    expect(exporter.dropVerifiedChunks).toHaveBeenCalledTimes(1);
    expect(prisma.archiveJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', error: 'storage down' }),
      }),
    );
  });

  it('drop ล้มเหลวของตารางหนึ่งไม่หยุดตารางถัดไป', async () => {
    exporter.dropVerifiedChunks
      .mockRejectedValueOnce(new Error('timescaledb error'))
      .mockResolvedValue({ droppedChunks: 0 });

    const outcome = await service.runExportAndDrop();

    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toEqual(['drop log_days: timescaledb error']);
    expect(exporter.dropVerifiedChunks).toHaveBeenCalledTimes(4);
  });

  it('จำกัดเฉพาะตารางที่ระบุ', async () => {
    await service.runExportAndDrop({ tables: ['notifications'] });
    expect(exporter.dropVerifiedChunks).toHaveBeenCalledTimes(1);
    expect(exporter.dropVerifiedChunks).toHaveBeenCalledWith('notifications', expect.any(Date));
  });

  it('dry-run: ไม่ export ไม่ drop ไม่เขียน archive_job_run', async () => {
    const outcome = await service.runExportAndDrop({ dryRun: true });

    expect(outcome.ok).toBe(true);
    expect(exporter.planDrop).toHaveBeenCalledTimes(4);
    expect(exporter.exportMonth).not.toHaveBeenCalled();
    expect(exporter.dropVerifiedChunks).not.toHaveBeenCalled();
    expect(prisma.archiveJobRun.create).not.toHaveBeenCalled();
  });

  describe('advisory lock', () => {
    it('ได้ล็อก: ปลดล็อกและปิด connection หลังงานเสร็จ', async () => {
      await service.runExportAndDrop({ tables: ['log_days'] });

      const sqls = lockQuery.mock.calls.map(([sql]) => sql as string);
      expect(sqls[0]).toContain('pg_try_advisory_lock');
      expect(sqls[sqls.length - 1]).toContain('pg_advisory_unlock');
      expect(lockQuery.mock.calls[0][1]).toEqual(['archive-job:export-and-drop']);
      expect(lockClient.end).toHaveBeenCalled();
    });

    it('ปลดล็อกแม้งานระหว่างทางโยน error', async () => {
      prisma.archiveJobRun.create.mockRejectedValue(new Error('db down'));

      await expect(service.runExportAndDrop({ tables: ['log_days'] })).rejects.toThrow('db down');

      const sqls = lockQuery.mock.calls.map(([sql]) => sql as string);
      expect(sqls[sqls.length - 1]).toContain('pg_advisory_unlock');
      expect(lockClient.end).toHaveBeenCalled();
    });

    it('มีคนถือล็อกอยู่: ข้ามงาน, บันทึก skipped, ไม่ปลดล็อกของคนอื่น, ok=true', async () => {
      setLock(false);

      const outcome = await service.runExportAndDrop();

      expect(outcome).toEqual({ ok: true, skipped: true, failures: [] });
      expect(exporter.exportMonth).not.toHaveBeenCalled();
      expect(exporter.dropVerifiedChunks).not.toHaveBeenCalled();
      expect(statusUpdates()).toEqual(['skipped']);
      expect(lockQuery.mock.calls.some(([sql]) => String(sql).includes('unlock'))).toBe(false);
      expect(lockClient.end).toHaveBeenCalled();
    });
  });

  describe('runCleanupRestored', () => {
    it('ลบข้อมูลที่หมดอายุและบันทึกจำนวนแถวที่ลบลง archive_job_run', async () => {
      const outcome = await service.runCleanupRestored();

      expect(outcome).toEqual({ ok: true, skipped: false, failures: [] });
      expect(restored.cleanupExpired).toHaveBeenCalledTimes(1);
      expect(prisma.archiveJobRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'succeeded', rowCount: BigInt(90) }),
        }),
      );
      expect(lockQuery.mock.calls[0][1]).toEqual(['archive-job:cleanup-restored']);
    });

    it('cleanup ล้มเหลว: บันทึก failed และ ok=false', async () => {
      restored.cleanupExpired.mockRejectedValue(new Error('lock timeout'));

      const outcome = await service.runCleanupRestored();

      expect(outcome.ok).toBe(false);
      expect(outcome.failures).toEqual(['cleanup-restored: lock timeout']);
    });

    it('dry-run: ไม่ลบอะไร', async () => {
      await service.runCleanupRestored({ dryRun: true });
      expect(restored.cleanupExpired).not.toHaveBeenCalled();
    });
  });

  describe('runBackfill (ขั้น 3 ของ cut-over: archive ข้อมูลเก่าโดยไม่ลบ)', () => {
    const pendingByTable = (map: Record<string, string[]>) =>
      exporter.findPendingMonths.mockImplementation((t: string) => Promise.resolve(map[t] ?? []));

    it('export ทุกเดือนที่ค้างแต่ "ไม่ drop" อะไรเลย และบันทึกเป็น job backfill', async () => {
      pendingByTable({ log_days: ['2026-03', '2026-04'], notifications: ['2026-04'] });

      const outcome = await service.runBackfill();

      expect(outcome.ok).toBe(true);
      expect(exporter.exportMonth).toHaveBeenCalledTimes(3);
      expect(exporter.dropVerifiedChunks).not.toHaveBeenCalled();
      expect(prisma.archiveJobRun.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ job: 'backfill' }) }),
      );
    });

    it('ใช้ล็อกเดียวกับ export-and-drop เพื่อไม่ให้ซ้อนกับ CronJob', async () => {
      await service.runBackfill();
      expect(lockQuery.mock.calls[0][1]).toEqual(['archive-job:export-and-drop']);
    });

    it('จำกัดช่วงเดือน (รวมทั้งสองปลาย) และตาราง', async () => {
      pendingByTable({ log_days: ['2026-01', '2026-02', '2026-03', '2026-04'] });

      await service.runBackfill({ tables: ['log_days'], from: '2026-02', to: '2026-03' });

      expect(exporter.exportMonth.mock.calls.map(([m]) => m)).toEqual(['2026-02', '2026-03']);
    });

    it('เดือนหนึ่งล้มเหลว: ไปต่อเดือนอื่น, ok=false, ไม่ drop', async () => {
      pendingByTable({ log_days: ['2026-03', '2026-04'] });
      exporter.exportMonth.mockRejectedValueOnce(new Error('s3 down'));

      const outcome = await service.runBackfill({ tables: ['log_days'] });

      expect(outcome.ok).toBe(false);
      expect(outcome.failures).toEqual(['backfill log_days 2026-03: s3 down']);
      expect(exporter.exportMonth).toHaveBeenCalledTimes(2);
      expect(exporter.dropVerifiedChunks).not.toHaveBeenCalled();
    });

    it('dry-run: นับแถวในฐานข้อมูลต่อเดือน ไม่ export ไม่เขียน archive_job_run', async () => {
      pendingByTable({ log_days: ['2026-03'] });

      const outcome = await service.runBackfill({ dryRun: true, tables: ['log_days'] });

      expect(outcome.ok).toBe(true);
      expect(exporter.countMonth).toHaveBeenCalledWith('log_days', '2026-03');
      expect(exporter.exportMonth).not.toHaveBeenCalled();
      expect(prisma.archiveJobRun.create).not.toHaveBeenCalled();
    });
  });

  describe('runVerify (ขั้น 4: พร้อมถอด add_retention_policy ไหม)', () => {
    const NOW = new Date('2026-07-15T00:00:00.000Z'); // hot window เริ่ม 2026-06-01
    const csv = 'id,v\na,1\nb,2\n';
    const sha = createHash('sha256').update(csv).digest('hex');
    const rec = (month: string, over: Record<string, unknown> = {}) => ({
      sourceTable: 'log_days',
      month: new Date(`${month}-01T00:00:00.000Z`),
      rowCount: BigInt(2),
      objectKey: `log-days/${month.replace('-', '/')}/x.csv.gz`,
      sha256: sha,
      ...over,
    });
    const good = () => Readable.from([gzipSync(Buffer.from(csv))]);

    beforeEach(() => {
      storage.getStream.mockImplementation(() => Promise.resolve(good()));
      prisma.archiveExport.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where.sourceTable === 'log_days' ? [rec('2026-04'), rec('2026-05')] : []),
      );
    });

    it('ไฟล์ครบ จำนวนและ sha256 ตรง และไม่มีเดือนค้าง: ผ่าน', async () => {
      const outcome = await service.runVerify({ now: NOW });

      expect(outcome).toEqual({ ok: true, skipped: false, failures: [] });
      expect(statusUpdates().every((st: string) => st === 'succeeded')).toBe(true);
      expect(prisma.archiveJobRun.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ job: 'verify' }) }),
      );
    });

    it('ไฟล์หายจาก object storage: ไม่ผ่าน', async () => {
      storage.exists.mockImplementation((k: string) => Promise.resolve(!k.includes('2026/04')));

      const outcome = await service.runVerify({ now: NOW, tables: ['log_days'] });

      expect(outcome.ok).toBe(false);
      expect(outcome.failures[0]).toMatch(/verify log_days 2026-04: object missing/);
    });

    it('เนื้อไฟล์ไม่ตรงกับ sha256 ที่บันทึก (ไฟล์เสีย/ถูกแก้): ไม่ผ่าน', async () => {
      storage.getStream.mockImplementation(() =>
        Promise.resolve(Readable.from([gzipSync(Buffer.from('id,v\na,1\nb,9\n'))])),
      );

      const outcome = await service.runVerify({ now: NOW, tables: ['log_days'] });

      expect(outcome.ok).toBe(false);
      expect(outcome.failures[0]).toMatch(/sha256 differs/);
    });

    it('จำนวนแถวในไฟล์ไม่ตรงกับ archive_export: ไม่ผ่าน', async () => {
      prisma.archiveExport.findMany.mockResolvedValue([rec('2026-04', { rowCount: BigInt(5) })]);

      const outcome = await service.runVerify({ now: NOW, tables: ['log_days'] });

      expect(outcome.failures[0]).toMatch(/row count: file has 2, archive_export says 5/);
    });

    it('ไฟล์ไม่ใช่ gzip / อ่านไม่ได้: ไม่ผ่านโดยไม่ทำให้ทั้งงานล้ม', async () => {
      storage.getStream.mockImplementation(() =>
        Promise.resolve(Readable.from([Buffer.from('not gzip')])),
      );

      const outcome = await service.runVerify({ now: NOW, tables: ['log_days'] });

      expect(outcome.ok).toBe(false);
      expect(outcome.failures).toHaveLength(2);
      expect(outcome.failures[0]).toMatch(/unreadable/);
    });

    it('เดือนที่เก่ากว่า hot window ยังค้างใน DB ไม่มี archive: ไม่ผ่าน (coverage)', async () => {
      exporter.findPendingMonths.mockResolvedValue(['2026-03']);

      const outcome = await service.runVerify({ now: NOW, tables: ['log_days'] });

      expect(outcome.ok).toBe(false);
      expect(outcome.failures).toContain(
        'coverage log_days 2026-03: still in database with no usable archive',
      );
    });

    it('เดือนก่อนหน้าที่ยังอยู่ใน hot window และค้างอยู่ ไม่ขวาง cut-over (cron วันที่ 1 จัดการ)', async () => {
      exporter.findPendingMonths.mockResolvedValue(['2026-06']);

      const outcome = await service.runVerify({ now: NOW, tables: ['log_days'] });

      expect(outcome.ok).toBe(true);
    });

    it('จำกัดช่วงเดือน: ตรวจเฉพาะเดือนที่ระบุ', async () => {
      await service.runVerify({ now: NOW, tables: ['log_days'], from: '2026-05', to: '2026-05' });
      expect(storage.getStream).toHaveBeenCalledTimes(1);
    });

    it('ไม่ใช่การเขียน: ไม่เรียก export หรือ drop เลย', async () => {
      await service.runVerify({ now: NOW });
      expect(exporter.exportMonth).not.toHaveBeenCalled();
      expect(exporter.dropVerifiedChunks).not.toHaveBeenCalled();
    });
  });
});
