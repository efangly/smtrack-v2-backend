import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { ArchiveExportService } from './archive-export.service';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/configuration';

const CSV_HEADER_AND_TWO_ROWS =
  'id,serial,temp,temp_display,humidity,humidity_display,send_time,plug,door1,door2,door3,internet,probe,battery,temp_internal,ext_memory,create_at,update_at\n' +
  'log-1,SN-1,5.5,5.5,60,60,2026-01-15T00:00:00.000Z,f,f,f,f,t,1,90,,f,2026-01-15T00:00:00.000Z,2026-01-15T00:00:00.000Z\n' +
  'log-2,SN-1,5.6,5.6,61,61,2026-01-16T00:00:00.000Z,f,f,f,f,t,1,89,,f,2026-01-16T00:00:00.000Z,2026-01-16T00:00:00.000Z\n';

describe('ArchiveExportService', () => {
  let service: ArchiveExportService;
  let storage: { uploadStream: jest.Mock; putJson: jest.Mock; delete: jest.Mock; bucket: string };
  let prisma: { logDays: { count: jest.Mock }; archiveExport: { upsert: jest.Mock } };
  let queryMock: jest.Mock;
  let pool: { connect: jest.Mock };

  const drainBody = (body: NodeJS.ReadableStream) =>
    new Promise<void>((resolve) => {
      body.on('data', () => undefined);
      body.on('end', resolve);
    });

  beforeEach(() => {
    storage = {
      uploadStream: jest.fn((_key: string, body: NodeJS.ReadableStream) => drainBody(body)),
      putJson: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      bucket: 'smtrack-log-archive',
    };
    prisma = {
      logDays: { count: jest.fn() },
      archiveExport: { upsert: jest.fn().mockResolvedValue(undefined) },
    };
    queryMock = jest.fn().mockReturnValue(Readable.from([Buffer.from(CSV_HEADER_AND_TWO_ROWS)]));
    pool = {
      connect: jest.fn().mockResolvedValue({ query: queryMock, release: jest.fn() }),
    };

    const config = { get: jest.fn().mockReturnValue(6) } as unknown as ConfigService<AppConfig>;

    service = new ArchiveExportService(
      storage as unknown as ObjectStorageService,
      prisma as unknown as PrismaService,
      config,
      pool as any,
    );
  });

  it('export สำเร็จ: อัปโหลด, ตรวจ row count ตรง, upsert ArchiveExport', async () => {
    prisma.logDays.count.mockResolvedValue(2);

    const meta = await service.exportMonth('2026-01');

    expect(storage.uploadStream).toHaveBeenCalledWith(
      'log-days/2026/01/log-days-2026-01.csv.gz',
      expect.anything(),
      'application/gzip',
    );
    expect(meta.rowCount).toBe(2);
    expect(meta.month).toBe('2026-01');
    expect(typeof meta.sha256).toBe('string');
    expect(storage.putJson).toHaveBeenCalledWith(
      'log-days/2026/01/log-days-2026-01.meta.json',
      meta,
    );
    expect(prisma.archiveExport.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { month: new Date('2026-01-01T00:00:00.000Z') },
        create: expect.objectContaining({
          rowCount: BigInt(2),
          objectKey: 'log-days/2026/01/log-days-2026-01.csv.gz',
        }),
      }),
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('row count ไม่ตรง: ลบ object ที่อัปโหลดไปแล้วและ throw โดยไม่ upsert', async () => {
    prisma.logDays.count.mockResolvedValue(999);

    await expect(service.exportMonth('2026-01')).rejects.toThrow('row count mismatch');

    expect(storage.delete).toHaveBeenCalledWith('log-days/2026/01/log-days-2026-01.csv.gz');
    expect(prisma.archiveExport.upsert).not.toHaveBeenCalled();
  });

  it('exportMonth ปฏิเสธรูปแบบเดือนที่ไม่ถูกต้อง', async () => {
    await expect(service.exportMonth('not-a-month' as any)).rejects.toThrow(
      'รูปแบบเดือนไม่ถูกต้อง',
    );
  });

  it('exportDueMonth คำนวณเดือนเป้าหมายจาก retentionMonths - 1', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T03:00:00.000Z'));
    prisma.logDays.count.mockResolvedValue(2);
    const spy = jest.spyOn(service, 'exportMonth');

    await service.exportDueMonth();

    // retentionMonths=6 -> buffer เดือน = now - 5 เดือน = 2026-02
    expect(spy).toHaveBeenCalledWith('2026-02');
    jest.useRealTimers();
  });
});
