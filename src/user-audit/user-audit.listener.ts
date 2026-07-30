import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppEvents } from '../common/events/app-events';
import { DeviceChangedEvent } from '../common/events/device-changed.event';
import { ProbeChangedEvent } from '../common/events/probe-changed.event';
import { ConfigChangedEvent } from '../common/events/config-changed.event';
import { RepairChangedEvent } from '../common/events/repair-changed.event';
import { WarrantyChangedEvent } from '../common/events/warranty-changed.event';
import { UserAuditService } from './user-audit.service';

/**
 * ฟัง *.changed event จากทุก entity (device/probe/config/repair) แล้วบันทึกลง user_audit
 * เพื่อให้ query ประวัติ action ของ user คนหนึ่งข้าม entity ได้ในที่เดียว — คนละหน้าที่กับ
 * AuditListener/DeviceAudit ที่ query หลักคือ deviceId ไม่ใช่ actorId (ทั้งสอง listener ทำงานคู่ขนานกัน
 * ไม่แตะกัน) เช่นเดียวกับ AuditListener จะข้าม event ที่ไม่มี actor (เช่น online/offline heartbeat)
 */
@Injectable()
export class UserAuditListener {
  private readonly logger = new Logger(UserAuditListener.name);

  constructor(private readonly userAudit: UserAuditService) {}

  @OnEvent(AppEvents.DEVICE_CHANGED)
  async handleDeviceChanged(event: DeviceChangedEvent): Promise<void> {
    if (!event.actor) return;
    await this.record('device', event.deviceId, event.action, event.actor, event.device);
  }

  @OnEvent(AppEvents.PROBE_CHANGED)
  async handleProbeChanged(event: ProbeChangedEvent): Promise<void> {
    if (!event.actor) return;
    await this.record('probe', event.probeId, event.action, event.actor, event.probe);
  }

  @OnEvent(AppEvents.CONFIG_CHANGED)
  async handleConfigChanged(event: ConfigChangedEvent): Promise<void> {
    if (!event.actor) return;
    await this.record('config', event.configId, event.action, event.actor, event.config);
  }

  @OnEvent(AppEvents.REPAIR_CHANGED)
  async handleRepairChanged(event: RepairChangedEvent): Promise<void> {
    if (!event.actor) return;
    await this.record('repair', event.repairId, event.action, event.actor, event.repair);
  }

  @OnEvent(AppEvents.WARRANTY_CHANGED)
  async handleWarrantyChanged(event: WarrantyChangedEvent): Promise<void> {
    if (!event.actor) return;
    await this.record('warranty', event.warrantyId, event.action, event.actor, event.warranty);
  }

  private async record(
    entityType: string,
    entityId: string,
    action: string,
    actor: NonNullable<DeviceChangedEvent['actor']>,
    snapshot: unknown,
  ): Promise<void> {
    try {
      await this.userAudit.record({
        entityType,
        entityId,
        action,
        actor,
        snapshot: JSON.parse(JSON.stringify(snapshot)),
      });
    } catch (err) {
      this.logger.warn(
        `บันทึก user audit (${entityType}.${action}) ล้มเหลว: ${(err as Error).message}`,
      );
    }
  }
}
