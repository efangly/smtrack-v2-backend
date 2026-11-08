import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArchiveExportService } from './archive-export.service';
import { ARCHIVE_TABLES, ArchiveTable } from './archive-tables';
import { monthRange, MonthString, toMonthString } from './archive.util';

/** เดือนที่จบแล้วเกินกี่วันและยังไม่ถูก archive ถือว่า "เกินกำหนด" (CronJob รันวันที่ 1 → เผื่อไว้ 3 วัน) */
export const OVERDUE_GRACE_DAYS = 3;
const CACHE_MS = 60_000;

export interface ArchiveTableStatus {
  table: ArchiveTable;
  /** เดือนล่าสุดที่มี archive ที่ตรวจผ่านแล้ว */
  lastExportedMonth: MonthString | null;
  pendingMonths: MonthString[];
  /** pending ที่เกินกำหนด (ดู OVERDUE_GRACE_DAYS) — ถ้ามี แปลว่า CronJob ไม่ทำงานหรือ export ล้มเหลวต่อเนื่อง */
  overdueMonths: MonthString[];
}

export interface ArchiveStatus {
  checkedAt: Date;
  healthy: boolean;
  reasons: string[];
  tables: ArchiveTableStatus[];
  lastSuccessfulRunAt: Date | null;
}

/**
 * สถานะของ archive สำหรับ health endpoint และ metric — คำนวณจากข้อมูลจริงใน DB (ไม่ใช่จากสถานะของ k8s Job)
 * จึงจับได้ทั้งกรณี Job ล้มเหลว, CronJob ไม่เคยรัน, และ Job ถูกลบทิ้งตาม history limit
 */
@Injectable()
export class ArchiveStatusService {
  private cache: { at: number; value: ArchiveStatus } | null = null;

  constructor(
    private readonly exporter: ArchiveExportService,
    private readonly prisma: PrismaService,
  ) {}

  async getStatus(now: Date = new Date()): Promise<ArchiveStatus> {
    if (this.cache && now.getTime() - this.cache.at < CACHE_MS) return this.cache.value;

    const tables: ArchiveTableStatus[] = [];
    for (const table of ARCHIVE_TABLES) {
      const [pendingMonths, last] = await Promise.all([
        this.exporter.findPendingMonths(table, now),
        this.prisma.archiveExport.findFirst({
          where: { sourceTable: table },
          orderBy: { month: 'desc' },
          select: { month: true },
        }),
      ]);
      const graceMs = OVERDUE_GRACE_DAYS * 24 * 60 * 60 * 1000;
      tables.push({
        table,
        lastExportedMonth: last ? toMonthString(last.month) : null,
        pendingMonths,
        overdueMonths: pendingMonths.filter(
          (m) => monthRange(m).to.getTime() + graceMs < now.getTime(),
        ),
      });
    }

    const lastSuccess = await this.prisma.archiveJobRun.findFirst({
      where: { job: 'export-and-drop', status: 'succeeded' },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    const failedSince = await this.prisma.archiveJobRun.count({
      where: {
        job: 'export-and-drop',
        status: 'failed',
        ...(lastSuccess?.finishedAt ? { startedAt: { gt: lastSuccess.finishedAt } } : {}),
      },
    });

    const reasons: string[] = [];
    for (const t of tables) {
      if (t.overdueMonths.length > 0) {
        reasons.push(`${t.table}: ยังไม่ได้ archive เกินกำหนด ${t.overdueMonths.join(', ')}`);
      }
    }
    if (failedSince > 0)
      reasons.push(`export-and-drop ล้มเหลว ${failedSince} ครั้งนับจากรอบที่สำเร็จล่าสุด`);

    const value: ArchiveStatus = {
      checkedAt: now,
      healthy: reasons.length === 0,
      reasons,
      tables,
      lastSuccessfulRunAt: lastSuccess?.finishedAt ?? null,
    };
    this.cache = { at: now.getTime(), value };
    return value;
  }
}
