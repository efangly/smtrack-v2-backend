import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { ArchiveMetricsService } from './archive-metrics.service';
import { BackupModule } from '../backup/backup.module';

@Module({
  imports: [TerminusModule, BackupModule],
  controllers: [HealthController],
  providers: [ArchiveMetricsService],
})
export class HealthModule {}
