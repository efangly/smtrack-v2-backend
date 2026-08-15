/**
 * ชื่อ internal event (EventEmitter2) ที่ใช้กระจายข้อมูลภายในโปรเซสเดียวกัน
 * เช่นจาก telemetry/notification service ไปยัง sse module
 */
export const AppEvents = {
  TELEMETRY_CREATED: 'telemetry.created',
  /** จาก topic realtime (~5s, ไม่บันทึก DB) — ใช้แค่ push ต่อให้ sse module ระหว่างปรับค่าชดเชย */
  TELEMETRY_REALTIME: 'telemetry.realtime',
  DEVICE_CHANGED: 'device.changed',
  PROBE_CHANGED: 'probe.changed',
  CONFIG_CHANGED: 'config.changed',
  REPAIR_CHANGED: 'repair.changed',
  WARRANTY_CHANGED: 'warranty.changed',
  FIRMWARE_CHANGED: 'firmware.changed',
} as const;

export type AppEventName = (typeof AppEvents)[keyof typeof AppEvents];
