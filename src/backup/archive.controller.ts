import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArchiveExportService } from './archive-export.service';
import { ArchiveRestoreService } from './archive-restore.service';
import { MonthString } from './archive.util';

/**
 * endpoint สำหรับหน้า admin บน frontend
 * ควรครอบด้วย auth guard ของระบบ (เช่น @UseGuards(JwtAuthGuard, AdminGuard))
 */
@ApiTags('backup')
@Controller('backup')
export class ArchiveController {
  constructor(
    private readonly exporter: ArchiveExportService,
    private readonly restorer: ArchiveRestoreService,
  ) {}

  /** รายการเดือนที่มี backup พร้อมสถานะว่า restore อยู่หรือไม่ */
  @Get('months')
  listMonths() {
    return this.restorer.listAvailable();
  }

  /** สั่ง export เดือนที่ระบุด้วยมือ (นอกเหนือจาก cron) */
  @Post('exports/:month')
  exportMonth(@Param('month') month: MonthString) {
    return this.exporter.exportMonth(month);
  }

  /** restore เดือนที่ระบุเข้า LogDayArchive เพื่อทำรายงาน */
  @Post('restores/:month')
  restoreMonth(@Param('month') month: MonthString) {
    return this.restorer.restoreMonth(month);
  }

  /** เคลียร์เดือนที่ restore ไว้ออกจากฐานข้อมูล (ไฟล์บน object storage ยังอยู่) */
  @Delete('restores/:month')
  removeMonth(@Param('month') month: MonthString) {
    return this.restorer.removeMonth(month);
  }
}
