import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';
import { DeviceModule } from '../device/device.module';
import { ProbeModule } from '../probe/probe.module';

@Module({
  imports: [DeviceModule, ProbeModule],
  controllers: [TelemetryController],
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
