import { ARCHIVE_TABLE_SPECS, ArchiveTable } from './archive-tables';

export type MonthString = `${number}-${number}` & string; // "YYYY-MM"

const MONTH_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthString(value: string): value is MonthString {
  return MONTH_FORMAT.test(value);
}

/**
 * โครงสร้าง key บน MinIO/S3: log-days/2026/01/log-days-2026-01.csv.gz
 * ตารางอื่นใช้ prefix ของตัวเอง เช่น notifications/2026/01/notifications-2026-01.csv.gz
 * log_days คง key เดิมไว้ทุกตัวอักษร — ไฟล์ที่ export ไปแล้วต้อง restore ได้ต่อ
 */
export function archiveObjectKey(month: MonthString, table: ArchiveTable = 'log_days'): string {
  const [y, m] = month.split('-');
  const prefix = ARCHIVE_TABLE_SPECS[table].prefix;
  return `${prefix}/${y}/${m}/${prefix}-${month}.csv.gz`;
}

export function metaObjectKey(month: MonthString, table: ArchiveTable = 'log_days'): string {
  return archiveObjectKey(month, table).replace(/\.csv\.gz$/, '.meta.json');
}

/** ขอบเขตเวลาแบบ UTC ของเดือนนั้น: [from, to) */
export function monthRange(month: MonthString): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 1)),
    to: new Date(Date.UTC(y, m, 1)),
  };
}

export function toMonthString(date: Date): MonthString {
  return date.toISOString().slice(0, 7) as MonthString;
}

/** วันที่ 1 (UTC) ของเดือนที่ date อยู่ */
export function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** ช่วงย้อนหลังที่ API ต้องอ่านจาก log_days ได้เสมอโดยไม่ต้อง restore (range=30d ของ graph/partner) */
export const ALWAYS_HOT_DAYS = 30;

/**
 * ต้นของ hot window = วันที่ 1 (UTC) ของเดือนที่ "30 วันก่อนหน้านี้" อยู่
 *
 * ปกติเท่ากับวันที่ 1 ของเดือนก่อนหน้า (hot window = เดือนก่อนหน้า + เดือนปัจจุบัน จริง ~1–2 เดือน
 * ดู CONTEXT.md) แต่ต้นเดือนมีนาคมที่เดือนก่อนหน้า (กุมภาพันธ์) มีแค่ 28 วัน การย้อน 30 วันจะหลุดไป
 * ถึงมกราคม — จึงถอยต้น window ไปอีกเดือนในช่วง 1–2 มีนาคม เพื่อให้ range=30d ครบเสมอ
 * ข้อมูลที่เก่ากว่านี้ถูก drop ได้ (เมื่อ archive ยืนยันแล้ว) และต้อง on-demand restore ก่อนอ่าน
 */
export function hotWindowStart(now: Date = new Date()): Date {
  const alwaysHotFrom = new Date(now.getTime() - ALWAYS_HOT_DAYS * 24 * 60 * 60 * 1000);
  return startOfMonthUtc(alwaysHotFrom);
}

/** ทุกเดือน [from, to) ในรูป YYYY-MM เรียงจากเก่าไปใหม่ (from/to ต้องเป็นวันที่ 1 ของเดือน) */
export function monthsBetween(from: Date, to: Date): MonthString[] {
  const months: MonthString[] = [];
  const cursor = new Date(from.getTime());
  while (cursor < to) {
    months.push(toMonthString(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
