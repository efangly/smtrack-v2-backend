import { Module } from '@nestjs/common';
import { DeviceRepairController } from './device-repair.controller';
import { DeviceRepairService } from './device-repair.service';

@Module({
  controllers: [DeviceRepairController],
  providers: [DeviceRepairService],
  exports: [DeviceRepairService],
})
export class DeviceRepairModule {}
