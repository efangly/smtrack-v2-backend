import { Module } from '@nestjs/common';
import { DeviceImageStorageService } from './device-image-storage.service';
import { DeviceService } from './device.service';
import { DeviceController } from './device.controller';

@Module({
  controllers: [DeviceController],
  providers: [DeviceService, DeviceImageStorageService],
  exports: [DeviceService],
})
export class DeviceModule {}
