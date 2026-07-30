import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module';
import { AuditController } from './audit.controller';
import { AuditListener } from './audit.listener';
import { AuditService } from './audit.service';

@Module({
  imports: [DeviceModule],
  controllers: [AuditController],
  providers: [AuditService, AuditListener],
  exports: [AuditService],
})
export class AuditModule {}
