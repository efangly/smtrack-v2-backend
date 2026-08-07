export type NotificationCategory =
  'TEMP' | 'DOOR' | 'INTERNET' | 'PLUG' | 'SDCARD' | 'REPORT' | 'OTHER';

export type NotificationSeverity = 'critical' | 'warning' | 'info';

export interface NotificationClassification {
  category: NotificationCategory;
  severity: NotificationSeverity;
}

/**
 * ตัวจัดหมวด/ระดับความสำคัญของ notification จาก message string เดียว ใช้ทั้งตอน create()
 * (persist ลง category/severity) และ findCount() — เดิมสอง flow นี้ parse message ซ้ำกันคนละที่
 * (แล้ว frontend ก็ทำซ้ำอีกฝั่งหนึ่ง) จึงรวมเป็นจุดเดียวเพื่อไม่ให้ logic ดริฟท์
 *
 * รูปแบบ message ที่มีอยู่จริง (ตาม findCount เดิม):
 * - "SD/OFF"...            → sdcard
 * - "AC/OFF"...             → plug
 * - "INTERNET/OFF"...       → internet
 * - "{code}/TEMP/OVER"|"{code}/TEMP/LOWER" → temp (ต้นเหตุจริงจัง จึง critical)
 * - "{code}/{doorNo}/ON"    → door
 */
export function classifyNotification(message: string): NotificationClassification {
  const parts = message.split('/');
  const [p0, p1, p2] = parts;

  if (p0 === 'SD' && p1 === 'OFF') return { category: 'SDCARD', severity: 'warning' };
  if (p0 === 'AC' && p1 === 'OFF') return { category: 'PLUG', severity: 'warning' };
  if (p0 === 'INTERNET' && p1 === 'OFF') return { category: 'INTERNET', severity: 'warning' };
  if (p1 === 'TEMP' && (p2 === 'OVER' || p2 === 'LOWER')) {
    return { category: 'TEMP', severity: 'critical' };
  }
  if (p2 === 'ON') return { category: 'DOOR', severity: 'warning' };
  if (message.includes('REPORT')) return { category: 'REPORT', severity: 'info' };

  return { category: 'OTHER', severity: 'info' };
}
