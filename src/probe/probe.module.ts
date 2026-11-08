import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module';
import { ProbeController } from './probe.controller';
import { ProbeService } from './probe.service';
import { ProbeResolverService } from './probe-resolver.service';

@Module({
  // DeviceAssignmentService ใช้ตรวจว่าผู้ใช้เข้าถึงจุดติดตั้งนี้ได้ (tenant/department)
  imports: [DeviceModule],
  controllers: [ProbeController],
  providers: [ProbeService, ProbeResolverService],
  exports: [ProbeService, ProbeResolverService],
})
export class ProbeModule {}
