import { Readable, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { ArchiveExportService } from './archive-export.service';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';

const CSV_HEADER_AND_TWO_ROWS =
  'id,serial,temp,temp_display,humidity,humidity_display,send_time,plug,door1,door2,door3,internet,probe,battery,temp_internal,ext_memory,create_at,update_at\n' +
  'log-1,SN-1,5.5,5.5,60,60,2026-01-15T00:00:00.000Z,f,f,f,f,t,1,90,,f,2026-01-15T00:00:00.000Z,2026-01-15T00:00:00.000Z\n' +
  'log-2,SN-1,5.6,5.6,61,61,2026-01-16T00:00:00.000Z,f,f,f,f,t,1,89,,f,2026-01-16T00:00:00.000Z,2026-01-16T00:00:00.000Z\n';

// notifications.detail มีขึ้นบรรทัดใหม่อยู่ใน field (ครอบด้วย "...") — 2 record แต่มี \n ถึง 4 ตัว
const CSV_NOTIFICATIONS_MULTILINE =
  'id,detail\n' + 'n-1,"line1\nline2 ""quoted""\nline3"\n' + 'n-2,plain\n';

describe('ArchiveExportService', () => {
  let service: ArchiveExportService;
  let storage: {
    uploadStream: jest.Mock;
    putJson: jest.Mock;
    delete: jest.Mock;
    copy: jest.Mock;
    exists: jest.Mock;
    getJson: jest.Mock;
    getStream: jest.Mock;
    bucket: string;
  };
  let prisma: {
    archiveExport: { upsert: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
  };
  let clientQuery: jest.Mock;
  let poolQuery: jest.Mock;
  let pool: { connect: jest.Mock; query: jest.Mock };

  const drainBody = (body: NodeJS.ReadableStream) =>
    new Promise<void>((resolve) => {
      body.on('data', () => undefined);
      body.on('end', resolve);
    });

  /** poolQuery ตอบตามประเภท SQL: min(...) / count(*) / drop_chunks */
  const mockDb = (opts: {
    first?: Date | null;
    counts?: Record<string, number>; // key = YYYY-MM ของ parameter แรก
    defaultCount?: number;
    /** จำนวนแถวที่มาช้า (create_at หลัง export) ต่อเดือน — default 0 */
    lateCounts?: Record<string, number>;
    dropped?: number;
  }) => {
    poolQuery.mockImplementation((sql: string, params?: string[]) => {
      if (sql.includes('min(')) return Promise.resolve({ rows: [{ first: opts.first ?? null }] });
      if (sql.includes('count(*)') && sql.includes('"create_at" > $3')) {
        const key = params![0].slice(0, 7);
        return Promise.resolve({ rows: [{ count: String(opts.lateCounts?.[key] ?? 0) }] });
      }
      if (sql.includes('count(*)')) {
        const key = params![0].slice(0, 7);
        return Promise.resolve({
          rows: [{ count: String(opts.counts?.[key] ?? opts.defaultCount ?? 0) }],
        });
      }
      if (sql.includes('drop_chunks')) return Promise.resolve({ rowCount: opts.dropped ?? 0 });
      throw new Error(`unexpected sql: ${sql}`);
    });
  };

  beforeEach(() => {
    storage = {
      uploadStream: jest.fn((_key: string, body: NodeJS.ReadableStream) => drainBody(body)),
      putJson: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
      getJson: jest.fn().mockResolvedValue({ columns: ['id', 'serial'] }),
      getStream: jest.fn(),
      bucket: 'smtrack-log-archive',
    };
    prisma = {
      archiveExport: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    clientQuery = jest.fn().mockReturnValue(Readable.from([Buffer.from(CSV_HEADER_AND_TWO_ROWS)]));
    poolQuery = jest.fn();
    pool = {
      connect: jest.fn().mockResolvedValue({ query: clientQuery, release: jest.fn() }),
      query: poolQuery,
    };

    service = new ArchiveExportService(
      storage as unknown as ObjectStorageService,
      prisma as unknown as PrismaService,
      pool as any,
    );
  });

  describe('exportMonth', () => {
    const KEY = 'log-days/2026/01/log-days-2026-01.csv.gz';

    it('export สำเร็จ: เขียน staging → ตรวจ row count → meta → promote → ลบ staging → upsert', async () => {
      mockDb({ defaultCount: 2 });

      const meta = await service.exportMonth('2026-01');

      expect(storage.uploadStream).toHaveBeenCalledWith(
        `${KEY}.staging`,
        expect.anything(),
        'application/gzip',
      );
      expect(meta.rowCount).toBe(2);
      expect(meta.month).toBe('2026-01');
      expect(meta.table).toBe('log_days');
      expect(typeof meta.sha256).toBe('string');
      expect(storage.putJson).toHaveBeenCalledWith(
        'log-days/2026/01/log-days-2026-01.meta.json',
        meta,
      );
      expect(storage.copy).toHaveBeenCalledWith(`${KEY}.staging`, KEY);
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(`${KEY}.staging`);
      expect(prisma.archiveExport.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sourceTable_month: {
              sourceTable: 'log_days',
              month: new Date('2026-01-01T00:00:00.000Z'),
            },
          },
          create: expect.objectContaining({
            sourceTable: 'log_days',
            rowCount: BigInt(2),
            objectKey: KEY,
          }),
        }),
      );
      expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining('BEGIN'));
    });

    it('export ตารางอื่น: ใช้ prefix, คอลัมน์ และคอลัมน์เวลาของตารางนั้น', async () => {
      mockDb({ defaultCount: 2 });
      clientQuery.mockReturnValue(Readable.from([Buffer.from(CSV_NOTIFICATIONS_MULTILINE)]));

      const meta = await service.exportMonth('2026-03', 'notifications');

      expect(storage.uploadStream).toHaveBeenCalledWith(
        'notifications/2026/03/notifications-2026-03.csv.gz.staging',
        expect.anything(),
        'application/gzip',
      );
      expect(storage.copy).toHaveBeenCalledWith(
        'notifications/2026/03/notifications-2026-03.csv.gz.staging',
        'notifications/2026/03/notifications-2026-03.csv.gz',
      );
      const copySql = (clientQuery.mock.calls[0][0] as { text: string }).text;
      expect(copySql).toContain('FROM "notifications"');
      expect(copySql).toContain('"create_at" >=');
      expect(meta.table).toBe('notifications');
      expect(meta.columns).toContain('is_read');
      expect(prisma.archiveExport.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sourceTable_month: expect.objectContaining({ sourceTable: 'notifications' }) },
        }),
      );
    });

    it('field ที่มีขึ้นบรรทัดใหม่ในเครื่องหมายคำพูดไม่ถูกนับเป็นหลาย record', async () => {
      mockDb({ defaultCount: 2 });
      clientQuery.mockReturnValue(Readable.from([Buffer.from(CSV_NOTIFICATIONS_MULTILINE)]));

      const meta = await service.exportMonth('2026-03', 'notifications');

      expect(meta.rowCount).toBe(2);
    });

    it('row count ไม่ตรง: ลบเฉพาะไฟล์ staging (archive เดิมไม่ถูกแตะ) และไม่ promote/upsert', async () => {
      mockDb({ defaultCount: 999 });

      await expect(service.exportMonth('2026-01')).rejects.toThrow('row count mismatch');

      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(`${KEY}.staging`);
      expect(storage.copy).not.toHaveBeenCalled();
      expect(storage.putJson).not.toHaveBeenCalled();
      expect(prisma.archiveExport.upsert).not.toHaveBeenCalled();
    });

    it('อัปโหลดล้มเหลวกลางทาง: ไม่ promote, ไม่แตะ archive เดิม', async () => {
      mockDb({ defaultCount: 2 });
      storage.uploadStream.mockRejectedValue(new Error('s3 reset'));

      await expect(service.exportMonth('2026-01')).rejects.toThrow('s3 reset');

      expect(storage.copy).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalledWith(KEY);
      expect(prisma.archiveExport.upsert).not.toHaveBeenCalled();
    });

    it('export ซ้ำเมื่อ DB มีแถวครบหรือมากกว่า: export ปกติ และบันทึกเวลาเริ่ม export เป็น exportedAt', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-02-01T03:00:00.000Z'));
      mockDb({ defaultCount: 2 });
      prisma.archiveExport.findUnique.mockResolvedValue({ rowCount: BigInt(2) });

      await service.exportMonth('2026-01');

      expect(prisma.archiveExport.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ exportedAt: new Date('2026-02-01T03:00:00.000Z') }),
        }),
      );
      expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining('BEGIN'));
      jest.useRealTimers();
    });

    describe('ผสาน (chunk ถูก drop บางส่วนแล้วมีแถวใหม่ของเดือนเก่าเข้ามา)', () => {
      const gz = () => Readable.from([gzipSync(Buffer.from('id,serial\nold,SN-1\n'))]);

      /** เส้นทางผสานคุยผ่าน client เดียว: BEGIN, CREATE TEMP, COPY IN, นับ, COPY OUT, COMMIT */
      const mockMergeClient = (opts: { expected: string; csv: string }) => {
        clientQuery.mockImplementation((arg: unknown) => {
          if (typeof arg === 'string') {
            return Promise.resolve(
              arg.includes('count(*)') ? { rows: [{ count: opts.expected }] } : { rows: [] },
            );
          }
          const text = (arg as { text: string }).text;
          if (text.startsWith('COPY "_merge_tmp"')) {
            return new Writable({ write: (_c, _e, cb) => cb() });
          }
          return Readable.from([Buffer.from(opts.csv)]);
        });
        storage.getStream.mockImplementation(() => Promise.resolve(gz()));
      };
      const csv = (rows: number) =>
        'id,serial\n' + Array.from({ length: rows }, (_, i) => `r${i},SN-1\n`).join('');

      it('ผสานไฟล์เดิมกับแถวใน DB ใน snapshot เดียว (DB ชนะเมื่อ id ซ้ำ) แล้ว promote', async () => {
        mockDb({ defaultCount: 1 }); // ใน DB เหลือ 1 แถว แต่ archive เดิมมี 5
        prisma.archiveExport.findUnique.mockResolvedValue({ rowCount: BigInt(5) });
        mockMergeClient({ expected: '6', csv: csv(6) });

        const meta = await service.exportMonth('2026-01');

        const sqls = clientQuery.mock.calls.filter(([a]) => typeof a === 'string').map(([a]) => a);
        expect(sqls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
        expect(sqls[1]).toContain('CREATE TEMP TABLE "_merge_tmp" (LIKE "log_days"');
        expect(sqls).toContain('COMMIT');
        const copyOut = clientQuery.mock.calls
          .map(([a]) => a as { text?: string })
          .find((a) => a.text?.startsWith('COPY ('))!.text!;
        expect(copyOut).toContain('DISTINCT ON ("id")');
        expect(copyOut).toContain('UNION ALL');
        expect(copyOut).toContain('FROM "_merge_tmp"');
        expect(meta.rowCount).toBe(6);
        expect(storage.copy).toHaveBeenCalledWith(`${KEY}.staging`, KEY);
        expect(prisma.archiveExport.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ update: expect.objectContaining({ rowCount: BigInt(6) }) }),
        );
      });

      it('อ่านลำดับคอลัมน์ของไฟล์เดิมจาก meta (ไม่ใช่ลำดับปัจจุบัน)', async () => {
        mockDb({ defaultCount: 1 });
        prisma.archiveExport.findUnique.mockResolvedValue({ rowCount: BigInt(5) });
        mockMergeClient({ expected: '6', csv: csv(6) });
        storage.getJson.mockResolvedValue({ columns: ['id', 'serial'] });

        await service.exportMonth('2026-01');

        const copyIn = clientQuery.mock.calls
          .map(([a]) => a as { text?: string })
          .find((a) => a.text?.startsWith('COPY "_merge_tmp"'))!.text!;
        expect(copyIn).toContain('("id", "serial")');
      });

      it('meta ระบุคอลัมน์ที่ไม่รู้จัก: ไม่ผสาน, ROLLBACK, ไม่แตะ archive เดิม', async () => {
        mockDb({ defaultCount: 1 });
        prisma.archiveExport.findUnique.mockResolvedValue({ rowCount: BigInt(5) });
        mockMergeClient({ expected: '6', csv: csv(6) });
        storage.getJson.mockResolvedValue({ columns: ['id', 'x; DROP TABLE y'] });

        await expect(service.exportMonth('2026-01')).rejects.toThrow('คอลัมน์ที่ไม่รู้จัก');

        expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
        expect(storage.uploadStream).not.toHaveBeenCalled();
        expect(storage.copy).not.toHaveBeenCalled();
      });

      it('ผลผสานได้แถวน้อยกว่า archive เดิม: ปฏิเสธและลบเฉพาะ staging', async () => {
        mockDb({ defaultCount: 1 });
        prisma.archiveExport.findUnique.mockResolvedValue({ rowCount: BigInt(5) });
        mockMergeClient({ expected: '1', csv: csv(1) });

        await expect(service.exportMonth('2026-01')).rejects.toThrow('refusing to replace');

        expect(storage.delete).toHaveBeenCalledWith(`${KEY}.staging`);
        expect(storage.delete).not.toHaveBeenCalledWith(KEY);
        expect(storage.copy).not.toHaveBeenCalled();
        expect(prisma.archiveExport.upsert).not.toHaveBeenCalled();
      });
    });

    it('ปฏิเสธรูปแบบเดือนที่ไม่ถูกต้อง', async () => {
      await expect(service.exportMonth('not-a-month' as any)).rejects.toThrow(
        'รูปแบบเดือนไม่ถูกต้อง',
      );
    });

    it('ปฏิเสธตารางที่ไม่อยู่ในรายการ (กัน SQL injection ผ่านชื่อตาราง)', async () => {
      await expect(service.exportMonth('2026-01', 'users; DROP TABLE x' as any)).rejects.toThrow(
        'ไม่รู้จักตาราง archive',
      );
      expect(pool.connect).not.toHaveBeenCalled();
    });
  });

  describe('findPendingMonths', () => {
    const NOW = new Date('2026-07-15T00:00:00.000Z');

    it('ตารางว่าง: ไม่มีเดือนค้าง', async () => {
      mockDb({ first: null });
      await expect(service.findPendingMonths('log_days', NOW)).resolves.toEqual([]);
    });

    it('คืนทุกเดือนที่จบแล้วและยังไม่ export (ไม่รวมเดือนปัจจุบัน)', async () => {
      mockDb({ first: new Date('2026-04-20T00:00:00.000Z') });
      await expect(service.findPendingMonths('log_days', NOW)).resolves.toEqual([
        '2026-04',
        '2026-05',
        '2026-06',
      ]);
    });

    it('ข้ามเดือนที่ export แล้วและไม่มีแถวใหม่หลังเวลา export', async () => {
      mockDb({ first: new Date('2026-04-20T00:00:00.000Z') });
      prisma.archiveExport.findMany.mockResolvedValue([
        { month: new Date('2026-04-01T00:00:00.000Z'), exportedAt: new Date('2026-05-01Z') },
        { month: new Date('2026-05-01T00:00:00.000Z'), exportedAt: new Date('2026-06-01Z') },
      ]);
      await expect(service.findPendingMonths('log_days', NOW)).resolves.toEqual(['2026-06']);
    });

    it('เดือนที่ export แล้วแต่มีแถวเขียนลง DB ทีหลัง (ข้อมูลมาช้า) ถือว่ายังค้าง', async () => {
      mockDb({ first: new Date('2026-05-02T00:00:00.000Z'), lateCounts: { '2026-05': 2 } });
      prisma.archiveExport.findMany.mockResolvedValue([
        { month: new Date('2026-05-01T00:00:00.000Z'), exportedAt: new Date('2026-06-01Z') },
        { month: new Date('2026-06-01T00:00:00.000Z'), exportedAt: new Date('2026-07-01Z') },
      ]);
      await expect(service.findPendingMonths('log_days', NOW)).resolves.toEqual(['2026-05']);
    });

    it('chunk ถูก drop บางส่วนแล้ว (แถวใน DB น้อยกว่าที่ export) ไม่ถือว่าค้าง — กัน export ทับด้วยไฟล์ไม่ครบ', async () => {
      // เหลือแค่ 3 แถวท้ายเดือนใน DB แต่ archive มี 1000 แถว และไม่มีแถวใหม่หลัง export
      mockDb({ first: new Date('2026-05-29T00:00:00.000Z'), defaultCount: 3 });
      prisma.archiveExport.findMany.mockResolvedValue([
        { month: new Date('2026-05-01T00:00:00.000Z'), exportedAt: new Date('2026-06-01Z') },
        { month: new Date('2026-06-01T00:00:00.000Z'), exportedAt: new Date('2026-07-01Z') },
      ]);
      await expect(service.findPendingMonths('log_days', NOW)).resolves.toEqual([]);
    });

    it('ถามเฉพาะ export ของตารางนั้น', async () => {
      mockDb({ first: new Date('2026-06-02T00:00:00.000Z') });
      await service.findPendingMonths('device_audit', NOW);
      expect(prisma.archiveExport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sourceTable: 'device_audit' }),
        }),
      );
    });
  });

  describe('dropVerifiedChunks', () => {
    const NOW = new Date('2026-07-15T00:00:00.000Z');
    const dropCall = () =>
      poolQuery.mock.calls.find(([sql]) => String(sql).includes('drop_chunks'))!;

    it('ไม่มีเดือนค้าง: ลบถึงต้น hot window (วันที่ 1 ของเดือนก่อนหน้า)', async () => {
      mockDb({ first: null, dropped: 3 });

      const res = await service.dropVerifiedChunks('log_days', NOW);

      expect(res.droppedChunks).toBe(3);
      expect(res.cutoff?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(dropCall()[0]).toContain(`drop_chunks('"log_days"'::regclass`);
      expect(dropCall()[1]).toEqual(['2026-06-01T00:00:00.000Z']);
    });

    it('มีเดือนเก่ากว่า hot window ที่ยังไม่ archive: cutoff ถอยไปที่เดือนนั้น (ไม่ลบข้อมูลที่ไม่มีสำเนา)', async () => {
      mockDb({ first: new Date('2026-03-10T00:00:00.000Z'), defaultCount: 5 });
      prisma.archiveExport.findMany.mockResolvedValue([
        { month: new Date('2026-03-01T00:00:00.000Z'), exportedAt: new Date('2026-04-01Z') },
        // 2026-04 ยังไม่ export
        { month: new Date('2026-05-01T00:00:00.000Z'), exportedAt: new Date('2026-06-01Z') },
      ]);

      const res = await service.dropVerifiedChunks('log_days', NOW);

      expect(res.cutoff?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
      expect(dropCall()[1]).toEqual(['2026-04-01T00:00:00.000Z']);
    });

    it('เดือนค้างอยู่ใน hot window เองไม่ทำให้ cutoff ถอยหลัง', async () => {
      // 2026-06 ยังไม่ export แต่ยังอยู่ใน hot window (>= 2026-06-01) → cutoff = ต้น hot window
      mockDb({ first: new Date('2026-06-05T00:00:00.000Z') });

      const res = await service.dropVerifiedChunks('log_days', NOW);

      expect(res.cutoff?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });
  });
});
