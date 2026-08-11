import { Module } from '@nestjs/common';
import { AdjustController } from './adjust.controller';
import { AdjustService } from './adjust.service';
import { DeviceModule } from '../device/device.module';
import { ProbeModule } from '../probe/probe.module';
import { DeviceConfigModule } from '../device-config/device-config.module';

@Module({
  imports: [DeviceModule, ProbeModule, DeviceConfigModule],
  controllers: [AdjustController],
  providers: [AdjustService],
})
export class AdjustModule {}
