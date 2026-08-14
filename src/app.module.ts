import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration';
import { buildPinoOptions } from './observability/logger.config';
import { ObservabilityModule } from './observability/observability.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';
import { SseModule } from './sse/sse.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { MqttModule } from './mqtt/mqtt.module';
import { NotificationModule } from './notification/notification.module';
import { DeviceModule } from './device/device.module';
import { AdjustModule } from './adjust/adjust.module';
import { AuditModule } from './audit/audit.module';
import { ProbeModule } from './probe/probe.module';
import { DeviceConfigModule } from './device-config/device-config.module';
import { DeviceRepairModule } from './device-repair/device-repair.module';
import { WarrantiesModule } from './warranties/warranties.module';
import { FirmwareModule } from './firmware/firmware.module';
import { UserAuditModule } from './user-audit/user-audit.module';
import { LogdayModule } from './logday/logday.module';
import { GraphModule } from './graph/graph.module';
import { BackupModule } from './backup/backup.module';
import { HealthModule } from './health/health.module';
import { ConsumerModule } from './consumer/consumer.module';
import { LogConsumerModule } from './consumer/log-consumer.module';
import { CacheModule } from './common/cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { MobileModule } from './mobile/mobile.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      cache: true,
    }),
    // observability ต้องมาก่อนโมดูลอื่น เพื่อให้ทุกโมดูลได้ logger/tracer ที่ตั้งค่าแล้ว
    LoggerModule.forRoot(buildPinoOptions()),
    ObservabilityModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    // infrastructure
    PrismaModule,
    RedisModule,
    RabbitmqModule,
    AuthModule,
    // core vertical slice
    SseModule,
    TelemetryModule,
    MqttModule,
    NotificationModule,
    DeviceModule,
    AdjustModule,
    AuditModule,
    ProbeModule,
    DeviceConfigModule,
    DeviceRepairModule,
    WarrantiesModule,
    FirmwareModule,
    UserAuditModule,
    // supporting modules
    LogdayModule,
    GraphModule,
    BackupModule,
    HealthModule,
    ConsumerModule,
    LogConsumerModule,
    CacheModule,
    MobileModule,
  ],
})
export class AppModule {}
