import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LogDays } from '../../generated/prisma/client';
import { RedisService } from '../../redis/redis.service';
import { AppEvents } from '../events/app-events';

/** ฟัง event telemetry ใหม่ แล้วล้าง cache กราฟ/สรุปรายวันของ serial นั้น */
@Injectable()
export class CacheInvalidationListener {
  constructor(private readonly redis: RedisService) {}

  @OnEvent(AppEvents.TELEMETRY_CREATED)
  async handleTelemetryCreated(log: LogDays): Promise<void> {
    await this.redis.delByPattern(`graph:${log.serial}:*`);
    await this.redis.delByPattern(`logday:${log.serial}:*`);
  }
}
