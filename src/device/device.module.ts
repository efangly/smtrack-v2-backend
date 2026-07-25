import { Module } from '@nestjs/common';
import { DeviceAssignmentService } from './device-assignment.service';
import { DeviceImageStorageService } from './device-image-storage.service';
import { DeviceService } from './device.service';
import { DeviceController } from './device.controller';

@Module({
  controllers: [DeviceController],
  providers: [DeviceService, DeviceImageStorageService, DeviceAssignmentService],
  exports: [DeviceService, DeviceAssignmentService],
})
export class DeviceModule {}
