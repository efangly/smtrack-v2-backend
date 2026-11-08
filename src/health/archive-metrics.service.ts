import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { ArchiveStatusService } from '../backup/archive-status.service';

/**
 * ส่งสถานะ archive เป็น gauge ผ่าน OTLP เหมือน metric อื่นของแอป (ไม่มี /metrics endpoint)
 *
 * ทำที่ฝั่ง API pod ไม่ใช่ในตัว CronJob: Job เป็น process อายุสั้นที่จบก่อนรอบ push ของ OTel reader
 * และต่อให้ push ทัน ถ้า Job ไม่ถูกสร้างเลย (CronJob ถูก suspend/ลบ) ก็จะไม่มี metric ให้ alert
 * — gauge จาก API pod คำนวณจาก DB จึงจับกรณีนั้นได้ด้วย
 */
@Injectable()
export class ArchiveMetricsService implements OnModuleInit {
  private readonly logger = new Logger(ArchiveMetricsService.name);

  constructor(private readonly status: ArchiveStatusService) {}

  onModuleInit(): void {
    const meter = metrics.getMeter('smtrack-backend');
    const overdue = meter.createObservableGauge('smtrack_archive_overdue_months', {
      description: 'จำนวนเดือนที่จบแล้วเกินกำหนดแต่ยังไม่ถูก archive แยกตามตาราง',
    });
    const pending = meter.createObservableGauge('smtrack_archive_pending_months', {
      description: 'จำนวนเดือนที่จบแล้วและยังไม่ถูก archive (รวมที่ยังไม่เกินกำหนด)',
    });
    const lastSuccess = meter.createObservableGauge('smtrack_archive_last_success_timestamp', {
      description: 'เวลา (unix วินาที) ที่ export-and-drop สำเร็จล่าสุด — 0 = ยังไม่เคย',
    });

    meter.addBatchObservableCallback(
      async (result) => {
        try {
          const s = await this.status.getStatus();
          for (const t of s.tables) {
            result.observe(overdue, t.overdueMonths.length, { table: t.table });
            result.observe(pending, t.pendingMonths.length, { table: t.table });
          }
          result.observe(
            lastSuccess,
            s.lastSuccessfulRunAt ? Math.floor(s.lastSuccessfulRunAt.getTime() / 1000) : 0,
          );
        } catch (err) {
          // metric ห้ามทำให้แอปล้ม — ข้ามรอบนี้ (alert absent จะจับเองถ้าเงียบนาน)
          this.logger.warn(`archive status metric skipped: ${(err as Error).message}`);
        }
      },
      [overdue, pending, lastSuccess],
    );
  }
}
