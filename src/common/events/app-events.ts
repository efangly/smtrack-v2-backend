/**
 * ชื่อ internal event (EventEmitter2) ที่ใช้กระจายข้อมูลภายในโปรเซสเดียวกัน
 * เช่นจาก telemetry/notification service ไปยัง sse module
 */
export const AppEvents = {
  TELEMETRY_CREATED: 'telemetry.created',
  NOTIFICATION_CREATED: 'notification.created',
} as const;

export type AppEventName = (typeof AppEvents)[keyof typeof AppEvents];
