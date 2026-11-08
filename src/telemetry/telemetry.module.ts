import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';
import { DeviceModule } from '../device/device.module';
import { ProbeModule } from '../probe/probe.module';
import { BackupModule } from '../backup/backup.module';

@Module({
  imports: [DeviceModule, ProbeModule, BackupModule],
  controllers: [TelemetryController],
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
