import { Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { ackOrNack } from '../consumer/rmq-ack.util';
import { validatePayload } from '../consumer/validate-payload.util';
import { MetricsService } from '../observability/metrics.service';
import {
  LegacyConfigDto,
  LegacyDeletedDto,
  LegacyDeviceDeletedDto,
  LegacyDeviceDto,
  LegacyProbeDto,
  LegacyRepairDto,
  LegacyWarrantyDto,
} from './dto/legacy-snapshot.dto';
import { LegacySyncPatterns as P } from './legacy-sync.patterns';
import { LegacySyncService, SyncOutcome } from './legacy-sync.service';

/**
 * รับ snapshot metadata จากระบบเดิม (ADR-0007) — handler แค่ validate แล้วเรียก LegacySyncService
 *
 * runtime event (device-log, device-notification, device-online/offline) ที่มาทาง exchange เดียวกัน
 * ถูก route ไป consumer เดิมใน src/consumer/ ตาม pattern ไม่ผ่าน controller นี้
 * payload เสีย/อ้างถึงสิ่งที่ยังไม่มี → nack ไม่ requeue → dead-letter เข้า DLQ
 */
@Controller()
export class LegacySyncController {
  private readonly logger = new Logger(LegacySyncController.name);
  private readonly queue: string;

  constructor(
    private readonly sync: LegacySyncService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.queue = config.get<string>('legacySync.queue') ?? 'legacy_sync_queue';
  }

  @EventPattern(P.DEVICE_UPSERTED)
  deviceUpserted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.DEVICE_UPSERTED, payload, LegacyDeviceDto, (d) =>
      this.sync.upsertDevice(d),
    );
  }

  @EventPattern(P.DEVICE_DELETED)
  deviceDeleted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.DEVICE_DELETED, payload, LegacyDeviceDeletedDto, (d) =>
      this.sync.deleteDevice(d),
    );
  }

  @EventPattern(P.PROBE_UPSERTED)
  probeUpserted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.PROBE_UPSERTED, payload, LegacyProbeDto, (d) =>
      this.sync.upsertProbe(d),
    );
  }

  @EventPattern(P.PROBE_DELETED)
  probeDeleted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.PROBE_DELETED, payload, LegacyDeletedDto, (d) =>
      this.sync.deleteProbe(d),
    );
  }

  @EventPattern(P.CONFIG_UPSERTED)
  configUpserted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.CONFIG_UPSERTED, payload, LegacyConfigDto, (d) =>
      this.sync.upsertConfig(d),
    );
  }

  @EventPattern(P.CONFIG_DELETED)
  configDeleted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.CONFIG_DELETED, payload, LegacyDeletedDto, (d) =>
      this.sync.deleteConfig(d),
    );
  }

  @EventPattern(P.REPAIR_UPSERTED)
  repairUpserted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.REPAIR_UPSERTED, payload, LegacyRepairDto, (d) =>
      this.sync.upsertRepair(d),
    );
  }

  @EventPattern(P.REPAIR_DELETED)
  repairDeleted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.REPAIR_DELETED, payload, LegacyDeletedDto, (d) =>
      this.sync.deleteRepair(d),
    );
  }

  @EventPattern(P.WARRANTY_UPSERTED)
  warrantyUpserted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.WARRANTY_UPSERTED, payload, LegacyWarrantyDto, (d) =>
      this.sync.upsertWarranty(d),
    );
  }

  @EventPattern(P.WARRANTY_DELETED)
  warrantyDeleted(@Payload() payload: unknown, @Ctx() ctx: RmqContext) {
    return this.handle(ctx, P.WARRANTY_DELETED, payload, LegacyDeletedDto, (d) =>
      this.sync.deleteWarranty(d),
    );
  }

  private handle<T>(
    ctx: RmqContext,
    pattern: string,
    payload: unknown,
    dto: new () => T,
    apply: (dto: T) => Promise<SyncOutcome>,
  ): Promise<void> {
    return ackOrNack(ctx, pattern, payload, async () => {
      try {
        // validate ข้างใน ackOrNack ไม่ใช่ที่ @Payload() — เหตุผลใน validate-payload.util.ts
        const outcome = await apply(await validatePayload(dto, payload));
        if (outcome !== 'applied') this.logger.debug(`${pattern}: ${outcome}`);
        this.metrics.recordRmqMessage(this.queue, 'success');
      } catch (err) {
        this.metrics.recordRmqMessage(this.queue, 'error');
        throw err;
      }
    });
  }
}
