import { Readable, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { RestoredWindowService } from './restored-window.service';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { RestoreInProgressException } from '../common/exceptions/restore-in-progress.exception';
import { LOG_DAYS_COLUMNS } from './archive-tables';

const NOW = new Date('2026-07-15T00:00:00.000Z'); // hot window เริ่ม 2026-06-01
const DEVICE = 'device-1';
const MARCH = new Date('2026-03-01T00:00:00.000Z');
const range = (from: string, to: string) => [new Date(from), new Date(to)] as const;

function ingestStream(): Writable {
  return new Writable({ write: (_c, _e, cb) => cb() });
}

describe('RestoredWindowService', () => {
  let service: RestoredWindowService;
  let storage: { exists: jest.Mock; getJson: jest.Mock; getStream: jest.Mock };
  let prisma: {
    archiveExport: { findMany: jest.Mock };
    restoredWindow: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let clientQuery: jest.Mock;
  let client: { query: jest.Mock; release: jest.Mock };
  let pool: { connect: jest.Mock };

  const win = (over: Record<string, unknown> = {}) => ({
    id: 'w1',
    status: 'done',
    requestedAt: new Date(NOW.getTime() - 60_000),
    error: null,
    ...over,
  });
  const archivedMarch = () => prisma.archiveExport.findMany.mockResolvedValue([{ month: MARCH }]);
  const sqlCalls = () =>
    clientQuery.mock.calls.filter(([a]) => typeof a === 'string').map(([a]) => a as string);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    storage = {
      exists: jest.fn().mockResolvedValue(true),
      getJson: jest.fn().mockResolvedValue({ rowCount: 5, columns: LOG_DAYS_COLUMNS }),
      getStream: jest
        .fn()
        .mockImplementation(() => Promise.resolve(Readable.from([gzipSync(Buffer.from('id\n'))]))),
    };
    prisma = {
      archiveExport: { findMany: jest.fn().mockResolvedValue([]) },
      restoredWindow: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'w1' }),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    clientQuery = jest.fn().mockImplementation((arg: unknown) => {
      if (typeof arg === 'string') {
        return Promise.resolve({ rowCount: arg.includes('INSERT INTO') ? 4 : 0, rows: [] });
      }
      return ingestStream();
    });
    client = { query: clientQuery, release: jest.fn() };
    pool = { connect: jest.fn().mockResolvedValue(client) };

    service = new RestoredWindowService(
      storage as unknown as ObjectStorageService,
      prisma as unknown as PrismaService,
      pool as any,
    );
    // ให้การ "รอ" เดินเวลาปลอมไปข้างหน้า แทนที่จะรอจริง
    jest.spyOn(service as any, 'sleep').mockImplementation((ms: number) => {
      jest.advanceTimersByTime(ms);
      return Promise.resolve();
    });
  });

  afterEach(() => jest.useRealTimers());

  describe('ensureRange', () => {
    it('ช่วงที่อยู่ใน hot window ทั้งหมด: ไม่แตะ DB หรือ storage เลย', async () => {
      await service.ensureRange(
        DEVICE,
        ...range('2026-06-10T00:00:00Z', '2026-07-15T00:00:00Z'),
        NOW,
      );
      expect(prisma.archiveExport.findMany).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('ขอย้อนหลังเกิน 6 เดือนต่อคำขอ: 400', async () => {
      await expect(
        service.ensureRange(DEVICE, ...range('2025-10-01T00:00:00Z', '2026-05-31T00:00:00Z'), NOW),
      ).rejects.toThrow(BadRequestException);
    });

    it('เดือนที่ไม่มี archive: ไม่ restore (ข้อมูลยังอยู่ใน log_days หรือไม่เคยมี)', async () => {
      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );
      expect(prisma.restoredWindow.findUnique).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('ช่วงคาบเกี่ยว hot window: restore เฉพาะเดือนที่อยู่นอก window', async () => {
      prisma.archiveExport.findMany.mockResolvedValue([]);
      await service.ensureRange(
        DEVICE,
        ...range('2026-04-20T00:00:00Z', '2026-07-01T00:00:00Z'),
        NOW,
      );
      const asked = prisma.archiveExport.findMany.mock.calls[0][0].where.month.in as Date[];
      expect(asked.map((d) => d.toISOString().slice(0, 7))).toEqual(['2026-04', '2026-05']);
    });

    it('ยังไม่เคย restore: สร้างแถวสถานะ, restore, แล้วตั้ง done พร้อม TTL 24 ชม.', async () => {
      archivedMarch();

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(prisma.restoredWindow.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceTable: 'log_days',
            deviceId: DEVICE,
            month: MARCH,
            expiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000),
          }),
        }),
      );
      expect(storage.getStream).toHaveBeenCalledWith('log-days/2026/03/log-days-2026-03.csv.gz');
      const sql = sqlCalls();
      expect(sql[0]).toBe('BEGIN');
      expect(sql.some((s) => s.includes('CREATE TEMP TABLE "_restore_tmp"'))).toBe(true);
      expect(sql[sql.length - 1]).toBe('COMMIT');
      expect(prisma.restoredWindow.update).toHaveBeenLastCalledWith({
        where: { id: 'w1' },
        data: expect.objectContaining({ status: 'done', rowCount: BigInt(4) }),
      });
      expect(client.release).toHaveBeenCalled();
    });

    it('INSERT กรองเฉพาะ device นี้ และกันแถวที่มีอยู่แล้วทั้งใน log_days และ log_day_archive', async () => {
      archivedMarch();
      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      const insert = sqlCalls().find((s) => s.includes('INSERT INTO "log_day_archive"'))!;
      expect(insert).toContain('t."device_id" = $1');
      expect(insert).toContain('FROM "log_days" l');
      expect(insert).toContain('FROM "log_day_archive" x');
      expect(clientQuery).toHaveBeenCalledWith(insert, [DEVICE]);
    });

    it('ไฟล์ legacy (meta ไม่มี columns): ผูกจุดติดตั้งผ่าน device_assignments ตามช่วงเวลา', async () => {
      archivedMarch();
      storage.getJson.mockResolvedValue({ rowCount: 5 });

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      const insert = sqlCalls().find((s) => s.includes('INSERT INTO "log_day_archive"'))!;
      expect(insert).toContain('JOIN LATERAL');
      expect(insert).toContain('FROM "device_assignments" a');
      expect(insert).toContain('m."device_id"');
      expect(insert).not.toContain('t."device_id" = $1');
    });

    it('meta ระบุคอลัมน์ที่ไม่รู้จัก: ปฏิเสธและตั้ง failed', async () => {
      archivedMarch();
      storage.getJson.mockResolvedValue({ rowCount: 1, columns: ['id', 'x; DROP TABLE y'] });

      await expect(
        service.ensureRange(DEVICE, ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'), NOW),
      ).rejects.toThrow(BadRequestException);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(prisma.restoredWindow.update).toHaveBeenLastCalledWith({
        where: { id: 'w1' },
        data: expect.objectContaining({ status: 'failed' }),
      });
    });

    it('ไฟล์ archive หาย: 404 และตั้ง failed', async () => {
      archivedMarch();
      storage.exists.mockResolvedValue(false);

      await expect(
        service.ensureRange(DEVICE, ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'), NOW),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.restoredWindow.update).toHaveBeenLastCalledWith({
        where: { id: 'w1' },
        data: expect.objectContaining({ status: 'failed' }),
      });
    });

    it('COPY ล้มเหลวกลางทาง: ROLLBACK, คืน connection, ตั้ง failed', async () => {
      archivedMarch();
      storage.getStream.mockRejectedValue(new Error('s3 reset'));

      await expect(
        service.ensureRange(DEVICE, ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'), NOW),
      ).rejects.toThrow('s3 reset');
      expect(sqlCalls()).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
      expect(prisma.restoredWindow.update).toHaveBeenLastCalledWith({
        where: { id: 'w1' },
        data: expect.objectContaining({ status: 'failed', error: 's3 reset' }),
      });
    });

    it('restore แล้ว (done): ต่ออายุ TTL แบบ sliding และไม่ restore ซ้ำ', async () => {
      archivedMarch();
      prisma.restoredWindow.findUnique.mockResolvedValue(win({ status: 'done' }));

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(prisma.restoredWindow.updateMany).toHaveBeenCalledWith({
        where: { id: 'w1', status: 'done' },
        data: {
          lastReadAt: NOW,
          expiresAt: new Date(NOW.getTime() + 24 * 3600 * 1000),
        },
      });
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('ต่ออายุไม่ทัน (cleanup ลบแถวตัดหน้า): วนกลับไป restore ใหม่', async () => {
      archivedMarch();
      prisma.restoredWindow.findUnique
        .mockResolvedValueOnce(win({ status: 'done' }))
        .mockResolvedValue(null);
      prisma.restoredWindow.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(prisma.restoredWindow.create).toHaveBeenCalledTimes(1);
      expect(pool.connect).toHaveBeenCalledTimes(1);
    });

    it('request อื่น/pod อื่นกำลัง restore อยู่: รอจนเสร็จ ไม่ restore ซ้ำ', async () => {
      archivedMarch();
      prisma.restoredWindow.findUnique
        .mockResolvedValueOnce(win({ status: 'running' }))
        .mockResolvedValueOnce(win({ status: 'running' }))
        .mockResolvedValue(win({ status: 'done' }));

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(pool.connect).not.toHaveBeenCalled();
      expect(prisma.restoredWindow.create).not.toHaveBeenCalled();
    });

    it('restore ไม่เสร็จใน 10 วินาที: ตอบ 202 (RestoreInProgress)', async () => {
      archivedMarch();
      prisma.restoredWindow.findUnique.mockResolvedValue(win({ status: 'running' }));

      await expect(
        service.ensureRange(DEVICE, ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'), NOW),
      ).rejects.toBeInstanceOf(RestoreInProgressException);
    });

    it('แถว running ที่ค้างเกิน 10 นาที (pod เจ้าของตาย): ตัวใหม่เข้ารับช่วงด้วย compare-and-set', async () => {
      archivedMarch();
      const requestedAt = new Date(NOW.getTime() - 11 * 60_000);
      prisma.restoredWindow.findUnique.mockResolvedValue(win({ status: 'running', requestedAt }));

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(prisma.restoredWindow.updateMany).toHaveBeenCalledWith({
        where: { id: 'w1', status: 'running', requestedAt },
        data: expect.objectContaining({ status: 'pending', error: null }),
      });
      expect(pool.connect).toHaveBeenCalledTimes(1);
    });

    it('แพ้การ claim แถวค้าง: ไม่ restore เอง วนรอผู้ชนะ', async () => {
      archivedMarch();
      const requestedAt = new Date(NOW.getTime() - 11 * 60_000);
      prisma.restoredWindow.findUnique
        .mockResolvedValueOnce(win({ status: 'running', requestedAt }))
        .mockResolvedValue(win({ status: 'done' }));
      prisma.restoredWindow.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('เพิ่งล้มเหลวภายใน 30 วินาที: ไม่ลองซ้ำ ตอบ 503 พร้อมสาเหตุ', async () => {
      archivedMarch();
      prisma.restoredWindow.findUnique.mockResolvedValue(
        win({ status: 'failed', error: 's3 down', requestedAt: new Date(NOW.getTime() - 5_000) }),
      );

      await expect(
        service.ensureRange(DEVICE, ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'), NOW),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('ล้มเหลวมานานกว่า 30 วินาที: ลองใหม่', async () => {
      archivedMarch();
      prisma.restoredWindow.findUnique.mockResolvedValue(
        win({ status: 'failed', requestedAt: new Date(NOW.getTime() - 60_000) }),
      );

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(pool.connect).toHaveBeenCalledTimes(1);
    });

    it('มีคนตัดหน้าสร้างแถวก่อน (unique violation): วนกลับไปรอเขา', async () => {
      archivedMarch();
      prisma.restoredWindow.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(win({ status: 'done' }));
      prisma.restoredWindow.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );

      await service.ensureRange(
        DEVICE,
        ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'),
        NOW,
      );

      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('restore พร้อมกันเต็มเพดานของ pod: ไม่เริ่มงานใหม่ ตอบ 202', async () => {
      archivedMarch();
      (service as any).active = 2;

      await expect(
        service.ensureRange(DEVICE, ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'), NOW),
      ).rejects.toBeInstanceOf(RestoreInProgressException);
      expect(prisma.restoredWindow.create).not.toHaveBeenCalled();
    });

    it('หลาย restore เสร็จแล้วคืน slot (active กลับเป็น 0 แม้ล้มเหลว)', async () => {
      archivedMarch();
      storage.getStream.mockRejectedValue(new Error('boom'));
      await service
        .ensureRange(DEVICE, ...range('2026-03-10T00:00:00Z', '2026-03-20T00:00:00Z'), NOW)
        .catch(() => undefined);
      expect((service as any).active).toBe(0);
    });
  });

  describe('cleanupExpired', () => {
    it('ลบข้อมูลและแถวสถานะในทรานแซกชันเดียว โดยล็อกแถวก่อน', async () => {
      prisma.restoredWindow.findMany.mockResolvedValue([{ id: 'w1' }]);
      clientQuery.mockImplementation((sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ device_id: DEVICE, month: '2026-03-01' }],
          });
        }
        if (sql.includes('DELETE FROM "log_day_archive"'))
          return Promise.resolve({ rowCount: 120 });
        return Promise.resolve({ rowCount: 0, rows: [] });
      });

      const res = await service.cleanupExpired(NOW);

      expect(res).toEqual({ removedWindows: 1, removedRows: 120 });
      const sql = sqlCalls();
      expect(sql[0]).toBe('BEGIN');
      expect(sql.findIndex((s) => s.includes('FOR UPDATE'))).toBeLessThan(
        sql.findIndex((s) => s.includes('DELETE FROM "log_day_archive"')),
      );
      expect(sql).toContain('COMMIT');
      expect(clientQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "log_day_archive"'),
        [DEVICE, '2026-03-01'],
      );
    });

    it('ถูกต่ออายุตัดหน้าระหว่างรอ (ล็อกแล้วไม่ตรงเงื่อนไขหมดอายุ): ไม่ลบอะไร', async () => {
      prisma.restoredWindow.findMany.mockResolvedValue([{ id: 'w1' }]);
      clientQuery.mockImplementation((sql: string) =>
        Promise.resolve({ rowCount: 0, rows: [], sql }),
      );

      const res = await service.cleanupExpired(NOW);

      expect(res).toEqual({ removedWindows: 0, removedRows: 0 });
      expect(sqlCalls()).toContain('ROLLBACK');
      expect(sqlCalls().some((s) => s.includes('DELETE'))).toBe(false);
    });

    it('error ระหว่างลบ: ROLLBACK และ throw (ไม่ทิ้งแถวสถานะที่ไม่ตรงกับข้อมูล)', async () => {
      prisma.restoredWindow.findMany.mockResolvedValue([{ id: 'w1' }]);
      clientQuery.mockImplementation((sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ device_id: DEVICE, month: '2026-03-01' }],
          });
        }
        if (sql.includes('DELETE FROM "log_day_archive"'))
          return Promise.reject(new Error('deadlock'));
        return Promise.resolve({ rowCount: 0, rows: [] });
      });

      await expect(service.cleanupExpired(NOW)).rejects.toThrow('deadlock');
      expect(sqlCalls()).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });

    it('เลือก candidate: done ที่หมดอายุ + แถวสถานะอื่นที่ค้างเกิน 1 ชม.', async () => {
      await service.cleanupExpired(NOW);
      expect(prisma.restoredWindow.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { status: 'done', expiresAt: { lt: NOW } },
              {
                status: { in: ['failed', 'pending', 'running'] },
                requestedAt: { lt: new Date(NOW.getTime() - 3600_000) },
              },
            ],
          },
        }),
      );
    });
  });
});
