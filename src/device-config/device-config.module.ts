import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module';
import { DeviceConfigController } from './device-config.controller';
import { DeviceConfigService } from './device-config.service';

@Module({
  // DeviceAssignmentService ใช้ตรวจว่าผู้ใช้เข้าถึงจุดติดตั้งนี้ได้ (tenant/department)
  imports: [DeviceModule],
  controllers: [DeviceConfigController],
  providers: [DeviceConfigService],
  exports: [DeviceConfigService],
})
export class DeviceConfigModule {}
