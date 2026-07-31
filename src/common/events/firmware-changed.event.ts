import { Firmwares } from '../../generated/prisma/client';
import { DeviceChangeActor } from './device-changed.event';

export type FirmwareChangeAction = 'created' | 'updated' | 'deleted';

/** payload ของ event `firmware.changed` — ส่ง firmware ทั้งก้อนไปด้วยเสมอ เหมือน warranty.changed */
export interface FirmwareChangedEvent {
  action: FirmwareChangeAction;
  firmwareId: string;
  version: string;
  firmware: Firmwares;
  at: string;
  /** ผู้ใช้ที่ทำ action นี้ — undefined ถ้าเป็น system-triggered */
  actor?: DeviceChangeActor;
}

export function buildFirmwareChangedEvent(
  action: FirmwareChangeAction,
  firmware: Firmwares,
  actor?: DeviceChangeActor,
): FirmwareChangedEvent {
  return {
    action,
    firmwareId: firmware.id,
    version: firmware.version,
    firmware,
    at: new Date().toISOString(),
    ...(actor ? { actor } : {}),
  };
}
