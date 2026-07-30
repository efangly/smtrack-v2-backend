import { Module } from '@nestjs/common';
import { DeviceConfigController } from './device-config.controller';
import { DeviceConfigService } from './device-config.service';

@Module({
  controllers: [DeviceConfigController],
  providers: [DeviceConfigService],
  exports: [DeviceConfigService],
})
export class DeviceConfigModule {}
