import { Devices } from '../../generated/prisma/client';

export type DeviceChangeAction = 'created' | 'updated' | 'swapped' | 'online' | 'offline';

/** ผู้ใช้จาก JWT payload ที่เป็นต้นเหตุของการเปลี่ยนแปลงนี้ — ไม่มีค่าถ้าเป็น system-triggered (เช่น heartbeat) */
export interface DeviceChangeActor {
  id: string;
  name: string;
  role: string;
}

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
  /** ผู้ใช้ที่ทำ action นี้ — undefined สำหรับ action ที่ไม่มีผู้ใช้เป็นต้นเหตุ (online/offline) */
  actor?: DeviceChangeActor;
}

/** สร้าง envelope จาก record ที่เพิ่งเขียนลง DB — คุม field ให้ตรงกันทุกจุดที่ emit */
export function buildDeviceChangedEvent(
  action: DeviceChangeAction,
  device: Devices,
  previousSerial?: string | null,
  actor?: DeviceChangeActor,
): DeviceChangedEvent {
  return {
    action,
    deviceId: device.id,
    staticName: device.staticName,
    serial: device.serial,
    ...(previousSerial !== undefined ? { previousSerial } : {}),
    device,
    at: new Date().toISOString(),
    ...(actor ? { actor } : {}),
  };
}
