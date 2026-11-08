import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { SkipInterceptor } from '../common/decorators/skip-interceptor.decorator';
import { ArchiveStatusService } from '../backup/archive-status.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly archiveStatus: ArchiveStatusService,
  ) {}

  @Get()
  @HealthCheck()
  @SkipInterceptor()
  check() {
    return this.health.check([() => this.prismaIndicator.pingCheck('database', this.prisma)]);
  }

  /**
   * สถานะ archive — แยกจาก GET /health โดยตั้งใจ: /health ถูกใช้เป็น liveness/readiness probe ได้
   * ถ้า archive ค้างแล้วทำให้ probe ล้ม k8s จะ restart pod ที่ไม่ได้เสียไปด้วย
   * endpoint นี้ตอบ 503 เมื่อมีเดือนที่ archive เกินกำหนด เพื่อให้ monitoring ภายนอกเรียกตรวจได้
   */
  @Get('archive')
  @SkipInterceptor()
  async archive() {
    const s = await this.archiveStatus.getStatus();
    const body = {
      status: s.healthy ? 'ok' : 'degraded',
      checkedAt: s.checkedAt,
      lastSuccessfulRunAt: s.lastSuccessfulRunAt,
      reasons: s.reasons,
      tables: s.tables,
    };
    // HttpExceptionFilter ส่งต่อเฉพาะ message — ใส่สาเหตุไว้ในข้อความเพื่อให้ monitoring เห็น
    if (!s.healthy)
      throw new ServiceUnavailableException(`archive degraded: ${s.reasons.join('; ')}`);
    return body;
  }
}
