import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceModule } from '../device/device.module';
import { PartnerController } from './partner.controller';
import { AdminPartnerKeyController } from './admin-partner-key.controller';
import { PartnerService } from './partner.service';
import { PartnerApiKeyService } from './partner-api-key.service';
import { GrpcApiKeyAuthGuard } from './partner-grpc.guard';
import { GrpcPartnerRateLimitGuard } from './partner-grpc-rate-limit.guard';
import { PartnerGrpcExceptionFilter } from './partner-grpc-exception.filter';
import { PartnerApiKeyCleanupService } from './partner-api-key-cleanup.service';

@Module({
  imports: [PrismaModule, DeviceModule],
  // เฉพาะ AdminPartnerKeyController เป็น HTTP controller จริง — PartnerController ใช้
  // @GrpcMethod ทั้งหมด (ไม่มี HTTP route ของตัวเอง) ยังต้องอยู่ใน controllers ให้ Nest
  // ผูก @GrpcMethod handler เข้ากับ gRPC microservice ที่ต่อไว้ใน main.ts
  controllers: [PartnerController, AdminPartnerKeyController],
  providers: [
    PartnerService,
    PartnerApiKeyService,
    GrpcApiKeyAuthGuard,
    GrpcPartnerRateLimitGuard,
    PartnerGrpcExceptionFilter,
    PartnerApiKeyCleanupService,
  ],
})
export class PartnerModule {}
