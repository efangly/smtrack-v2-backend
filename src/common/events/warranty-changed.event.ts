import { Warranties } from '../../generated/prisma/client';
import { DeviceChangeActor } from './device-changed.event';

export type WarrantyChangeAction = 'created' | 'updated';

/** payload ของ event `warranty.changed` — ส่ง warranty ทั้งก้อนไปด้วยเสมอ เหมือน repair.changed */
export interface WarrantyChangedEvent {
  action: WarrantyChangeAction;
  warrantyId: string;
  serial: string;
  warranty: Warranties;
  at: string;
  /** ผู้ใช้ที่ทำ action นี้ — undefined ถ้าเป็น system-triggered */
  actor?: DeviceChangeActor;
}

export function buildWarrantyChangedEvent(
  action: WarrantyChangeAction,
  warranty: Warranties,
  actor?: DeviceChangeActor,
): WarrantyChangedEvent {
  return {
    action,
    warrantyId: warranty.id,
    serial: warranty.serial,
    warranty,
    at: new Date().toISOString(),
    ...(actor ? { actor } : {}),
  };
}
