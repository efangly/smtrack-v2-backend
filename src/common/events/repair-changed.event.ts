import { Repairs } from '../../generated/prisma/client';
import { DeviceChangeActor } from './device-changed.event';

export type RepairChangeAction = 'created' | 'updated' | 'deleted';

/** payload ของ event `repair.changed` — ส่ง repair ทั้งก้อนไปด้วยเสมอ เหมือน device.changed */
export interface RepairChangedEvent {
  action: RepairChangeAction;
  repairId: string;
  serial: string;
  repair: Repairs;
  at: string;
  /** ผู้ใช้ที่ทำ action นี้ — undefined ถ้าเป็น system-triggered */
  actor?: DeviceChangeActor;
}

export function buildRepairChangedEvent(
  action: RepairChangeAction,
  repair: Repairs,
  actor?: DeviceChangeActor,
): RepairChangedEvent {
  return {
    action,
    repairId: repair.id,
    serial: repair.serial,
    repair,
    at: new Date().toISOString(),
    ...(actor ? { actor } : {}),
  };
}
