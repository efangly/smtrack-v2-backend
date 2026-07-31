import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LogDays } from '../../generated/prisma/client';
import { RedisService } from '../../redis/redis.service';
import { AppEvents } from '../events/app-events';
import { ProbeChangedEvent } from '../events/probe-changed.event';

/** ฟัง event ที่ทำให้ cache ของ graph/logday/probe ล้าสมัย แล้วล้างทิ้ง */
@Injectable()
export class CacheInvalidationListener {
  constructor(private readonly redis: RedisService) {}

  @OnEvent(AppEvents.TELEMETRY_CREATED)
  async handleTelemetryCreated(log: LogDays): Promise<void> {
    // GraphService/LogdayService ตั้ง cache key ด้วย deviceId (จุดติดตั้ง) ไม่ใช่ serial ของกล่อง
    // ก่อนหน้านี้ที่นี่ล้างด้วย serial ทำให้ pattern ไม่เคย match — cache ไม่ถูก invalidate เลย
    if (!log.deviceId) return; // กล่องยังไม่ถูกติดตั้ง ไม่มีใคร cache กราฟของมันอยู่
    await this.redis.delByPattern(`graph:${log.deviceId}:*`);
    await this.redis.delByPattern(`logday:${log.deviceId}:*`);
  }

  /**
   * probe ถูกแก้/ลบ → mapping (deviceId, channel) -> probeId และ threshold ที่ติดไปกับ
   * series ของกราฟล้าสมัยทันที ถ้า cache probeId ที่ถูกลบไปแล้วค้างอยู่ ingest จะยิง FK
   * ที่ไม่มีอยู่จริงและพัง จึงต้องล้างทั้ง 3 namespace
   */
  @OnEvent(AppEvents.PROBE_CHANGED)
  async handleProbeChanged(event: ProbeChangedEvent): Promise<void> {
    await this.redis.delByPattern(`probe:${event.deviceId}:*`);
    await this.redis.delByPattern(`graph:${event.deviceId}:*`);
    await this.redis.delByPattern(`logday:${event.deviceId}:*`);
  }
}
