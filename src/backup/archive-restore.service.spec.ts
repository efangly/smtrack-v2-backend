import { Readable, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArchiveRestoreService } from './archive-restore.service';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/configuration';

function makeIngestStream(rowCount: number): Writable & { rowCount: number } {
  const w = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as Writable & { rowCount: number };
  w.rowCount = rowCount;
  return w;
}

describe('ArchiveRestoreService', () => {
  let service: ArchiveRestoreService;
  let storage: {
    list: jest.Mock;
    exists: jest.Mock;
    getStream: jest.Mock;
    getJson: jest.Mock;
    bucket: string;
  };
  let prisma: { archiveRestore: { findMany: jest.Mock; findUnique: jest.Mock; delete: jest.Mock } };
  let clientQuery: jest.Mock;
  let client: { query: jest.Mock; release: jest.Mock };
  let pool: { connect: jest.Mock; query: jest.Mock };
  let config: ConfigService<AppConfig>;

  const gzippedCsv = () => Readable.from([gzipSync(Buffer.from('id,serial\n1,SN-1\n'))]);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T00:00:00.000Z'));

    storage = {
      list: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(true),
      getStream: jest.fn().mockImplementation(() => Promise.resolve(gzippedCsv())),
      getJson: jest.fn().mockResolvedValue({ rowCount: 2 }),
      bucket: 'smtrack-log-archive',
    };
    prisma = {
      archiveRestore: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };

    clientQuery = jest.fn().mockImplementation((arg: unknown) => {
      if (typeof arg === 'string') return Promise.resolve({});
      return makeIngestStream(2);
    });
    client = { query: clientQuery, release: jest.fn() };
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockResolvedValue({ rowCount: 5 }),
    };

    config = { get: jest.fn().mockReturnValue(6) } as unknown as ConfigService<AppConfig>;

    service = new ArchiveRestoreService(
      storage as unknown as ObjectStorageService,
      prisma as unknown as PrismaService,
      config,
      pool as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('listAvailable', () => {
    it('รวม storage list กับสถานะ restored จาก prisma', async () => {
      storage.list.mockResolvedValue([
        { key: 'log-days/2025/12/log-days-2025-12.csv.gz', size: 100 },
        { key: 'log-days/2026/01/log-days-2026-01.csv.gz', size: 200 },
        { key: 'log-days/2026/01/log-days-2026-01.meta.json', size: 1 },
      ]);
      prisma.archiveRestore.findMany.mockResolvedValue([
        { month: new Date('2025-12-01T00:00:00.000Z') },
      ]);

      const result = await service.listAvailable();

      expect(result).toEqual([
        { month: '2025-12', sizeBytes: 100, restored: true },
        { month: '2026-01', sizeBytes: 200, restored: false },
      ]);
    });
  });

  describe('restoreMonth', () => {
    it('ปฏิเสธรูปแบบเดือนที่ไม่ถูกต้อง', async () => {
      await expect(service.restoreMonth('bad' as any)).rejects.toThrow(BadRequestException);
    });

    it('ปฏิเสธเดือนที่ยังอยู่ใน retention window', async () => {
      // now = 2026-07-15, retentionMonths = 6 -> retentionEdge = 2026-01-15
      // เดือน 2026-06 สิ้นสุด (to) = 2026-07-01 ซึ่งอยู่หลัง retentionEdge
      await expect(service.restoreMonth('2026-06')).rejects.toThrow(BadRequestException);
    });

    it('ปฏิเสธเมื่อ restore ไปแล้ว (409)', async () => {
      prisma.archiveRestore.findUnique.mockResolvedValue({ rowCount: BigInt(2) });
      await expect(service.restoreMonth('2025-01')).rejects.toThrow(ConflictException);
    });

    it('ปฏิเสธเมื่อไม่มีไฟล์บน object storage (404)', async () => {
      storage.exists.mockResolvedValue(false);
      await expect(service.restoreMonth('2025-01')).rejects.toThrow(NotFoundException);
    });

    it('restore สำเร็จ: insert ArchiveRestore แล้ว commit', async () => {
      const result = await service.restoreMonth('2025-01');

      expect(result).toEqual({
        month: '2025-01',
        rowCount: 2,
        objectKey: 'log-days/2025/01/log-days-2025-01.csv.gz',
      });
      expect(clientQuery).toHaveBeenCalledWith('BEGIN');
      expect(clientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "archive_restore"'),
        [new Date('2025-01-01T00:00:00.000Z'), 2, 'log-days/2025/01/log-days-2025-01.csv.gz'],
      );
      expect(clientQuery).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalled();
    });

    it('rowCount ไม่ตรงกับ meta -> rollback ไม่ insert', async () => {
      storage.getJson.mockResolvedValue({ rowCount: 999 });

      await expect(service.restoreMonth('2025-01')).rejects.toThrow('mismatch');

      expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(clientQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO'),
        expect.anything(),
      );
    });
  });

  describe('removeMonth', () => {
    it('ปฏิเสธเมื่อเดือนนั้นไม่ได้ถูก restore อยู่', async () => {
      await expect(service.removeMonth('2026-01')).rejects.toThrow(NotFoundException);
    });

    it('ลบแถวใน LogDayArchive แล้วลบ audit row', async () => {
      prisma.archiveRestore.findUnique.mockResolvedValue({ rowCount: BigInt(5) });

      const result = await service.removeMonth('2026-01');

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "log_day_archive"'),
        [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-02-01T00:00:00.000Z')],
      );
      expect(prisma.archiveRestore.delete).toHaveBeenCalledWith({
        where: { month: new Date('2026-01-01T00:00:00.000Z') },
      });
      expect(result).toEqual({ month: '2026-01', removedRows: 5 });
    });
  });
});
