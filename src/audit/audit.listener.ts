import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppEvents } from '../common/events/app-events';
import { DeviceChangedEvent } from '../common/events/device-changed.event';
import { AuditService } from './audit.service';

/**
 * ฟัง device.changed แล้วบันทึก audit เฉพาะ action ที่มีผู้ใช้เป็นต้นเหตุจริง (created/updated/swapped)
 * online/offline เป็น heartbeat ที่ไม่มี actor จึงข้าม ไม่ใช่สิ่งที่ต้อง audit
 */
@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  constructor(private readonly audit: AuditService) {}

  @OnEvent(AppEvents.DEVICE_CHANGED)
  async handleDeviceChanged(event: DeviceChangedEvent): Promise<void> {
    if (!event.actor) return;

    try {
      await this.audit.record({
        deviceId: event.deviceId,
        staticName: event.staticName,
        action: event.action,
        actor: event.actor,
        snapshot: JSON.parse(JSON.stringify(event.device)),
      });
    } catch (err) {
      this.logger.warn(`บันทึก device audit (${event.action}) ล้มเหลว: ${(err as Error).message}`);
    }
  }
}
