import { Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { ArchiveExportService } from './archive-export.service';
import { ArchiveRestoreService } from './archive-restore.service';
import { MonthString } from './archive.util';

/**
 * endpoint สำหรับหน้า admin บน frontend — จัดการ archive ด้วยมือ (นอกเหนือจาก CronJob และ
 * on-demand restore อัตโนมัติ) จำกัดที่ SUPER/SERVICE เพราะ export/restore กิน I/O ของ DB และ S3
 * และ DELETE /backup/restores/:month ลบข้อมูลที่ restore ไว้
 */
@ApiTags('backup')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER, Role.SERVICE)
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
