import { Module } from '@nestjs/common';
import { UserAuditController } from './user-audit.controller';
import { UserAuditListener } from './user-audit.listener';
import { UserAuditService } from './user-audit.service';

@Module({
  controllers: [UserAuditController],
  providers: [UserAuditService, UserAuditListener],
  exports: [UserAuditService],
})
export class UserAuditModule {}
