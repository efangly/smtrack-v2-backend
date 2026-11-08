import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import configuration from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { ObservabilityModule } from '../observability/observability.module';
import { LegacySyncModule } from '../legacy-sync/legacy-sync.module';

/** module แบบเบาสำหรับ CLI backfill — ไม่ต่อ MQTT / RabbitMQ consumer / gRPC */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    EventEmitterModule.forRoot(),
    ObservabilityModule,
    PrismaModule,
    RedisModule,
    LegacySyncModule,
  ],
})
export class LegacyBackfillCliModule {}
