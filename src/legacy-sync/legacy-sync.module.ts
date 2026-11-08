import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module';
import { LegacySyncController } from './legacy-sync.controller';
import { LegacySyncService } from './legacy-sync.service';

/**
 * Legacy sync (ADR-0007) — ชั่วคราวจนถึง cutover แล้วลบทั้งโมดูล + ตาราง legacy_sync_map
 * controller ทำงานเฉพาะเมื่อ main.ts ต่อ queue legacy (LEGACY_SYNC_ENABLED=true)
 */
@Module({
  imports: [DeviceModule],
  controllers: [LegacySyncController],
  providers: [LegacySyncService],
  exports: [LegacySyncService],
})
export class LegacySyncModule {}
