import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const RETENTION_DAYS = 90;

/** ลบ PartnerApiRequestLogs ที่เก่ากว่า retention window (grill session Q19) */
@Injectable()
export class PartnerApiKeyCleanupService {
  private readonly logger = new Logger(PartnerApiKeyCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldRequestLogs(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.partnerApiRequestLogs.deleteMany({
      where: { createAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Deleted ${count} partner API request log(s) older than ${RETENTION_DAYS}d`);
    }
  }
}
