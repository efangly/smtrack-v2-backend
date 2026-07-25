import { Devices } from '../../generated/prisma/client';

export type DeviceChangeAction = 'created' | 'updated' | 'swapped' | 'online' | 'offline';

/**
 * payload ของ event `device.changed` — ส่งจุดติดตั้งทั้งก้อนไปด้วยเสมอ
 * เพื่อให้ dashboard เอาไป replace ใน state ได้ทันทีโดยไม่ต้องยิง GET /devices ซ้ำ
 */
export interface DeviceChangedEvent {
  action: DeviceChangeAction;
  deviceId: string;
  staticName: string;
  /** null ได้ ถ้าจุดติดตั้งนี้ยังไม่มีกล่องติดตั้งอยู่ */
  serial: string | null;
  /** เฉพาะ action 'swapped' — กล่องตัวเดิมที่เพิ่งถูกถอดออก */
  previousSerial?: string | null;
  device: Devices;
  at: string;
}

/** สร้าง envelope จาก record ที่เพิ่งเขียนลง DB — คุม field ให้ตรงกันทุกจุดที่ emit */
export function buildDeviceChangedEvent(
  action: DeviceChangeAction,
  device: Devices,
  previousSerial?: string | null,
): DeviceChangedEvent {
  return {
    action,
    deviceId: device.id,
    staticName: device.staticName,
    serial: device.serial,
    ...(previousSerial !== undefined ? { previousSerial } : {}),
    device,
    at: new Date().toISOString(),
  };
}
