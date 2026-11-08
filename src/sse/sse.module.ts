import { Module } from '@nestjs/common';
import { SseService } from './sse.service';
import { SseController } from './sse.controller';
import { DeviceModule } from '../device/device.module';

@Module({
  // ต้องใช้ DeviceAssignmentService หา department ของ serial เพื่อกรอง stream ตาม department ของผู้ใช้
  imports: [DeviceModule],
  controllers: [SseController],
  providers: [SseService],
  exports: [SseService],
})
export class SseModule {}
