/**
 * ตารางที่ถูก archive ขึ้น object storage ก่อนออกจาก hot window (ดู CONTEXT.md, ADR-0005)
 *
 * ⚠️ รายการคอลัมน์ต้อง "ต่อท้าย" เท่านั้น ห้ามแทรกกลาง — COPY ... FROM STDIN อ่านไฟล์ตามลำดับที่
 * ระบุ ไม่ได้อ่านจาก header และไฟล์เก่าที่ไม่มี meta.columns ถูก restore ด้วยลำดับ legacy
 */
export const ARCHIVE_TABLES = ['log_days', 'notifications', 'device_audit', 'user_audit'] as const;
export type ArchiveTable = (typeof ARCHIVE_TABLES)[number];

export interface ArchiveTableSpec {
  /** ชื่อตารางจริงใน DB (ใช้ต่อเข้า SQL ตรง ๆ — มาจากรายการนี้เท่านั้น ห้ามรับจาก input) */
  name: ArchiveTable;
  /** คอลัมน์เวลาที่เป็น partition key ของ hypertable */
  timeColumn: string;
  /** ORDER BY ตอน export — ให้ไฟล์ได้ลำดับคงที่ (ผลลัพธ์ sha256 ซ้ำได้) */
  orderBy: string;
  /** โฟลเดอร์/prefix บน object storage */
  prefix: string;
  columns: readonly string[];
}

export const LOG_DAYS_COLUMNS = [
  'id',
  'serial',
  'temp',
  'temp_display',
  'humidity',
  'humidity_display',
  'send_time',
  'plug',
  'door1',
  'door2',
  'door3',
  'internet',
  'probe',
  'battery',
  'temp_internal',
  'ext_memory',
  'create_at',
  'update_at',
  'device_id',
  // ⚠️ คอลัมน์ใหม่ต้อง "ต่อท้าย" เท่านั้น ห้ามแทรกกลาง — ไฟล์เก่าที่ไม่มี meta.columns
  // ถูก restore ด้วยลำดับ legacy ที่ hardcode ไว้ การแทรกกลางทำให้ทุกไฟล์นั้น misalign
  'probe_id',
] as const;

/**
 * ลำดับคอลัมน์ของไฟล์ที่ export ไว้ "ก่อน" จะมีคอลัมน์ device_id (และก่อน probe_id ที่มาทีหลัง)
 * ใช้เมื่อไฟล์ meta ไม่มีฟิลด์ `columns` (ไฟล์เก่า) — ห้ามแก้ลำดับนี้ ไม่งั้น backup เก่าจะ restore ไม่ได้
 * คอลัมน์ที่ไม่อยู่ในชุดนี้ (device_id, probe_id) จะถูก COPY ปล่อยเป็น NULL ซึ่งถูกต้องแล้ว
 */
export const LEGACY_LOG_DAY_ARCHIVE_COLUMNS = [
  'id',
  'serial',
  'temp',
  'temp_display',
  'humidity',
  'humidity_display',
  'send_time',
  'plug',
  'door1',
  'door2',
  'door3',
  'internet',
  'probe',
  'battery',
  'temp_internal',
  'ext_memory',
  'create_at',
  'update_at',
] as const;

/** คอลัมน์ใน meta ที่ไม่รู้จัก — ชื่อคอลัมน์ถูกต่อเข้า COPY ตรง ๆ จึงต้องตรวจก่อนเสมอ */
export function unknownLogDayColumns(columns: readonly string[]): string[] {
  const known = new Set<string>(LOG_DAYS_COLUMNS);
  return columns.filter((c) => !known.has(c));
}

export const ARCHIVE_TABLE_SPECS: Record<ArchiveTable, ArchiveTableSpec> = {
  log_days: {
    name: 'log_days',
    timeColumn: 'send_time',
    orderBy: '"serial", "send_time"',
    prefix: 'log-days',
    columns: LOG_DAYS_COLUMNS,
  },
  notifications: {
    name: 'notifications',
    timeColumn: 'create_at',
    orderBy: '"create_at", "id"',
    prefix: 'notifications',
    columns: [
      'id',
      'serial',
      'message',
      'detail',
      'status',
      'delivered_sse',
      'delivered_fcm',
      'is_read',
      'read_at',
      'category',
      'severity',
      'device_id',
      'probe_id',
      'probe',
      'create_at',
      'update_at',
    ],
  },
  device_audit: {
    name: 'device_audit',
    timeColumn: 'create_at',
    orderBy: '"create_at", "id"',
    prefix: 'device-audit',
    columns: [
      'id',
      'device_id',
      'static_name',
      'action',
      'actor_id',
      'actor_name',
      'actor_role',
      'snapshot',
      'create_at',
    ],
  },
  user_audit: {
    name: 'user_audit',
    timeColumn: 'create_at',
    orderBy: '"create_at", "id"',
    prefix: 'user-audit',
    columns: [
      'id',
      'entity_type',
      'entity_id',
      'action',
      'actor_id',
      'actor_name',
      'actor_role',
      'snapshot',
      'create_at',
    ],
  },
};

export function isArchiveTable(value: string): value is ArchiveTable {
  return (ARCHIVE_TABLES as readonly string[]).includes(value);
}
