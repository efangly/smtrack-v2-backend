import { ArchiveStatusService } from './archive-status.service';
import { ArchiveExportService } from './archive-export.service';
import { PrismaService } from '../prisma/prisma.service';

const NOW = new Date('2026-07-15T00:00:00.000Z');

describe('ArchiveStatusService', () => {
  let exporter: { findPendingMonths: jest.Mock };
  let prisma: {
    archiveExport: { findFirst: jest.Mock };
    archiveJobRun: { findFirst: jest.Mock; count: jest.Mock };
  };
  let service: ArchiveStatusService;

  beforeEach(() => {
    exporter = { findPendingMonths: jest.fn().mockResolvedValue([]) };
    prisma = {
      archiveExport: {
        findFirst: jest.fn().mockResolvedValue({ month: new Date('2026-06-01T00:00:00.000Z') }),
      },
      archiveJobRun: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ finishedAt: new Date('2026-07-01T03:05:00.000Z') }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new ArchiveStatusService(
      exporter as unknown as ArchiveExportService,
      prisma as unknown as PrismaService,
    );
  });

  it('ไม่มีเดือนค้างและไม่มีรอบล้มเหลว: healthy', async () => {
    const s = await service.getStatus(NOW);

    expect(s.healthy).toBe(true);
    expect(s.reasons).toEqual([]);
    expect(s.tables.map((t) => t.table)).toEqual([
      'log_days',
      'notifications',
      'device_audit',
      'user_audit',
    ]);
    expect(s.tables[0].lastExportedMonth).toBe('2026-06');
    expect(s.lastSuccessfulRunAt).toEqual(new Date('2026-07-01T03:05:00.000Z'));
  });

  it('เดือนที่เพิ่งจบ (ยังไม่เกิน 3 วัน) ค้างอยู่: pending แต่ยังไม่ถือว่าเกินกำหนด', async () => {
    // 2026-06 จบเมื่อ 2026-07-01 → ที่ 2026-07-03 ผ่านมา 2 วัน
    exporter.findPendingMonths.mockResolvedValue(['2026-06']);

    const s = await service.getStatus(new Date('2026-07-03T00:00:00.000Z'));

    expect(s.healthy).toBe(true);
    expect(s.tables[0].pendingMonths).toEqual(['2026-06']);
    expect(s.tables[0].overdueMonths).toEqual([]);
  });

  it('เดือนที่จบเกิน 3 วันแล้วยังค้าง: เกินกำหนด → degraded พร้อมระบุตารางและเดือน', async () => {
    exporter.findPendingMonths.mockImplementation((t: string) =>
      Promise.resolve(t === 'notifications' ? ['2026-05', '2026-06'] : []),
    );

    const s = await service.getStatus(NOW);

    expect(s.healthy).toBe(false);
    expect(s.reasons).toEqual(['notifications: ยังไม่ได้ archive เกินกำหนด 2026-05, 2026-06']);
  });

  it('มีรอบล้มเหลวหลังรอบที่สำเร็จล่าสุด: degraded', async () => {
    prisma.archiveJobRun.count.mockResolvedValue(2);

    const s = await service.getStatus(NOW);

    expect(s.healthy).toBe(false);
    expect(s.reasons[0]).toContain('ล้มเหลว 2 ครั้ง');
    expect(prisma.archiveJobRun.count).toHaveBeenCalledWith({
      where: {
        job: 'export-and-drop',
        status: 'failed',
        startedAt: { gt: new Date('2026-07-01T03:05:00.000Z') },
      },
    });
  });

  it('ยังไม่เคยมีรอบสำเร็จเลย: นับทุกรอบที่ล้มเหลว และ lastSuccessfulRunAt เป็น null', async () => {
    prisma.archiveJobRun.findFirst.mockResolvedValue(null);
    prisma.archiveJobRun.count.mockResolvedValue(1);

    const s = await service.getStatus(NOW);

    expect(s.lastSuccessfulRunAt).toBeNull();
    expect(prisma.archiveJobRun.count).toHaveBeenCalledWith({
      where: { job: 'export-and-drop', status: 'failed' },
    });
  });

  it('cache 60 วินาที: เรียกซ้ำในช่วงนั้นไม่ query ใหม่ (gauge + health endpoint ใช้ร่วมกัน)', async () => {
    await service.getStatus(NOW);
    await service.getStatus(new Date(NOW.getTime() + 30_000));
    expect(exporter.findPendingMonths).toHaveBeenCalledTimes(4); // 4 ตาราง ครั้งเดียว

    await service.getStatus(new Date(NOW.getTime() + 61_000));
    expect(exporter.findPendingMonths).toHaveBeenCalledTimes(8);
  });
});
